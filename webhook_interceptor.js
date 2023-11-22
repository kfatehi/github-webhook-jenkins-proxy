const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const httpProxy = require('http-proxy');
const Queue = require('node-persistent-queue');
const config = require('./config.json')
const setupProfile = require('./profile');
const hooks = require('./hooks');
const axios = require('axios')
const needle = require('needle');
const cors = require('cors');

const useManualBuildRequestMiddleware = require('./manual-build-middleware');

const q = new Queue('db.sqlite', 1);

const jenkins = require('jenkins')({
  baseUrl: 'http://'+config.jenkinsAuth+'@localhost:'+config.jenkinsPort,
  crumbIssuer: true
});

const proxy = httpProxy.createProxyServer({});

const proxyApp = express();
proxyApp.use(bodyParser.json({ limit: "50mb" }));

const pis = {}

config.profiles.forEach((pc)=>{
  const {
    // do not forward these into the profile instance
    profiles, jenkinsAuth, jenkinsPort, listenPort,
    // forward the rest though
    ...fwGlobalConf
  } = config;
  let combinedConfig = { ...fwGlobalConf, ...pc }
  let repoFullName = combinedConfig.repoOwner+'/'+combinedConfig.repoName;
  pis[repoFullName] = setupProfile(combinedConfig, jenkins, q);
  console.log("Defined profile:", repoFullName);
});

function getPiByFullName(repoFullName) {
  return pis[repoFullName];
}

function getPi(repoOwner, repoName) {
  return getPiByFullName(repoOwner+'/'+repoName);
}

const manualBuildRequestMiddleware = useManualBuildRequestMiddleware({ getPi, getPiByFullName })

const commitLengthCheckMiddleware = (req, res, next)=>{
  if (req.body.commit.length !== 40) {
    return res.send("commit should be 40 characters\n")

    // If trying to build a branch, you maybe can use this to get the SHA1
    // either way you need that because the checks API does not accept a branch name
    // when we are ready to report the result.
    //
    // https://docs.github.com/en/rest/commits/commits#list-commits
    //let commits = await octokit.request('GET /repos/{owner}/{repo}/commits', {
    //  owner: pi.config.repoOwner,
    //  repo: pi.config.repoName,
    //  sha: 
    //})

  }
  return next()
}

proxyApp.post('/build-all', manualBuildRequestMiddleware, commitLengthCheckMiddleware, async (req, res, next)=>{
  await req.pi.queueBuild(req.body.commit)
  res.send("queued\n")
})

proxyApp.post('/build-one', manualBuildRequestMiddleware, commitLengthCheckMiddleware, async (req, res, next)=>{
  await req.pi.queueBuildForProject(req.body.project, req.body.commit)
  res.send("queued\n")
})

proxyApp.post('/retry-one', manualBuildRequestMiddleware, async (req, res, next)=>{
  jenkins.build.get(req.body.project, req.body.build, async (err, data)=>{
    if (err) {
      return next(err)
    }
    let paramsAction = data.actions.find(a=>a._class === 'hudson.model.ParametersAction')
    let commit = paramsAction.parameters.find(a=>a.name="BRANCH_SPECIFIER").value
    await req.pi.queueBuildForProject(req.body.project, commit)
    res.send("queued\n")
  })
})

proxyApp.get("/retry/:repoOrg/:repoName/:projectName/:buildNumber", (req, res, next)=>{
  res.render("retry.html.ejs", req.params);

});

if (config.artifactProxy) {
  const artifactProxyCorsOptions = {
    origin: '*', // or specify allowed origins
    methods: 'GET', // specify allowed methods
    allowedHeaders: ['Content-Type'], // specify allowed headers
  };
  
  // Effectively makes all artifacts public via secret key
  // To use it, you need to define a section in the config.json like this:
  // "artifactProxy": { "secret": "mysecret" }
  // and then you can access artifacts by taking the public URL and prefixing it
  // with artifactProxy and suffixing it with ?secret=mysecret
  // thus providing a mechanism by which you can share artifacts via public URL
  proxyApp.get("/artifactProxy/:secret/job/:projectName/:build/artifact/*", cors(artifactProxyCorsOptions), (req, res, next)=>{
    if (req.params?.secret === config.artifactProxy.secret) {
      let { auth, hostname, port, protocol } = jenkins._opts.baseUrl
      let regex = new RegExp(`^/artifactProxy/${req.params.secret}`)
      let url = `${protocol}//${hostname}:${port}${req.path.replace(regex,'')}`
      let [username, password] = auth.split(":")
      needle.get(url, {username, password}).pipe(res)
    } else {
      res.status(403).end("403 Forbidden")
    }
  });
}

