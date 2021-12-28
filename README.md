# angry jenkins mitm proxy

ghprplugin is broken on dangly PRs (branch of a branch) and is not easy to work on
so to bypass let us intercept webhooks and create the jobs ourself
f course the point is to publish status check, so lets do all that too

## usage

you need to create a config.json like so

```json
{
    "githubAuth": "personal access token with full 'repo' scope",
    "jenkinsAuth": "youruser:yourapikey",
    "jenkinsProject": "name of jenkins project",
    "repoOwner": "org name",
    "repoName": "repo name",
    "triggerPhrase": "a phrase to check for in pr comments to trigger a build",
    "listenPort": 8080,
    "jenkinsPort": 8081,
    "slackAlertEndpoint": "https://hooks.slack.com/services/..."
}
```

The slack is optional. There is also this concept of hooks that can be used to change behavior depending on the ref on a push event. For example:

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

then run it

`node webhook_interceptor.js`

## periodic builds

There is an endpoint that you can use in a loop like this to hammer your jenkins with builds using a commit hash:

```
while true; curl localhost:8080/build/3e5c62be177a2ca1489f383ee258031ee458c3fa; do sleep 1400; done;
```
