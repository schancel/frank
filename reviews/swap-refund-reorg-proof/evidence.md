# S2b ordinary refund/fallback proof evidence

Accepted base: `f20181df3ca25b4f44cfd95d5becfd5285d28432`.
Initial root contract: `f0a04d56fe096c313acd2503bd4adfc5d3f5ba8d`;
root amendments `2d963f02` and `d0722bf3` permit bounded public JSON and a
fixture-only read observation proxy. Frozen executable/public capture commit:
`342c587801d8ddbe22c5d9d6a0d0496b4585699b`. Its evidence-only successor changes no executable source.
Tier 3; requested and selected implementation lane GPT-6.1 Sol medium.
Parent owns independent exact-candidate review and integration; neither is claimed
by these implementation gates.

## Ownership and preservation

An explicit `refund-reorg` scenario reuses the existing pair-clock fixture's
ordinary keys, funding, channel setup, signing and accounting. The new
`threshold-adaptor/refund-reorg.ts` owns only fixture public observation,
fsync/reload, fresh-process observation and bounded ordinary reorg assertions.
This is not a threshold/adaptor proof or production financial-operation store.
No protocol, crypto, contract, chain configuration, node lifecycle or timing
constant changed. The existing default scenario and test file remain unchanged.

Byte comparisons to the accepted base preserve four complete source slices:
constants/types through `OwnedEvm`; the entire `startOwnedEvm`; exercise setup
through funding/deployment before fee accounting; and open/challenge/fallback,
cooperative authorization and XEC signing helpers through `nativeSpend`.
Scenario hooks select only actual safe refund/fallback and existing fallback-first
ordering cases. The scenario's post-reinclusion rejection moves one second later
to follow the new canonical fallback block; no horizon or envelope is enlarged.
S2a's shared `startOwnedEvm` and all S2a executable/public files remain unchanged.

The public observer receives an fsynced file and literal owned `127.0.0.1` HTTP
endpoint. ABC's existing fixture exposes an authenticated RPC capability, so a
proof-local temporary read proxy forwards only `getblockchaininfo`, `getblockhash`,
`getblockheader`, `getblock` and canonical-only `gettxout`. Requests are at most
4096 bytes with bounded parameters. Mutation/oversized requests reject without
forwarding. The owned server closes in `finally`, including observation errors;
no cookie, private key or signing state reaches the child. This is fixture
transport, not production authentication/relay design. Public child processes have
20-second deadlines and only their recorded process handles are stopped.

## Gate matrix

All final gates exited naturally with code 0, using candidate-local Frank links
and installed external dependencies. Native suites ran serially on the released
lane; no download, public/shared endpoint or funded public transaction occurred.

| Gate | Result |
| --- | --- |
| Final `refund-reorg.test.cjs` | 3/3 pass: inert import, read-proxy denial/error cleanup, all three actual native cases |
| Existing `pair-recovery-clock-fixture.test.cjs` | 4/4 pass: original ordinary dual-custody/deadline proof, timeout, actual post-start failure and SIGTERM cleanup |
| Existing `cltv-consensus-fixture.test.cjs` | 3/3 pass: import, real CLTV/MTP/races/accounting, actual exercise-error cleanup |
| Threshold Jest | 6 suites, 94/94 pass |
| Swap-protocol Jest | 6 suites, 66/66 pass |
| Bot native-digests/import-safety Jest | 2 suites, 6/6 pass |
| Final `yarn typecheck:fast` | All 23 configured projects pass |
| Changed source/test Prettier with app configuration | Pass |
| `git diff --check` | Pass |
| Public capture inspection | Public transaction bytes/signatures/checkpoints, public block nonces and negative private-key flags only; no private keys, shares, seeds or signing nonce state |

Reproduction from this worktree:

