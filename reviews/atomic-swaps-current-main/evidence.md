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

## Combined Q2 and P1 boundary validation

Exact tested candidate: `cce216306a2d0dc1a0150abbd2be21dc27a9aa0c`, before the evidence-only commit appending this section. Q2 is integrated as `cc478dcb1aec1cc49faf028d25c727bea503ab7d`; P1 is integrated as `cce216306a2d0dc1a0150abbd2be21dc27a9aa0c`.

Source equivalence was checked before testing:

- `git diff --binary 07f3cfbb 6a23` equals `git diff --binary cc478dcb^ cc478dcb` byte for byte. All seven Q2 changed files also match their reviewed source contents exactly. Stable patch ID: `18efe43933528a297f7b1ee18df57fe50c4f3909`.
- P1 original `2ce17775436ce7d7ffc1fb4206370deb62dd8a13` and integrated `cce21630` have identical patch hunks and stable patch ID `43e03bea45bdafa2d6df9d4d757a5783d4fde128`. Raw patch bytes differ only in the `packages/cashweb/types/messages.ts` index blob IDs. Eight of nine changed files are content-identical. The remaining file preserves the current-main `Message.contentDigest` field, absent on P1's source base; the same difference exists between both parents, so this is inherited integration context, not a changed P1 hunk.

All following gates completed naturally with exit code 0:

| Directory | Exact command | Result |
| --- | --- | --- |
| Root | `yarn typecheck:fast` | 23/23 projects pass |
| `packages/wallet` | `../../node_modules/.bin/jest --runInBand --runTestsByPath ecash-operation-store.jest.test.ts ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts ecash-wallet.jest.test.ts` | 4 suites, 56 tests pass |
| `app` | `../node_modules/.bin/jest --config test/jest/accounts.config.cjs --runInBand --runTestsByPath src/accounts/session.jest.test.ts` | 101 tests pass |
| `packages/wallet` | `../../node_modules/.bin/jest --runInBand --runTestsByPath message-item-plugins/application-item.jest.test.ts message-item-plugins/registry.jest.test.ts message-item-plugins/wire.jest.test.ts message-item-plugins/decoder-limits.jest.test.ts message-item-plugins/default-registry.jest.test.ts chain/canonical-item-roundtrip.jest.test.ts` | 6 suites, 1080 tests pass; canonical two-wallet transport, decoder budgets, default registry and application carrier included |
| Root | `git diff --check` | Pass |

Logs: `/tmp/frank-current-main-combined-typecheck.log`, `/tmp/frank-current-main-combined-ecash.log`, `/tmp/frank-current-main-combined-session.log`, `/tmp/frank-current-main-combined-p1.log`.

The retained candidate-local dependency overlays were reused. No source changed during validation. The native/threshold/contract/Nakamoto paths listed above have no differences from the previously tested `49b09a04`; unchanged base/native/cryptographic gates were not repeated. Q2 awaits I/O but does not qualify the localStorage adapter as strictly durable; Q3 adapter/lifecycle work remains separate. P1 supplies a generic carrier and transport evidence, not atomic-swap runtime activation. No push, merge, deployment or funded execution occurred.

## Combined Q3a and H0 qualification

Exact tested candidate: `a4183bf770af4e491309875ee46e451b57bedff5`, before this evidence-only addition. All 13 files introduced by integrated Q3a `f67de4f3ba659e2bef82d5da9827345217a9cc01` match reviewed source `836f96d8` byte for byte. All 11 files changed by integrated H0 `a4183bf7` match reviewed source `6958f1931059392f9d811aba32557f8388a226f6` byte for byte. Their source scopes are disjoint.

