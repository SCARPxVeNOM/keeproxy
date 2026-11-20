#!/usr/bin/env bash
# Downloads the public proving parameters Keeproxy's circuits use (k = 9..16)
# into contract/managed/proxy/params, checking each against the SHA-256 the
# Midnight wallet SDK pins (@midnightntwrk/wallet-sdk-prover-client). The
# viewer serves them at /zk/params/ for browsers that prove in the page, since
# srs.midnight.network does not allow cross-origin reads.
set -euo pipefail
cd "$(dirname "$0")/.."
out=contract/managed/proxy/params
mkdir -p "$out"
while read -r k sha; do
  f="$out/bls_midnight_2p$k"
  if [ ! -f "$f" ] || [ "$(sha256sum "$f" | cut -d' ' -f1)" != "$sha" ]; then
    curl -fsSL "https://srs.midnight.network/bls_midnight_2p$k" -o "$f.part"
    [ "$(sha256sum "$f.part" | cut -d' ' -f1)" = "$sha" ] || { echo "hash mismatch for k=$k" >&2; rm -f "$f.part"; exit 1; }
    mv "$f.part" "$f"
  fi
done <<'LIST'
9 b9009f1098bcefffec3c461ab3a5e3a17f7e5599f0f08c70fcdc55a89227bcbd
10 46b2290933cbed4c378889e4ba971f1a92888331ffb09466acd4ff61a1e2cb42
11 9901589d7956ff58be0d85569b2f455b77b58c3758026ffb5bbe4807000b96d1
12 ef08eb3fcf62df8f72c515cffa027e681808b530cb016eea104115545ef6d5c8
13 d3324910969c4cc54143b8045b649e5c3a4bd5fb7b8f85fe1b770f640ce1c803
14 fc253016885ec830e97808c9ec920bb5cab5c21af590380a6cb5eb0538e2b244
15 724c7c3d779148bb113c7ee9c034b2f27db16e6bdf315fde90105a9bad00b1de
16 09c877216d6589b370263e18af40a030a901b41a7a7c37ef58c9901db41f05c6
LIST
echo "params ready in $out ($(du -sh "$out" | cut -f1))"
