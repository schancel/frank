# Q1 implementation evidence

Base: `c6179974ca49de18253fef1f85622604219cfa12`. Branch: `refactor/async-wallet-observations`. Coordinator contract: [contract.md](contract.md).

Both optional `NativeWalletHandle` observation queries now return Promises. EVM, Solana, UTXO and eCash implementations preserve their prior query results. Callers await the result. eCash still reads current ledger exclusions; no ledger, persistence, custody, transaction or recovery format changed. The app checks account readiness, account revision, configured network and request generation after each awaited observation. The second observation supplies the refreshed timestamp. Observation rejection retains the last valid presentation and exposes an error.

## Gates

| Gate | Exact command and result |
| --- | --- |
| Configured typechecks | Root: `yarn typecheck:fast`; 22/22 projects pass. Main enumerates 21 package tsconfigs plus custody. S0 separately adds `packages/contracts/tsconfig.adaptor-tests.json`, explaining its 23-project count. |
| Wallet behavior | From `packages/wallet`: `../../node_modules/.bin/jest --runInBand --runTestsByPath ecash-preparation.jest.test.ts utxo-wallet.jest.test.ts solana-wallet.jest.test.ts chain/contact-payment.jest.test.ts chain/monad-contract-call-composition.jest.test.ts chain/chain-factory.jest.test.ts`; 6/6 suites, 215/215 tests pass, natural exit. |
| App balance | From `app`: `../node_modules/.bin/jest --config test/jest/accounts.config.cjs --runInBand --runTestsByPath src/composables/useChainBalance.jest.test.ts`; 51/51 tests pass. |
| Mutation sensitivity | Same app command with `-t 'discards a delayed'`, temporarily removing only the two new post-observation fences: 4 failed, 2 passed. Restored production source then passes the full app suite. |
| Livecheck compile only | Root: `node_modules/.bin/tsgo -p /tmp/async-wallet-observations-livechecks.tsconfig.json --noEmit`; passes. Temporary config extends wallet production config, includes `ecash-wallet.livecheck.ts`, `utxo-chains.live.jest.test.ts`, wallet `level.d.ts` / `ecash-wallet-sdk.d.ts`, and bitcore ambient declarations, with candidate-local type roots. `parallel-send.livecheck.ts` is included in the configured bot project. No livecheck executed. |
| Diff hygiene | `git diff --check` passes; only contract-authorized files changed. |

Eight new cases cover delayed initial/refreshed observations after request replacement, account revision changes and session unavailability, plus rejected initial/refreshed observations preserving a valid display. An existing local-before-refresh test additionally checks that the final timestamp comes from the refreshed observation. Existing all-family reservation, unresolved-attempt and original-retry tests retain their assertions with awaited queries.

## Environment and limits

Worktree-local dependency overlays linked installed third-party dependencies and resolved `@frank/*` to this checkout; no dependency manifests changed. Temporary livecheck configuration initially lacked ambient type/declaration roots; supplying the existing repository declarations resolved those configuration-only failures.

Assigned lane: GPT-6.1 Sol medium. The running inherited agent does not expose a separate runtime-model identifier to verify beyond that assignment.

The async eCash ledger/store is a successor. This candidate does not make browser storage strictly durable or implement atomic swaps. Independent review and root integration remain required; PR #1692 overlapping receive-address changes were not absorbed. No push, external publication, merge, deployment or funded execution occurred.