```sh
export TSX_TSCONFIG_PATH=packages/bot/tsconfig.json
export ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz
export FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin
node --import tsx --test packages/bot/demo/regtest/threshold-adaptor/refund-reorg.test.cjs
node --import tsx --test packages/bot/demo/regtest/pair-recovery-clock-fixture.test.cjs
node --import tsx --test packages/bot/demo/regtest/cltv-consensus-fixture.test.cjs
(cd packages/threshold-ecdsa && ../../node_modules/.bin/jest --runInBand)
(cd packages/swap-protocol && ../../node_modules/.bin/jest --runInBand)
(cd packages/bot && ../../node_modules/.bin/jest --runInBand --runTestsByPath demo/regtest/threshold-adaptor/import-safety.jest.test.ts demo/regtest/threshold-adaptor/native-digests.jest.test.ts)
yarn typecheck:fast
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/bot/demo/regtest/pair-recovery-clock-fixture.ts packages/bot/demo/regtest/threshold-adaptor/refund-reorg.ts packages/bot/demo/regtest/threshold-adaptor/refund-reorg.test.cjs
git diff --check
```

For a fresh public capture set `REFUND_REORG_EVIDENCE_DIR` to an existing owned
directory without `refund-reorg.json`; exclusive creation refuses replacement.
Final native suite duration was 12.629 seconds; actual three-case proof 9.062
seconds. Original pair and CLTV suites took 16.985 and 8.348 seconds. Their source
and dependency boundary was unchanged by later public-observer negative/custody
assertions, so those baselines were not needlessly repeated.

Logs: `/tmp/frank-s2b-native-frozen.log`, `/tmp/frank-s2b-pair-baseline.log`,
`/tmp/frank-s2b-cltv-baseline.log`, `/tmp/frank-s2b-threshold.log`,
`/tmp/frank-s2b-policy.log`, `/tmp/frank-s2b-import.log`,
`/tmp/frank-s2b-typecheck-final.log`, `/tmp/frank-s2b-format.log`.
Two development native trials failed at the terminal observer because ethers'
decoded Result array was passed directly to the calldata encoder. The intended
first mechanical fix missed formatted indentation; the second trial repeated the
same failure. The corrected call passes a fresh two-element public balances array.
Neither failure is acceptance evidence; both completed owned cleanup. Subsequent
passing captures were refreshed after adding both-chain negative observation and
explicit current backing assertions. Initial local TypeScript errors (native
output type and unavailable Server type member) were corrected before all23 pass.

## Native identities and public trace

