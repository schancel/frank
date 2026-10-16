# Authoritative enumeration for installed native recovery

Parent-scoped local continuation of the accepted atomic-swap/reorg program. Base `1d4c4dedcdc1dfa4549e524e203a001009fbc090`; branch `fix/native-recovery-refresh`; worktree `.worktrees/native-recovery-refresh`. Implementation: GPT-6.1 Sol, medium; independent review and integration remain parent-owned. No main merge, push, deployment, live RPC, funded operation, private configuration edits or worktree cleanup.

## Outcome and authority

A pending native payment persisted by another journal wrapper must become visible to the installed recovery pass without reopening this wallet. Recovery must not silently use a stale candidate set after a durable refresh failure. This is an enumeration/recovery correction and reusable reorg prerequisite, not included-member rechecking or inventory restoration.

At the base, `EvmNativeOperationJournal.list/get` return cloned cached views. Mutations reload authoritative bytes, and `refreshPreparation` already uses instance exclusion plus shared coordination and `reloadRows(false)`. `EvmLegacyConsolidator.reobservePending` instead enumerates cached rows and sets pass ownership only after computing candidates. Production executors receive a restricted reader; lifetime-fenced execution capability is composed by `nativeAdmissionJournal`.

Keep the existing journal as the durable owner. Add `refreshOperations(): Promise<EvmNativeOperation[]>` using its established validated refresh path, without initialization, writes of defaults, schema changes, signing or RPC. Expose it through the existing `NativeExecutionJournal` capability with admission projection and lifetime checks, following the existing preparation refresh. Do not export raw mutable ownership or introduce a second cache/authority.

The installed pending-recovery pass must refresh inside its captured lifetime before deriving candidates. Establish in-flight ownership synchronously before the first await; concurrent polls cannot duplicate refresh or probe work. Use the authoritative refreshed rows consistently. Preserve pending-only eligibility, bounded batches, cursor/backoff, minimum interval, unresolved physical-request suppression, local evidence application and independent send progress. No network await inside storage/admission coordination. Revocation during refresh prevents later probes or application; no late completion can revive a closed pass.

A durable refresh failure must reject the returned recovery promise and perform no probe/application using the stale candidate set. Preserve existing best-effort semantics for unrelated RPC failures; do not refactor all recovery error handling. Update the method's documentation to distinguish these outcomes. Existing host reporting is outside scope; do not claim a visible UI error merely because this boundary rejects. Ensure pass ownership is released after rejection so a later valid pass can recover, subject to explicit existing pacing.

## Exclusive implementation claim

Allowed production files: `packages/wallet/storage/evm-native-operation-journal.ts`, `packages/wallet/evm-input-admission.ts`, `packages/wallet/chain/evm-legacy-consolidator.ts`. Relevant co-located journal, admission, consolidator and recovery tests plus this evidence directory are allowed. Request parent coordination for any additional production scope. The sibling installed-identity worker owns `monad-chain.ts`, EVM config/qualification, app session and its fixtures; do not edit those. Its qualifier will precede this pass after parent combination, but this correction is independently meaningful on the base.

No persisted/wire-format or derivation changes; no migrations, deletion, reservations release, observation-generation changes, included-member policy changes, head tracking, rollback horizon or generalized freshness framework. Cached synchronous views may remain for their existing consumers; this packet gives the installed async pass an authoritative read, not universal cross-tab synchronization.

## Acceptance and handoff

First reproduce stale installed enumeration on the base with two real Level-backed wrappers. Then prove newly persisted signed/exposed pending work is recovered without reopen; changed/cancelled or now-included members are excluded; returned snapshots are detached; failed durable read/validation yields an observable rejection and zero probes/local application; concurrent polls share one refresh/pass; close during refresh prevents continuation; later recovery after a failed pass; repeated close/reopen; and admission projection reflects refreshed facts without permitting conflicting selection. Pin the actual execution/lifetime boundary rather than only a fake helper.

Rerun relevant journal observation-generation/capture races, admission and installed consolidator recovery suites, including physical timeout and unrelated-send concurrency. Run all configured `yarn typecheck:fast` projects, diff/format checks appropriate to changed files, and affected boundary checks. No redundant full wallet sweep if focused suites and types cover this scope. Coordinate the broad typecheck slot with the parent; sibling may be using it. Use only a local dependency overlay; do not install or mutate shared dependencies.

Record fail-before commands/results, final commands/logs, architecture/compression pass, limitations and exact revision in `reviews/native-recovery-refresh/evidence.md`. Freeze a clean candidate and hand off; no integration or agent attribution trailers.

## Immediate successor obligations retained

The parent owns the next separate contract for durable native reconciliation frontier/work and typed admission holds. Its scheduling must compare a durable frontier revision and retain original orphaned inclusion evidence before any downgrade. The current pending probe skips null receipts, so including confirmed members in its filter is insufficient. `commitSpend` is one-way: clearing journal inclusion/sync does not restore pool state, received funding provenance or later nonces. Do not enable automatic included-evidence downgrade or claim a financial hold until those effects have a tested typed owner. Full retained funding/spend recovery remains required by the user.
