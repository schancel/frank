# frank-cbor

Rust codec for Frank deterministic CBOR, version 1. The human semantics and
status front door is `docs/CASHWEB-PROTOCOL-SPEC.md`; the current frozen
encoding/validation profile is `docs/protocol/cbor/`, whose CDDL owns exact
structure and whose vectors are executable proof. The TypeScript reference is `@frank/codec`
(`packages/frank-codec`). The two codecs meet at
`docs/protocol/cbor/vectors/`. Cashwebd uses this crate for opt-in CBOR topics
and explicit CBOR account registration; no direct-message or mailbox path uses
it.

## Ownership

This crate owns canonical CBOR encoding and decoding, FRNK frame bytes, schema
checks through section 9 stage 9, type-2 directory signature validation at
stage 10.6, and the pure hashes T1, T1a, T3, T4, and T7. Type-1 stages
10.1–10.5 are absent. Callers pass typed values or payload bytes. They do not
hand-roll CBOR maps.

## Public entry points

`encode_frame`, `wrap_frame`, `parse_frame`, `validate_frame`,
`encode_canonical`, `decode_canonical`, `is_valid_canonical`, and `cbor_map`,
re-exported from `src/lib.rs`. Explicit CBOR account registration and opt-in
topics are production consumers. Direct-message and mailbox paths are not
wired. Type-1 decryption, T3/DLEQ/payment observation and the rest of stages
10.1–10.5 remain out of scope.

## Encryption suites

Type-5 schema 2 allocates production suite 1 to crypto-box authenticated
XChaCha20-Poly1305. Suite 65535 remains reserved for schema-1 opaque proof-vector
ciphertext and must not be emitted by a production writer. Private crypto-box
registry ids `0xFE01`, `0xFE02`, and `0xFE03` are not Frank-CBOR
encryption-suite allocations. A crypto-box envelope is not a frame. This crate marshals and unmarshals frames. A digest or
ciphertext is a byte array passed into nakamoto or crypto-box. Nakamoto still
owns the HD nodes, keys, and transactions that do the signing. Nakamoto does
not parse CBOR. Crypto-box does not parse Frank/CashWeb CBOR; it privately
parses only its fixed-schema envelope CBOR.

## Tests

From `backend/cashweb`: `cargo test -p frank-cbor`.
# Structured Forum codec

The public facade validates type9 schema2/min2 structured bodies and types12–15 read/status
frames through the existing shared traversal budgets. `ForumPostContent` distinguishes opaque
schema1 from structured content, and `ForumOperationEvidence` distinguishes unverified request
echoes from relay observations. Original frames and body bytes remain authoritative.
`encode_forum_post`, `encode_forum_read_frame`, cursor transport helpers and
`match_forum_operation` perform pure construction/comparison; they establish neither chain
finality nor wallet authority. Active TS/Rust conformance uses
`docs/protocol/cbor/vectors/forum-content-read.json`. Runtime snapshot storage/publication,
normal-client switching and predecessor removal remain under #675.
