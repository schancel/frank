echo 'Generating Wallet protobuffers...'
# NOTE: unlike this repo's other generate_protobufs.sh scripts, this one does NOT use the bundled
# ../../../node_modules/protoc/protoc/bin/protoc binary -- that npm package (protoc v1.0.4) bundles
# a 32-bit (i386) binary that cannot execute at all on a modern host (arm64 or x86_64). Use the
# system protoc instead (`brew install protobuf protoc-gen-js`), with protoc-gen-ts resolved from
# this package's own node_modules/.bin via PATH.
PATH="$(cd "$(dirname "$0")/../.." && pwd)/node_modules/.bin:$PATH" \
  protoc \
  --proto_path=./proto \
  --js_out=import_style=commonjs,binary:. \
  --ts_out=. \
  ./proto/*.proto
