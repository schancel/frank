# B1a native evidence

Base: `0f2d97ef3683979f7cce0d925e9786337c6c0975`. Actual model: gpt-6.1-sol; tier3/strong task packet. This is an ordinary-key single-chain fixture, not joint-J, threshold/adaptor, cross-chain safety, or external cryptographic assurance.

Public proof: [evidence.json](evidence.json), SHA-256 `d3dc99beeeae8f70c1eb7e730060c1fb700090bf019157ca8e3f540514ee1baa`. Contains only public keys, redeem script, raw signed transactions and digests/signatures, native headers/MTP, actual RPC errors, inclusion blocks, recipient/change/fee accounting, node version and checkpoint. No private keys, RPC credentials or external resources. Disposable keys were generated in memory for this run.

## Native versus policy gates

| Scenario | Native generateblock result | Observation |
| --- | --- | --- |
| ordinary claim positive control before refund maturity | Included at height 1354 | 10000 recipient sats; fee 1000 sats |
| previous-tip MTP T_X-1 | Rejected: `TestBlockValidity failed: bad-txns-nonfinal` | Tip/outpoint unchanged, or already canonically spent |
| previous-tip MTP T_X equality | Rejected: `TestBlockValidity failed: bad-txns-nonfinal` | Tip/outpoint unchanged, or already canonically spent |
| previous-tip MTP T_X+1 independent refund positive control | Included at height 1373 | 10000 recipient sats; fee 1000 sats |
| final sequence cannot bypass CLTV | Rejected: `TestBlockValidity failed: mandatory-script-verify-flag-failed (Locktime requirement not satisfied)` | Tip/outpoint unchanged, or already canonically spent |
| locktime below script timestamp | Rejected: `TestBlockValidity failed: mandatory-script-verify-flag-failed (Locktime requirement not satisfied)` | Tip/outpoint unchanged, or already canonically spent |
| height versus timestamp mismatch | Rejected: `TestBlockValidity failed: mandatory-script-verify-flag-failed (Locktime requirement not satisfied)` | Tip/outpoint unchanged, or already canonically spent |
| wrong independent refund key | Rejected: `TestBlockValidity failed: mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)` | Tip/outpoint unchanged, or already canonically spent |
| race claim first | Included at height 1374 | 10000 recipient sats; fee 1000 sats |
| refund after canonical claim | Rejected: `TestBlockValidity failed: bad-txns-inputs-missingorspent` | Tip/outpoint unchanged, or already canonically spent |
| race refund first | Included at height 1375 | 10000 recipient sats; fee 1000 sats |
| claim after canonical refund | Rejected: `TestBlockValidity failed: bad-txns-inputs-missingorspent` | Tip/outpoint unchanged, or already canonically spent |
| unspent claim remains valid after T_X; no claim expiry | Included at height 1376 | 10000 recipient sats; fee 1000 sats |
| independent refund key signs higher local fee | Included at height 1377 | 10000 recipient sats; fee 1500 sats |
| zero fee policy rejected but native valid; deliberately outside fee envelope | Included at height 1378 | 10000 recipient sats; fee 0 sats |

The same refund bytes are tested at previous-tip MTP `1792026913`, `1792026914`, and `1792026915`. Its first two native failures are non-final transaction failures; the third is included. CLTV sequence/threshold/type failures are separately re-signed and yield native `Locktime requirement not satisfied`. The wrong-key case is a separate native signature failure. Negative checks confirm input script/value and unaffected UTXO/tip, so a fee/input/signature failure cannot substitute for timing evidence.

Both canonical race orders prove spent-outpoint rejection through generateblock, separately from mempool absence. Late claim succeeds on an unspent output. All seven positive spend inclusions have later native confirmations at depth >=2. A dedicated zero-fee refund fails `testmempoolaccept` with `min relay fee not met` but succeeds in native generateblock, explicitly outside the predeclared local envelope. No production fee or mempool replacement policy is asserted. Independent refund fee adjustment preserves 10000-sat principal by changing independently owned residual change.

## Setup and primary upstream sources

`generateblock` is ABC's ordinary RPC: it validates candidate transactions with native TestBlockValidity, then mines and processes the block: https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/rpc/mining.cpp#L331-L460 . No handcrafted block, PoW loop, activation override or validation bypass option is used.

Default regtest activates BIP113 at height576 and CLTV/BIP65 at1351: https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/kernel/chainparams.cpp#L383-L393 . A first low-height experiment failed the equality assertion because BIP113 was not active. It shut down and removed owned state; no result from that trial is labeled pass. Ordinary mining reaches the default activation heights before any native script gate. The funded coinbase has 1351 confirmations before spend. Header timestamps are captured for every generated block, and the runner independently recomputes the median of each available eleven-header window. No wall-clock inference is used for MTP.

BIP113 selects previous-tip MTP once CSV is active: https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/validation.cpp#L4243-L4260 . Finality is strict less-than: https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/consensus/tx_verify.cpp#L17-L44 .

## Reproduction and gates

The existing pinned archive `/tmp/frank-adaptor-abc.tar.gz` and matching verified binary `/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin/bitcoind` are mandatory. Approved readiness fixture checks the archive SHA-256 and binary identity before every owned startup. No download occurred. `@frank` overlays point to this worktree and wallet's Chronik resolves4.3.1. No dependency manifest changed.

```
export TSX_TSCONFIG_PATH=packages/bot/tsconfig.json
export ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz
export FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin
node --import tsx --test packages/bot/demo/regtest/cltv-consensus-fixture.test.cjs
node --import tsx --test packages/bot/demo/regtest/owned-template-fixture.test.cjs
node --import tsx packages/bot/demo/regtest/cltv-consensus-fixture.ts > /tmp/cltv-public-proof.json
yarn typecheck:fast
```

Executed serial native gates: CLTV tests3/3; unchanged approved readiness tests3/3; standalone public proof normal exit0. Whole typecheck23/23. Logs: `/tmp/frank-cltv-tests.log`, `/tmp/frank-cltv-readiness-tests.log`, `/tmp/frank-cltv-typecheck.log`. Pure import traps cover both entrypoints. Deliberately invalid ephemeral-key entropy causes an exercise error after real owned startup and proves finally cleanup; timeout cleanup is separately exercised. SIGTERM and repeated stop are covered by the unchanged readiness tests. Owned ports close and datadir snapshots return to baseline. Post-gate process inspection found no owned bitcoind. Dependency links are removed after all processes finish and before commit.

Unchanged: approved fixture API/source, shared crypto/transaction code, dependency manifests, chain registry, paused B1 worktree, and main checkout. No rollback experiment was needed; no reorg/cross-chain recovery claim. All broader B1 threshold/adaptor/common-secret/dual-refund/storage/late-reveal/fee-horizon and bidirectional reorg gates remain unproved. Independent Astra exact-tip review is required before any integration; no merge, PR, deployment or publication performed.