proxyApp.use(async function(req, res){
  let githubEvent = req.headers['x-github-event'];

  if (!githubEvent) { 
    return proxy.web(req, res, {
      target: 'http://localhost:'+config.jenkinsPort
    }, function(err) {
      console.log("proxy error", err.message);
    });
  }

  const pi = getPiByFullName(req.body.repository.full_name);

  if (!pi) {
    res.status(404).end("no profile defined for this repository")
  }

  console.log("Received github event", githubEvent, "matched to", pi.config);

  if (githubEvent == "pull_request" && ( req.body.action == "synchronize" || req.body.action == "opened" )) {
    await pi.queueBuild(req.body.pull_request.head.sha, null, req.body);
    return res.status(201).end("thanks for the PR, i will build it");
  } else if (githubEvent == "push" && pi.config.refHooks && pi.config.refHooks[req.body.ref]) {
    let hookDefinitions = pi.config.refHooks[req.body.ref];
    if (hookDefinitions.buildBranch) {
      await pi.queueBuild(req.body.head_commit.id, hookDefinitions.buildBranch, req.body, (projectList)=>{
        if (hookDefinitions.extraJenkinsProjects) {
          return [...projectList, ...hookDefinitions.extraJenkinsProjects]
        } else {
          return projectList
        }
      });
    }
    if (hookDefinitions.exec) {
      console.log("Executing hook...");
      let stdout = ""
      let stderr = ""
      try {
        const out = await hooks.exec(hookDefinitions.exec.command);
        if (out && out.stdout) {
          stdout = out.stdout
        }
        if (out && out.stderr) {
          stderr = out.stderr
        }
      } catch(err) {
        console.error("error with exec", err.stack);
        if (pi.config.slackAlertEndpoint)
          axios.post(pi.config.slackAlertEndpoint, pi.slackNotifyHookError(req.body, err, stdout, stderr));
      }
    }
    return res.status(201).end("thanks for the push. hooks have executed.");
  } else if (githubEvent == "issue_comment" && req.body.action == "created" && req.body.issue.pull_request && req.body.comment.body.includes(pi.config.triggerPhrase)) {
    let pull = await pi.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: pi.config.repoOwner,
      repo: pi.config.repoName,
      pull_number: req.body.issue.number
    })
    await pi.queueBuild(pull.data.head.sha, null, req.body);
    return res.status(201).end("thanks for the issue comment, i will test it");
  } else {
    console.log("ignoring irrelevant webook delivery", req.headers['x-github-delivery']);
    return res.status(202).end("irrelevant webhook, ignoring");
  }
});

q.on('next',task => {
  const { repoOwner, repoName } = task.job.config;
  let pi = getPi(repoOwner, repoName);
  pi.onNext(task);
});

q.on('stop',() => {
  console.log('Stopping queue') ;
});

q.on('close',() => {
  console.log('Closing SQLite DB') ;
});

q.on('open',() => {
  console.log('Opening SQLite DB') ;
  console.log('Queue contains '+q.getLength()+' job/s');
}) ;

q.on('add',task => {
  console.log('Adding task ('+q.getLength()+' total) ');//+JSON.stringify(task));
}) ;

q.on('start',() => {
  console.log('Started queue') ;
});

q.open().then(() => {
  q.start();
}).catch(err => {
  console.log('Error occurred:') ;
  console.log(err.stack);
});

http.createServer(proxyApp).listen(config.listenPort, '0.0.0.0', () => {
  console.log('Proxy server listening on '+config.listenPort);
});

