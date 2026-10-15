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

MON deliberately does not invoke the `frank-solonet` fixture lifecycle. The integration owner must supply an authorized actual Monad solonet endpoint and checkpoint; use a dedicated fixture unless the owner explicitly authorizes the bounded proof on a shared disposable fixture:

```sh
export ADAPTOR_MONAD_RPC_URL=http://127.0.0.1:49080
export ADAPTOR_MONAD_CHECKPOINT_HEIGHT=1
export ADAPTOR_MONAD_CHECKPOINT_HASH=0x... # exact 32-byte operator-supplied block hash
```

The port above is illustrative, not an available service. No implicit default exists. Only literal loopback HTTP is accepted. Native chain ID must be 20143, the supplied checkpoint must match, and client version must identify Monad. The authorized solonet must include its standard disposable genesis faucet. Coordinate a faucet nonce window with every fixture user before running. The runner takes an exclusive OS temporary lock, requires matching stable latest/pending nonces, and uses an explicit funding nonce; the lock does not coordinate unrelated harnesses by itself. The fixture uses only that publicly known local faucet and funds a fresh joint address with one wei plus `21000 * maxFeePerGas`, capped below 0.03 MON and 0.1% of the faucet balance. It waits six funding confirmations before the first spend, which is exempt from the small-account reserve restriction; gas limit remains exactly 21000. It never broadcasts negative cases from the faucet. Startup and cleanup of that dedicated fixture belong to its owner. This runner never starts, stops, resets, or reconfigures a VM/container. MON evidence remains under the printed `frank-adaptor-monad-*` OS temporary directory.

Evidence includes client version, canonical chain, pinned checkpoint, native digest, public transcript hashes, raw signed bytes, transaction identity and recipient accounting. It excludes shares, seeds, the pre-completion secret and private state. XEC checks mempool acceptance, duplicate submission identity, mined raw bytes, spent prevout and recipient UTXO. MON checks the observed transaction, successful receipt, recipient value, checkpoint continuity and receipt ancestry before extraction. Node rejection is failure; there is no mock fallback.

The pure tests independently construct the ForkID preimage and pin literal EIP-1559 unsigned bytes. They reject wrong canonical/native chain identity, changed input/value, public endpoints, wrong observation digest/signature, wrong adaptor point and public key, and high-s observations while proving extraction's sign ambiguity. Existing threshold suites own adversarial session/round/proof coverage; these checks do not replace them. Native acceptance is passed only when the corresponding livecheck actually prints PASS.

Validation on the initial candidate: the focused suite passed (4 tests), and the existing threshold suite passed (6 suites, 94 tests). Real Bitcoin ABC 0.34.0 accepted the XEC proof, including its negative mempool checks and observed signature extraction. Real Monad solonet 0.16.4 accepted the MON proof on an explicitly owner-authorized existing disposable fixture, with both worker coordinator subtrees confirming no concurrent faucet use. The observed transfer delivered exactly one wei and extraction succeeded; funding was 0.004242000000000001 MON, including the fee-cap budget. No VM/container lifecycle or chain configuration changed. The required repository typecheck passed all 22 projects with the corrected isolated dependency overlay (wallet-local Chronik 4.3.1 and Frank workspace links pointing to this candidate). The initial root-only dependency symlink selected Chronik 0.8.5 and produced spurious wallet API errors; it was replaced without source changes. The focused tests and real XEC proof also passed again under the corrected overlay. Both native acceptance gates passed. Exact-candidate independent review remains required; these results establish the Packet A precursor only, not an atomic exchange or recovery protocol.

## Ordinary settlement reorg proof (S2a)

`settlement-reorg.test.cjs` reuses the existing honest conditional-success setup.
The baseline entry point has two explicit fixture-only scenarios; its normal
output, two sequential signing sessions, fsynced recovery barrier and immediate
joint-handle destruction are preserved. No cryptographic implementation changes.

The reorg scenario disconnects the actual XEC claim and descendants while keeping
funding canonical. The canonical-only UTXO read is separate from mempool state.
A fresh process recreates the public completion while the old inclusion is absent;
then the original claim bytes reappear on a different depth-two canonical branch.
It also snapshots EVM state after opening, disconnects actual cooperative settlement,
restarts public observation in fresh processes, and reuses the original signed
transaction with its original nonce. Orphaned fee effects remain separate from
current-chain recipient principal and fees.

The delayed observer receives recovery artifacts and an exact funding outpoint,
not a claim notification. After actual refund MTP maturity it scans at most 32
canonical blocks from the protected funding anchor, finds the earlier spend and
uses a fresh public-only completion process. The existing refund/finality/response
constants remain unchanged; observation and settlement must fit their declared
window. These local cases are not a general censorship, reorg or consensus theorem.
Anvil supplies generic EVM execution evidence, not Monad consensus qualification.

Use only the existing verified pinned ABC archive/binaries and installed Anvil.
Coordinate the single native lane before running; there is no download or endpoint
fallback. Optional `SETTLEMENT_REORG_EVIDENCE_DIR` retains compact public JSON in an
existing fixture-owned directory, using exclusive file creation.

```sh
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/settlement-reorg.test.cjs
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.test.cjs
```

S2b still owns EVM fallback-already-final and XEC refund/EVM fallback reorg cases.
S1 assurance, production observation/storage ownership, financial recovery runtime,
UI and release authorization remain unfinished. This proof installs none of them.

## Ordinary refund/fallback reorg proof (S2b)

`refund-reorg.test.cjs` selects an explicit scenario on the existing pair-clock
fixture. Its default proof, ordinary-key setup, identity checks, fee budgets and
clock envelope remain unchanged. This is ordinary-key consensus and observation
evidence; it makes no threshold/adaptor or malicious-signing claim.

The scenario disconnects the actual mature XEC refund while keeping funding
canonical, restarts a public-only observer, and reincludes the original signed
refund bytes on a different depth-two branch. It snapshots after the EVM opening
and challenge, reverts actual fallback, then reuses the identical signed fallback
transaction with its restored nonce. Fresh observers verify exact chain,
checkpoint, contract, opening/challenge anchors and current receipt ancestry.
Current principal and fees exclude orphaned effects. After the separate existing
fallback-first case, a fresh observer recognizes terminal refund, verifies the
retained cooperative signatures and rejects their executability; the actual
cooperative transaction also reverts without moving principal.

The ABC observer uses a temporary fixture-owned `127.0.0.1` read-only proxy because
the existing node fixture exposes an authenticated RPC capability. Only bounded
read requests from an explicit allowlist are forwarded; mutation and oversized
requests reject without forwarding. The proxy closes in `finally`. No cookie,
private key or signing state reaches the child. This is fixture observation
transport, not a production relay or authentication design.

```sh
TSX_TSCONFIG_PATH=packages/bot/tsconfig.json ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/refund-reorg.test.cjs
```

Use only existing pinned verified binaries and coordinate the single native lane;
there is no download/shared-endpoint fallback. `REFUND_REORG_EVIDENCE_DIR` optionally
retains a bounded public JSON trace in an existing owned directory, with exclusive
creation. Anvil proves generic EVM execution, not Monad consensus. Local fsync and
observer restart do not prove browser durability, arbitrary rollback resistance or
recovery after an unbounded outage. S1, financial runtime/browser recovery,
watcher-outage policy, an ordinary-looking settlement alternative and external
cryptographic assurance remain outstanding.
