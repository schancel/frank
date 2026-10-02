# `@frank/codex32`

A strict, browser-safe core for BIP-93 Codex32 seed backup strings and their
GF(32) threshold-share construction. It is deliberately not exposed as a
generic Shamir implementation: the field, identifiers, indices, checksum, and
recovery rules are part of Codex32.

This first slice supports canonical lowercase standard-checksum strings with
16 through 32 seed bytes, including the common 128- and 256-bit BIP32 seed
sizes. The BIP-93 long-checksum variant required for larger seeds is rejected,
not guessed or silently downgraded.

Splitting requires an explicit caller-supplied CSPRNG. Decoding and recovery
reject malformed checksums, noncanonical padding, duplicate shares,
inconsistent metadata, and insufficient thresholds.

This implementation has not received an external cryptographic audit. Do not
use it as the sole backup mechanism for real funds until it has independent
review and the remaining official long-checksum vectors are incorporated.
