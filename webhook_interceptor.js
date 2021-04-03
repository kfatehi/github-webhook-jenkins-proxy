const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const httpProxy = require('http-proxy');
var Queue = require('node-persistent-queue') ;
var q = new Queue('./db/status_reporter.sqlite', 1) ;
const { Octokit } = require("@octokit/rest");
const config = require('./config.json')

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
proxyApp.use(bodyParser.json());

function shouldTest(githubEvent, {pull_request, comment}) {
    return (
        // it's a new pull request
        githubEvent == "pull_request"
        ||
        // it's a push to an existing pull request
        (githubEvent == "push" && req.body.pull_request)
        ||
        // it's a comment on a pull request saying to test it
        // in this case we need to fetch the sha
        ( 
            githubEvent == "issue_comment"
            && req.body.pull_request
            && /test this/.test(comment.body)
        )
    )
}

async function queueBuild(commitSha) {
    console.log('queue build for sha', commitSha)
    return new Promise((resolve, reject)=>{
        jenkins.job.build({
            name: config.jenkinsProject,
            parameters: {
                BRANCH_SPECIFIER: commitSha
            }
        }, function(err, jenkinsItemNumber) {
            if (err) return reject(err);
            q.add({ jenkinsItemNumber, commitSha });
            resolve();
        });
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

    if (githubEvent == "pull_request" && ( req.body.action == "synchronize" || req.body.action == "opened" )) {
        await queueBuild(req.body.pull_request.head.sha);
        return res.status(201).end();
    } else if (githubEvent == "issue_comment" && req.body.action == "created" && req.body.issue.pull_request && req.body.comment.body.includes(config.triggerPhrase)) {
        let pull = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
            owner: config.repoOwner,
            repo: config.repoName,
            pull_number: req.body.issue.number
        })
        await queueBuild(pull.data.head.sha);
        return res.status(200).end();
    } else {
        console.log("ignoring irrelevant webook delivery", req.headers['x-github-delivery']);
        return res.status(400).end();
    }
});

q.on('open',() => {
    console.log('Opening SQLite DB') ;
    console.log('Queue contains '+q.getLength()+' job/s') ;
}) ;
 
q.on('add',task => {
    console.log('Adding task: '+JSON.stringify(task)) ;
    console.log('Queue contains '+q.getLength()+' job/s') ;
}) ;
 
q.on('start',() => {
    console.log('Starting queue') ;
}) ;
 
// "blocks" for 5 seconds before calling done (so we are more crash-resistant) and adds to queue
const reschedule = (task, extraData={}, retryIn=5000)=> {
    setTimeout(()=>{
        q.done();
        q.add(Object.assign({}, task.job, extraData))
    }, retryIn); 
}
q.on('next',task => {
    console.log('Queue contains '+q.getLength()+' job/s') ;
    console.log('Process task: ') ;
    console.log(JSON.stringify(task)) ;

    if (!task.job.jenkinsBuildId) {
        return jenkins.queue.item( task.job.jenkinsItemNumber,  function(err, data) {
            if (err) throw err;
    
            if (data.executable) {
                return reschedule(task, {
                    jenkinsBuildId: data.executable.number,
                    jenkinsBuildUrl: data.executable.url.replace('b1to1p1to1d.hopto.org', '10.244.187.148')
                }, 5000);
            } else {
                return reschedule(task, 1000);
            }
        })
    }

    jenkins.build.get('bpd-web', task.job.jenkinsBuildId, function(err, data) {
        if (err) throw err;

        console.log(task.job);
        
        if (data.result == "FAILURE") {               
            return octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
                owner: config.repoOwner,
                repo: config.repoName,
                sha: task.job.commitSha,
                state: 'failure',
                description: "Build has failed",
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as failure");
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
                description: "Build succeeded",
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as success");
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
                description: "Build is pending",
                target_url: task.job.jenkinsBuildUrl
            }).then(()=>{
                console.log("marked job as pending");
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

q.open()
.then(() => {
    q.start();
})
.catch(err => {
    console.log('Error occurred:') ;
    console.log(err.stack);
    process.exit(1);
}) ;

http.createServer(proxyApp).listen(config.listenPort, '0.0.0.0', () => {
	console.log('Proxy server listening on '+config.listenPort);
});