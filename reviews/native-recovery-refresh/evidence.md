# Native pending recovery refresh evidence

Source candidate: `417f7854db6259629fc706f6f8bb7ab983064fe9`, based on codebase `1d4c4dedcdc1dfa4549e524e203a001009fbc090` and accepted contract `0267b0c4`. The final evidence-only commit identifies the frozen review candidate in the handoff. Tier 3; implement workflow used; independent review and integration remain parent-owned.

## Outcome and ownership

`EvmNativeOperationJournal` remains the durable owner. `refreshOperations` uses the existing instance exclusion/shared coordination/validated `reloadRows(false)` path and returns detached snapshots. It initializes nothing and writes nothing. Cached synchronous readers remain available to their existing consumers.

The existing executor capability exposes refresh through admission mutation coordination, updates admission revision/projection, and checks the captured lifetime after completion. The installed pending pass claims ownership synchronously before any await, refreshes inside its lifetime, and derives candidates from the returned authoritative rows. Overlapping polls retain their existing immediate-return behavior and start no additional refresh or probe; only the owning call receives a refresh failure. Failure releases pass ownership, preserving the existing minimum interval before a retry. Storage coordination contains no network await.

Durable refresh failures reject before probes or local application. Unrelated RPC failures retain best-effort semantics. Stop still never rejects and prevents a late refresh from probing or applying. There are no persistent/wire-format, derivation, signing, submission, reservation-release, included-member-policy, inventory restoration, head/frontier or observation-generation changes.

## Fail before

On the actual codebase base, with final regression fixture retained:

```sh
./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/chain/evm-legacy-consolidator.jest.test.ts -t 'another Level-backed'
```

Exit 1: expected the newly persisted signed/exposed transaction hash in receipt probes; received `[]`. See [fail-before.log](fail-before.log). All three production files were temporarily read from the named base, the command ran, and the candidate bytes were restored in a `finally` block.

The test follows the established `evm-native-journal-concurrency` opener substitution: two journal instances call real `Open`, own independent caches, and share one actual physical Level handle per location. Node Level rejects simultaneous physical openers for one path. This proves real durable-byte behavior and in-realm coordination, not browser/cross-process behavior. No private journal fields are injected.

## Acceptance and validation

Final focused command at the source candidate:

```sh
./node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/storage/evm-native-operation-journal.jest.test.ts packages/wallet/storage/evm-native-journal-concurrency.jest.test.ts packages/wallet/evm-input-admission.jest.test.ts packages/wallet/chain/evm-legacy-consolidator.jest.test.ts
```

Four suites, 237 tests passed: [final-focused.log](final-focused.log).

New coverage pins the composed executor's restricted reader, real admission and captured lifetime; another durable wrapper's pending payment recovers without reopen; a formerly pending member included by another wrapper receives no probe; actual Level iterator failure and invalid durable row bytes reject without probes/application and later recover after repair; overlapping polls start one refresh; close and actual admission revocation during refresh prevent continuation. Admission coverage verifies projection invalidation, conflicting selection refusal, and expired refresh completion. Journal coverage verifies detached snapshots, read-only refresh, and three close/reopen cycles. Existing eligibility coverage excludes unsigned/cancelled/unexposed/included/reverted members. Existing bounded batch/cursor/backoff, unresolved physical requests, timeout/late completion, unrelated-send progress, local evidence application, and observation-generation/capture races all pass.

Recovery tests now wait behind actual Level refresh before asserting RPC phase barriers or advancing fake network timers. No arbitrary sleep or timeout increase was added.

`yarn typecheck:fast`: all 25 configured projects passed; [typecheck.log](typecheck.log). Broad slot coordinated with parent and identity sibling. Local dependency overlay links external packages to existing root dependencies and local workspace packages to this worktree; no installation or shared dependency mutation.

`git diff --check` passed. Prettier using `app/.prettierrc.json` passes the changed journal/consolidator source and tests. Admission files preserve pre-existing formatting outside the added blocks. Focused capability/lifetime/selection tests enforce the changed authority boundary; no dependency-direction imports were introduced.

## Compression and limitations

Compression retained the named durable-refresh/admission/executor seams, removed unrelated formatting, and added no cache or generalized freshness framework. Production scope is exactly the three claimed files. No sibling-owned configuration/app files changed.

Only local simulated providers and temporary test stores were used. No live RPC, real funds, secrets, deployment, main merge, push, browser attestation or host-visible UI error claim. This is pending enumeration recovery only. Durable frontier/work ownership, typed financial holds, orphaned inclusion retention and funding/inventory restoration remain the separately contracted parent successors.
