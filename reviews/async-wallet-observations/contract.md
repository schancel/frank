# Q1: asynchronous wallet observations

Coordinator-authored implementation contract. Base: `c6179974ca49de18253fef1f85622604219cfa12`. Branch: `refactor/async-wallet-observations`. Implementation owner: blackjack_evidence, GPT-6.1 Sol medium; independent review and integration: root. Local candidate only; no push, merge, deployment or funded execution.

## Outcome and architecture

Atomic-swap recovery needs truly durable asynchronous storage. The shared synchronous observation methods currently prevent callers from awaiting authoritative reads. Change the optional `NativeWalletHandle.getBalanceObservation` and `getUnresolvedNativeTransaction` methods to Promise-returning methods across every implementation and caller. Wallet state remains authoritative; UI observations remain derived. No wire or persistent format changes occur in Q1.

EVM, Solana and UTXO implementations return equivalent values asynchronously. Preserve eCash's current-ledger reservation filtering, including the current-main balance correction. The eCash ledger remains synchronous here. Its subsequent asynchronous durable-store replacement is a separate predecessor to the atomic-swap feature, with its own contract and review. Do not add MaybePromise, compatibility aliases, cached replacements or fire-and-forget reads.

`useChainBalance` awaits each observation and rechecks existing account/session/request-generation fences after each new await before publishing results. Preserve the second observation when needed to obtain refreshed timestamps. Rejected reads retain a previous valid display; they must not publish a fabricated zero or stale result.

## Exclusive scope

- `app/src/composables/useChainBalance.ts` and its Jest test.
- `packages/bot/parallel-send.livecheck.ts`.
- `packages/wallet/chain/chain-wallet.ts`, `chain-factory.jest.test.ts`, `contact-payment.jest.test.ts`, `monad-chain.ts`, `monad-contract-call-composition.jest.test.ts`.
- `packages/wallet/ecash-wallet.ts`, `ecash-wallet.livecheck.ts`, `ecash-preparation.jest.test.ts`, `solana-wallet.ts`, `solana-wallet.jest.test.ts`, `utxo-wallet.ts`, `utxo-wallet.jest.test.ts`, `utxo-chains.live.jest.test.ts`.
- Evidence in this review directory.

No changes to `EcashOperationStore`, concrete `getEcashOperations`/`getStealthReceipts`, custody, schemas, configuration, recovery algorithms, UI layout or dependency manifests. Directly required awaited internal calls are in scope. Report additional callsites before extending ownership. PR #1692 overlaps some files for a separate receive-address behavior; do not absorb or mutate it. Root owns later integration checks.

## Acceptance and reversal

Run all configured `yarn typecheck:fast` projects and focused affected app and all-family wallet suites. Add meaningful delayed-observation regressions covering account/session and request-generation replacement, plus rejected asynchronous observation preserving a valid display. Existing reservation filtering and unresolved-attempt behavior must remain equivalent. Livecheck callsites must compile, but do not execute funded checks.

Retain the wallet facade and dependency direction; no application feature imports enter wallet. New async storage will be able to implement these methods without changing caller contracts again. This is a source API replacement with no temporary dual API. Reversal is a coordinated source revert, with no data migration or deletion. If implementation discovers a changed state owner or persistent format, stop and split that successor rather than expanding Q1.