| Command from repository root | Exact-tip result |
| --- | --- |
| `yarn typecheck:fast` | 23/23 configured projects pass |
| `cd packages/wallet && ../../node_modules/.bin/jest storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand` | 2 suites, 8 tests pass using actual native Level |
| `node packages/wallet/storage/ecash-operations/browser-test.mjs` | Actual Chrome 155.0.8059.40 passes all phases, process restart and two independent-page updates |
| `yarn --cwd app test:custody` | Stage/activate/process-reopen pass; 364 regression assertions; zero network/log effects |
| `yarn --cwd packages/account-vault test` | Create/process-reopen with exact root bytes pass; 269 regression assertions |
| `yarn --cwd packages/account-vault test:node` | 5/5 tests pass |
| `git diff --check` | Pass |

Every gate exited naturally with code 0. Logs use `/tmp/frank-current-main-h0-q3a-{typecheck,native,browser,custody,vault,node}.log`. Retained candidate-local dependency overlays were reused and preserved. No source changes or unrelated crypto/native-chain reruns occurred. Adapter qualification does not install a production host/default or solve lifecycle/retention/reset policy; those successor boundaries remain separate. No push, merge, deployment or funded activity occurred.

## S5a repaired negotiation integration

Exact tested candidate: `10c55621bed385a1967c82d92009c1fb30257266`, before this evidence-only addition. All eight S5a changed files, including production code, tests, package/configuration metadata and review evidence, match reviewed repair tip `33b2f4ac75ff0ffb132b49763a31dc219d643406` byte for byte. This integrates original `9274824fba23d78f1e3aaf0f2ac83659f421d2ca` with its reviewed Buffer-ownership correction. The original snapshot defect was independently confirmed; the repair owns accepted Buffer-backed context, offer/decoder/batch bytes and signer input/output as plain Uint8Arrays. The repair's five Buffer regressions are included in the passing suite. No initial-candidate 43-test result is substituted for repaired-candidate acceptance.

| Command from repository root unless noted | Exact-tip result |
| --- | --- |
| `yarn typecheck:fast` | 23/23 configured projects pass |
| From `packages/swap-protocol`: `../../node_modules/.bin/jest --runInBand` | 4 suites, 48 tests pass |
| From `packages/frank-codec`: `../../node_modules/.bin/jest --runInBand test/registration.jest.test.ts test/cbor.jest.test.ts test/stages.jest.test.ts` | 3 suites, 97 tests pass |
| `git diff --check` | Pass |

All gates exited naturally with code 0. Logs: `/tmp/frank-current-main-s5a-typecheck.log`, `/tmp/frank-current-main-s5a-swap.log`, `/tmp/frank-current-main-s5a-codec.log`. Accepted H1/Q3a/H0 source was not modified; unrelated qualification gates were not repeated. Owned integration overlays remain preserved. This validation adds no source change or independent review claim of its own. S5b transport/host installation and later runtime/UI/financial execution remain separate; no push, merge, deployment or funded action occurred.

## Reviewed Q3b lifecycle integration

Exact tested candidate: `d11b21ba5e0eb9056ff891ff4fb60d5087345f77`, before this evidence-only addition. All 39 Q3b changed files, including source/tests and recorded evidence, match repaired source `7b2e3debf0c2d1dbd7dc5eec003d840df5e6b2a7` byte for byte. The coordinator reports independent SAFE review by `private_dice` at that exact source, separate verification of Q3b-1 by `c0_review` before correction, and its own lifecycle source/fix inspection.

Confirmed Q3b-1: yielding custody formerly queued runtime release behind a blocked session refresh, allowing an existing eCash wallet to submit prepared bytes before revocation. The repair starts release synchronously, immediately observes its rejection, then awaits the same cleanup in the queued custody-close section. Domain-root and BIP39 actual-session/Chronik/SDK regressions reject submission and preparation before queue release and preserve original ledger bytes/reservations. These cases are included in the final app gate; original pre-repair results are not acceptance evidence for the repair.

