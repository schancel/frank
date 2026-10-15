# Q3b host candidate evidence

Base: `a4183bf770af4e491309875ee46e451b57bedff5`.
Dispatch lane: GPT-6.1 Sol medium; runtime model identifier is not independently exposed.
No deployment, funded checks, dependency changes or user-storage deletion.

## Ownership and behavior

- The existing ledger remains the sole owner of new operation claims, signed bytes,
  change allocation, receipts and tombstones. Formats/keys are unchanged.
- Exactly one explicit borrowed store or owned factory is required. Factory acquisition
  follows checkpoint/backend/address verification. Owned initialization failure and
  wallet close drain and close once; borrowed close methods confer no ownership.
- Wallet admission and post-await lifetime fences prevent late signing, import,
  callbacks, fresh mutation and handle publication. Already-started submission retains
  original claims/bytes and drains its accounting before owned storage closes.
- Recovery uncertainty permits publication only after fresh operation-ledger AND
  prior native-attempt owner health/validation. Unreadable/poisoned owners reject.
- Session registers relays before its first wallet await, and release/close revoke
  immediately. Relay tracks opening/open wallets and surfaces cleanup failure.
  Cache checks liveness even at unchanged account/revision and propagates cleanup failure.
- Session wallet creation is for ready sessions. Effective-relay-close regression proves
  pre-ready initialization release cannot publish a usable late wallet.
- App explicitly selects strict IndexedDB under `local-account-v1`. Browser factory
  preserves/rejects every exact old localStorage-ledger presence or inspection failure.
  Implicit operation-store memory/localStorage defaults and writer class were removed.
  Native-attempt defaults and historical obligations remain separate and unchanged.

## Gates

Commands run from repository root unless a working directory is given:

| Command | Result |
| --- | --- |
| `yarn typecheck:fast` | All 23 configured projects pass |
| In `packages/wallet`: `../../node_modules/.bin/jest ecash-wallet.jest.test.ts ecash-preparation.jest.test.ts ecash-stealth.jest.test.ts ecash-seed-boundary.jest.test.ts ecash-operation-store.jest.test.ts chain/chain-factory.jest.test.ts chain/utxo-family.jest.test.ts storage/ecash-operations/native.jest.test.ts storage/level-durability.jest.test.ts --runInBand` | 9 suites / 96 tests passed |
| In `app`: `../node_modules/.bin/jest src/accounts/session.jest.test.ts src/accounts/utxo-wallets.jest.test.ts --runInBand` | 2 suites / 112 tests passed |
| In `packages/wallet`: `../../node_modules/.bin/jest chain/utxo-family.jest.test.ts --runInBand` | Final cleanup-failure addition: 10 tests passed |
| `node_modules/.bin/jest --config packages/wallet/jest.config.js ecash-stealth.jest.test.ts --runInBand` | Final obsolete-writer assertion removal: focused suite passed |
| `node packages/wallet/storage/ecash-operations/browser-test.mjs` | Actual Chrome 155.0.8059.40, all phases pass |
| `node_modules/.bin/tsgo --project packages/wallet/.q3b-livechecks.json --noEmit` | All four affected opt-in livechecks compile; no execution |

The last command used `livechecks-tsconfig.json` copied to the temporary exact
path above, with existing wallet Level/SDK ambient declarations, then removed.
Logs are adjacent. Package-local dependency versions were preserved; temporary
`@frank` links resolved to this candidate. Only owned overlays are removed afterward.

Contract-authorized browser harness extension bundles actual `EcashWallet` and
actual installed SDK against public synthetic Chronik replies, strict IndexedDB
and the canonical wallet lock. It proves distinct exact outpoint reservations
across two wallet handles and reopen. The fixture installs the same Buffer browser
polyfill that app/quasar.config.js injects. Existing independent-page store tests
remain included. No external RPC or funded key is used.

An additional exploratory full-app `tsc --project app/tsconfig.json --noEmit`
encountered existing Vue alias/worker-library declaration setup failures; it is not
one of the configured fast projects, and no unrelated configuration was changed.
Affected session/cache source is exercised by the boundary suites above.

## Residual limits

Q3a backend/platform limits still apply (qualified Darwin/Chrome, installed default
LevelDB WAL physical-corruption limitation, no rollback/eviction resistance).
Storage/lifetime installation does not implement swap retention, secrets,
cryptography, protocol/runtime, propose/accept/execute UI or settlement. New
namespaces and old ledger bytes must survive reversal; do not resume old writers
without explicit recovery handling. Independent review/integration remains required.
