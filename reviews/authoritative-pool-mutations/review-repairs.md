# Repairs after independent review of 8419d984

Tier 3, same authoritative-pool contract and format. Parent owns fresh independent review and integration. The two production files changed are `monad-account-pool.ts` and `storage/monad-wallet-bundle.ts`; the change-store implementation and persistent schemas are unchanged.

## POOL-1: capture each contribution before asynchronous work

The public multi-funder writer previously reread its target after signing. With optional `claimFor` omitted, that read adopted a newer lease's revision and allowed funding completion to replace its `in-use` state with `available`. Each contribution now captures the committed row, revision and expected lifecycle before inter-contribution delay, spacing and signing. Its existing authoritative mutation compares that captured revision. An intervening lease causes a stale refusal before the delayed signed transaction can be persisted or submitted; there is no signature retry.

The actual Level/public pool regression uses two real offline EVM signatures and pauses the second contribution both during spacing and after signing. The first contribution is `available` at revision 3; a real lease durably claims revision 4. Both delayed completions reject, preserve that exact row through close/reopen, retain the original lease, refuse a second lease, submit only the first contribution, and sign each contribution once. This repairs stale completion only: durable incomplete multi-funder holds and funding-history retention remain successor work.

## POOL-2: qualify change state before initialization

Missing-manifest initialization previously skipped empty-component qualification. A recovered change output could therefore be adopted or refused only after custody and bindings were written. Bundle loading now opens the change component read-only and checks its public binding, allocation high-water, ordinary rows, recovered outputs and pending intent before any seed generation, manifest or HD binding initialization. The later loading path uses the same emptiness qualification rather than assuming that a missing manifest authorizes adoption, and rechecks before binding an unbound component. Only genuinely empty interrupted initialization is permitted.

Three actual Level regressions seed valid nonempty unbound recovered change with no manifest and empty HD state. Same-seed restore, different-seed restore and generated-seed create all refuse before initialization. Complete key/value digests of manifest/custody, HD and change namespaces remain identical, and seed generation is never called. Digests keep disposable custody material out of failure logs. Existing empty manifest-before-binding restart coverage remains required and is included in the full bundle suite.

## Fail-before and repaired evidence

`review-fail-before.log` was captured on unchanged `8419d9841e70663b8bec119614e79d217d2b6182` with only the new regression file present: all five desired assertions fail. Both delayed preparations resolve instead of refusing; all three initialization cases change persisted namespaces. `review-regressions.log` records the same five assertions passing after the two repairs.

Commands run from this checkout with its existing local dependency overlay, without installs, live RPC, live funds, resets, deployment or push:

```sh
NODE_ENV=test node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/storage/pool-review-regressions.jest.test.ts
NODE_ENV=test node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/monad-domain-wallet.jest.test.ts packages/wallet/storage/authoritative-pool-mutations.jest.test.ts packages/wallet/storage/monad-wallet-bundle.jest.test.ts packages/wallet/monad-account-pool.jest.test.ts packages/wallet/monad-account-lease.jest.test.ts packages/wallet/evm-input-admission.jest.test.ts packages/wallet/storage/pool-review-regressions.jest.test.ts
NODE_ENV=test node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/evm-legacy-consolidator.jest.test.ts packages/wallet/monad-stamp-client.jest.test.ts
NODE_ENV=test node node_modules/jest/bin/jest.js --config packages/bot/jest.config.js --runInBand --runTestsByPath packages/bot/qwen-host-safety.jest.test.ts packages/bot/stamp-pool-seed.jest.test.ts
node packages/wallet/storage/authoritative-pool-mutations.browser-test.mjs
yarn typecheck:fast
git diff --check
```

Post-repair results on the final production/test tree:

- `review-regressions.log`: standalone regressions 5/5.
- `review-core.log`: 7 suites, 399/399 pass, including the full 98-test domain suite and valid empty interrupted initialization/reopen.
- `review-consumers.log`: consolidator and stamp-client full suites 170/170 pass.
- `review-bot-hosts.log`: bot host suites 63/63 pass.
- `review-browser.log`: actual Chrome independent-page Web Locks race and full browser-process restart pass, with one revision-2 winner surviving reopen.
- `review-typecheck-fast.log`: all 25 configured projects pass.
- `git diff --check`: pass.

The browser test qualifies the unchanged shared mutation backend; the new Node Level regressions exercise the two repaired public entrypoints directly. Compression review retained one narrow public change-emptiness predicate shared by preflight and binding, with no new authority, store framework or schema.

The earlier candidate's logs and known baseline attribution remain in `validation.md`; they are not relabeled as repaired-source runs. The initial 15-suite consumer aggregate was not green and is not rerun or claimed green here. Its independently confirmed contact repeated-cursor and topic Forum-codec baseline failures remain outside this repair. Original funding investigation checkout `f88a434e` remains untouched.
