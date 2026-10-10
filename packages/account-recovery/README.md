# `@frank/account-recovery`

This package owns Frank's transient Codex32 signup and recovery ceremonies. It
composes `@frank/codex32` with the frozen `@frank/domain-roots` registry.
Public encoding uses only `@frank/nakamoto/bech32` and `convert-bits` leaf
modules; the browser bundle check rejects chain, key, wallet, storage and UI
modules. Commitments use the existing pinned Noble SHA-256 dependency.

Signup parameters are explicit: the caller chooses the threshold, identifier,
share indices, and CSPRNG. The ceremony returns encoded threshold shares but
releases no domain roots until the caller supplies an exact threshold set
that reconstructs the complete canonical 103-symbol payload generated for that
ceremony. It never creates or exposes an encoded Codex32 `s` secret.

`pending.publicDescriptor` is available during transient signup for independent
backup. `pending.confirmWithMetadata(shares)` returns `{ roots, metadata,
accountRoot }` after exact recovery verification; restore returns the same shape.
`accountRoot` is an owned copy of R for custody to store, wiped with
`destroyRecoveredAccount`.

`exportCodex32Backup({ accountRoot, expected, threshold, shareCount, randomBytes })`
issues a new share set for an existing account. It wraps R as the same master
`R || V` that signup splits, refuses with `descriptor-mismatch` unless that master
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

`beginCodex32Restore` snapshots the descriptor once. Recovery first validates
`R || V`, compares all 32 fingerprint bytes, then derives the five purpose-tagged
roots. Invalid shares or invalid `M` can retry against the same pinned descriptor
with another family; `descriptor-mismatch` is terminal and no domain roots are
derived. Success and cancellation also consume the session. Selecting a new
descriptor requires a new session. The caller owns the independent trust source,
account/ceremony binding, async attempt fencing, and UI cleanup. A valid checksum
or a self-comparison cannot establish that trust.

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
