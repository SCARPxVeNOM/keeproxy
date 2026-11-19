#!/usr/bin/env bash
# Runs the pinned Compact compiler (0.36.1) in Docker, so it works on Windows
# too. Usage: scripts/compactc.sh [--skip-zk] contract/proxy.compact contract/managed/proxy
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if command -v compactc >/dev/null 2>&1 && compactc --version | grep -q '^0.36.1'; then
  cd "$root" && exec compactc "$@"
fi
MSYS_NO_PATHCONV=1 exec docker run --rm -v "$root:/work" -v keeproxy-zk-cache:/root compactc:0.36.1 "$@"
