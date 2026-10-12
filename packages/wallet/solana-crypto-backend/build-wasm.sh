#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cargo_bin="${SOLANA_CARGO_BIN:-cargo}"
bindgen_bin="${SOLANA_WASM_BINDGEN:-wasm-bindgen}"
test "$("$bindgen_bin" --version)" = 'wasm-bindgen 0.2.129'
"$cargo_bin" build --offline --locked --release --target wasm32-unknown-unknown
artifact="${CARGO_TARGET_DIR:-target}/wasm32-unknown-unknown/release/frank_experimental_solana_crypto_backend.wasm"
"$bindgen_bin" --target web --out-dir generated --out-name backend "$artifact"
shasum -a 256 generated/backend.js generated/backend_bg.wasm
