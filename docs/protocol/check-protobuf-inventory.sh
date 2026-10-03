#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
cd "$repo"

snapshot=${PROTO_INVENTORY_SNAPSHOT:-docs/protocol/protobuf-inventory.snapshot}
mode=${1:---check}
if [[ "$mode" != "--check" && "$mode" != "--write" ]]; then
  echo "usage: $0 [--check|--write]" >&2
  exit 2
fi
command -v protoc >/dev/null 2>&1 || {
  echo "protoc is required to check the protobuf inventory" >&2
  exit 2
}
protoc_version=$(protoc --version)
if [[ "$protoc_version" != "libprotoc 36.2" ]]; then
  echo "protobuf inventory requires libprotoc 36.2, found: $protoc_version" >&2
  exit 2
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
actual="$tmp/protobuf-inventory.snapshot"

classify() {
  case "$1" in
    backend/bitcoinsuite/bitcoinsuite-chronik-client/proto/chronik.proto)
      owner="Chronik client dependency" family="Chronik upstream RPC" disposition="third-party/non-CashWeb" group="chronik-upstream" ;;
    backend/cashweb/cashweb-http-utils/proto/http.proto)
      owner="CashWeb HTTP utilities" family="legacy HTTP error" disposition="transport-only" group="http-error" ;;
    backend/cashweb/cashweb-payload/proto/payload.proto)
      owner="cashweb-payload verifier" family="Lotus signed payload and burn evidence" disposition="retained constrained legacy reader" group="lotus-signed-payload-backend" ;;
    backend/cashweb/cashweb-registry/proto/broadcast.proto)
      owner="cashweb-registry Lotus topics" family="Lotus broadcast storage" disposition="retained constrained legacy reader" group="lotus-broadcast-backend" ;;
    backend/cashweb/cashweb-registry/proto/monad_message.proto)
      owner="cashweb-registry Monad mailbox" family="Monad stamped direct message" disposition="retained constrained legacy reader" group="monad-message-mirror" ;;
    backend/cashweb/cashweb-registry/proto/monad_profile.proto)
      owner="cashweb-registry Monad profiles" family="Monad profile discovery" disposition="retained constrained legacy reader" group="monad-profile-backend" ;;
    backend/cashweb/cashweb-registry/proto/registry.proto)
      owner="cashweb-registry legacy directory" family="Lotus registry and federation transport" disposition="retained reader plus transport-only responses" group="lotus-registry-backend" ;;
    backend/cashweb/cashweb-registry/proto/topic_message.proto)
      owner="cashweb-registry Monad topics" family="Monad topic post vote and discovery" disposition="retained constrained legacy reader" group="monad-topic-mirror" ;;
    packages/cashweb/bip70/proto/paymentrequest.proto)
      owner="CashWeb BIP70/POP client" family="legacy admission payment and bearer token" disposition="retained constrained legacy reader" group="bip70-pop" ;;
    packages/cashweb/registry/proto/broadcast.proto)
      owner="CashWeb registry client" family="Lotus broadcast application data" disposition="retained constrained legacy reader" group="lotus-broadcast-client" ;;
    packages/cashweb/registry/proto/metadata.proto)
      owner="CashWeb registry client" family="Lotus registry and Monad profile transport" disposition="retained reader plus transport-only responses" group="lotus-registry-client" ;;
    packages/cashweb/relay/proto/filters.proto)
      owner="CashWeb relay client" family="legacy inbox filters" disposition="retained constrained legacy reader" group="relay-filters" ;;
    packages/cashweb/relay/proto/monad_message.proto)
      owner="CashWeb relay client" family="Monad stamped direct message" disposition="retained constrained legacy reader" group="monad-message-mirror" ;;
    packages/cashweb/relay/proto/p2pkh.proto)
      owner="CashWeb relay client" family="legacy P2PKH transport" disposition="transport-only" group="relay-p2pkh" ;;
    packages/cashweb/relay/proto/relay.proto)
      owner="CashWeb relay client" family="legacy relay profile message and pages" disposition="retained constrained legacy reader" group="relay-core" ;;
    packages/cashweb/relay/proto/stealth.proto)
      owner="CashWeb relay client" family="legacy stealth transport" disposition="transport-only" group="relay-stealth" ;;
    packages/cashweb/signed_payload/proto/payload.proto)
      owner="CashWeb signed-payload client" family="Lotus signed payload and burn evidence" disposition="retained constrained legacy reader" group="lotus-signed-payload-client" ;;
    packages/wallet/proto/topic_message.proto)
      owner="wallet Monad topics" family="Monad topic post vote and discovery" disposition="retained constrained legacy reader" group="monad-topic-mirror" ;;
    *)
      echo "unclassified tracked protobuf source: $1" >&2
      exit 1 ;;
  esac
}

