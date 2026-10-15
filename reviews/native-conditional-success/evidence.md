# B1c native conditional-success evidence

Base: `a7f7017a43d97d0188aaaa53a0c02b9f6d1cb029`. Independently approved lifecycle predecessor: `f3532c0f9d7250020e3ec547b79cc1f2702c042f`. Actual model gpt-6.1-sol, tier3/strong packet. One bounded local success path; no external security, restart, rollback or production assurance.

Public proof: [evidence.json](evidence.json), SHA-256 `2f6f3adff200020d7fb75ffa351a6e0b4e0fe7d5749cdf958360ef72c552c37e`. Contains actual fresh dealerless J public key, owned T/proofs, exactly two sequential public presignatures, B's ordinary authorization, exact bound terms/native digests, public transcript hashes, actual ABC raw transaction/signature, native EVM calldata/signature/parity/receipts, fee/principal accounting and 1362 XEC headers. No shares/private keys/secret scalar are serialized. Completion signatures intentionally provide the public observation from which extraction is tested.

## Gates

| Gate | Result |
| --- | --- |
| Focused native/import/storage rejection | 3/3 pass; normal process exit |
| Existing threshold suite | 6 suites, 94/94 pass |
| Existing pure B0 policy suite | 3 suites, 28/28 pass |
| Whole repository typecheck | 23/23 pass |
| New source/test formatter | Pass with existing app configuration |
| Lifecycle predecessor native/import/error/SIGTERM | 4/4 pass, exact two-export delta independently approved |
| Standalone native public proof | Normal exit0 |
| Fresh-process public-only replay | Exact EVM signature reproduced from saved public package and observed ABC bytes; no J handles or original t present |
| Separate saved trace checks | Header continuity/eleven-header MTP, admission/inclusion identity, release order and recipient assertions pass |

Unchanged policy files on original ancestry retain the known formatting gap already corrected by separately reviewed B0/publication predecessors (B0 `30148b0cb7793d962681df51fc5a731691853568`, reviewed CLTV stack `0b6c0038a82b14a5fc186a87bdbb7a7a723b50ad`). No whole-package format/hosted-CI pass is claimed for this original base. A local byte comparison verified both corrected policy files equal the exact Prettier transform of this ancestry. Integration must use the corrected reviewed ancestry and rerun exact-tree gates; no policy source changed here.

## Actual native outcomes and functional order

ABC0.34.0 owned temporary nodes use the unchanged pinned archive/binary identity verification and ordinary consensus activation mining. Public checkpoint is per-run. StateChannel artifact/runtime bytes match exactly on an owned one-thread Anvil, native ID20143. Anvil proves generic EVM contract execution; it is not Monad consensus evidence. No public/shared funded node is used.

1. Fresh dealerless2of2 J, A initiator/B responder; B creates one owned lock T. First fresh session produces the EVM public presignature under T. B's ordinary signature matches the once-prefixed getCloseDigest. EVM-only package is fsynced/reloaded before actual B native deposit.
2. Actual channel participants are [B,J], native [M,0], seq0, no challenge/join/checkpoint; custody backing and zero J balance verified. A independently funded and confirmed the exact native P2SH J/CLTV/A_refund script before making the second native digest.
3. Second fresh sequential session binds exact confirmed outpoint/input amount/full redeem script/ForkID0x41/fixed recipient and fee. Initiator has its verified presignature while final outgoing frame is held and responder result is absent. Wrong stored digest/T/session/contract/recipient are rejected with releaseCallbacks0.
4. Full public package is written, fsynced and reloaded byte-for-byte; both signatures, B authorization and exact bindings are verified. Only then is final frame delivered once. Both J handles immediately report destroyed/burned via the existing API. This is not malicious threshold burn or durable antirollback proof.
5. B completes only the XEC artifact with owned t. Native low-s DER+0x41/true/redeemScript is constructed. Original t buffers are wiped before A's observation path. Honest B cutoff, current native clocks and fee readiness are rechecked before sendrawtransaction.
6. `testmempoolaccept` is policy admission only. Actual `sendrawtransaction` returned `db0127eb09e123cf3ed28f5aec58e2fe155050cf2c46426aed1508309a805379`; this is not inclusion. Standard native `generateblock` then included exactly those raw bytes at height 1361, block `13147f15b1985f966e9d25cef43b147718d07f4542dc2c3707088e128d419445`. Input is spent; B receives10000 sats; separate fixed fee1000 sats; depth 2 observed. No custom block/PoW or validation override.
7. A's helper accepts only reloaded public packages/expected bindings and actual observed chain bytes. It verifies transaction intent, full ForkID digest, DER/selector/script binding and native signature under J, extracts against matching T, then completes EVM authorization. It receives no original t or share. Wrong observed transaction/signature fail before completion. A fresh process with only the saved public proof reproduces the exact completed EVM signature.
8. Independent relayer's native transaction submits exact fixed calldata. Actual status1 receipt `0xe6cfa175971b887209656bb6beac9a86e46d9a15877b4f63ce8e1f06ed51195a` at block 4, timestamp 1792037145; J recovery parity 1. ChannelSettled has [M,0], cooperative=true. A receives exact10^16wei; J and contract end at zero. B opening fee and independent relayer fee are separate; deployment is a separately recorded setup fee. B's reported net baseline is after deployment; aggregate gas includes deployment/open/close and stays within10^17wei.

