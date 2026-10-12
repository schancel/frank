# `@frank/account-recovery`

This package owns Frank's transient signup and recovery ceremonies and Frank Recovery Shares. It
composes `@frank/codex32` with the frozen `@frank/domain-roots` registry.
Public encoding uses only `@frank/nakamoto/bech32` and `convert-bits` leaf
modules; the browser bundle check rejects chain, key, wallet, storage and UI
modules. Commitments use the existing pinned Noble SHA-256 dependency.

Signup parameters are explicit: the caller chooses the threshold, identifier,
share indices, and CSPRNG. The ceremony returns encoded threshold shares but
releases no domain roots until the caller supplies an exact threshold set
that reconstructs the original account root generated for that ceremony. It never creates or exposes an encoded Codex32 `s` secret.

`pending.publicDescriptor` is available during transient signup for independent
backup. `pending.confirmWithMetadata(shares)` returns `{ roots, metadata,
accountRoot }` after exact recovery verification; restore returns the same shape.
`accountRoot` is an owned copy of R for custody to store, wiped with
`destroyRecoveredAccount`.

`exportCodex32Backup({ accountRoot, expected, threshold, shareCount, randomBytes })`
issues a new Frank Recovery Share set for an existing account. It refuses with `descriptor-mismatch` unless that master
reproduces the account's recorded public fingerprint (so a derived domain root or
another account's root cannot be split), reads the new shares back, and gives the
set a fresh random identifier. Share sets are independent: shares from two sets
fail recovery with `inconsistent-share`. `isAccountRootOf(accountRoot, descriptor)`
is the same fingerprint check for custody to run before it stores a root. The metadata contains the public descriptor,
`masterRetirementId`, and `recoveryIdentityCommitment`, computed using the frozen
preimages in recovery-spec sections 7.2 and 12. It contains no family threshold,
identifier, shares, master or root secret. `deriveRecoveryPublicMetadata(M)`
also exposes this pure operation; it validates an owned 64-byte snapshot before
hashing and wipes the snapshot and extracted root on exit.

`encodeRecoveryDescriptor` / `decodeRecoveryDescriptor` own the complete
76-character `frankdesc` Bech32m envelope. `encodeRecoveryFingerprint` /
`decodeRecoveryFingerprint` convert the full raw 32-byte fingerprint to/from
`frankrec`. Encoders emit lowercase; decoders accept uniform upper/lower case
and reject mixed case, wrong variants/HRPs/versions/codes, padding, lengths and
trailing data. No trimming or correction is performed. Returned public objects
are frozen; their byte properties return fresh copies, so changing a returned
buffer cannot change a descriptor or another result.

Normal restore pins an independently trusted decoded descriptor **before**
share collection:

```ts
const expected = decodeRecoveryDescriptor(independentlyTrustedDescriptorText)
const restore = beginCodex32Restore(expected)
const { roots, metadata } = restore.recover(exactThresholdShares)
// Caller checks its retirement indices and coordinates the approved vault/activation.
// After wrapping resident material:
destroyAccountDomainRoots(roots)
```

`restore.recoverAny(shares)` (and `recoverFromAnyShares`) accept the threshold
number of shares or more and tolerate wrong ones. Each share is decoded on its
own; shares are grouped by backup set (identifier and threshold) and never mixed
across sets; every threshold-sized subset of a set is tried for one whose
reconstruction is a valid master `R || V`; every share of the set is then checked
against each master found, at its own index. The result lists the reconstructed
accounts and, for every supplied share by position, whether it `supports` one or
more of them (a share can lie on two splits), is `inconsistent`, comes from a
`different-set`, is a `duplicate` or is `invalid`; share contents never appear in
results or errors. If complete share sets of more than one account are present,
all are returned and the caller must let the user choose; a pinned descriptor
selects its account. The search is always exhaustive, so the number of shares of
one set is limited to keep it small: `maxSharesForThreshold(t)` is 31 for
thresholds 2 and 3, 20 for 4, 16 for 5 and 14 for 6 to 9 (never fewer than the
threshold plus two). More than that fails with `too-many-shares`, whose
`maxShares` says how many may be entered.

`beginCodex32Restore` snapshots the descriptor once. Recovery first validates
`R || V`, compares all 32 fingerprint bytes, then derives the five purpose-tagged
roots. Invalid shares or invalid `M` can retry against the same pinned descriptor
with another family; `descriptor-mismatch` is terminal and no domain roots are
derived. Success and cancellation also consume the session. Selecting a new
descriptor requires a new session. The caller owns the independent trust source,
account/ceremony binding, async attempt fencing, and UI cleanup. A valid checksum
or a self-comparison cannot establish that trust. Descriptor pinning is optional in the mixed-share app flow; several valid accounts require an explicit user choice.

