# S5c2 storage implementation evidence

Candidate branch `feat/swap-negotiation-storage`, exact start
`742f7592e7b64a7d9c47be6b8b33b35afbb82926`, root contract documents on reviewed source
`54123d97517d8437ae5f91112dc488725505c403`. Tier 3; owner-requested/selected implementation
lane GPT-6.1 Sol medium. Parent owns contract, independent review and integration. This is
unused storage infrastructure; no host/runtime activation or financial execution.

## Ownership and durable shape

New separate browser/native entries return only read/CAS/namespace/close. Small pure common
helpers validate explicit scalar UTF-8 host discriminator (128 bytes), account incarnation
(256 bytes), and actual compressed secp256k1 local public key. The namespace hashes four-byte
big-endian length-framed domain `frank/swap-negotiation-storage/v1`, host, incarnation and key;
complete versioned binding metadata is persisted and compared, independently of its hash.
One namespace serves that account across messaging chains. S5c1's inspector remains the sole
row schema/signature/authenticated-context authority; storage additionally checks incarnation,
local key and the exact derived row key. Original raw strings survive CAS/read/reopen exactly.

Parent clarification: noncanonical means schema/key/hex fields, not JSON whitespace/property
order. The adapter adds no JSON canonicalizer or duplicated writer. Tests accept equivalent
order and whitespace and count actual UTF-8 bytes. Limits are production constants 128 rows,
8388608 serialized row bytes and the unchanged 262144 per-row parser bound. Binding metadata
is separate. Fresh inventory scans derive count/bytes; there is no durable counter/cache,
eviction, deletion, migration or format repair. CAS compares exact expected raw before proposed
capacity admission; capacity exceptions and CAS-false leave the owner usable. Unknown storage
failure poisons before queued later work; exception never means absence or automatic retry.

Direct IndexedDB uses schema 1, one out-of-line records store, exact schema/config validation,
and verified strict first-row and subsequent CAS transactions. Every new connection's open and
inspection and any initial binding+row commit are under its namespace Web Lock. Existing-only
open aborts creation; existing missing binding is incomplete even when first CAS is requested.
Reopen has no readwrite capability probe. CAS comparison/validation/capacity/write callbacks
stay synchronous in one readwrite transaction, and success awaits completion. Abandoned late
opens abort upgrades or close their connection; close observes pending terminal cleanup.

Native Level 7 owns a sole private handle and serializes the entire operation. Binding plus
first row is a sync:true atomic batch; later writes are sync:true. Existing approved roots are
canonicalized, symlink/incomplete/unexpected namespace layouts are refused, recovery/open
synchronizes the namespace directory, and new creation synchronizes its parent. Cleanup errors
preserve the original error too. Close synchronously revokes new admission, drains admitted
work and closes once; a previously admitted CAS may commit.

Source changes are confined to the allowed storage directory, package README/manifest/runtime
dependency declaration, pure tsconfig exclusions and two explicit platform tsconfigs, plus
adding both exact gates to scripts/typecheck.ts. Node16 types and the narrow Level native-only
module declaration stay out of browser/pure projects. Level ^7.0.0 and Node types ^16.11.11 reuse
existing lock selectors, so no lockfile/install/shared dependency mutation was needed. Own
checkout overlays and package-local Node16 types are retained for independent verification.

## Fresh gate matrix

All commands ran in this candidate checkout with synthetic public negotiation evidence,
owned temporary files/profiles/PIDs and loopback browser transport. No public/funded chain,
native chain proof, external message, push, merge or deployment.

| Exact command | Result |
| --- | --- |
| `yarn --cwd packages/swap-protocol test --runInBand` | PASS: 8 suites / 89 tests, including 21 actual native and 2 common storage cases; S5a/S5b/S5c1 existing vectors/regressions unchanged |
| `yarn --cwd packages/swap-protocol test --runInBand negotiation-native -t 'exclusive ownership'` | Fail-before/pass-after of the native implementation's lock premise (historical logs below); final full package also passes this case |
| `yarn --cwd packages/swap-protocol test:storage-browser` | PASS actual Chrome qualification and pure/browser bundle import checks |
| `node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol` | PASS: 3 justified runtime dependencies |
| `yarn typecheck:fast` | PASS: 25 projects, including both new browser/native configs |
| `node_modules/.bin/prettier --config app/.prettierrc.json --check 'packages/swap-protocol/src/storage/*.{ts,mjs}' packages/swap-protocol/README.md packages/swap-protocol/package.json packages/swap-protocol/runtime-deps.json packages/swap-protocol/tsconfig.json packages/swap-protocol/tsconfig.storage-browser.json packages/swap-protocol/tsconfig.storage-native.json` | PASS; new typecheck gate lines also agree with formatter without sweeping existing script style |
| `git diff --check` | PASS |

