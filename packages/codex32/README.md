# `@frank/codex32`

A strict, browser-safe core for BIP-93 Codex32 seed backup strings and their
GF(32) threshold-share construction. It is deliberately not exposed as a
generic Shamir implementation: the field, identifiers, indices, checksum, and
recovery rules are part of Codex32.

This first slice supports canonical lowercase standard-checksum strings with
exactly 16, 20, 24, 28, or 32 seed bytes. The BIP-93 long-checksum variant
required for larger seeds is rejected, not guessed or silently downgraded.

Splitting requires an explicit caller-supplied CSPRNG. Decoding and recovery
reject malformed checksums, unsupported lengths, duplicate shares,
inconsistent metadata, and any recovery set that is not exactly the threshold
size. BIP-93's residual 0-4 payload bits are discarded whether zero or nonzero.
Object inputs and recovery arrays are snapshotted once before validation so
getters or later caller mutation cannot change the checked material.
Recovery accepts only non-`s` shares; the `s` index is the reconstructed raw
secret, not one of the threshold shares supplied to interpolation.

The checksum detects transcription errors; it does not authenticate shares
against an adversary. Applications need an authenticated transcript or another
trusted mechanism for binding shares to the intended recovery set.

This implementation has not received an external cryptographic audit. Do not
use it as the sole backup mechanism for real funds until it has independent
review and the remaining official long-checksum vectors are incorporated.
