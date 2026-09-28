#!/usr/bin/env bash
set -euo pipefail

echo 'Generating BIP70 protobuf bindings...'
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PATH="$REPO_ROOT/node_modules/.bin:$PATH" protoc \
  --proto_path=./proto \
  --js_out=import_style=commonjs,binary:. \
  --ts_out=. \
  ./proto/*.proto