Qualified environment: macOS 26.6 arm64; Node 26.10.0; Level 7.0.1 with leveldown 6.1.1;
package-local @types/node 16.18.126; actual Chrome 155.0.8059.80. Browser runner bundles source
from this checkout and asserts no native/Node/Level/wallet in the browser bundle and no storage
adapter selected by pure core/negotiation/journal/plugin entries. No new test dependency or
browser download was installed.

Native qualification covers no-create reads/expected mismatch/invalid and foreign proposals,
mutable Buffer binding snapshot, real signed orphan/offer/accept engine admissions and duplicate
no-write behavior, exact raw reopen, same-owner concurrent CAS, actual 128 rows shared across
messaging chains and two final-slot proposals, update/duplicate at capacity, actual 8 MiB bytes
and shrinking replacement, independent child-process exclusion, canonical root aliases,
sync:true options and directory barriers, metadata/malformed/valid-derived-foreign/unknown-key
corruption and invalid layouts, incomplete read/CAS refusal, lost acknowledgment of a sync
batch with reopened original signed evidence, queued-work poison, retained token after failed
cleanup and later explicit close, close/drain/reopen, and preservation of dual cleanup errors.

Browser qualification covers real signed engine admissions, SIGKILL with the qualified
connection still open then same-profile/origin reopen, actual 128-row and8MiB capacity and
UTF-8 sizes, update/duplicate and refusal usability, independent-page CAS of the same expected
row, and separate-page distinct proposals racing for the actual final row slot. It checks 11
metadata/row/schema/configuration corruption cases, strict capability refusal on the FIRST
commit (schema remains incomplete), zero readwrite transactions on reopen, and schema-gap
initialization across three pages. After actual schema commit but before first binding/row
transaction, both a second-page read and third-page CAS are positively observed waiting in
Web Locks. They finish only after the creator resumes and commits. A separate creator is killed
in that gap; fresh read AND CAS reject surviving incomplete storage and raw inspection confirms
no metadata/row repair. Lost acknowledgment is fault-injected after a REAL strict transaction
completes: the caller reports failure, queued work fails, and reopen recovers the original signed
row as duplicate. This does not claim that a real IndexedDB abort commits data.

Close-while-waiting is tested using an actually pending Web Lock. Fixed-version 1 opens do not
normally upgrade a live version 1 connection; the actual blocked-open test therefore queues an
open behind a blocked deletion, observes the issued request, closes its owner, then releases
the blocker. Its late creation upgrade aborts and no replacement database survives. No timeout
is treated as successful acquisition, initialization or cleanup.

## Native lock finding and correction

Initial native qualification reproduced a concrete Level/POSIX ownership failure in this new
implementation: child process exit 2/LOCK while the first owner held the database; a second
same-process constructor then failed LOCK; afterward the child exited0 and read present:true
in the EXACT same namespace/key while the first owner was still active. The isolated trace is
`/tmp/frank-s5c2-lock-before.log`; the corrected regression passes in
`/tmp/frank-s5c2-lock-after.log` and the final full suite. This is saved implementation-stage
fail-before evidence, not a claim that the source base already had this new adapter.

Parent approved a module-private canonical-location ownership token before any Level
construction. A rejected duplicate neither touches Level nor releases another owner's token.
The token remains until its own acquired handle cleanup succeeds; Level's actual OS lock still
rejects other processes. Tests recheck child exclusion AFTER rejected same-process open and
cover failed cleanup/close/reopen. Source inspection found similar patterns in existing native
adapters; root separately delegated independent verification/repair. This candidate does not
edit or claim qualification of those other adapters.

## Actual limits and handoff

The native token guard covers one loaded module/process, not independently duplicated module
copies or unrelated direct Level consumers. Native durability was qualified only on the listed
macOS/POSIX environment, not Linux, other platforms, power failure or physical media corruption.
Browser qualification covers the listed Chrome's strict transaction API and owned process
restart, not browser eviction/profile loss, malicious rollback or other browser engines. Pending
IndexedDB opens cannot be canceled directly; close may wait for an external blocker to release
so the late request can terminate safely. An interrupted namespace is intentionally preserved
and rejected; no automatic reset or repair is added.

Account restoration/incarnation rules, H2 reset, host lifecycle, saturation presentation and
runtime ingestion remain successor work. There is no custody, financial authority, execution
signing, outgoing acceptance automation, UI or host installation. Main merge/deploy remains held.
Earlier native-chain saved proofs are unchanged and were not rerun by this storage candidate.

Fresh logs: `/tmp/frank-s5c2-{swap,browser,typecheck,format}.log`; saved lock regression logs
are listed above. Candidate-local overlays are retained; no other worktree cleanup occurred.
