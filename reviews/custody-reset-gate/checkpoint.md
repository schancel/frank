# H2 Browser Custody Reset Gate & Message/Chat Reset Separation — Checkpoint

## 1. Frozen Candidate Summary

- **Worktree**: `/Users/shammah/repos/frank/.worktrees/custody-reset-gate`
- **Branch**: `feat/custody-reset-gate`
- **Base Commit**: `2d5f0f8636ff876158f3fd2f88c27922c5ca5e2c` (`integration/atomic-swaps-current-main`)
- **Contract**: [reviews/custody-reset-gate/contract.md](file:///Users/shammah/repos/frank/.worktrees/custody-reset-gate/reviews/custody-reset-gate/contract.md)

## 2. Production Changes

1. **Custody Reset API & Durable Fencing (`app/src/accounts/custody/{types.ts,retention.ts,index.ts,README.md}`)**:
   - Added `reset(cleanup?: () => Promise<void>): Promise<CustodySnapshot>` to `AccountCustody` and exported `resetAccountCustody({ namespace, cleanup })`.
   - Extended `RetentionRecord` (`retention-v1` row in `frank-account-custody-<namespace>`) with optional `resetting?: true`.
   - `parseRetention` permits `resetting: true` only when `holds.length === 0`.
   - `retentionSnapshot` and `snapshot` reject with `CustodyError('locked')` while `resetting: true`.
   - `acquireRetention`, `releaseRetention`, `update`, and `readOpen` reject with `CustodyError('conflict')` while `resetting: true`.
   - `beginResetRetention(account, retention)` rejects with `CustodyError('conflict')` when `retention.holds.length > 0`, advances `nextGeneration` once when retiring any active or pending account (`active !== null || pending !== null`), and sets `resetting: true`.
   - `custody.reset(cleanup)` executes a 3-phase durable protocol:
     1. Atomically verify `holds.length === 0`, advance `nextGeneration` if retiring any account, and persist `resetting: true`, then revoke local untaken capabilities.
     2. Revalidate the `resetting` fence before retiring `pending` and `active` secrets in `frank-preview-vault-<namespace>` via `vault.discardIntent(writeIntent(account))` (deleting wrapped AES-GCM keys and ciphertexts while preserving anti-resurrection creation-slot fences) and awaiting `cleanup?.()`.
     3. Atomically clear `account` to `{ schema: 1, revision: 0, active: null, pending: null }` and `retention` to `{ schema: 1, nextGeneration, holds: [] }` (removing `resetting`).

2. **Session Reset Gate & Chat Reset Isolation (`app/src/accounts/session.ts`)**:
   - Updated `session.reset()` to pre-check `custody.retentionSnapshot()` when `state.status === 'ready'` (rejecting with `CustodyError('conflict')` before closing the active runtime wallet if any hold exists) and wrapped teardown/reset in `try / finally { deps.notify?.(); await runRefresh() }` so failed resets restore truthful session state.
   - Updated `resetAccountStorage(namespace)` to delegate through `resetAccountCustody({ namespace, cleanup })`, never calling `indexedDB.deleteDatabase` on `frank-account-custody-*` or `frank-preview-vault-*`, and failing closed on `onblocked` (`unavailable`) or `onerror` (`storage-failed`).
   - Isolated `resetMessageAndChatStorage()` so it deletes only `MessageStore*` and `vuex-store*` databases, never calls `listAllocatedWalletDatabases()` / `clearAllWalletDatabases()`, never touches wallet/swap/custody/vault databases, and fails closed on `onblocked` (`unavailable`) or `onerror` (`storage-failed`).

## 3. Verification Evidence

- **Fail-before evidence**:
  - Prior to H2, `resetAccountStorage` called `indexedDB.deleteDatabase` directly on `frank-account-custody-<namespace>` and `frank-preview-vault-<namespace>` without checking `retention-v1` holds or preserving `nextGeneration`, and swallowed `onblocked` as success.
  - Prior to H2, `resetMessageAndChatStorage` included `name.includes('monad-wallet-state') || name.includes('level-js')` and called `clearAllWalletDatabases()`, deleting local wallet databases during a message/chat reset.
- **Pass-after gates**:
  - `yarn workspace frank typecheck:custody`: PASS
  - `yarn workspace frank test:custody`: PASS (Chrome 155 real-browser suite: stage 3, activate 4, reopen 20, regressions 664 assertions; 0 network calls/logs)
  - `yarn --cwd app test:unit src/accounts/session.jest.test.ts src/pages/Setup.repairs.jest.test.ts`: PASS (2 test suites, 131 tests)
  - `yarn typecheck:fast`: PASS (25/25 TypeScript projects)
