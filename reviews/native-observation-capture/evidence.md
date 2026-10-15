# Native observation capture implementation evidence

Candidate is a bounded equality-precondition repair on contract commit `9174555f94e3c7c486bc7adf1885b84a492451cc` (production base `e7f06cd2c3a0f277d339d46735f8de70f14c8271`). Journal remains the sole durable owner. No persisted or wire format, dependency direction, production consolidator, submission, or reservation policy changed.

Captures now retain a private immutable string projection of signed bytes/hash, observation state/inclusion fields, and account evidence. The returned capture and token are frozen; only the original capture object is accepted. Existing coordinated mutation reloads durable rows before comparing this basis for every incoming observation state. Exposure and sync acknowledgement are excluded from the comparison and preserved from the reloaded row. Local supersession and close still revoke captures. Evidence projection ignores object property order.

## Verification

- Final five-case real-Level two-wrapper regressions against original production source: **5 failed / 5**, `/tmp/native-capture-before-final.log`. Cases: delayed actual consolidator missing, pending, older included-success, older included-revert, and account-only evidence change. Both wrappers share one actual Level handle because Node Level permits one physical opener; this proves independent cached wrappers with durable reload, not separate browser tabs/processes.
- Affected suites: **5 passed, 225 tests passed**, `/tmp/native-capture-after.log`. Command: `./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand evm-native-journal-concurrency evm-native-operation-journal evm-legacy-consolidator evm-input-admission evm-native-payment-set`.
- Final focused delta: **38 passed** across storage journal, concurrency, and five temporary ABA probe cases, `/tmp/native-capture-final-storage.log`. Of these, **33 are permanent acceptance tests**, including added per-member isolation/restart and unknown-without-contradiction assertions. Temporary probes were copied to `/tmp/native-capture-aba-probe.jest.test.ts` and removed from candidate sources; their assertions expose an unresolved limitation, not accepted safe behavior.
- `yarn typecheck:fast`: **25/25 projects passed**, `/tmp/native-capture-typecheck.log`. No production edits occurred after this run; final additions are Jest-only. `git diff --check` passes.
- Existing queued-write consolidator assertion now expects false when a capture starts against cached pending evidence while an already admitted inclusion write is held: after inclusion durability completes, pending evidence no longer matches. The test still verifies timeout, completion, stop, sync application and no extra provider work.
- Fresh lower-height inclusion accepts after refresh; stale exact-contradiction unknown rejects, fresh exact contradiction accepts, and unknown without contradiction cannot erase inclusion. Same evidence with reordered keys plus concurrent sync acknowledgement accepts and preserves it. Capture identity mutation/copy/mismatch, exposure preservation, repeated capture commits, member isolation, reservations and reopen behavior have focused coverage.

Candidate-owned dependency overlay uses existing external dependencies and candidate-local `@frank` links. Wallet-local Chronik resolves to existing 4.3.1; bot local type dependencies mirror root package-local dependencies. No install or shared dependency mutation occurred.

## Reproduced ABA limitation and next-work gate

`/tmp/native-capture-aba-probe.jest.test.ts` and `/tmp/native-capture-aba.log` reproduce this with the same two real-Level wrappers:

1. Wrapper B captures included-success evidence A and its account evidence.
2. Wrapper A writes pending evidence B, then writes exactly the prior inclusion/account evidence A again through fresh captures.
3. Wrapper A marks sync applied. Wrapper B submits its old captured missing result.
4. Current equality matches A, so the old result is accepted, replaces inclusion with missing and resets syncApplied to false.

The probe deliberately asserts that harmful effect and logs `ABA CONFIRMED`; passing it is evidence of the remaining hole, not safety. Equality CAS cannot detect intervening history or prove RPC recency. Parent explicitly authorized this bounded correction and retained ABA as an unresolved gate for broader head-driven reconciliation. History-aware invalidation would need a separately authorized design (for example a durable evidence revision shared by all wrappers), format/ownership assessment, and regression before expansion. No revision, migration, compatibility reader, or global ordering claim was introduced here.

Requested and dispatch-selected lane: GPT-6.1-Sol, medium. This is dispatch metadata, not an independent runtime model attestation. Parent performs independent frozen-candidate review and integration; no push, merge, deployment, live service or funded operation performed.
