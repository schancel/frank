# Native threshold adaptor acceptance precursor

Packet A only: disposable independent native XEC and MON transfers signed by fresh dealerless two-party Lindell keys. This is not an atomic swap, a refund protocol, production custody, durable recovery, or external cryptographic assurance. No full shared private key is constructed. Both party state machines live in the fixture solely to shuttle local authenticated test frames. Only public transcript hashes are recorded.

Run from the repository root with installed workspace dependencies:

```sh
node node_modules/jest/bin/jest.js --config packages/bot/jest.config.js --runInBand --runTestsByPath packages/bot/demo/regtest/threshold-adaptor/native-digests.jest.test.ts
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx packages/bot/demo/regtest/threshold-adaptor/xec.livecheck.ts
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json node --import tsx packages/bot/demo/regtest/threshold-adaptor/evm.livecheck.ts
yarn typecheck:fast
```

XEC starts its own real Bitcoin ABC 0.34.0 process, chooses free loopback ports, creates a new temporary data directory, mines mature faucet outputs, and stops only that process in `finally`. The existing fixture verifies the downloaded archive against its pinned SHA256. Optional `FRANK_BITCOIN_ABC_BIN_DIR` names an already verified Bitcoin ABC binary directory; `FRANK_REGTEST_CACHE_DIR` names a download cache. No funded application wallet is opened. State and public evidence remain under the printed `frank-adaptor-xec-*` OS temporary directory; cleanup after inspection is removal of that exact owned directory. The process also has an exit cleanup hook.

MON deliberately does not invoke the shared `frank-solonet` fixture lifecycle. The integration owner must supply a dedicated actual Monad solonet endpoint and checkpoint:

```sh
export ADAPTOR_MONAD_RPC_URL=http://127.0.0.1:49080
export ADAPTOR_MONAD_CHECKPOINT_HEIGHT=1
export ADAPTOR_MONAD_CHECKPOINT_HASH=0x... # exact 32-byte operator-supplied block hash
```

The port above is illustrative, not an available service. No implicit default exists. Only literal loopback HTTP is accepted. Native chain ID must be 20143, the supplied checkpoint must match, and client version must identify Monad. The dedicated solonet must include its standard disposable genesis faucet. The fixture uses only that publicly known local faucet and funds a fresh joint address; reserve/gas behavior is left to the real client. Startup and cleanup of that dedicated fixture belong to its owner. This runner never starts, stops, resets, or reconfigures a VM/container. MON evidence remains under the printed `frank-adaptor-monad-*` OS temporary directory.

Evidence includes client version, canonical chain, pinned checkpoint, native digest, public transcript hashes, raw signed bytes, transaction identity and recipient accounting. It excludes shares, seeds, the pre-completion secret and private state. XEC checks mempool acceptance, duplicate submission identity, mined raw bytes, spent prevout and recipient UTXO. MON checks the observed transaction, successful receipt, recipient value, checkpoint continuity and receipt ancestry before extraction. Node rejection is failure; there is no mock fallback.

The pure tests independently construct the ForkID preimage and pin literal EIP-1559 unsigned bytes. They reject wrong canonical/native chain identity, changed input/value, public endpoints, wrong observation digest/signature, wrong adaptor point and public key, and high-s observations while proving extraction's sign ambiguity. Existing threshold suites own adversarial session/round/proof coverage; these checks do not replace them. Native acceptance is passed only when the corresponding livecheck actually prints PASS.

Validation on the initial candidate: the focused suite passed (4 tests), and the existing threshold suite passed (6 suites, 94 tests). Real Bitcoin ABC 0.34.0 accepted the XEC proof, including its negative mempool checks and observed signature extraction. MON acceptance remains **unproven** pending a dedicated endpoint and operator checkpoint. The required repository typecheck ran with 18/22 projects passing; bot, bot-framework, CLI and wallet failed on existing Chronik API type mismatches in `wallet/chain/utxo-family.ts` and `wallet/ecash-sdk-backend.ts`. This is an incomplete Packet A candidate, not a passed two-chain acceptance gate.
