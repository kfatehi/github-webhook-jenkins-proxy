# github-webhook-jenkins-proxy

The Jenkins Plugin called [ghprb-plugin](https://github.com/jenkinsci/ghprb-plugin) was failing to build dangly PRs (branch of a branch).
It was difficult to work on so instead I created this project to intercept the webhooks and create the jobs using Jenkins API from Node.js.
The end-goal is to publish status checks, which this project does as well. It supports one or more Jenkins jobs (misnomered as "project" in our config below) but only a single webhook input at this time. These jobs results are sent to the Github statuses API at which point they coalesce into a final pull-request/commit status of pass or failure.

## Usage

Create config.json file (see below sections for more customization information).

```json
{
    "githubAuth": "personal access token with full 'repo' scope",
    "jenkinsAuth": "youruser:yourapikey",
    "jenkinsProject": "name of jenkins job for incoming webhooks to queue",
    "repoOwner": "org name",
    "repoName": "repo name",
    "triggerPhrase": "a phrase to check for in pr comments to trigger a build",
    "listenPort": 8080,
    "jenkinsPort": 8081
}
```

Create a directory for the database

```
mkdir db
```

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

## Multi-project configuration

You may want to invoke multiple projects at once.

```
    "jenkinsProjects": ["myproject-rspec", "myproject-e2e"],
```

The results of these will be collected and added as checks to the pull request under test.

## Slack

You can provide this: 

```
    "slackAlertEndpoint": "https://hooks.slack.com/services/..."
```

### Github->Slack User Mentions

You can configure slack user resolution and interpolation by providing a map like so:

```
  "githubAccountSlackMemberMap": {
    "kfatehi": "<@U01923F21LG>",
  }
```

You can get your slack "ID" from the users' slack profiles.

## Hooks

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

## API

* GET /build/:commit will invoke all jenkins projects defined for your repo

For example, to queue a build periodically, you can do something like this:

```
while true; curl localhost:8080/build/3e5c62be177a2ca1489f383ee258031ee458c3fa; do sleep 1400; done;
```

This also works in your browser to quickly queue up some specific commit hash.

* GET /build/:commit/:project will invoke only that specified jenkins :project for your repo
