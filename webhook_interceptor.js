const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const httpProxy = require('http-proxy');
var Queue = require('node-persistent-queue');
var q = new Queue('./db/status_reporter.sqlite', 1);
const { Octokit } = require("@octokit/rest");
const config = require('./config.json')
const axios = require('axios')
const hooks = require('./hooks');
const { response } = require('express');

const octokit = new Octokit({
    auth: config.githubAuth,
    userAgent: 'angryproxy v0.0.1',
})

const jenkins = require('jenkins')({
    baseUrl: 'http://'+config.jenkinsAuth+'@localhost:'+config.jenkinsPort,
    crumbIssuer: true
});

const proxy = httpProxy.createProxyServer({});
const proxyApp = express();
proxyApp.use(bodyParser.json({ limit: "50mb" }));


const jenkinsProjects = config.jenkinsProjects || [config.jenkinsProject]

async function queueBuildForProject(name, commitSha, branchSpecificerOverride, payload) {
  let parameters = {
    BRANCH_SPECIFIER: branchSpecificerOverride || commitSha
  }
  console.log('telling jenkins to build', name, parameters)
  await (new Promise((resolve, reject)=>{
    jenkins.job.build({
      name,
      parameters
    }, function(err, jenkinsItemNumber) {
      if (err) {
        if (err.statusCode === 303) {
          console.log("jenkins is already planning to work on that");
          resolve();
        } else {
          return reject(err);
        }
      }
      q.add({ jenkinsProjectName: name, jenkinsItemNumber, commitSha, payload });
      resolve();
    });
  }))
}

async function queueBuild(commitSha, branchSpecificerOverride, payload) {
    console.log('queue build for sha', commitSha)
    for (let name of jenkinsProjects) {
      await queueBuildForProject(name, commitSha, branchSpecificerOverride, payload);
    }
}

// This route is useful for submitting a build every so often...
// e.g.: build @ this commit every 20 mins:
// while true; curl localhost:8080/build/f7e4795dcbe97a6bf2c36c986184fe7de73af3b0; do sleep 1440; done;
proxyApp.get('/build/:commit', async (req, res, next)=>{
    try {
        await queueBuild(req.params.commit)
        res.send("queued\n")
    } catch(err) {
        next(err);
    }
})

proxyApp.get('/build/:commit/:project', async (req, res, next)=>{
    try {
        await queueBuildForProject(req.params.project, req.params.commit)
        res.send("queued\n")
    } catch(err) {
        next(err);
    }
})

proxyApp.use(async function(req, res){
    let githubEvent = req.headers['x-github-event'];

    if (!githubEvent) { 
        return proxy.web(req, res, {
            target: 'http://localhost:'+config.jenkinsPort
        }, function(err) {
            console.log("proxy error", err.message);
        });
    }

    if (githubEvent == "pull_request" && ( req.body.action == "synchronize" || req.body.action == "opened" )) {
        await queueBuild(req.body.pull_request.head.sha, null, req.body);
        return res.status(201).end("thanks for the PR, i will build it");
    } else if (githubEvent == "push" && config.refHooks && config.refHooks[req.body.ref]) {
        let hookDefinitions = config.refHooks[req.body.ref];
        if (hookDefinitions.buildBranch) {
          await queueBuild(req.body.head_commit.id, hookDefinitions.buildBranch, req.body);
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
              if (config.slackAlertEndpoint)
                axios.post(config.slackAlertEndpoint, slackNotifyHookError(req.body, err, stdout, stderr));
          }
        }
        return res.status(201).end("thanks for the push. hooks have executed.");
    } else if (githubEvent == "issue_comment" && req.body.action == "created" && req.body.issue.pull_request && req.body.comment.body.includes(config.triggerPhrase)) {
        let pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: config.repoOwner,
            repo: config.repoName,
            pull_number: req.body.issue.number
        })
        await queueBuild(pull.data.head.sha, null, req.body);
        return res.status(201).end("thanks for the issue comment, i will test it");
    } else {
        console.log("ignoring irrelevant webook delivery", req.headers['x-github-delivery']);
        return res.status(202).end("irrelevant webhook, ignoring");
    }
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
 
