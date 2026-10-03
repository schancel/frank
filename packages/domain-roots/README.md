# `@frank/domain-roots`

This browser-safe package implements the immutable `frank-domain-roots-v1`
registry used by Codex32-backed Frank accounts. It accepts only the validated
32-byte account root `R` and returns a purpose-tagged 32-byte root. It does not
accept a Codex32 string, the 64-byte recovery payload, or a BIP-39 mnemonic.

The normative byte-level contract and downstream interpretations live in
[`docs/domain-derivation-registry-v1.md`](../../docs/domain-derivation-registry-v1.md).
Callers must retain the purpose tag at adapter boundaries and wipe disposable
secret copies when ownership ends.

`yarn check:vectors` verifies the committed corpus with Node's independent
OpenSSL-backed HKDF implementation; the package tests verify it with Noble.
