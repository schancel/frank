# Bounded negotiation discovery and coverage evidence

Tier 3 implementation of the parent-authored contract at `5d9b8f09`, on exact base
`2c24e53690c016b8066cbb0d1127466367e61eeb`. Parent owns independent review/integration.
Requested implementation lane: GPT-6.1 Sol medium. Actual runtime identifies itself as
GPT-6/Codex; an exact selected model/reasoning setting is not exposed to this worker.

## Ownership, shape and compression

The existing account/host/local-key namespace remains the sole durable storage owner.
Signed rows remain interpreted by the pure negotiation inspector/reducer; optional
`coverage-v1` records host consumption per exact protocol-registry chain identifier.
There is one shared metadata validator and no durable index, duplicated negotiated state,
new database, transport/custody dependency, format fallback or automatic reset. Existing
browser strict transactions/Web Locks and native synchronous batches/exclusive directory
ownership implement atomicity. The first successful coverage mutation commits unchanged
binding metadata plus coverage in one transaction/batch. Journal writes retain coverage;
coverage writes retain signed rows. Absent inspection and expected-value refusal preserve
absence. Complete inventory validation precedes all returned facts and mutation comparisons.

Coverage metadata is exactly version 1 with sorted unique canonical positions, bounded to
32 entries and 16,384 UTF-8 bytes independently of the 128-row/8 MiB budget. Inclusive
positions are nonnegative safe integers, monotonic, and support an equal-position CAS.
Inventory is a copied frozen sorted array of frozen entries; no internal maps escape.
Unknown/malformed metadata fails without repair. Capacity is the existing recoverable
refusal; other failures preserve poisoned-owner behavior and require explicit reconciliation.

Compression inspection kept platform atomicity separate and metadata semantics shared.
The extension changes the existing inventory result to contain rows plus coverage rather
than adding a second scanner/cache. The two lexical sorting expressions are local and
bounded; no utility abstraction or framework is introduced. No unrelated cleanup or
architectural predecessor was folded into the patch. Persistent additive format and its
reversal limitation are documented in the package README: older adapters reject coverage,
and rollback must preserve stored data. Wire format and derivation remain unchanged.

## Final verification

All commands ran in this candidate checkout using local dependency overlays derived from
`.worktrees/atomic-swaps-current-main`'s effective installed dependency locations. Workspace
source links point into this candidate. No install/download or shared dependency mutation.

| Command                                                                                                                                             | Result                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `yarn --cwd packages/swap-protocol test --runInBand`                                                                                                | PASS: 8 suites, 112 tests, including actual native Level and child-process qualification plus journal/plugin regressions |
| `yarn --cwd packages/swap-protocol test:storage-browser`                                                                                            | PASS: actual Chrome 155.0.8059.80, real IndexedDB/Web Locks and process kill/reopen; pure/browser dependency checks pass |
| `yarn typecheck:fast`                                                                                                                               | PASS: all 25 configured projects including browser/native storage                                                        |
| `node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol`                                                                       | PASS: 3 justified runtime dependencies, no added dependency                                                              |
| `node_modules/.bin/prettier --config app/.prettierrc.json --check 'packages/swap-protocol/src/storage/*.{ts,mjs}' packages/swap-protocol/README.md` | PASS                                                                                                                     |
| `git diff --check`                                                                                                                                  | PASS                                                                                                                     |

Qualified native environment is Darwin arm64, Node 26.10.0, Level 7.0.1 / leveldown 6.1.1.
Native and browser suites exercise absent list/read/refused-CAS noncreation, coverage-first
reopen, journal-first coverage addition, sorted exact frozen inventory, owner validation,
per-chain concurrent CAS, equal-position retry and maximum-safe position, 32-position
capacity refusal without poison, 16 corrupt metadata cases without rewriting, exact metadata
byte boundary, row/byte capacity preserving coverage, journal writes preserving metadata,
and actual durable writes whose acknowledgments are deliberately lost followed by reopen
and committed-position reconciliation. The browser races first row and first coverage writes
on independent pages, verifies both winning facts, then races competing expected positions.
Its process-kill/reopen retains signed entries and coverage. Native additionally checks a
coverage-only namespace excludes an actual child process and coverage writes drain on close.
Browser pending first coverage CAS revokes under an actual held Web Lock and preserves
absence; original blocked-open/schema-gap/incomplete-namespace regressions still pass.

The composed consumer-shaped case admits a real signed offer, fails its attempted coverage
advance, closes/reopens, replays as duplicate evidence, advances coverage, and discovers the
original negotiation. It also admits acceptance while retaining independent chain coverage.
This proves the storage seam, not installed app/bot scheduling.

One intermediate browser run exposed stale acknowledgment flags shared between fault phases
in the expanded test harness. That owned Chrome process was stopped, the flag reset before
the original journal fault case, and the complete final suite passes. No timeout was treated
as a successful test or as absence. All live test handles were retained and observed to exit.
Final logs: `/tmp/frank-coverage-{jest,browser,typecheck,format}-final.log`.

## Limits and next action

Only the listed Chrome/native environment is qualified; no other engine, Linux, physical
power loss, eviction, rollback or media-corruption claim. The existing native module-token
barrier still covers one loaded module/process plus actual Level OS exclusion, not arbitrary
duplicate module copies. Browser incomplete schema remains preserved and rejected. There is
no host installation, outgoing acceptance automation, financial execution, wallet/provider
access, actual message delivery, live funds or secrets. Actual app/bot installation is the
next separate dependency. Parent independent review of the frozen commit is next; no push,
main merge, deployment, tracker mutation or unrelated worktree cleanup was performed.