Actual order:

1. EVM public presignature and B signature verified.
2. EVM-only public package fsynced and reloaded before B opening.
3. native EVM opening and backing verified.
4. XEC final outgoing frame held; responder result absent.
5. public file written.
6. public file fsynced.
7. exact public bytes reloaded and verified.
8. held frame delivered to B exactly once.
9. both J handles destroyed.
10. actual ABC claim observed and verified.
11. A extracted from native observed signature and completed EVM authorization.
12. independent relayer EVM receipt status1; fixed A payout verified.

Complete public package compact SHA-256 `7119779051421fd2d5179e327f6310c41b2401720ec810898deaf2b699ed3794`; EVM-only pre-funding file SHA-256 `d04d4fb24f895f3ac288b970a9fb26715e7a030dcb2c4379e043034e90635800`; final frame hash `d706b9756f8b01e567ea5303e7ecb633a34a82e473914f05e94d2f46eafa66a6`. Files are owned temporary public artifacts and are removed with the fixture after proof capture. A fresh J/T is used for the real EEXIST rejection; it produces zero callbacks and fails observably, with all nodes/state cleaned. No mocked native success or skipped outcome.

Two earlier fresh-key development trials failed and cleaned: an address checksum comparison, then a missing transaction when ordinary mempool-selection mining omitted an admitted transaction. Neither is labeled pass and no signing state was reused. ABC's default preconsensus-mining filter selects finalized mempool transactions ([miner source](https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/node/miner.cpp#L118-L128), [default](https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/avalanche/avalanche.h#L58-L59)). Passing proof uses the standard [generateblock validation/mining RPC](https://github.com/Bitcoin-ABC/bitcoin-abc/blob/v0.34.0/src/rpc/mining.cpp#L331-L460) after broadcast; it does not alter validation flags or claim Avalanche finality.

## Reproduction and cleanup

```
export TSX_TSCONFIG_PATH=packages/bot/tsconfig.json
export ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz
export FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin
node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.test.cjs
yarn --cwd packages/threshold-ecdsa test --runInBand
yarn --cwd packages/swap-protocol test --runInBand
yarn typecheck:fast
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.ts packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.test.cjs
node --import tsx packages/bot/demo/regtest/threshold-adaptor/native-conditional-success.ts > /tmp/native-conditional-public-proof.json
```

Owned @frank overlay points to this worktree; wallet Chronik4.3.1. No dependency manifest, crypto, Solidity/artifact, wallet, schema, approved ABC fixture or paused broad B1 source changes. No large download, VM, shared-node mutation or external deployment. Import traps cover process/network/key generation/state writes/exitCode/listeners. Timeout and real post-startup storage error cleanup pass. All owned ABC/Anvil processes/tempdirs are stopped/removed and owned ports close. Dependency links are removed only after every process/gate completes, before commit.

Logs: /tmp/frank-native-conditional-tests.log, /tmp/frank-native-conditional-threshold-tests.log, /tmp/frank-native-conditional-policy-tests.log, /tmp/frank-native-conditional-typecheck.log, /tmp/frank-native-conditional-format-check.log, /tmp/frank-native-conditional-public-replay.log, /tmp/frank-native-lifecycle-tests.log, /tmp/frank-native-lifecycle-typecheck.log.

## Explicit remaining hypotheses and gates

Mandatory internal critique: /tmp/frank-astra-composition-review/crypto-assurance-gap.md. Static at-most-one-corrupted-party security of custom joint DLEQ+Paillier, two sequential same-J/T composition and public DH leakage remains unproved; vectors/native acceptance are functional evidence only. Fresh entropy and exclusive in-process session ordering do not establish distributed leases, crash recovery or nonce/burn rollback resistance. Handle destruction is not malicious burn or JavaScript secure erasure. Node fsync acknowledgement/reload is not browser C0/C1, power-loss testing or antirollback assurance. B's cutoff and bounded controlled local clocks/fees are explicit premises, not malicious fairness under unbounded censorship/reorgs.

Still required: actual malicious threshold burn plus independent refunds, durable C0/C1 ownership before any runtime activation, in-envelope bidirectional rollback/reinclusion with monotonic secret knowledge, late-reveal/fee recovery adversarial gates and external cryptographic assurance. No normal application runtime activation, merge, PR or publication performed. Astra exact-tip review and corrected-ancestry integration remain required.
