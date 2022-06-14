const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const httpProxy = require('http-proxy');
const Queue = require('node-persistent-queue');
const config = require('./config.json')
const setupProfile = require('./profile');
const hooks = require('./hooks');
const axios = require('axios')

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
  console.log('Adding task ('+q.getLength()+' total) '+JSON.stringify(task));
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
      await pi.queueBuild(req.body.head_commit.id, hookDefinitions.buildBranch, req.body);
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
    await queueBuild(pull.data.head.sha, null, req.body);
    return res.status(201).end("thanks for the issue comment, i will test it");
  } else {
    console.log("ignoring irrelevant webook delivery", req.headers['x-github-delivery']);
    return res.status(202).end("irrelevant webhook, ignoring");
  }
});

function manualBuildRequestMiddleware(req, res, next) {
  const pi = getPi(req.body.repoOwner,req.body.repoName) || getPiByFullName[req.body.repo];
  if (!pi) {
    res.send("must provide a matching repoOwner and repoName combination")
    return;
  }
  if (req.body.commit.length !== 40) {
    res.send("commit should be 40 characters\n")

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

    return;
  }
  try {
    req.pi = pi;
    next();
  } catch(err) {
    next(err);
  }
}

proxyApp.post('/build/:commit', manualBuildRequestMiddleware, async (req, res, next)=>{
  await req.pi.queueBuild(req.body.commit)
  res.send("queued\n")
})

proxyApp.post('/build/:commit/:project', manualBuildRequestMiddleware, async (req, res, next)=>{
  await req.pi.queueBuildForProject(req.body.project, req.body.commit)
  res.send("queued\n")
})


http.createServer(proxyApp).listen(config.listenPort, '0.0.0.0', () => {
  console.log('Proxy server listening on '+config.listenPort);
});
