const needle = require('needle');
const cors = require('cors');
const harmon = require('harmon')
const crypto = require('crypto');

module.exports = function(proxyApp, proxy, config, jenkins) {
  const playwrightLogo = 'https://trace.playwright.dev/playwright-logo.svg'

  function currentSecret() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const hour = now.getHours();
    const secret = `Secret-${year}-${month}-${day}-${hour}`;
    const hash = crypto.createHash('sha256').update(secret).digest('hex');
    return hash;
  }

  function encodeSecret(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }
  
  function generateDynamicSecret() {
    const currentHour = new Date().getHours();
    return encodeSecret(currentSecret() + currentHour.toString());
  }
  
  const artifactProxyCorsOptions = {
    origin: '*', // or specify allowed origins
    methods: 'GET', // specify allowed methods
    allowedHeaders: ['Content-Type'], // specify allowed headers
  };
  
  config.playwrightTraceLinkers.forEach(({project, path})=>{
    // Provide a proxy for URL-secret-authenticated public-access artifacts. Be sure to use SSL.
    proxyApp.get(`/artifactProxy/:secret/job/${project}/:build/artifact/*`, cors(artifactProxyCorsOptions), (req, res, next)=>{
      if (req.params?.secret === generateDynamicSecret()) {
        let { auth, hostname, port, protocol } = jenkins._opts.baseUrl
        let regex = new RegExp(`^/artifactProxy/${req.params.secret}`)
        let url = `${protocol}//${hostname}:${port}${req.path.replace(regex,'')}`
        let [username, password] = auth.split(":")
        needle.get(url, {username, password}).pipe(res)
      } else {
        res.status(403).end("403 Forbidden")
      }
    });  

    // Now, when authenticated users are exploring the artifacts, we will have rewritten
    // links to the "view" link to use the playwright trace viewer with the public link embedded
    proxyApp.get(`/job/${project}/:projectName/artifact/${path}/:directory`, (req, res) => {
      let secret = generateDynamicSecret()
      let alterations = []
      alterations.push({
        query: 'a[href$=".zip/*view*/"]',
        func: function (node) {
          let prevHref = node.getAttribute('href').replace('/*view*/', '')
          let origin = req.headers['x-forwarded-proto'] + '://' + req.headers['x-forwarded-host']
          let traceUrl = `${origin}/artifactProxy/${secret}${req.path}/${prevHref}`
          let newHref = `https://trace.playwright.dev?trace=${traceUrl}`
          node.createWriteStream().end(`<a href="${newHref}">
            <img src="${playwrightLogo}" width="16" height="16" style="vertical-align: middle; margin-right: 4px;"/>
            View in playwright trace viewer
          </a>`)
        }
      })
      harmon([], alterations)(req, res, (err) => {
        if (err) {
          console.error("error rewriting trace links", err.stack)
          return res.status(500).end("500 Internal Server Error")
        }
        proxy.web(req, res, { target: 'http://localhost:' + config.jenkinsPort });
      })
    });
  })
}