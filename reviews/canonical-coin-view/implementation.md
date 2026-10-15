# Canonical coin view implementation evidence

Tier 3; contract `contract.md`, base `5100b241ae6bf8337124071fdb279c0c5601688f`.
Requested lane: GPT-6.1 Sol medium. Dispatch specifies that selection; worker has no independent runtime model introspection. Independent review and integration remain parent-owned.

## Result and ownership

`ChainUtxoPool` remains a derived, in-memory construction and selection view. HD/change lifecycle stores, received holdings, operation journals and admission retain durable authority. No inventory replacement, financial transition redesign, scanner, reorg recovery or maintenance-policy change is implemented.

Pool identity fields and parameters use `chainIdentifier`. Exact registry lookup reads `PROTOCOL_CHAINS`, the existing projection of `docs/protocol/chains/v1.json`; no second network table or new protocol network is added. Protocol `bitcoin` maps explicitly to existing adapter family `utxo`. Alias, case-variant, unknown and family-mismatch inputs reject before effects. EVM address normalization remains existing behavior; Solana and Bitcoin-family case is preserved without address-prefix dispatch.

Address/outpoint/transaction indexes, dependency traversal, confirmation/unconfirmed sets, spent tracking and archive filters retain canonical scope. Global outpoint fallback indexes are removed. Supplied coin IDs must start with their exact canonical chain scope; an existing ID cannot be reassigned to another chain/address/outpoint, nor may another ID replace the active index for one outpoint. Family signer adapters validate their inputs; Solana transaction inputs require one canonical network.

## Source and consumer inventory

- `chain-utxo-pool.ts`: pool records, registration, selection, address/ID helpers, family adapters, dependency/confirmation/spent indexes, archive and sweep queries.
- `monad-account-pool.ts`, `monad-change-pool.ts`: explicit canonical EVM attachment; reject a different network after attachment. HD status and interrupted change completion use that captured scope. Attachment is private to its typed setter.
- `chain/monad-chain.ts`: initial HD/change population, cache hydration and account lookups use its validated captured `chainIdentifier`.
- `monad-account-hygiene.ts`: required explicit EVM identity; signer lookup, dirty scan and change registration use it. `privacy-simulation-engine.ts` supplies its simulated Monad identity.
- `monad-stamp-client.ts`, `monad-wallet-handle.ts`, `canonical-relay-joined-driver.ts`: the canonical stamp handle requires identity, and the client validates/captures it for lookups and cache refresh.
- `solana-wallet.ts`, `chain/solana-chain.ts`: canonical registration, actual transfer selection and fee estimation agree on wallet identity.
- `ecash-wallet.ts`: exact outpoint producer supplies canonical identity.
- Existing associated fixtures updated together; no app/bot host-composition changes.

Canonical stamp owner `canonicalWalletPublicBinding` currently accepts only the three Monad networks. Sepolia stamp support was not introduced. Supported Monad stamp lookup is covered directly; real configured EVM composition, HD/change and hygiene cover Monad and Ethereum Sepolia. Parent explicitly accepted this capability limit.

## Persistent and wire impact

There is no pool serializer. Generated IDs now contain canonical scope; `ChainUtxoCoin.chain` and pool parameter `chain` are intentionally replaced by `chainIdentifier`. No durable/wire serializer is changed by this unit.

`hygiene/cold-vault-sweeper.ts` persists caller-supplied opaque `coinIds` and compares them for admission, so arbitrary persisted pool IDs cannot be declared compatible. A whole-tree TS/Vue call-site trace found concrete cold-vault journal/sweeper construction only in tests, not an installed pool-ID producer. `message-item-plugins/registry.ts` has coin-effect capability type declarations (`coinId`, `coinIds`), with no installed persistence/lookup producer. External-wallet-signer only consumes configuration types. Cold-vault schemas and historical records remain unchanged.

Any separately installed consumer persisting alias-based pool IDs must be requalified before this baseline is installed. Reversal is local for this in-memory view, but separately persisted IDs require an explicit owner policy. There is no auto-reset, migration, dual alias, key deletion or generic public-library compatibility promise.

## Fail-before / pass-after

Ran new real-consumer tests against production files from the exact base, restoring candidate files afterward. `chain/evm-host.jest.test.ts` and the actual Solana wallet registration test were unchanged during this baseline run. For the pool-only test, the sole adaptation was its renamed API field/variable spelling (`chainIdentifier` to baseline `chain`) so it exercised baseline behavior instead of failing on undefined fields.

Baseline command:

```sh
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand packages/wallet/canonical-coin-view.jest.test.ts packages/wallet/chain/evm-host.jest.test.ts packages/wallet/chain/solana-chain.jest.test.ts --testNamePattern 'isolates identical outpoints|rejects aliases|real EVM composition scopes|selects canonical wallet registrations'
```

Five baseline failures: both real EVM compositions had zero clean coins under their canonical network; actual Solana registration estimated one input instead of two; alias registration did not throw; confirmation of one network's parent was visible on the other network. All five pass on the candidate.

## Gates

```sh
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand packages/wallet/canonical-coin-view.jest.test.ts packages/wallet/chain-utxo-pool.jest.test.ts packages/wallet/account-hygiene.jest.test.ts packages/wallet/chain/evm-host.jest.test.ts packages/wallet/chain/solana-chain.jest.test.ts packages/wallet/solana-wallet.jest.test.ts packages/wallet/ecash-wallet.jest.test.ts packages/wallet/monad-stamp-client.jest.test.ts packages/wallet/monad-account-pool.jest.test.ts packages/wallet/monad-change-pool.jest.test.ts packages/wallet/chain/evm-bound-pool.jest.test.ts packages/wallet/chain/monad-chain.jest.test.ts packages/wallet/evm-input-admission.jest.test.ts packages/wallet/chain/protocol-chain-registry.jest.test.ts
yarn typecheck:fast
git diff --check
```

14 suites / 531 tests passed. `yarn typecheck:fast`: all 25 configured projects passed. Added final assertions for explicit adapter mismatch and per-network ancestor/parent sets, then reran `canonical-coin-view.jest.test.ts`: all 6 passed. Diff whitespace check passed. Existing admission coverage includes concurrency, interrupted submission and restart recovery; no financial-transition behavior changed.

Registry agreement is enforced by existing protocol-registry tests plus the new all-registered-network family/case test. Import inspection found no new wallet-to-feature or cashweb-to-wallet edge. Scope inspection found no global outpoint fallback, substring family dispatch, missing-context EVM default or production pool alias caller. Compression retained only registry-backed validation, canonical indexes, required consumer updates and regression evidence; no new framework or durable state owner.

Candidate-owned dependency overlays mirror installed effective external entries and link `@frank` sources into this worktree; wallet-local installed Chronik 4.3.1 is preserved. No install/download or shared dependency mutation was performed. Synthetic fixture keys and local temporary test stores only; no live APIs, funds, mail, deployment or push.
