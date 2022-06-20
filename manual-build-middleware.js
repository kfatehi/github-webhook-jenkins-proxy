module.exports = ({getPi, getPiByFullName}) => (req, res, next) => {
  console.log(req.body)
  const pi = getPi(req.body.repoOwner,req.body.repoName) || getPiByFullName(req.body.repo);
  if (!pi) {
    res.send("must provide a matching repoOwner and repoName combination")
    return;
  }
  try {
    req.pi = pi;
    next();
  } catch(err) {
    next(err);
  }
}