| Command from repository root | Exact-tip result |
| --- | --- |
| `yarn typecheck:fast` | 23/23 configured projects pass |
| `node_modules/.bin/jest --config app/jest.config.js src/accounts/session.jest.test.ts src/accounts/utxo-wallets.jest.test.ts --runInBand` | 2 suites, 114 tests pass |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js ecash-wallet.jest.test.ts ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts ecash-seed-boundary.jest.test.ts ecash-operation-store.jest.test.ts chain/chain-factory.jest.test.ts chain/utxo-family.jest.test.ts storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand` | 9 suites, 97 tests pass |
| `node packages/wallet/storage/ecash-operations/browser-test.mjs` | Actual Chrome 155.0.8059.40 passes store/restart/independent-page phases and actual SDK host qualification with two wallet handles and reopened reservations |
| `yarn --cwd app test:custody` | Stage/activate/process-reopen pass; 570 regression assertions across 28 cases; zero network/log effects |
| `git diff --check` | Pass |

All gates exited naturally with code 0. Actual Chrome lanes ran one at a time: Q3b host qualification completed before H1 custody qualification started. Logs use `/tmp/frank-current-main-q3b-{typecheck,app,wallet,browser,custody}.log`. The Node localStorage experimental warning did not change successful results. No source changed; owned overlays remain retained.

Backend qualification remains scoped to the tested Darwin/Chrome runtime and installed Level stack, without arbitrary rollback/eviction or physical-WAL-corruption resistance. Lifecycle installation does not complete retention/reset protection, operation secrets, negotiation host installation, swap execution, settlement or UI; H2 remains required before production holds. No live/funded experiment, push, merge or deployment occurred.

The coordinator also records that independent `negotiation_review` resolved the S5a response-builder pre-bound extra-copy concern as a minor redundant allocation, not a blocker: no production caller exists at `33b2f4ac`, the API is typed Uint8Array, oversized builder input rejects before signing, and received decoding checks bounds before copying. The SAFE S5a verdict stands; no source repair or additional repair round was required.

Independent review: `c0_review` reviewed exact Q3a `836f96d8400401c00085d103a2735a7babc4840d`, and `private_dice_design_review` reviewed exact H0 `6958f1931059392f9d811aba32557f8388a226f6`, both against `3951bbf2557a31d7380a3ae6b07431f966e031b5`. Each returned SAFE TO INTEGRATE with no concrete findings after source and evidence inspection. Perspectives included correctness, security, efficiency, simplicity/shape, test quality, persistence, concurrency, authority and resource lifetime. Neither duplicated passing gates. Root also inspected the production changes and combined evidence. Reviewers used inherited strong model context; implementations used the owner-requested GPT-6.1 Sol medium lane. Already-started authorized custody transactions can commit after facade closure; callers receive a failure requiring original-intent reconciliation. Neither review qualifies reset safety, production store activation, browser eviction, physical WAL corruption or whole-store rollback. Release hold remains.

## H1 local integration

H1 was independently reviewed SAFE as an inactive predecessor at `3730d3137b711035a3ab64822f19f07c3a57acfd` against `d7eb7e37adeca759dfcfd1f13ad740aecb5613a3`. Reviewer `c0_review` inspected exact source and browser evidence across the review floor plus concurrency, persistence, authority and lifecycle, finding no concrete defect. Root inspected the complete production diff separately. Implementation was GPT-6.1 Sol medium; reviewer inherited the strong context.

H1 source and evidence commits were squashed into `df71d49a`. `git diff --name-only 3730d3137b711035a3ab64822f19f07c3a57acfd df71d49a` reports only this integration evidence file. The entire executable/test tree therefore matches the reviewed and tested H1 candidate; no new source combination requires repeating its gates. Recorded evidence is 23 configured typechecks, actual Chrome process-restart retention and 570 assertions across 28 cases, including independent IDB-handle races and cleanup-guard mutation sensitivity. This is not a separate-tab race claim. H1 retains H0 read-only opening and Q3a unchanged.

No production operation acquires these holds. H2 must protect reset before admission is enabled; existing payment retirement is not established by an empty new hold record. Arbitrary store rollback/deletion and terminal financial-operation reuse remain outside this bounded custody guarantee.
