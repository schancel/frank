# Current-main integration validation

Exact tested candidate: `49b09a04cc697df5633b7b451981b817860d98e2`, before this evidence-only commit. The coordinator rebased S0 onto current main `c6179974ca49de18253fef1f85622604219cfa12`, then transported reviewed Q1. This validation changed no source, dependency manifest, or lockfile.

## Exact-candidate gates

All completed gates exited naturally with code 0. Commands below run from the named directory; logs are disposable local files under `/tmp/frank-current-main-*.log`.

| Directory | Command | Result |
| --- | --- | --- |
| Root | `yarn typecheck:fast` | 23/23 configured projects pass, including the adaptor composition project |
| `packages/frank-codec` | `../../node_modules/.bin/jest --runInBand` | 36 suites, 1430 tests pass |
| `packages/frank-codec` | `node scripts/renumber-signed-vectors.cjs --check` | Pass |
| `packages/wallet` | `../../node_modules/.bin/jest --runInBand --runTestsByPath ecash-preparation.jest.test.ts utxo-wallet.jest.test.ts solana-wallet.jest.test.ts chain/contact-payment.jest.test.ts chain/monad-contract-call-composition.jest.test.ts chain/chain-factory.jest.test.ts message-item-plugins/swap-offer/plugin.jest.test.ts message-item-plugins/swap-offer/serialization.jest.test.ts message-item-plugins/swap-record/plugin.jest.test.ts message-item-plugins/wire.jest.test.ts` | 10 suites, 318 tests pass; 217.397 seconds |
| `app` | `../node_modules/.bin/jest --config test/jest/accounts.config.cjs --runInBand --runTestsByPath src/composables/useChainBalance.jest.test.ts` | 51 tests pass |
| `packages/cashweb` | `../../node_modules/.bin/jest --runInBand --runTestsByPath relay/canonical-dm-stamp.jest.test.ts relay/canonical-dm-transport.jest.test.ts relay/canonical-dm.jest.test.ts relay/monad-mailbox-client.jest.test.ts` | 4 suites, 183 tests pass |
| `packages/threshold-ecdsa` | `../../node_modules/.bin/jest --runInBand` | 6 suites, 94 tests pass |
| `packages/adaptor-signatures` | `../../node_modules/.bin/jest --runInBand` | 6 suites, 53 tests pass |
| `packages/swap-protocol` | `../../node_modules/.bin/jest --runInBand` | 3 suites, 28 tests pass |
| `packages/wallet` | `../../node_modules/.bin/jest --runInBand --runTestsByPath threshold-custody/uncertainty-journal.jest.test.ts` | 36 tests pass |
| `packages/bot` | `../../node_modules/.bin/jest --runInBand --runTestsByPath demo/regtest/threshold-adaptor/import-safety.jest.test.ts demo/regtest/threshold-adaptor/native-digests.jest.test.ts` | 2 suites, 6 tests pass |
| Root | `git diff --check` | Pass |

While the combined wallet run was unresolved, isolated checks additionally passed eCash preparation (12), Solana wallet (33), contract-call composition (10), chain factory (13), and swap plugin/wire (103) tests. These duplicate checks are not added to the combined count. The redundant standalone contact-payment run was stopped with SIGTERM after the combined gate passed; it supplies no acceptance evidence. The combined run was not interrupted or force-exited. Expected simulated submission warnings do not change its passing result.

## Dependency qualification

Isolated checkout-local `node_modules` overlays link installed third-party dependencies, while all 22 root `@frank/*` workspace links resolve exclusively into this candidate's `packages/` directory. Package-local dependency overlays preserve the installed wallet-specific Chronik version, verified as 4.3.1. Overlays remain in this isolated checkout for later combined validation, as requested. No shared dependency directory was modified.

## Native-source equivalence and limits

Both commands produce no differences:

```sh
git diff --name-status a6ec2e3b 49b09a04 -- packages/bot/demo/regtest packages/threshold-ecdsa packages/adaptor-signatures packages/contracts packages/nakamoto
git diff --name-status 7c31ee8c 49b09a04 -- packages/bot/demo/regtest packages/threshold-ecdsa packages/adaptor-signatures packages/contracts packages/nakamoto
```

Thus the native executable fixtures, native transaction construction dependencies, cryptographic implementation, and contracts are unchanged from the prior S0 code candidate and rebased S0. This is source equivalence, not fresh native execution evidence. Q1's separate `packages/bot/parallel-send.livecheck.ts` change awaits observations and compiles in the configured bot gate.

No ABC/Anvil experiment, live funded check, deployment, push, or merge ran. Existing native public evidence remains historical evidence from its recorded candidate. These gates establish the tested integration and Q1 observation behavior; they do not complete atomic-swap runtime, encrypted threshold custody, malicious cryptographic assurance, or authorization to lift the protected release hold. Independent review remains separate.
