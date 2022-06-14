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
  "profiles": [
    "githubAuth": "personal access token with full 'repo' scope",
    "jenkinsAuth": "youruser:yourapikey",
    "jenkinsProject": "name of jenkins job for incoming webhooks to queue",
    "repoOwner": "org name",
    "repoName": "repo name",
    "triggerPhrase": "a phrase to check for in pr comments to trigger a build",
  ]
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

### Hooks

Scope: profile

Hooks can be used to perform additional behavior depending on the ref on a push event. For example:

```
  "refHooks": {
    "refs/heads/foo": {
      "buildBranch": "foo",
    },
    "refs/heads/master": {
      "buildBranch": false,
      "exec": {
        "command": "cd /repo && some crazy merge push automation"
      }
    }
  }
```

This is useful if you want pushes to "main" or "master" to be built. They are not built by default. If this is all you want, defining the "buildBranch" key to match the "refs/heads/[branch]" will suffice. Use exec for more fancy behavior. Failures are reported to slack if endpoint is defined.

## API

* GET /build/:commit will invoke all jenkins projects defined for your repo

For example, to queue a build periodically, you can do something like this:

```
while true; curl localhost:8080/build/3e5c62be177a2ca1489f383ee258031ee458c3fa; do sleep 1400; done;
```

This also works in your browser to quickly queue up some specific commit hash.

* GET /build/:commit/:project will invoke only that specified jenkins :project for your repo
