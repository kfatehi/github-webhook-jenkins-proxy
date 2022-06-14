module.exports = ({getPi, getPiByFullName}) => (req, res, next) => {
  console.log(req.body)
  const pi = getPi(req.body.repoOwner,req.body.repoName) || getPiByFullName(req.body.repo);
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