Malformed descriptors/fingerprints raise `AccountRecoveryError` with stable
`invalid-descriptor` / `invalid-fingerprint` codes; unknown format or registry
uses `wrong-recovery-format` / `wrong-registry`. A consistent share set whose
payload is not a valid master `R || V` (any other secret, or shares of two sets
that happen to share an identifier) fails with `not-account-backup`; no roots are
derived from it. Consumed ceremonies use `ceremony-consumed`. Errors do not include
input text, bytes or caller exceptions. Inputs are bounded before allocation,
and descriptor properties and share entries are snapshotted once.

For compatibility, `confirm()` still returns roots alone. The old `descriptor`
property is now explicitly deprecated family metadata (`familyMetadata` /
`RecoveryFamilyMetadata`), with the old `RecoveryDescriptor` type alias retained.
The old `recoverCodex32Account()` checks this family metadata only and is
deprecated for normal account restore; it does not authenticate account identity.

Callers own returned domain byte arrays, must wrap them with the approved vault
before persistence, and call `destroyAccountDomainRoots` when ownership ends.
Owned temporary masters, roots, interpolation buffers, hash preimages and
partially derived outputs are wiped best-effort. Caller-owned inputs and immutable
share strings cannot be erased by this package. JavaScript makes no forensic
erasure guarantee.

This package neither selects descriptor trust nor checks retirement storage,
chooses a default k-of-n policy, activates accounts, or encrypts resident roots.
#699 owns descriptor backup evidence, the two independent copies required for
signup, user choice, vault coordination and account activation. This additive
seam is not a claim that those integration or production-custody gates are met.

Verification uses the package `typecheck`, `test`, `check:vectors`, and
`check:bundle` commands. Build the workspace's own Nakamoto TypeScript output
before type/bundle checks, as required by its exported leaf modules. The frozen
`vectors/public-recovery-v1.json` corpus records exact preimages, digests and
encodings for synthetic zero/sequence roots; `check:vectors` independently
recomputes it using Node/OpenSSL and a separate Bech32m implementation. The
Codex32 and domain-root package suites and domain-root vector checker must also
pass. No real account material belongs in these fixtures.

## Frank Recovery Shares

New signup and backup output is **Frank Recovery Shares**, an application format based
on Codex32's GF(32) Shamir construction and long BCH code, not a standard Codex32
master-seed encoding. `@frank/codex32` standard APIs and vectors remain unchanged.

`exportRecoveryShares({ format, secret, threshold, shareCount, randomBytes })` is the
common writer for original 32-byte account roots (`format: 'root'`) and original
64-byte BIP39 PBKDF2 seeds (`format: 'historical'`). Both use one encoding and splitting
pass over `secret || validation32`. BIP39 is only an upstream secret producer and its
historical derivation only a downstream consumer. The root and historical backup
adapters call this same writer. No seed is truncated, hashed into a new account root,
or otherwise converted. This preserves the declared secret/derivation; it does not
recover legacy family material that was derived from a phrase by a different algorithm.

One share is `fr1` followed by ten unshared base32 metadata symbols, the shared
payload symbols, and fifteen long BCH symbols. Metadata, in order:

| Symbols | Meaning                                                  |
| ------- | -------------------------------------------------------- |
| 1       | version, value 1                                         |
| 1       | secret format: root=0, historical BIP39=1                |
| 2       | secret byte length, high/low five bits: literal 32 or 64 |
| 1       | threshold, 1–9                                           |
| 4       | random set identifier                                    |
| 1       | share index, any field coordinate except `s`             |

Threshold 1 emits exactly one share. Share count is not required for reconstruction.
Strings are 131 characters (root32) or 182 (seed64); expanded BCH lengths are 133/184,
within the 96–1023 long-code bound. Uniform upper/lower case is accepted, mixed case
is rejected. The BCH covers HRP expansion of `fr`, all metadata and shared payload.

The validation digest is SHA256 of ASCII `frank/recovery-share/v1` + NUL, nine raw
five-bit metadata bytes excluding share index, derivation-context ASCII + NUL,
and the unchanged secret. Contexts are `frank-root-v1` and `frank-bip39-bip32-v1`.
All secret and digest symbols are shared together at Codex32's `s` coordinate.
Reconstruction requires zero residual padding and the complete inner digest match.
Every emitted threshold window is decoded and validated before the writer returns.

`recoverAccountBackupShares` is the common bounded search across both secret types.
Groups include full version, format, length, threshold and identifier. Conflicting
same-index payloads are searched without putting two equal indices in one subset.
At most 31 strings and 5000 subsets per group are examined. Account duplicates merge
supporting positions across sets; multiple accounts remain explicit choices.
Malformed inputs have per-share diagnostics; incomplete groups expose public
`required`/`available` counts. The existing common stage/activation/reopen flow owns
custody, and the caller wipes recovered material with `destroyRecoveredBackup`.

Previously issued `ms1...` root shares and `frank-bip39-v1:<seed>:<check>` paired
historical shares remain **recovery-only** by explicit owner authorization.
`parseAccountBackupShareInput` also joins the two adjacent standard lines of an issued
paired share. No production writer emits either old format. They use isolated reader
adapters into bounded search; no persisted account migration or key reset occurs.
