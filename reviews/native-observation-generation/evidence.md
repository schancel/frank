# Durable native observation generation evidence

Tier 3 candidate on `fix/native-observation-generation`, based on
`61c6d468a1911f05fb469a4d28c512fb049ef78a` plus contract `f6d85a5f`.
Implementation follows the accepted contract; independent review/integration is
still required. This evidence describes the commit containing this file.

## Outcome and ownership

The existing native journal remains the sole durable owner. Version 2 rows and
manifest require per-member `observationGeneration`; new plans initialize it to
zero. The existing coordinated reload/mutation computes semantic
observation/account changes with a stable field projection and persists each
increment in the same row. Capture checks combine expected generation with the
reviewed evidence equality and signed affinity checks. Exposure, sync
acknowledgements and unrelated members do not advance that member's generation.

All production observation/account assignment sites were traced: preparation,
`recordObservation`, and `discardUnexposed`. Preparation initializes generation;
the latter two use the same atomic mutation boundary. No new production module,
transport dependency, format outside this journal, key derivation or wire
change was required. Production imports and dependency manifests are unchanged.
The consolidator observer makes one capture before its RPC reads and does not
refresh/reuse a rejected answer.

## Acceptance evidence

| Gate                                                                                                                                 | Result                                                                                                                                | Log                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| New harmful ABA regression against unchanged base implementation                                                                     | All five durable two-wrapper cases fail: stale missing accepted after A → pending → exact A; changing wrapper reopens between commits | `/tmp/native-generation-before.log`            |
| Storage/concurrency with v2 generation, malformed/old formats, overflow, failed/lost write acknowledgement, account-only and discard | 44 tests pass                                                                                                                         | `/tmp/native-generation-storage.log`           |
| Five affected journal, concurrency, consolidator, admission and payment suites                                                       | 5 suites, 237 tests pass                                                                                                              | `/tmp/native-generation-affected.log`          |
| All configured typechecks                                                                                                            | 25/25 pass                                                                                                                            | `/tmp/native-generation-typecheck.log`         |
| Final concurrency delta: real consolidator observer suspended during RPC, ABA across other-wrapper reopen, no answer reuse           | 5/5 pass                                                                                                                              | `/tmp/native-generation-final-concurrency.log` |
| Scoped Prettier with `app/.prettierrc.json`, `git diff --check`                                                                      | Pass                                                                                                                                  | Checked locally                                |

Commands:

```sh
./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand evm-native-journal-concurrency evm-native-operation-journal evm-legacy-consolidator evm-input-admission evm-native-payment-set
yarn typecheck:fast
./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand evm-native-journal-concurrency
./node_modules/.bin/prettier --config app/.prettierrc.json --check packages/wallet/storage/evm-native-operation-journal.ts packages/wallet/storage/evm-native-operation-journal.jest.test.ts packages/wallet/storage/evm-native-journal-concurrency.jest.test.ts packages/wallet/storage/evm-native-operation-journal.md reviews/native-observation-generation/evidence.md
git diff --check
```

The final delta adds only test coverage after the full affected/typecheck gates;
production source is unchanged since those gates. Existing five changed-basis
regressions, lower-height fresh reorg, exact unknown contradiction, field-order
replay, capture affinity and member isolation remain covered. Added ABA checks
retain full durable inclusion/account/sync/exposure snapshots, require exactly
two generation advances, and exercise competing captures of one generation.
Invalid old-row/old-manifest/missing/negative/fractional/unsafe/string counters
reject without changing original signed/exposed pending application bytes.
Overflow allows identical replay but rejects changing evidence without changing
durable state. Failed and committed-but-unacknowledged writes poison the owner;
reopen recovers the actual evidence/counter together with exposure.

Candidate-owned ignored dependency overlays point external dependencies at
existing installed packages and `@frank/*` at this candidate. Wallet Chronik uses
existing 4.3.1 and bot local type dependencies mirror the existing reference
checkout. No installs, shared dependency mutation, live services or funds were
used. Costly gates were coordinated with the parent.

## Material release limitations

See [journal format and release gate](../../packages/wallet/storage/evm-native-operation-journal.md).
The existing physical namespace is retained: no alternate namespace, migration,
compatibility reader, old-field default or reset. Existing old funded/pending
journals remain untouched and unsupported. **Deployment is gated until an
explicit owner disposition/release decision for those records.** Persisted v2
records must also be retained if source is reversed. No deletion or migration
is authorized here.

This fixes local accepted-evidence ordering, not RPC truth, finality, full
head-driven reorg recovery, spent-balance restoration or funding provenance.
No merge, push, deployment, worktree/dependency cleanup or attribution trailer
was performed. Parent tool selection requested GPT-6.1 Sol at medium reasoning;
there is no hidden runtime attestation claim.
