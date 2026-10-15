# Local signing uncertainty predecessor (C0)

`uncertainty-journal.ts` is an internal, native-Level metadata journal. It has no
package export, application consumer, transport, chain client or production
activation. It does not approve the experimental threshold primitive or swaps
for funds.

## Ownership and binding

The journal owns local signing admission, consumed session IDs, per-step frame
and artifact hashes, revisions and retirement for one local public share. A
record is keyed by its canonical compressed secp256k1 public point; curve and
encoding validation reject alternate spellings and invalid points. An opaque
key ID is unique within this namespace. The key-ID map is a derived index rebuilt
from the authoritative point-keyed records. Creation rejects any second alias
for an existing point, including a retired point. This guarantee applies only
inside this single journal owner and DB lock domain.

Authorized creation freezes an opaque key ID, local public-share point, terms
hash, role and one or two distinct session/digest bindings. The journal cannot
widen that policy. It does not know swap payloads, native transactions or wallet
reservations. The trusted custody caller must match this metadata to the actual
local private share and backend, authenticate incoming frames, propagate every
primitive failure as a thrown callback failure, and accurately identify terminal
steps. Supplying an arbitrary apparently safe binding never authorizes importing
or using a share. No consumer establishing that trust is implemented here.

There is no existing encrypted threshold-share owner certified by this change.
`packages/joint-signer/src/frank-lindell/backend.ts` exports raw private key-share
bytes through the primitive and translates burns into `key-unusable`; it does not
persist them. `packages/account-vault` encrypts account-root preview records, not
arbitrary threshold shares. `packages/crypto-box` owns transport envelopes, not a
threshold custody lifecycle. Reusing either as threshold custody requires a
separate account/backend/encryption/retention contract. C0 imports none of them.

## Ordering and failures

`create` explicitly opens a new namespace under an existing authorized directory;
`createKey` is the separate authorized metadata admission. `openReadOnly` and
`openForMutation` require an existing namespace. Inspection does not initialize
records, migrate, delete unknown data, import keys or persist quarantine defaults.
Corrupt fields, unknown schema versions and missing/mismatched bindings fail
visibly. Native Level may maintain its own engine files while opening an existing
DB; read-only here means no application-record mutation, not a filesystem
read-only Level backend.

`beginSession` durably consumes a predeclared session before nonce generation.
Callers must use `runGuardedStep` for initial signing-state creation as well as
later potentially burning transitions. Before invoking the callback, the journal
commits the exact frame hash, key/session, step index and next revision as
`step-in-progress`. It hashes and copies local output, commits the resulting
artifact hash and next state, then returns the output copy. Session IDs, duplicate
frames and stale revisions never invoke a callback. A terminal transition is
explicit; a nonterminal session cannot yield to a different session.

The callback is trusted local signing computation only. It must never send, log,
fund with or otherwise externally expose its result. A malicious callback can
perform side effects or retain output before returning; this journal cannot
prevent them. This is an ordering seam, not a sandbox or signing authorization
capability. Outgoing recovery packages and transport exposure barriers belong to
successor owners and are absent here.

Commit failure immediately disables current-process signing for that point.
Callback failure or post-step commit failure also attempts a durable retirement;
a failed retirement never clears committed uncertainty. No catch/finally resumes
a nonce session. Every key with any consumed session found on reopen is unusable,
even if its last session completed successfully. A terminal write may reach disk
and then report failure; if retirement also fails, a persisted completed row
cannot prove the callback result was acknowledged. C0 therefore admits a second
predeclared session only in the same live owner after an acknowledged terminal
commit. This deliberately conservative local policy resolves that ambiguity
without resuming nonce state or introducing an external freshness authority. It
does not choose deployed availability policy. Completed public packages owned
elsewhere remain usable and are unaffected by key retirement.

The journal uses the existing `storage/level-durability.ts` unchanged, including
native `sync: true` writes and new-namespace directory flushes. It observes Level
7's initial open callback alongside the helper because a second open during a
failed auto-open otherwise waits forever. This makes native lock failures
observable. Per-key transition queues cover only short checks/commits; signer
callbacks run outside them, so another key can progress. A concurrent retirement
or close prevents pending output from being returned.

## Record inventory and limits

Stored plaintext consists only of schema version, opaque key identity, local
public-share point, terms hash, fixed role, allowed session IDs/digests, revision,
consumed session history, successful frame/artifact hashes, terminal flags and
current progress/retirement state. Private shares, seeds, nonce state, adaptor
secrets, encrypted share blobs, actual frames, output bytes and recovery packages
are never stored. Public metadata may reveal linkages and requires a future
privacy/retention policy; absence of signing secrets is not encryption at rest.

Native Level's exclusive path lock provides one owner for this DB path. A
separate copied DB, different profile/device or restored authentic old snapshot
can evade its history. A local counter cannot detect restoration of itself.
The test deliberately restores an authentic old one-key record and observes old
permission: this limitation is explicit, not masked by an invented outside
counter. No physical power-loss, malicious OS, hardware flush honesty, browser
strict-durability, storage eviction, rollback or distributed-lock claim is made.
Browser hosts are explicitly unsupported in C0; read-only probing must not
create an absent IndexedDB database.

A failed write before any session or retirement reached durable storage cannot
create a historical fact on reopen; current-process admission still closes.
No signer is invoked before session consumption and pre-step uncertainty commit.
There is no automatic repair or reset path. Unsupported development metadata
requires an explicitly scoped removal of this namespace only after confirming
there are no live shares or obligations; do not delete keys or unrelated data.

C1 must supply qualified host/rollback and device ownership policy, encrypted
share/account/backend binding, real stage integration, browser retention,
complete recovery/exposure packages and authoritative financial reservations and
reconciliation. XEC's existing localStorage operation owner is not qualified by
this Level journal. No funds, signature transport or application activation may
be wired on C0 alone.

## Verification

From this repository's installed workspace, with its workspace dependencies
resolving to this checkout and wallet-local `chronik-client` 4.3.1:

```sh
cd packages/wallet
node ../../node_modules/jest/bin/jest.js --config jest.config.js --runInBand --runTestsByPath threshold-custody/uncertainty-journal.jest.test.ts storage/level-durability.jest.test.ts
cd ../..
yarn typecheck:fast
node node_modules/prettier/bin-prettier.js --check --config app/.prettierrc.json packages/wallet/threshold-custody/uncertainty-journal.ts packages/wallet/threshold-custody/uncertainty-journal.jest.test.ts packages/wallet/threshold-custody/README.md
```

Tests use real isolated native Level close/reopen and synchronous writes; fault
injection wraps those writes and can fail before storage or lose an acknowledgment
after storage. The genuine malicious-ciphertext regression generates fresh
threshold shares in memory, drives the existing primitive fixture to the attacked
step, then guards that exact malicious delivery. It resets only the primitive's
test burn set to model a fresh process and demonstrates that old-share import
would succeed without the reopened journal's refusal. This is a focused burn
regression, not production integration of every cryptographic stage. Only test
owned temporary directories are removed. No live chains or production keys are
used.
