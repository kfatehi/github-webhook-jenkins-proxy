#!/bin/bash
set -euxo pipefail
cd /my/app
git reset --hard
git clean -dfx
git fetch origin
git checkout origin/master-next
git branch -D master-next
git checkout -b master-next
git pull --no-edit origin master-next
git pull --no-edit origin master
git push origin master-next
