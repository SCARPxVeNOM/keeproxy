#!/usr/bin/env bash
# Assembles .deploy/viewer: everything keeproxy-viewer needs and nothing else.
# The compiled contract JS (contract/managed/proxy/contract) is gitignored, so
# it is copied in here, with the public proving artifacts the viewer serves
# to browsers under /zk/ (about 200 MB of keys).
#
#   npm run compile:fast && bash scripts/stage-viewer.sh && cd .deploy/viewer && railway up
set -euo pipefail
cd "$(dirname "$0")/.."
test -f contract/managed/proxy/keys/enroll.prover || { echo "run npm run compile first (with keys)" >&2; exit 1; }
bash scripts/fetch-params.sh
out=.deploy/viewer
mkdir -p "$out" && find "$out" -mindepth 1 -delete && mkdir -p "$out/web" "$out/server" "$out/contract/managed/proxy"
cp deploy/viewer/Dockerfile deploy/viewer/railway.json package.json package-lock.json tsconfig.json "$out/"
cp web/package.json "$out/web/"
cp -r src "$out/src"
rm -rf "$out/src/test"
cp server/viewer.ts "$out/server/"
cp contract/*.ts "$out/contract/"
for d in contract compiler keys zkir params; do cp -r "contract/managed/proxy/$d" "$out/contract/managed/proxy/$d"; done
echo "staged $(du -sh "$out" | cut -f1) in $out"
