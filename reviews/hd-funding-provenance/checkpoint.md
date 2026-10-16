# Implementation & Validation Checkpoint (`fix/hd-funding-provenance`)

Implemented retained HD funding provenance across the pool storage schema, Level store, wallet state validator, wallet bundle manifest v4 (`sub-account-pool-v4-funding-evidence`), input admission, chain construction, and `MonadSubAccountPool` on base `96c815df75c6f402e9220a28fc275fadb2d8d22d`.

## Key boundary guarantees

- **Retained row-owned funding collection (`SubAccountFundingCollection`)**:
  - Replaces transient `fundingAttempt` and singular `lifecycle.funding` with a durable, versioned (`version: 1`) collection of funding attempts (`rawTx`, `txHash`, `valueWei`, `generation`, `observation`) and optional multi-funder preparation `hold` (`operationId`, `expectedContributors`) on `SubAccountRecord` and `SubAccountTerminalCheckpoint`.
  - Transaction semantics (`from`, `to`, `nonce`, `value`, `chainId`, `gasLimit`, empty calldata/accessList, canonical serialized encoding) are validated from the signed bytes on registration and store reload; duplicate hashes or `(funder, nonce)` pairs are rejected.
  - Observations distinguish `unresolved` (`pending`, `unavailable`, `unknown-execution`, `inconsistent`), `superseded` (with pinned `accounts` proving `senderNonce > tx.nonce`), and `included` (`success` or `failure` with canonical `receiptBlock` and pinned `accounts`).
- **Generation CAS & multi-funder preparation hold**:
  - `recordFundingObservation` compares the captured `expectedGeneration` and `rawTx` inside `store.mutate`, incrementing `generation` on changed observations, treating identical replay as idempotent, refusing stale (`A -> B -> A`) completions or `MAX_SAFE_INTEGER` overflow, and preserving concurrent contributors.
  - Multi-funder burn preparation holds the target in `funding` under `funding.hold` until all expected contributors have verified `included` (`success`) observations and `completeHeldFundingPreparation` explicitly releases the hold. Interrupted preparations remain `funding` across reopen without inventing or repeating contributions.
- **Manifest v4 & incompatible format refusal**:
  - Advances `MONAD_WALLET_STORAGE_VERSION` to `4` with `POOL_SCHEMA_INTENT = "sub-account-pool-v4-funding-evidence"` and `CHANGE_POOL_SCHEMA_INTENT = "change-pool-v2"`, refusing pre-v4 manifests or envelopes before mutating durable state.

## Scope & Compression

- Production files (8):
  - `packages/wallet/monad-account-tx.ts`
  - `packages/wallet/storage/sub-account-pool-storage.ts`
  - `packages/wallet/storage/level-sub-account-pool-store.ts`
  - `packages/wallet/storage/monad-wallet-state-validator.ts`
  - `packages/wallet/storage/monad-wallet-bundle.ts`
  - `packages/wallet/evm-input-admission.ts`
  - `packages/wallet/chain/monad-chain.ts`
  - `packages/wallet/monad-account-pool.ts`

## Validation

- Fail-before (`reviews/hd-funding-provenance/base-loss.log`): `reviews/hd-funding-provenance/base-loss.jest.test.ts` failed against base before retained provenance implementation.
- Typechecks (`reviews/hd-funding-provenance/checkpoint-typecheck.log`): `yarn typecheck:fast` — 25/25 TypeScript projects passed (`0` failures).
- Affected Jest suites (`reviews/hd-funding-provenance/checkpoint-after.log`): 10 suites, 504 tests passed (`0` failures):
  - `reviews/hd-funding-provenance/base-loss.jest.test.ts` (8 tests)
  - `packages/wallet/funding-observation.jest.test.ts`
  - `packages/wallet/storage/monad-wallet-bundle.jest.test.ts`
  - `packages/wallet/storage/authoritative-pool-mutations.jest.test.ts`
  - `packages/wallet/storage/pool-review-regressions.jest.test.ts`
  - `packages/wallet/evm-input-admission.jest.test.ts`
  - `packages/wallet/chain/monad-parallel-send.jest.test.ts`
  - `packages/wallet/chain/monad-fund-ahead.jest.test.ts`
  - `packages/wallet/chain/monad-domain-wallet.jest.test.ts`
  - `packages/wallet/monad-account-pool.jest.test.ts`
