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
checks through section 9 stage 9, and the pure hashes T1, T1a, T3, T4, and T7.
Callers pass typed values or payload bytes. They do not hand-roll CBOR maps.

## Public entry points

`encode_frame`, `wrap_frame`, `parse_frame`, `validate_frame`,
`encode_canonical`, `decode_canonical`, `is_valid_canonical`, and `cbor_map`,
re-exported from `src/lib.rs`. Stage 10 (signatures, payment observation, and
the DLEQ proof) is out of scope.

## Encryption suites

Version 1 allocates no production encryption suite. Suite 65535 is reserved for
opaque proof-vector ciphertext and must not be emitted by a production writer.
`@frank/crypto-box` registry ids `0xFE01`, `0xFE02`, `0xFE03`, and `0xFE04` are
not version-1 encryption-suite allocations (decision 356). A crypto-box envelope
is not a frame. This crate marshals and unmarshals frames. A digest or
ciphertext is a byte array passed into nakamoto or crypto-box. Nakamoto still
owns the HD nodes, keys, and transactions that do the signing. Nakamoto does
not parse CBOR. Crypto-box does not parse Frank/CashWeb CBOR; it privately
parses only its fixed-schema envelope CBOR.

## Tests

From `backend/cashweb`: `cargo test -p frank-cbor`.
