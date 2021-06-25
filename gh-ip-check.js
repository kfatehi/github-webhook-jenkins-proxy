const http = require('http');
const express = require('express');
const { Octokit } = require("@octokit/rest");
const config = require('./config.json')

const octokit = new Octokit({
    auth: config.githubAuth,
    userAgent: 'angryproxy v0.0.1',
});

const publicIp = require('public-ip');

(async () => {
	let currentIp = await publicIp.v4();

        let hook = await octokit.request('GET /repos/{owner}/{repo}/hooks/{hook}', {
            owner: config.repoOwner,
            repo: config.repoName,
            hook: 7892826
        })

	let configuredIp = new URL(hook.data.config.url).hostname;

	if (configuredIp == currentIp) {
		console.log("ip was the same");
	} else {
		console.log("ip changed from "+configuredIp+" to "+currentIp);
		await octokit.request('PATCH /repos/{owner}/{repo}/hooks/{hook}', {
			owner: config.repoOwner,
			repo: config.repoName,
			hook: 7892826,
			config: {
				content_type: 'json',
				insecure_ssl: '0',
				url: 'http://'+currentIp+':8080/ghprbhook/'
			}
		})
		console.log("github was updated");
	}
})();
