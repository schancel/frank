# `@frank/codex32`

A strict, browser-safe core for BIP-93 Codex32 seed backup strings and their
GF(32) threshold-share construction. It is deliberately not exposed as a
generic Shamir implementation: the field, identifiers, indices, checksum, and
recovery rules are part of Codex32.

This slice supports the pinned BIP-93 payload sizes: 16, 20, 24, 28, and 32
bytes with the regular checksum, plus the 64-byte long-checksum format used by
Frank. Encoders produce canonical lowercase strings; decoders accept uniform
lowercase or uppercase and reject mixed case.

Splitting requires an explicit caller-supplied CSPRNG. Decoding and recovery
reject malformed checksums, unsupported lengths, duplicate shares,
inconsistent metadata, and any recovery set that is not exactly the threshold
size. BIP-93's residual 0-4 payload bits are discarded whether zero or nonzero.
Object inputs and recovery arrays are snapshotted once before validation so
getters or later caller mutation cannot change the checked material.
Recovery accepts only non-`s` shares; the `s` index is the reconstructed raw
secret, not one of the threshold shares supplied to interpolation. The exact
recovery API also returns all interpolated field symbols so a signup or reshare
ceremony can compare the final residual bits instead of comparing only bytes.

`createMasterPayload` and `validateMasterPayload` implement Frank's frozen v1
`R || SHA-256("frank/master-validation/v1" || 0x00 || R)` construction. They
do not select a derivation registry or persist account material.

The checksum detects transcription errors; it does not authenticate shares
against an adversary. Applications need an authenticated transcript or another
trusted mechanism for binding shares to the intended recovery set.

This implementation has not received an external cryptographic audit. Bounded
error correction and the canonical recovery-descriptor codec are not yet
implemented. Do not use it as the sole backup mechanism for real funds until
those spec gates and an independent review are complete.