binding_source() {
  case "$1" in
    packages/cashweb/bip70/paymentrequest_pb.*) binding_proto="packages/cashweb/bip70/proto/paymentrequest.proto" binding_generator="packages/cashweb/bip70/generate_protobufs.sh" ;;
    packages/cashweb/registry/broadcast_pb.*) binding_proto="packages/cashweb/registry/proto/broadcast.proto" binding_generator="packages/cashweb/registry/generate_protobufs.sh" ;;
    packages/cashweb/registry/metadata_pb.*) binding_proto="packages/cashweb/registry/proto/metadata.proto" binding_generator="packages/cashweb/registry/generate_protobufs.sh" ;;
    packages/cashweb/relay/filters_pb.*) binding_proto="packages/cashweb/relay/proto/filters.proto" binding_generator="packages/cashweb/relay/generate_protobufs.sh" ;;
    packages/cashweb/relay/monad_message_pb.*) binding_proto="packages/cashweb/relay/proto/monad_message.proto" binding_generator="packages/cashweb/relay/generate_protobufs.sh" ;;
    packages/cashweb/relay/p2pkh_pb.*) binding_proto="packages/cashweb/relay/proto/p2pkh.proto" binding_generator="packages/cashweb/relay/generate_protobufs.sh" ;;
    packages/cashweb/relay/relay_pb.*) binding_proto="packages/cashweb/relay/proto/relay.proto" binding_generator="packages/cashweb/relay/generate_protobufs.sh" ;;
    packages/cashweb/relay/stealth_pb.*) binding_proto="packages/cashweb/relay/proto/stealth.proto" binding_generator="packages/cashweb/relay/generate_protobufs.sh" ;;
    packages/cashweb/signed_payload/payload_pb.*) binding_proto="packages/cashweb/signed_payload/proto/payload.proto" binding_generator="packages/cashweb/signed_payload/generate_protobufs.sh" ;;
    packages/wallet/topic_message_pb.*) binding_proto="packages/wallet/proto/topic_message.proto" binding_generator="packages/wallet/generate_protobufs.sh" ;;
    *)
      echo "unclassified tracked generated protobuf binding: $1" >&2
      exit 1 ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

{
  echo "# Generated by docs/protocol/check-protobuf-inventory.sh; do not edit."
  echo "# Every descriptor message, enum, and field inherits its source classification."
  echo "descriptor_protoc: $protoc_version"
  while IFS= read -r source; do
    classify "$source"
    descriptor="$tmp/descriptor.pb"
    diagnostics="$tmp/protoc.stderr"
    if ! protoc \
      -I "$repo" \
      -I "$repo/backend/cashweb/cashweb-payload/proto" \
      -I "$repo/backend/cashweb/cashweb-registry/proto" \
      --descriptor_set_out="$descriptor" \
      "$source" 2>"$diagnostics"; then
      cat "$diagnostics" >&2
      exit 1
    fi
    printf 'source: %s\nowner: %s\nfamily: %s\ndisposition: %s\nexplicit_source_group: %s\n' \
      "$source" "$owner" "$family" "$disposition" "$group"
    echo "descriptor: |"
    protoc --decode=google.protobuf.FileDescriptorSet google/protobuf/descriptor.proto \
      < "$descriptor" | sed 's/^/  /'
    echo "---"
  done < <(git ls-files '*.proto' | LC_ALL=C sort)
  echo "# Generated-binding versions are historically unknown; hashes detect drift only."
  while IFS= read -r binding; do
    binding_source "$binding"
    printf 'generated_binding: %s\nsource_proto: %s\ngenerator_script: %s\n' \
      "$binding" "$binding_proto" "$binding_generator"
    echo "historical_generator_versions: unknown"
    printf 'sha256: %s\n---\n' "$(sha256_file "$binding")"
  done < <(git ls-files -- '*_pb.js' '*_pb.d.ts' | LC_ALL=C sort)
} > "$actual"

if [[ "$mode" == "--write" ]]; then
  cp "$actual" "$snapshot"
  echo "wrote $snapshot"
  exit 0
fi

if ! cmp -s "$actual" "$snapshot"; then
  echo "protobuf inventory is stale or incomplete; run $0 --write and review the diff" >&2
  diff -u "$snapshot" "$actual" >&2 || true
  exit 1
fi
echo "protobuf inventory is current"
