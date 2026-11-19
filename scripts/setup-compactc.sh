#!/usr/bin/env bash
# Builds the compactc:0.36.1 Docker image from the official release binaries.
# Needed once on Windows (or anywhere without a native Compact 0.36.1 install).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.compact"
mkdir -p "$dir"
cd "$dir"
if [ ! -f compactc.bin ]; then
  curl -fsSL -o compactc.zip \
    https://github.com/midnightntwrk/compact/releases/download/compactc-v0.36.1/compactc_v0.36.1_x86_64-unknown-linux-musl.zip
  unzip -o -q compactc.zip
fi
# The key generator downloads public parameters over HTTPS: give the image a CA bundle.
for ca in /etc/ssl/certs/ca-certificates.crt /usr/ssl/certs/ca-bundle.crt /etc/ssl/cert.pem; do
  if [ -f "$ca" ]; then cp "$ca" ca-certificates.crt; break; fi
done
docker build -q -f "$root/docker/compactc.Dockerfile" -t compactc:0.36.1 .
docker run --rm compactc:0.36.1 --version
