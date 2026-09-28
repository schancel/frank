#!/usr/bin/env bash
set -euo pipefail

echo 'Generating Relay protobuf bindings...'
# The old npm `protoc` package bundles an i386 binary that cannot run on current macOS. Use the
# system compiler and JS plugin, while resolving this repo's ts-protoc-gen executable explicitly.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATH="$REPO_ROOT/node_modules/.bin:$PATH" protoc \
  --proto_path=./proto \
  --js_out=import_style=commonjs,binary:. \
  --ts_out=. \
  ./proto/*.proto
