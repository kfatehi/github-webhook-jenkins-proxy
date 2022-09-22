const { Octokit } = require("@octokit/rest");
const axios = require('axios')

module.exports = (config, jenkins, q) => {
  const octokit = new Octokit({
    auth: config.githubAuth,
    userAgent: 'angryproxy v0.0.1',
  })

  const jenkinsProjects = config.jenkinsProjects || [config.jenkinsProject]

  async function queueBuildForProject(name, commitSha, branchSpecificerOverride, payload) {
    let testTarget = branchSpecificerOverride || commitSha;
    if (testTarget.length != 40) {
      // resolve the sha from the branch
      let commits = await pi.octokit.request('GET /repos/{owner}/{repo}/commits/{branch_name}', {
        owner: pi.config.repoOwner,
        repo: pi.config.repoName,
        branch_name: testTarget
      })
      testTarget = commits.data.sha
    }
    let parameters = { BRANCH_SPECIFIER: testTarget }
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
        q.add({ config, jenkinsProjectName: name, jenkinsItemNumber, commitSha, payload });
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

  // "blocks" for 5 seconds before calling done (so we are more crash-resistant) and adds to queue
  const reschedule = (task, extraData={}, retryIn=5000)=> {
    console.log("reschedule the block again");
    setTimeout(()=>{
      q.done();
      q.add(Object.assign({}, task.job, extraData))
    }, retryIn); 
  }

  function onNext(task) {
    console.log('Process task ('+q.getLength()+' total) '); //+JSON.stringify(task));

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
            jenkinsBuildUrl: data.executable.url
          }, 5000);
        } else if (data.blocked || data.why && data.why.startsWith("Waiting")) {
          if (!task.job.reportedBlockedState) {
            let params = {
              owner: config.repoOwner,
              repo: config.repoName,
              sha: task.job.commitSha,
              state: 'pending',
              context: task.job.jenkinsProjectName,
              description: `queued`,
            }
            console.log("Posting status", params)
            octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', params).then(()=>{
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
        if (task.job.commitSha.length !== 40) {
        }
        let params = {
          owner: config.repoOwner,
          repo: config.repoName,
          sha: task.job.commitSha,
          state: 'success',
          context: task.job.jenkinsProjectName,
          description: `succeeded`,
          target_url: task.job.jenkinsBuildUrl
        }
        console.log("Reporting success for task", params);
        return octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', params).then(()=>{
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
        let params = {
          owner: config.repoOwner,
          repo: config.repoName,
          sha: task.job.commitSha,
          state: 'pending',
          context: task.job.jenkinsProjectName,
          description: `pending`,
          target_url: task.job.jenkinsBuildUrl
        }
        console.log("Posting status", params)
        octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', params).then(()=>{
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
  }

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
      content = `job invoked by <${payload.head_commit.url}|commit> in monitored branch <${branch_url}|${branch}>: ${payload.head_commit.message}`
    } else if (payload.issue) { // Issue comment "jenkins test this"
      content = `job invoked by force on <${payload.issue.html_url}|PR #${payload.issue.number}: ${payload.issue.title}>`
    }

    return {
      "attachments": [
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

  return { octokit, config, onNext, queueBuild, queueBuildForProject, slackNotifyHookError }
}