// "blocks" for 5 seconds before calling done (so we are more crash-resistant) and adds to queue
const reschedule = (task, extraData={}, retryIn=5000)=> {
    console.log("reschedule the block again");
    setTimeout(()=>{
        q.done();
        q.add(Object.assign({}, task.job, extraData))
    }, retryIn); 
}
q.on('next',task => {
    console.log('Process task ('+q.getLength()+' total) '+JSON.stringify(task));

    if (!task.job.jenkinsBuildId) {
        return jenkins.queue.item( task.job.jenkinsItemNumber,  function(err, data) {
            if (err) {
                console.error("Error on job build"+ err.message);
                q.done();
                return;
            }
    
            if (data.executable) {
                return reschedule(task, {
                    jenkinsBuildId: data.executable.number,
                    jenkinsBuildUrl: data.executable.url.replace('b1to1p1to1d.hopto.org', '10.170.148.199')
                }, 5000);
            } else if (data.blocked) {
                if (!task.job.reportedBlockedState) {
                    octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
                        owner: config.repoOwner,
                        repo: config.repoName,
                        sha: task.job.commitSha,
                        state: 'pending',
                        context: task.job.jenkinsProjectName,
                        description: `queued`,
                    }).then(()=>{
                        console.log("marked job as blocked");
                        return reschedule(task, { reportedBlockedState: true });
                    }).catch(err=>{
                        console.log(err.stack)
                        return reschedule(task, 1000);
                    })
                } else {
                    return reschedule(task, 1000);
                }
            } else if (data.cancelled) {
                console.log("job canceled from jenkins ui");
                return;
            } else {
                console.log("There is some other issue with this, read the output and handle it")
                console.log(data);
                return reschedule(task, 1000);
            }
        })
    }
    // slack api for attachment: https://api.slack.com/reference/messaging/attachments
    jenkins.build.get(task.job.jenkinsProjectName, task.job.jenkinsBuildId, function(err, data) {
        if (err) {
          console.error(err.stack)
          q.done();
          console.log("Marking as done due to error");
          return;
        }

        if (data.result == "FAILURE" || data.result == "ABORTED") {               
            return octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
                owner: config.repoOwner,
                repo: config.repoName,
                sha: task.job.commitSha,
                state: 'failure',
                context: task.job.jenkinsProjectName,
                description: `failed`,
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as failure");
              if (config.slackAlertEndpoint)
                axios.post(config.slackAlertEndpoint, slackNotify(
                    "Failed", task.job, "#ff0000"
                ));
                q.done();
            }).catch(err=>{
                console.log(err.stack)
                return reschedule(task);
            })
        } else if (data.result == "SUCCESS") {
            return octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
                owner: config.repoOwner,
                repo: config.repoName,
                sha: task.job.commitSha,
                state: 'success',
                context: task.job.jenkinsProjectName,
                description: `succeeded`,
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as success");
              if (config.slackAlertEndpoint)
                axios.post(config.slackAlertEndpoint, slackNotify(
                    "Succeeded", task.job, "#36a64f"
                ));
                q.done();
            }).catch(err=>{
                console.log(err.stack)
                return reschedule(task);
            })
        } else if (!task.job.reportedPendingState) {
            octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
                owner: config.repoOwner,
                repo: config.repoName,
                sha: task.job.commitSha,
                state: 'pending',
                context: task.job.jenkinsProjectName,
                description: `pending`,
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as pending");
              if (config.slackAlertEndpoint)
                axios.post(config.slackAlertEndpoint, slackNotify(
                    "Pending", task.job, ""
                ));
                return reschedule(task, { reportedPendingState: true });
            }).catch(err=>{
                console.log(err.stack)
                return reschedule(task);
            })
        } else {
            return reschedule(task);
        }
    });
});
 
q.on('stop',() => {
    console.log('Stopping queue') ;
});
 
q.on('close',() => {
    console.log('Closing SQLite DB') ;
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

function getSenderIfAny(payload) {
  let login = "";
  let avatar_url = "";
  if (payload && payload.sender) {
    login = payload.sender.login;
    avatar_url = payload.sender.avatar_url;
  }
  return { login, avatar_url }
}

function slackNotify(status, { jenkinsProjectName, jenkinsBuildUrl, payload}, color){
  let { login, avatar_url } = getSenderIfAny(payload);
  let content = ""
  if (!payload) {
    content = `job invoked manually.`
  } else if (payload.pull_request) {
    content = `job invoked by commit to <${payload.pull_request.html_url}|PR #${payload.pull_request.number}: ${payload.pull_request.title}>`
  } else if (payload.ref && payload.head_commit) {
    let branch = payload.ref.split('/').pop()
    let branch_url = `https://github.com/${config.repoOwner}/${config.repoName}/tree/${branch}`
    content = `job invoked by commit <${payload.head_commit.url}|${payload.head_commit.message}> to monitored branch <${branch_url}|${branch}>`
  } else if (payload.issue) { // Issue comment "jenkins test this"
    content = `job invoked by force on <${payload.issue.html_url}|PR #${payload.issue.number}: ${payload.issue.title}>`
  }

    return { "attachments": [
            {
                "mrkdwn_in": ["text"],
                "color": color,
                "author_name": login,
                "author_icon": avatar_url,
                "title": `[Jenkins] ${jenkinsProjectName} ${status}`,
                "title_link": jenkinsBuildUrl,
                "text": `${githubNameToSlackName(login)} ${jenkinsProjectName} ${status} for ${content}`,
                "footer": "jenkins",
                "footer_icon": "https://www.jenkins.io/images/logos/cowboy/cowboy.png"
            }
        ]
    }
}

function slackNotifyHookError(payload, err, stdout, stderr){
  let { login, avatar_url } = getSenderIfAny(payload);
  let attachments = [
    {
      "mrkdwn_in": ["text"],
      "color": "#ff0000",
      "author_name": login,
      "author_icon": avatar_url,
      "title": `[Jenkins] Hook Error`,
      "text": `${githubNameToSlackName(login)} Hook Error`,
      "footer": "jenkins",
      "footer_icon": "https://www.jenkins.io/images/logos/cowboy/cowboy.png"
    }
  ];
  if (err && err.stack && err.stack.length) {
    attachments.push({
      "title": `Stack Trace`,
      "text": err.stack
    })
  }
  if (stdout && stdout.length) {
    attachments.push({
      "title": "Standard output",
      "text": stdout
    })
  }
  if (stderr && stderr.length) {
    attachments.push({
      "title": "Standard error",
      "text": stderr
    })
  }
  return { attachments }
}

function githubNameToSlackName(name) {
  if (config && config.githubAccountSlackMemberMap) {
    let slackref = config.githubAccountSlackMemberMap[name];
    if (slackref)
      return slackref;
  }
  return name;
}
