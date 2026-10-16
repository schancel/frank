# Funding provenance feasibility evidence

Production is unchanged. The parent deferred schema implementation pending separately reviewed predecessors. These probes pin observed defects, so their green result is evidence of the old behavior, not acceptance of the proposed fix.

Run from this worktree:

```sh
node node_modules/jest/bin/jest.js --config reviews/hd-funding-provenance/probe-jest.config.cjs --runInBand
```

`base-loss.jest.test.ts` uses real `MonadAccountTxSigner`, `prepareBurnAccount`, signed EVM transfers, and `LevelSubAccountPoolStore`, with local fake receipt/provider reads. No network request is permitted by the provider. Each fixture opens a newly created temporary directory and removes only that fixture directory. The dependency overlay links existing installed dependencies and this worktree's workspace packages; no installation or shared dependency mutation occurred.

Six observed failures on the unchanged implementation:

1. Two distinct funders sign and submit two contributions to one HD target. After completion and two close/reopen cycles, neither raw transaction exists in the row, and no lifecycle funding checkpoint exists.
2. The first contribution settles; the second signing fails before any second bytes exist. The error drops the holder claim, and after reopen the partially funded row is available and returned by actual pool selection. Probe 6 also exercises the installed input admission guard.
3. The second contribution is signed, persisted and offered to a submitter that throws. After reopen, only that second raw transaction survives. The first is lost; the row remains funding and excluded from pool selection.
4. A real Level write is fault-injected to reject. `setStatus` exposes available before durability, selection returns it before and after the rejected flush, and a second flush succeeds without retrying the failed write. Reopen reveals the durable row was still unfunded.
5. A durable funding obligation with missing receipt and positive recipient balance is changed to available by `topUpPool`, drops its exact bytes and becomes selectable.

6. After the unsigned second-contributor interruption and reopen, the installed `createEvmInputAdmission`, real native journal and real `validateMonadWalletState` report ready with zero obligations. An unrelated native operation is admitted and durably reserves that partial target. This proves the installed guard does not restore the missing preparation hold. It is not a live spend or app/UI end-to-end test.

`base-loss.log` records the command result. No broad typecheck was run: no production implementation was made and the parent owns the broad slot. The evidence test is outside normal wallet suite discovery and its explicit config is required. `pool-caller-search.txt` is investigation output, not a complete authority map: it includes unrelated similarly named methods and must be narrowed against implementations.

Current architectural obstacle: Level pool writes mutate an instance cache before `durableBatch` completes; `flush` drains the pending promise list before observing failure. The store API has no coordinated authoritative read/update or revision compare. A funding-only compare path would remain bypassable by existing status, spend, recovery, allocation, import and terminal-compaction writers. The independent predecessor must move every writer at this row to the same authority, rather than add a second cache or retain an unrestricted legacy write API.

A second authorization obstacle exists independently: after the first multi-funder success, storage cannot distinguish a completed one-funder target from an incomplete multi-funder target whose next contributor has not yet signed. Retained signed attempts cannot reconstruct unsigned intent. A durable preparation hold/completion boundary can preserve the partial target without persisting permission to sign additional transactions; only original already-signed obligations may be reconciled after reopen. The intended funding outcome remains open, with manifest version 3 and exact-byte/evidence preservation requirements unchanged.


## Bounded authoritative pool-write predecessor recommendation

This is a recommendation for parent contract authoring, not permission to implement it.

Replace the synchronous store mutations (`put`, `putMany`, `replaceWithCheckpoint`, `setNextIndex`, destructive `clear` when exposed) with one awaitable pool-specific atomic mutation boundary. Its reducer is synchronous and receives authoritative current rows, terminal checkpoints and allocation high-water; it returns a row/checkpoint/allocation write-set and result. The store runs the reducer in a short coordinator, writes one durable batch and only then publishes the committed read view and returns the result. An empty/no-op reducer does not increment revision. All competing row mutations use this boundary; no unrestricted legacy writer remains.

A delayed network observation captures row revision/attempt identity/generation outside this boundary. Its completion re-reads authoritative state inside it and compares those facts before applying. A contributor append preserves current lifecycle and earlier attempts, and terminal projection is an atomic row-to-checkpoint mutation with a revision check. Allocation and checkpoint tombstones share the authority, preventing old writes from recreating compacted rows. Revisions must detect intervening A→B→A, not merely compare current payload text.

