# Independent Code Review: H2 (`custody-reset-gate`)

- **Verdict**: `SAFE TO INTEGRATE`
- **Candidate Commit Reviewed**: `839c9ace4bcde154672f6dc26a14b0507ab8b592` (`feat/custody-reset-gate`)
- **Base Commit**: `2d5f0f8682c0710ff838cb29d573eaf7b93133d1` (`integration/atomic-swaps-current-main`)
- **Reviewer**: Independent Code Reviewer (`92c5fc8e-7b96-41be-a04c-9966c652da6b`)

---

## Perspectives Evaluated

1. **Custody & Retention Invariants (`app/src/accounts/custody/{types.ts,retention.ts,index.ts,README.md}`)**
   - **Atomic hold check before destructive action**: Verified that `custody.reset(cleanup)` first validates `cleanup === undefined || typeof cleanup === 'function'` (`CustodyError('invalid-input')`), then runs `beginResetRetention(account, retention)` inside a single readwrite IndexedDB transaction over `state` (`account` + `retention-v1`). If `account` or `retention-v1` is corrupt (including `resetting !== true` or `resetting === true` alongside non-empty `holds`), `parse` / `parseRetention` throws `CustodyError('locked')` before any write or cleanup occurs. If `retention.holds.length > 0`, `beginResetRetention` throws `CustodyError('conflict')` before any vault retirement or external cleanup runs.
   - **Durable `resetting?: true` fence in `retention-v1`**: Verified that Step 1 persists `resetting: true` on `retention-v1`. While `resetting === true`, `retentionSnapshot()` and `read()` (`snapshot()`, initial reads of `openActive()` and `exportAccountRoot()`) throw `CustodyError('locked')`; `readOpen()` (mid-operation rechecks and `reconcile`/`activate`/`openPending`/`openPendingBip39Seed`), `update()` (`stage`/`cancel`), `acquireRetention()`, and `releaseRetention()` throw `CustodyError('conflict')`.
   - **Preservation of custody & preview-vault namespaces and monotonic `nextGeneration`**: Verified that neither `custody.reset`, `resetAccountCustody`, nor `resetAccountStorage` ever calls `indexedDB.deleteDatabase` on `frank-account-custody-<namespace>` or `frank-preview-vault-<namespace>`. Active and pending vault slots are retired through `vault.discardIntent` so creation-slot fences remain intact in `frank-preview-vault-<namespace>`. `beginResetRetention` advances `nextGeneration` by 1 when `account.active !== null || account.pending !== null` (checking `Number.MAX_SAFE_INTEGER` for `capacity`) and preserves `retention` unchanged if `retention.resetting` is already `true` so retrying an interrupted reset never double-increments `nextGeneration`.
   - **Cross-instance race safety during async cleanup**: Verified that `assertFenced()` re-verifies `retention.resetting === true && retention.nextGeneration === fenced.retention.nextGeneration && same(account, fenced.account)` before each `vault.discardIntent`, before `await cleanup()`, and inside the final Step 3 readwrite transaction, preventing a paused/late reset from clobbering a post-reset successor account.

2. **Session & Storage Reset Boundaries (`app/src/accounts/session.ts`)**
   - **`session.reset()`**: Verified that when `state.status === 'ready'`, `session.reset()` checks `await custody.retentionSnapshot()` and throws `CustodyError('conflict')` if `retention.holds.length > 0` before incrementing `generation`, setting `state.status = 'loading'`, or tearing down the live wallet via `release()`. If `deps.reset()` or `resetAccountStorage()` fails mid-flight (e.g., due to a concurrent hold, blocked DB deletion, or storage failure), the `finally { deps.notify?.(); await runRefresh() }` block restores truthful session state.
   - **`resetAccountStorage(namespace)`**: Verified that it delegates through `resetAccountCustody({ namespace, cleanup })`, filters candidate databases via `isAccountResetDatabaseName` (explicitly excluding `frank-account-custody-*` and `frank-preview-vault-*`), and maps `indexedDB.deleteDatabase` `onblocked` to `CustodyError('unavailable')` and `onerror`/exceptions to `CustodyError('storage-failed')`.
   - **`resetMessageAndChatStorage()`**: Verified that `isMessageOrChatDatabaseName` matches only `MessageStore`, `MessageStore/*`, `level-js-MessageStore`, `level-js-MessageStore/*`, `vuex-store`, `vuex-store/*`, `level-js-vuex-store`, and `level-js-vuex-store/*` (falling back to `DEFAULT_MESSAGE_AND_CHAT_DATABASES` when `indexedDB.databases` is unavailable), never touching wallet, swap, custody, or preview-vault databases.

3. **Test Quality (`app/src/accounts/custody/test/suite.ts`, `app/src/accounts/session.jest.test.ts`)**
   - Verified the 3 new real-Chrome regression tests in `suite.ts` covering concurrent `acquireRetention` vs `reset` races, mid-reset admission fencing (`locked` vs `conflict`), interrupted cleanup recovery without double-incrementing `nextGeneration`, capability revocation on `reset`, and late-reset fencing against a successor account.
   - Verified the Jest tests in `session.jest.test.ts` covering `session.reset()` hold refusal and state restoration, `resetAccountStorage()` end-to-end hold/blocked/error/corrupt-record handling with `fake-indexeddb`, and `resetMessageAndChatStorage()` database isolation and error mapping.

---

## Findings

- **CONFIRMED**: None (0 blocking or non-blocking defects found).
- **PLAUSIBLE**: None.
- **SETTLED**:
  1. *Could a retry after an interrupted `resetAccountStorage` double-increment `nextGeneration` or skip `cleanup()`?* — **SETTLED**: In `beginResetRetention` (`app/src/accounts/custody/retention.ts:132`), if `retention.resetting` is already `true`, `retention` is returned unchanged with the already-incremented `nextGeneration`, and `account` (`active`/`pending`) is only cleared in Step 3 after `vault.discardIntent` and `await cleanup()` both succeed. Tested in both `suite.ts` (`reset fences admission across its destructive lifecycle and recovers after interrupted cleanup`) and `session.jest.test.ts`.
  2. *Could a paused `reset()` whose `cleanup()` resolves after another instance has already completed reset and activated a new account overwrite the new account in Step 3?* — **SETTLED**: `assertFenced()` and Step 3 (`app/src/accounts/custody/index.ts:624-662`) check `same(account, fenced.account)` and `retention.nextGeneration === fenced.retention.nextGeneration`, throwing `CustodyError('conflict')` if another reset completed and a successor was staged/activated. Tested in `suite.ts` (`reset revokes local untaken capabilities and a paused reset cannot clobber a post-reset successor`).
