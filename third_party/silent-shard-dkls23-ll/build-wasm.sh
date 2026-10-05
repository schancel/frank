#!/usr/bin/env bash
# Builds the node and web WebAssembly packages of this fork into pkg/.
#
# Added by the Frank project (2026-10-04); not part of the upstream library.
#
# Needs: a Rust toolchain with the wasm32-unknown-unknown target, and
# wasm-bindgen-cli at exactly the version of the `wasm-bindgen` crate in
# Cargo.lock (0.2.92):
#
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.92 --locked
#
# In the Frank repository cargo must go through the cargo slot (one cargo at
# a time on the machine). Pass it as CARGO, for example:
#
#   CARGO="bash /path/to/frank/.agents/scripts/with-cargo-slot cargo" ./build-wasm.sh
#
# The cargo slot script chooses the target directory itself; this script
# asks cargo where the artefact landed instead of assuming ./target.
set -euo pipefail

cd "$(dirname "$0")"
CARGO="${CARGO:-cargo}"

want="$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/[^0-9.]/, ""); print; exit }' Cargo.lock)"
have="$(wasm-bindgen --version | awk '{ print $2 }')"
if [ "$want" != "$have" ]; then
  echo "wasm-bindgen-cli is $have but Cargo.lock needs $want" >&2
  exit 1
fi

wasm="$(
  $CARGO build -p dkls-wasm-ll --locked --release \
    --target wasm32-unknown-unknown --message-format=json-render-diagnostics |
    grep -o '"[^"]*dkls_wasm_ll\.wasm"' | tail -1 | tr -d '"'
)"
if [ ! -f "$wasm" ]; then
  echo "cargo did not report dkls_wasm_ll.wasm" >&2
  exit 1
fi

rm -rf pkg
wasm-bindgen --target nodejs --out-dir pkg/node --out-name dkls-wasm-ll-node "$wasm"
wasm-bindgen --target web --out-dir pkg/web --out-name dkls-wasm-ll-web "$wasm"

# The glue is generated code under the same licence as the library.
cp LICENSE.md pkg/LICENSE.md
(cd pkg && shasum -a 256 node/* web/* LICENSE.md > SHA256SUMS)
cat pkg/SHA256SUMS
