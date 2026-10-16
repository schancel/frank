# Implementation & Validation Checkpoint (`fix/funding-observation`)

Implemented `observeFunding(input: EvmFundingObservationInput): Promise<EvmFundingObservation>` on `MonadAccountTxSigner` in `packages/wallet/monad-account-tx.ts`, exporting `EvmFundingObservationInput`, `EvmFundingBlock`, `EvmFundingAccounts`, and `EvmFundingObservation`. Existing `getStatus` and all callers remain unchanged.

## Key boundary guarantees

- **Synchronous pre-RPC input validation and snapshotting**: validates canonical hex `rawTx` and `txHash`, exact serialized match (`transaction.serialized`), valid signature recovery matching `funder` and `this.address`, checksummed `recipient` matching `transaction.to`, positive `chainId` matching `transaction.chainId`, safe nonnegative `nonce`, positive `gasLimit` and `value`, empty calldata (`"0x"`), plain transfer type (`0`, `1`, or `2`) with empty `accessList`. Any invalid caller binding throws before RPC.
- **Anchored receipt and account observation**:
  - When a receipt is returned, validates `txHash`, safe nonnegative `blockNumber`, 32-byte hex `blockHash`, execution status (`"unknown"` returns `{ kind: "unresolved", reason: "unknown-execution" }`; `"success"` / `"failure"` verify canonical `provider.getBlock(anchor.number)` before and after pinned account reads at `anchor.number`, requiring `senderNonce > nonce`).
  - When no receipt is returned, pins `anchor` from `provider.getBlock("latest")`, reads `senderNonce`, `recipientNonce`, and `recipientBalance` at `anchor.number`, re-queries `getTransactionReceipt(hash)` to guard against a receipt appearing while nonce reads were in flight, and re-verifies `provider.getBlock(anchor.number)` matches `anchor.hash`. Reports `superseded` only when `senderNonce > nonce` and the receipt remains absent; otherwise reports `unresolved` (`pending`). Positive recipient balance without a receipt never implies success.
  - Malformed RPC/evidence payloads resolve to `{ kind: "unresolved", reason: "inconsistent" }`; thrown RPC errors resolve to `{ kind: "unresolved", reason: "unavailable" }`.

## Validation

- Fail-before (`reviews/funding-observation/checkpoint-before.log`): `node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/funding-observation.jest.test.ts` failed 27 tests at base `c3e0fdbe` (`f.signer.observeFunding is not a function`).
- Focused signer suites (`reviews/funding-observation/checkpoint-after.log`): `node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/funding-observation.jest.test.ts packages/wallet/monad-account-tx.jest.test.ts` — 2 suites, 49 tests passed.
- Typechecks (`reviews/funding-observation/checkpoint-typecheck.log`): `yarn typecheck:fast` — 25/25 projects passed.
