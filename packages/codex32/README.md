# `@frank/codex32`

A strict, browser-safe recovery-share core divided into two explicit layers:

1. **`src/gf32-recovery-shares.ts`**: The core $\text{GF}(32)$ polynomial interpolation, 15-character long BCH checksum framing, master-payload validation (`createMasterPayload`, `validateMasterPayload`), and byte/symbol codecs (`bytesToGf32Symbols`, `gf32SymbolsToBytes`, `splitGf32Symbols` / `splitRecoveryShares`, `interpolateGf32Symbols` / `combineRecoveryShares`, `RecoveryShareMetadata`, `createLongBchChecksum`, `verifyLongBchChecksum`) powering Frank's production `frk1...` / `fr1...` threshold recovery shares (including 67-byte and 64-byte recovery payloads).
2. **`src/bip93-codex32.ts`**: The optional BIP-93 `ms1...` compatibility codec (`encodeCodex32`, `decodeCodex32`, `validateCodex32Checksum`, `codex32SecretPayloadSymbols`, `interpolateCodex32Symbols`, `codex32SymbolsToBytes`, `splitCodex32`, `recoverCodex32Exact`, `recoverCodex32`).
3. **`src/index.ts`**: Re-exports all symbols from both `gf32-recovery-shares.ts` and `bip93-codex32.ts` so all `@frank/codex32` callers continue to work without breakage.

Persisted storage and descriptor tags (such as `recoveryFormat: 'codex32-master-v1'`) remain frozen for backwards compatibility.

## BIP-93 Compatibility Codec (`bip93-codex32.ts`)

Supports the pinned BIP-93 payload sizes: 16, 20, 24, 28, and 32 bytes with the
regular 13-character checksum, plus the 64-byte long-checksum format. Encoders
produce canonical lowercase strings; decoders accept uniform lowercase or
uppercase and reject mixed case.

Splitting requires an explicit caller-supplied CSPRNG. Decoding and recovery
reject malformed checksums, unsupported lengths, duplicate shares,
inconsistent metadata, and any recovery set that is not exactly the threshold
size. BIP-93's residual 0-4 payload bits are discarded whether zero or nonzero.
Object inputs and recovery arrays are snapshotted once before validation so
getters or later caller mutation cannot change the checked material.
Recovery accepts only non-`s` shares; the `s` index is the reconstructed raw
secret, not one of the threshold shares supplied to interpolation.

## GF(32) + Long-BCH Recovery Shares (`gf32-recovery-shares.ts`)

`createMasterPayload` and `validateMasterPayload` implement Frank's frozen v1
`R || SHA-256("frank/master-validation/v1" || 0x00 || R)` construction. They
do not select a derivation registry or persist account material.

`splitGf32Symbols` (`splitRecoveryShares`) and `interpolateGf32Symbols`
(`combineRecoveryShares`) operate over $\text{GF}(32)$ reduced by $x^5 + x^3 + 1$
and support threshold $1 \le k \le 9$, while `createLongBchChecksum` and
`verifyLongBchChecksum` provide generalized 15-character BCH checksum framing
for application-owned prefixes.

The checksum detects transcription errors; it does not authenticate shares
against an adversary. Applications need an authenticated transcript or another
trusted mechanism for binding shares to the intended recovery set.