The coordinator belongs to the opened pool-store owner, not the pool wrapper or signer. Independent pool wrappers over the owner must see the same committed authority; fresh store wrappers must read durable state when admitted. Existing Level path locks reject overlapping independent database owners in Node, so this is not evidence of cross-process concurrent writers. A predecessor must either explicitly enforce one store owner per canonical storage identity/binding and delegate wrappers to it, or provide a backend-supported atomic comparison when multiple owners are supported. A path-keyed mutex plus independent stale caches is insufficient. No general database framework is required.

On any durable batch failure whose commit status cannot be proven, retain a sticky uncertain state. All pool eligibility/selection, allocation, mutation and flush paths refuse until explicit close/reopen and authoritative validation succeed. Do not clear the error after one rejected flush, publish a candidate row, or interpret rejection as proof that bytes were never durable/submitted. A proven noncommit may leave the old committed view, but must not release an exposed financial obligation. The contract should choose the simpler conservative fence first.

The public pool methods that mutate become awaitable. Synchronous read-only selection may continue over committed state with the uncertainty check. `acquireForIndex` and `acquireLease` become async: take an existing holder claim before the first await, retain it through the durable `in-use` write, publish a lease handle and release the temporary claim only after success. A second caller checks the same claim/authoritative row under the mutation boundary. `releaseLease` becomes async: preserve the live handle/claim until its terminal or unused transition is durable, then remove it. Failed/uncertain writes retain the exclusion; callers receive failure and cannot sign or expose a new payment. This changes return semantics deliberately rather than staging a selectable cache outside the owning operation.

Concrete production scope discovered:

| File | Required seam |
| --- | --- |
| `storage/sub-account-pool-storage.ts`, `storage/level-sub-account-pool-store.ts` | Single write API, in-memory equivalent, committed reads, terminal/high-water mutation, uncertainty fence, open/close ownership |
| `monad-account-pool.ts` | Every store write: initialization/allocation, recovery imports, status, funding/spend/recovery checkpoints, spend application, preparation, receipt completion, terminal compaction |
| `monad-account-lease.ts` | Async acquire/release/try-wait helpers; preserve claims and handles across commit |
| `evm-input-admission.ts` | Existing native spend mutation, canonical pool adapter, lease acquisition/release and existing uncertainty handling |
| `monad-forum-operation.ts` | Acquire/release, spend checkpoint and success/recovery completion |
| `evm-stamp-payer.ts`, `monad-stamp-client.ts` | Spend/terminal mutation awaits before reporting outcome |
| `chain/monad-chain.ts` | Initial pool creation and orphaned-lease retirement awaits |
| `storage/monad-wallet-bundle.ts` | Lifecycle/compaction use, close/failure semantics and owner attachment |
| `canonical-relay-joined-driver.ts` | Initial pool creation await |

Public recovery helpers with no production callsites found (`applyPrevalidatedRecoveryRecords`, `deriveNextUnfunded`, `restoreJournaledInUse`, `restoreTerminalEvidence`, `recordFundingTransaction`, `recordRecoveryDisposition`) still must convert to the one authority or be removed separately with reachability evidence. `packages/bot/stamp-pool-seed.ts` constructs the persistent store and closes it; its local return path contains no direct pool mutation. Tests and examples consuming changed lease returns need updating and all configured projects must typecheck. `pool-caller-search.txt` retains the broad search evidence, including non-pool name matches.

This predecessor does not need to introduce funding observation schema or change financial policy. Keep derivation/key material untouched and preserve existing persistent facts. The parent must freeze any required row revision baseline/version decision before edits.

## Minimal multi-funder authorization boundary

Before the first signed contribution can be exposed, persist a row-owned preparation hold identifying its operation and HD target and marking preparation incomplete. Appending each already-signed contribution retains all earlier artifacts. Do not make the row generally available between contributors. Only the live original caller, after all contributions it actually prepared satisfy the accepted inclusion checks, may durably mark preparation complete and release the hold. Persist enough completion facts to validate that transition; no unsigned contributor list is permission to pay after restart.

On an interruption, reopening restores the hold and reconciles only retained signed bytes. It does not sign a second contributor, repeat an earlier contribution, infer completion from positive balance or automatically release the hold. If the crash happened after the last successful contribution but before explicit completion, conservatively keep the hold pending authorized disposition. This deliberately sacrifices automatic availability to preserve authorization and funds, without adding a durable unsigned funding plan or a second journal. Unrelated accounts remain selectable. Explicit owner-authorized completion/disposition can be a separately scoped successor; the current contract must state this limitation before claiming automatic multi-funder restart completion.

The immediate funding implementation remains deferred: there is no schema candidate to review, no manifest rewrite, migration/reset, live RPC, funded test or release authorization.
