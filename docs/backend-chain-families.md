# Relay chain-family ownership

The relay uses canonical network identifiers from `docs/protocol/chains/v1.json`.
A network name is configuration, not an implementation family. Monad is one EVM
network alongside the other configured EVM networks.

Shared EVM implementation modules use `evm_`/`Evm` names: RPC, WebSocket heads,
transaction decoding, payment checks, mailbox authentication, profiles and topic
payment verification. These modules must not be labelled neutral merely because
they can run against another EVM network. Bitcoin-family and Solana adapters are
peers, not specializations of an EVM owner.

The current EVM canonical DM handler is `http/evm_direct_messages.rs`; its store is
`store/evm_direct_messages.rs`. Source renaming does not make their EVM address,
native-chain-ID or payment semantics support Lotus. Pure request framing and the
family payment boundary are the immediate refactor successor; no empty Lotus
adapter or universal payment framework is introduced by the naming predecessor.

## Configuration

The required mailbox section is `[registry.evm_mailbox]`, with the same `enabled`
and `min_value_wei` behavior. The metadata proof-of-payment endpoint uses
`[registry.pop] evm_rpc_url`. Retired `monad_mailbox` and `monad_rpc_url` fields are
rejected, including files containing both old and new fields. Update the operator
configuration explicitly; there is no alias, implicit default, data migration or
wallet reset. Checked-in configuration writers and fixtures use the new names.

## Wire and storage stability

This document maps current implementation owners; it does not allocate or amend a
protocol. The pinned canonical CBOR specification retains historical source-path
references unchanged. Use this owner map for current implementation paths.

Public URL paths, signing-domain bytes, exact message encodings, key derivation,
canonical `monad-*` identifiers, persisted store extensions/subspaces/keys and
historical protobuf DTO names remain unchanged. Historical ErrorMeta variant identifiers
also remain where their names generate an externally visible error code; implementation
type names change, but those error codes do not. The retained protobuf names are
wire/schema identifiers, not Rust implementation owners. Only their source file
paths changed to `evm_message.proto` and `evm_profile.proto`; message packages,
fields and tags did not change.

Protobuf inventory source: `docs/protocol/check-protobuf-inventory.sh` and `.proto`
files. Regenerate `docs/protocol/protobuf-inventory.snapshot` with
`./docs/protocol/check-protobuf-inventory.sh --write`; verify with `--check`, using
its required protoc version. Generated binding/source checks retain the existing
commands; do not hand-edit the snapshot or generated bindings.

Run `python3 backend/cashweb/check-family-names.py` to reject network-labelled
relay source modules/types and retired config owners. Backend CI runs this guard.
It deliberately permits actual network identities and frozen wire/persistence
identifiers; it is not proof that every EVM owner is chain-neutral.
