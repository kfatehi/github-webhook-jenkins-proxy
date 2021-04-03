# angry jenkins mitm proxy

ghprplugin is broken on dangly PRs (branch of a branch) and is not easy to work on
so to bypass let us intercept webhooks and create the jobs ourself
f course the point is to publish status check, so lets do all that too

## usage

you need to create a config.json like so

```json
{
    "githubAuth": "personal access token with repo:status perms",
    "jenkinsAuth": "youruser:yourapikey",
    "repoOwner": "org name",
    "repoName": "repo name",
    "listenPort": 8080,
    "jenkinsPort": 8081
}
```

then run it

`node webhook_interceptor.js`