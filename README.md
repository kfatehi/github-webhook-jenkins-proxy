# github-webhook-jenkins-proxy

The Jenkins Plugin called [ghprb-plugin](https://github.com/jenkinsci/ghprb-plugin) was failing to build dangly PRs (branch of a branch).

It was difficult to work on so instead I created this project to intercept the webhooks and create the jobs using Jenkins API from Node.js.

The end-goal is to publish status checks, which this project does as well.

You configure one or more profiles in the config.json, each of which can launch one or more Jenkins jobs for a given repository's incoming github webhook.

The jobs results are sent to the Github statuses API at which point they coalesce into a final pull-request/commit status of pass or failure.

## Usage

Create config.json file (see below sections for more customization information) with at least one repository:

```json
{
  "listenPort": 8080,
  "jenkinsPort": 8081,
  "profiles": [{
    "githubAuth": "personal access token with full 'repo' scope",
    "jenkinsAuth": "youruser:yourapikey",
    "jenkinsProject": "name of jenkins job for incoming webhooks to queue",
    "repoOwner": "org name",
    "repoName": "repo name",
    "triggerPhrase": "a phrase to check for in pr comments to trigger a build",
  }]
}
```

### Shared Keys

Config keys that are common among the profiles can be placed in the global scope, for example, you can put the repoOwner once in the global scope and omit defining it in the profiles


## Install

Install npm packages:

```
npm install
```

Start the proxy server

`node webhook_interceptor.js`

Configure your github project's webhook setting:

* Payload URL: `https://<webserver>/ghprbhook/`
* Content type: application/json
* Select individual events: Issue comments, Pushes, Pull requests

### Multi-project configuration

Scope: profile

You may want to invoke multiple projects at once.

```
    "jenkinsProjects": ["myproject-rspec", "myproject-e2e"],
```

The results of these will be collected and added as checks to the pull request under test.

### Slack

Scope: profile

You can provide this: 

```
    "slackAlertEndpoint": "https://hooks.slack.com/services/..."
```

### Github->Slack User Mentions

Scope: global

You can configure slack user resolution and interpolation by providing a map like so:

```
  "githubAccountSlackMemberMap": {
    "kfatehi": "<@U01923F21LG>",
  }
```

You can get your slack "ID" from the users' slack profiles.

### Playwright Trace Linkers

Scope: global

Effectively makes these projects' artifacts (at that path) public via secret key. Be sure to use SSL.
You can use this in combination with Playwright's trace writing feature which creates a series of folders with zip files in them.
Enter the parent directory of those folders in the `path` key relative to the workspace.

```
"playwrightTraceLinkers": [{
  "project": "my-playwright-project",
  "path": "my-traces-dir"
}]
```

Now browse the artifacts page and enter the folders with the traces in them.
You will see a link to playwright's trace viewer next to each zip.
The links that are generated are using a 1-hour TTL secret for the public links to artifacts.

### Hooks

Scope: profile

Hooks can be used to perform additional behavior depending on the ref on a push event.

This is useful if you want pushes to "main" or "master" to be built. They are not built by default because the webhook payload is different from pull requests, so they are detected and handled separately with this hook concept.

#### buildBranch

If you want to run all jenkinsProjects as usual, then defining the "buildBranch" key to match the "refs/heads/[branch]" will suffice:

```
"refHooks": {
  "refs/heads/master": {
    "buildBranch": "master",
  }
}
```

##### extraJenkinsProjects Hook

Combine buildBranch with extraJenkinsProjects to include any extra jenkins projects that are NOT defined in the profile's jenkinsProjects but which should be included for this branch.

```
"refHooks": {
  "refs/heads/master": {
    "buildBranch": "master",
    "extraJenkinsProjects": ["master-only-project"]
  }
}
```

#### exec

Use exec for custom scripts. Failures are reported to slack if endpoint is defined. Jenkins is bypassed/irrelevant in this case, however the other hooks will still fire and behave as expected if defined.

```
"refs/heads/master": {
  "exec": {
    "command": "cd /repo && some crazy merge push automation"
  }
}
```

## API

### POST /build-all

Build all projects that match the given repository at the given commit

`curl -XPOST -H"Content-Type:application/json" -d'{"repo":"my/proj", "commit":"d0d353e1df3e97e234b93c381b4f55d1205e23e5"}' https://jenkins.site/build-all`

### POST /build-one

Build a single project that matches the given repository at the given commit

`curl -XPOST -H"Content-Type:application/json" -d'{"project":"e2e", "repo":"my/proj", "commit":"d0d353e1df3e97e234b93c381b4f55d1205e23e5"}' https://jenkins.site/build-one`


### POST /retry-one

Retry a single project based on a provided build number

`curl -XPOST -H"Content-Type:application/json" -d'{"repo":"my/proj", "project":"e2e", "build":"552"}' https://jenkins.site/retry-one`

## Pages

### GET /retry/:repoOrg/:repoName/:projectName/:buildNumber

Provides a link to retry the specific build.

#### Github Check Retry Userscript

The following userscript can be used to put a retry button on failed checks.

This will take you to the aforementioned page within the proxy from which a retry of that specific check can be requested.

```
JENKINS_SITE="https://jenkins.site"
function check() {
  document.querySelectorAll('.merge-status-item [title=failed]').forEach(a=>{
    if (!a.querySelector('a')) {
      let detailsURL = a.parentElement.querySelector('a.status-actions').href;
      let detailParts = detailsURL.split('/').filter(b=>b!=='')
      let [projectName, buildNumber] = detailParts.slice(detailParts.length-2, detailParts.length)
      let [repoOrg, repoName] = window.location.pathname.split('/').filter(b=>b!=='').slice(0,2)
      let link = document.createElement("a")
      link.target = "_blank"
      link.innerText = "Retry"
      link.href = `${JENKINS_SITE}/retry/${repoOrg}/${repoName}/${projectName}/${buildNumber}`
      a.appendChild(link)
    }
  })
}

setInterval(check, 1000)
```
