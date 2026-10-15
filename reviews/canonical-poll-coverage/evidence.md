# Canonical polling correction: implementation evidence

Base production: `91e01c981bb9a1e7df7bed31fbfaef03ab6a1b3c`. Parent contract: `836b7db0`, [contract.md](contract.md). Implementation lane: parent-dispatched GPT-6.1 Sol / medium; no separate runtime model introspection was available. Parent owns independent review and integration.

The canonical reader now collects bounded raw pages before decoding or publishing quarantine callbacks. It validates safe timestamps, ordered lists/page boundaries, and cursor progress. A later-page failure or remaining cursor after eight pages withholds the greatest raw timestamp group; if no earlier raw group exists, it rejects. Unreadable rows participate in coverage. Missing directory entries remain inclusive incomplete timestamps inside the proven prefix. Outbox reconstruction preserves the relay receipt time and still omits the unavailable original content digest. No production imports, public API, persistent records, or wire formats changed.

## Results and exact commands

All commands ran from `.worktrees/canonical-poll-coverage`, using installed dependencies only. Verbose logs are retained at `/var/folders/j3/nh8wltcx7l58w2gw1ycc_ryr0000gn/T/frank-canonical-poll-coverage-kstzmame`.

```sh
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts --testNamePattern 'bounded canonical polling coverage|projects a self note'
node node_modules/jest/bin/jest.js --config app/jest.config.js --runInBand --runTestsByPath app/src/adapters/pinia-chain-adapter.jest.test.ts app/src/adapters/pinia-chain-adapter.polling.jest.test.ts
node node_modules/jest/bin/jest.js --config packages/bot-framework/jest.config.js --runInBand --runTestsByPath packages/bot-framework/test/bot-host-reliability.jest.test.ts
yarn typecheck:fast
git diff --check
```

Final results: focused canonical 14 passed (`wallet-final-focused.log`); app 50 passed (`app.log`); bot 28 passed (`bot.log`); configured typechecks 25 passed (`typecheck.log`); whitespace check passed. The only subsequent production edit was an explanatory receipt-time comment.

Completed broader canonical gates on the same production behavior:

```sh
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --verbose --runTestsByPath packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/monad-canonical-dm.jest.test.ts packages/wallet/chain/monad-canonical-dm-message-id.jest.test.ts
```

Composition: 98 passed in 151.611 seconds (`wallet-full.log`), including existing awaited-stream tests. Other two suites: 50 passed in 109.139 seconds (`wallet-other.log`). These loaded the test module before the final additional later-failure/no-complete-prefix matrix case was added; that added case passed in the final focused run. A prior combined three-file invocation was interrupted after more than two minutes without output, before the parent clarified the baseline's normal long duration. It was not a failure or a completed gate (`wallet.log`); the two split runs completed naturally. No redundant full repeat is claimed.

## Fail-before/pass-after

With final tests retained, a script temporarily replaced only `monad-canonical-dm.ts` with `git show 91e01c981bb9a1e7df7bed31fbfaef03ab6a1b3c:packages/wallet/chain/monad-canonical-dm.ts`, ran the focused tests, then restored candidate bytes in `finally` before any candidate gates resumed.

- Canonical command above: 12 failed, 2 passed, 85 skipped (`fail-before-final-wallet.log`). Failures cover a nine-page timestamp group at the eight-page bound; later failure with no complete group; earlier complete group followed by a split group at either limit/failure; unreadable tail withholding; all-unreadable complete prefix; directory-unavailable prefix; repeated cursor; NaN/negative/fractional timestamps; regressing page order; and reconstructed outbox sentAt 50 versus receipt 100. The callback-failure observability and ordinary self-note controls passed before and after.
- App command narrowed to `pinia-chain-adapter.jest.test.ts --testNamePattern 'canonical scan'`: 1 failed before, passed after. The actual poller calls the actual canonical reader, retains replay position on rejection, emits no quarantine completion for the withheld tail, then durably quarantines a completed unreadable prefix and advances to 101.
- Bot command above with `--testNamePattern 'oversized canonical'`: 1 failed before, passed after. The actual host calls the actual canonical reader, logs the coverage rejection, preserves its in-memory and persisted replay position, and admits no handler. A subsequent complete corpus record decrypts through the canonical reader; successful bot consumer admission/restart advancement is not claimed by this new test.

Typed-wallet canonical regressions use real sealing/decryption and directory admission. The shared host fixture uses admitted protocol corpus evidence and actual decryption, replacing only page I/O; custody/financial methods throw if invoked. Only repository fixtures and local owned stores were used.

## Formatting and dependencies

The new corpus fixture passes Prettier with `app/.prettierrc.json`. Edited production/canonical/app ranges were checked for exact equality with Prettier's API using that config; the bot test range uses its existing semicolon/double-quote style. Unrelated pre-existing formatting was retained. `git diff --check` passed. A scoped dependency assertion passed: no production import/export edge was added, and the canonical reader has no app, Vue, Pinia, or default-plugin-composition import.

Dependency overlays are candidate-owned symlinks to already installed dependencies under `.worktrees/atomic-swaps-current-main`; root `@frank` links point at candidate package sources (codec maps to `packages/frank-codec`). Package-local dependency overlays preserve the installed package-local resolution, including wallet-local chronik-client 4.3.1. An initial typecheck attempt without those local overlays selected older root chronik declarations; after restoring the baseline-equivalent installed resolution and fixing test-fixture RolePoint metadata, all 25 gates passed. No installs, downloads, shared-target mutation, external relay/chain execution, credentials, funding, push, merge, or deployment occurred. Candidate-local prerequisite declaration emits were produced by the repository typecheck command.

## Limits and reversal

Timestamp groups larger than the fixed eight-page budget remain an explicit retryable scan limitation; this correction does not provide continuation or backfill. Receipt maxima/returned arrays do not establish durable consumer completion. Authenticated scan provenance and host durable consumer replay frontiers remain separately owned successors. Existing ordinary API inbox fallback remains per this contract; no both-direction successor certification is added. No persistence/schema changes or reset are needed. Reversal is reverting the source correction.