Existing archive SHA-256:
`08dbe296274c7940d47e9db15d2c6aa99aa6eb749d84f7888a1d5ce19cfb6233`.
Existing ABC executable SHA-256:
`606742cc74c3eee011e993e3731dc263278a57a94dc54da945daa002b29aeaee`,
version `Bitcoin ABC v0.34.0-a284f96d9fa3`. Each native fixture verifies exact
archive-member equality and pinned archive before startup. Installed Anvil 1.7.1,
commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`, build timestamp
`2026-05-08T07:54:31.470926000Z`. Unchanged StateChannel artifact SHA-256
`652dd7406da6862f7e3b6185bc9f260ccc1c3d5509c99c17c5ba171e33a2d0ab`.
Actual runtime bytes equal the artifact. Native identities remain `xec-regtest`
and `monad-regtest`/20143 with actual checkpoint validation. Anvil is generic EVM
execution evidence, not Monad consensus qualification.

[refund-reorg.json](refund-reorg.json), 130,839 bytes, SHA-256
`cecb962bdbfac1bf7b9ff6086469db68c33d7ee4471a5b1950a3b587f5dae6ab`.
The passing final run produced this capture from fresh synthetic nodes/keys.
Top-level headers are bounded to 24 from funding; each reorg observer's ancestry
is bounded independently. It retains exact public signed bytes and historical
anchors separately from current projections.

* XEC funding remains canonical at height 1353,
  `60a93cb96048e9aeed3a837fc8595c25c08777f9c31b872b9d4ebe92c127b309`,
  outpoint `31f67b444e9236efafeb7315fcddfccb47d33472bdebe9b5d8d0deb6d12de8fc:0`.
  Mature refund originally appears at height 1366,
  `5ba90dc18a237ab1b7c9b797d341c844fbf53bd08dee714b9373bf3d6ed641d9`.
  After invalidation, its confirmations are -1. Fresh observation reports
  noncanonical/nonterminal, retains the artifact and verifies canonical-only
  funding availability; mempool state is recorded independently.
* Identical refund transaction
  `1f927b7605c05b5084287fd7693b27d7dbdc3880cde11194f6f449ca45ac2eec`
  reappears at height 1367,
  `7a7f59ea17673432deee4092abdf1db4e18c258b08ff4e70747bb8677ca54ab4`,
  depth 2. Public validation verifies the exact outpoint, full redeem script,
  refund branch/sequence/locktime, ForkID signature, 11,000-satoshi input,
  10,000-satoshi refund and separate 1,000-satoshi fee. Wrong canonical-chain and
  mismatched outpoint observations reject in fresh children.
* XEC final time `1792102720` remains below unchanged bound `1792102747`.
  EVM observation `1792102725` remains below earliest fallback `1792102817`,
  with original response margin 10 and cross-clock margin 5 unchanged.
* EVM opening block 2 and challenge block 3 remain canonical. Actual fallback
  transaction `0xf4cefcb612c6966654c3a6ad5ae48ad7cb6cfb97c6fd530709fcca1dfeedfa4b`
  originally occupies block 6,
  `0x84b370e9e03768f03143385e8994270ed2562da65cb4e5c433e9a1bbd7731ae4`.
  After actual revert, fresh observation reports no current receipt, unsettled
  channel and `10000000000000000` wei backing. Parent checks restored recipient
  and relayer balances plus original nonce. Wrong native ID and mismatched
  channel observations reject in fresh children.
* The identical signed raw fallback/hash reappears in different block 6,
  `0xe9a6f16bf82cb814707f76e8aa6579665c1a867e69762627fd7a7c15b9eb12a0`.
  Fresh observation confirms current ancestry/terminal fallback and zero remaining
  backing. B receives `10^16` wei once; current relayer fee `31564838451080`
  wei is counted, orphan fee `36050383357120` wei is retained historically only.
* Separate fallback-first terminal observation finds successful transaction
  `0x681adda73ed4c6773c50c19c1dc2ea07c020a3e19d32682f665b568ca20b935d`
  at block 18,
  `0x73d5ebdace18923e207d8c83bef088312b77b3baffd443acd1a0b76797a3710f`.
  Its persisted cooperative calldata has valid original ordinary participant
  signatures. Fresh public observation preserves that knowledge while rejecting
  executability as `ChannelAlreadySettled`. The actual original cooperative call
  also has status 0, with only gas-payer fee changes and zero principal movement.
* Complete original pair accounting still reconciles 6 funded EVM principals,
  2 cooperative A payouts, 4 fallback B payouts, zero final contract/ordinary-K
  balances and canonical-only aggregate fee `2043976766617190` wei, below the
  unchanged `10^17` budget. Historical orphan fee is not counted twice.

All owned native processes, public temporary files and observation servers close
on success/error. Temporary-directory snapshot checks include the new observer
prefix; existing timeout/error/SIGTERM cleanup gates pass. No pattern process kill
or other-worktree cleanup occurred. Candidate-local dependency overlays remain.

## Explicit limits and next action

This completes only the contracted ordinary local refund/fallback subset after
S2a. Bounded clocks, native ancestry and fee premises do not prove recovery after
an unbounded watcher outage, deep funding reorg or arbitrary censorship. Original
pair guard-bypass control remains an ordinary-key baseline, not S1 or threshold
security. File fsync/reopen is not browser durability or antirollback assurance;
private-handle destruction is not malicious burn or secure erasure.

S1 remains separately outstanding and was not revisited. Financial runtime/browser
recovery, production public-observation ownership, watcher-outage policy,
ordinary-looking settlement alternative, external cryptographic assurance and
release authorization remain unfinished. Parent independent review of this frozen
candidate is next. No push, main merge, deployment, tracker closure or funded
public-chain action occurred.
