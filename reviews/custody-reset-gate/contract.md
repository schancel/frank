# H2: browser custody reset admission fence and message/chat reset separation

Root-authored Tier-3 contract. Base `2d5f0f8636f1c52d257bbdeaaab02749573b219b`; branch `feat/custody-reset-gate`. H0 read-only opening and H1 retention holds are integrated and independently reviewed. Local candidate only; no push, main merge, deployment, funded operation, or user-data deletion. Independently reviewed before local integration.

## Outcome and boundary

`H1` added durable operation retention holds (`retention-v1`) in the custody `state` object store and wired replacement exclusion and cleanup reauthorization, but explicitly deferred destructive reset protection to `H2`:
1. `resetAccountStorage` (`app/src/accounts/session.ts`) previously deleted `frank-account-custody-<namespace>` and `frank-preview-vault-<namespace>` via `indexedDB.deleteDatabase` without checking retention holds or corrupt state, erasing `retention-v1` and `nextGeneration`, and silently resolving after 300ms when `deleteDatabase` was blocked or errored.
2. `resetMessageAndChatStorage` (`app/src/accounts/session.ts`) previously called `listAllocatedWalletDatabases()`, `clearAllWalletDatabases()`, and deleted `level-js`, `monad-wallet-state`, and `frank-wallet-` databases alongside message/chat databases, and silently resolved on blocked/errored deletions.

`H2` closes both holes so destructive local account reset/logout is gated and fenced by custody retention authority across its entire destructive lifecycle, and message/chat reset is strictly isolated from wallet, swap, eCash, custody, and vault databases.

## Durable custody reset semantics (`app/src/accounts/custody/`)

- **Durable reset fence in `retention-v1`**:
  - Extend `RetentionRecord` with optional `resetting?: true` (`{ schema: 1, nextGeneration, holds, resetting?: true }`). When not resetting, the persisted row remains `{ schema: 1, nextGeneration, holds }`.
  - `parseRetention` validates `resetting`: only `resetting === true` with `holds.length === 0` is valid; any non-true value or non-empty `holds` while `resetting` is present fails closed with `CustodyError('locked')`.
  - While `retention.resetting === true`:
    - `snapshot()`, `retentionSnapshot()`, `openActive()`, and `exportAccountRoot()` reject with `CustodyError('locked')` (or `CustodyError('conflict')` if a reset begins mid-operation after initial snapshot).
    - `acquireRetention()`, `stage()`, `activate()`, `cancel()`, `reconcile()`, `openPending()`, and `openPendingBip39Seed()` reject with `CustodyError('conflict')`.
    - `openAccountCustody({ namespace })` validates structural integrity via `custodyTransaction` and succeeds when `resetting: true` is structurally valid so a caller can invoke `reset()` to complete an interrupted reset, while still rejecting with `CustodyError('locked')` on corrupt `account` or `retention-v1` records.
- **`custody.reset(cleanup?)` and `resetAccountCustody({ namespace, cleanup? })`**:
  - Synchronously validate `cleanup` (`cleanup !== undefined && typeof cleanup !== 'function'` throws `CustodyError('invalid-input')`).
  - **Step 1 (Atomic Admission Fence & Hold/Corruption Gate)**:
    - In a strict `readwrite` transaction on `frank-account-custody-<namespace>` (`state` store), parse and validate `account` and `retention-v1` (corrupt records abort with `CustodyError('locked')`; blocked/unavailable DB aborts with `CustodyError('unavailable')`).
    - If `retention.holds.length > 0`, abort with `CustodyError('conflict')` before any vault or database destruction.
    - If `!retention.resetting`, require `retention.nextGeneration < Number.MAX_SAFE_INTEGER` (else `CustodyError('capacity')`) and atomically persist `{ schema: 1, nextGeneration: retention.nextGeneration + 1, holds: [], resetting: true }` while retaining `account` (`active` and `pending` receipts) as durable cleanup targets. If `retention.resetting` is already `true` from an interrupted reset, preserve `nextGeneration` without double-incrementing.
  - **Step 2 (Bounded Vault Retirement & External Cleanup)**:
    - Reauthorize that the exact fenced reset generation and account state remain current before each destructive step.
    - If `fencedAccount.pending` is present, retire its vault slot via `vault.discardIntent(writeIntent(fencedAccount.pending.account))` (deleting wrapped key and ciphertext while recording the anti-resurrection fence tombstone).
    - If `fencedAccount.active` is present, retire its vault slot via `vault.discardIntent(writeIntent(fencedAccount.active))`.
    - If `cleanup` is supplied, reauthorize fence ownership and await `cleanup()`. Any error thrown by `cleanup()` aborts before Step 3, leaving `resetting: true` durable on disk so the partially cleaned state cannot be used until a retry completes reset.
  - **Step 3 (Atomic Reset Completion)**:
    - In a strict `readwrite` transaction on `frank-account-custody-<namespace>`, verify the exact reset generation and fenced account state (or return idempotently if a concurrent/lost-ack completion of the exact same generation already committed `{ active: null, pending: null }` with no successor), and persist `account: { schema: 1, revision: 0, active: null, pending: null }` and `retention-v1: { schema: 1, nextGeneration, holds: [] }`.
  - Never delete `frank-account-custody-<namespace>` or `frank-preview-vault-<namespace>` via `indexedDB.deleteDatabase`, preserving `retention-v1` `nextGeneration` and vault anti-resurrection fences across resets.

## Session & storage reset helpers (`app/src/accounts/session.ts`)

- **`resetAccountStorage(namespace = 'local-account-v1')`**:
  - Delegates through `resetAccountCustody({ namespace, cleanup })` so direct callers and `session.reset()` enforce the custody hold gate, corruption gate, and admission fence before touching any wallet or chat database.
  - Inside `cleanup`: deletes allocated wallet databases and `frank-*` / `monad-wallet-state*` / `level-js*` / `MessageStore*` / `vuex-store*` databases (excluding `frank-account-custody-*` and `frank-preview-vault-*`), failing closed with `CustodyError('unavailable')` on `onblocked` and `CustodyError('storage-failed')` on `onerror`.
- **`resetMessageAndChatStorage()`**:
  - Strictly isolated from wallet, swap, eCash, custody, and vault databases.
  - Never calls `listAllocatedWalletDatabases()` or `clearAllWalletDatabases()`.
  - Deletes only message/chat databases (`MessageStore`, `MessageStore/*`, `level-js-MessageStore`, `level-js-MessageStore/*`, `vuex-store`, `vuex-store/*`, `level-js-vuex-store`, `level-js-vuex-store/*`), failing closed with `CustodyError('unavailable')` on `onblocked` and `CustodyError('storage-failed')` on `onerror`.
- **`session.reset()`**:
  - When ready with no custom `deps.reset`, checks `custody.retentionSnapshot()` before tearing down the live wallet handle; wraps teardown and reset in `try / finally` so `deps.notify?.()` and `await runRefresh()` always restore accurate session state when reset rejects.

## Scope and proof

- Allowed files:
  - `app/src/accounts/custody/{index.ts,retention.ts,types.ts,README.md}`
  - `app/src/accounts/custody/test/suite.ts`
  - `app/src/accounts/session.ts`
  - `app/src/accounts/session.jest.test.ts`
  - `reviews/custody-reset-gate/{contract.md,checkpoint.md,review.md}`
- Verification:
  - `yarn workspace frank typecheck:custody`
  - `yarn workspace frank test:custody` (real Chrome multi-tab/crash harness)
  - `yarn --cwd app test:unit src/accounts/session.jest.test.ts`
  - `yarn typecheck:fast`
