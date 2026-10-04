#!/usr/bin/env bash
# Builds the WebAssembly kernel and copies it next to this script.
# Cargo runs through the repository's cargo slot (one cargo at a time), which
# also chooses the target directory, so the artifact path is read from cargo.
set -euo pipefail
cd "$(dirname "$0")"
slot="$(git rev-parse --show-toplevel)/.agents/scripts/with-cargo-slot"
artifact="$(
  bash "$slot" cargo build --release --locked --target wasm32-unknown-unknown \
    --message-format=json |
    python3 -c '
import json, sys
for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if message.get("reason") == "compiler-artifact" and message["target"]["name"] == "dkls_kernel":
        for name in message["filenames"]:
            if name.endswith(".wasm"):
                print(name)
'
)"
test -n "$artifact"
cp "$artifact" dkls_kernel.wasm
shasum -a 256 dkls_kernel.wasm
wc -c dkls_kernel.wasm
