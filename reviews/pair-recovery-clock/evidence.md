# B1b ordinary recovery-clock evidence

Base: `a9aa5cc53b38d398eeec76f56ab14e2a3ed396c2`. Pure helper predecessor: `594b7011f6a7a74b30b270cc1f535597e94b89a5`, independently approved by Astra. Actual model gpt-6.1-sol, tier3/strong packet.

Public proof: [evidence.json](evidence.json), SHA-256 `d1be7a17920279ef7ef3447328142cb88499ce24abb227deb647b8d845c166e9`. Actual owned ABC0.34.0 plus owned Anvil, exact unmodified StateChannel artifact/runtime comparison, RPC chain IDs/checkpoints, both custodial deposits, public scripts/signatures/raw transactions, 1375 native XEC headers and 23 mined EVM receipts. No private keys, RPC credentials, public funds, shared nodes, downloads or VM. K is ordinary and explicitly not joint J; no threshold/adaptor completion or extracted secret is asserted.

## Native gates

| Gate | Result |
| --- | --- |
| Actual pair fixture tests | 4/4 pass: import effects, native scenario proof, exercise error cleanup, SIGTERM cleanup |
| B1a after helper extraction | 3/3 pass: unchanged native/import/error controls |
| Prior B1a public proof equivalence | Exact redeem script plus15 raw/digest records match extracted helpers |
| Existing pure B0 policy suite | 28/28 pass, 3 suites |
| Whole repository typecheck | 23/23 projects pass |
| New pair source/test formatter | Pass with app Prettier configuration |
| Standalone public proof | Normal exit0; independent saved header median/continuity, timestamp, and ledger arithmetic verification pass |
| Full swap-protocol formatter at original base | FAIL: inherited unchanged state-channel-pair.ts and .jest.test.ts |

The inherited formatting gap is already corrected by a separately reviewed predecessor in protected B0 head `30148b0cb7793d962681df51fc5a731691853568`; protected native CLTV head `0b6c0038` inherits it. Publication worker reports the package format check passes there. Original B1b preserves its specified base and does not edit those policy files. Integration must transport onto that reviewed correction and rerun its exact-tree package gate; no full-package format pass is claimed for this original ancestry.

## Predeclared clocks and independent recovery

Principal per XEC output10000 sats and fee1000 sats (max2000) are separate from M=10^16wei. MTP lag6s + observation4s + inclusion8s + finality12s give XEC refund-final bound T_X+30, native depth2. EVM response10s and cross-clock5s require opening+D strictly greater than T_X+45. Gas per operation<=300000; deployment<=3000000; price<=2gwei; aggregate<=10^17wei. These are explicitly controlled local test assumptions, not measured production latency or irreversible finality promises.

Both actual deposits exist before recovery. The safe ordinary K byte buffer is overwritten and its reference removed before recovery; there is no cooperative signature or claim construction afterward. A_refund independently signs the native ForkID refund; B alone starts challenge; unrelated relayer closes fallback. This models unavailable ordinary signing authority and does not claim threshold burn. The sender and relayer cannot redirect fixed cooperative payout: altered payout fails native InvalidSignature and only charges gas.

Safe refund rejects at observed previous-tip MTP T_X, then succeeds at T_X+1 and reaches depth2. Actual observed MTP lag, inclusion, finality timestamps and EVM cross-clock observation remain within the predeclared bounds. Earliest EVM fallback is opening+D even though actual immediate challenge expires one second later. Delayed challenge cannot widen admission: an actual equal-bound-duration channel remains rejected by the unchanged pure B0 validator. Pure equal/short variants are rejected before ordinary completion authorization; no threshold prepared-package flags are fabricated. The unused adaptorPoint in the shape validator is an explicitly labeled public-generator placeholder only.

Native receipts before/exact/after actual expiry, both settlement race orders and late cooperative close:

| Scenario | Native block timestamp | Outcome |
| --- | --- | --- |
| safe independent refunds: actual deposit | 1792031036 | status1 included |
| safe independent refunds: B alone starts challenge | 1792031037 | status1 included |
| safe fallback before expiry rejects | 1792031236 | reverted ChallengeNotExpired |
| safe independent refunds: independent relayer fallback | 1792031237 | status1 included |
| safe fallback after settlement rejects | 1792031238 | reverted ChannelAlreadySettled |
| delayed challenge equal-bound rejection: actual deposit | 1792031246 | status1 included |
| delayed challenge equal-bound rejection: B alone starts challenge | 1792031276 | status1 included |
| delayed challenge equal-bound rejection: independent relayer fallback | 1792031421 | status1 included |
| cooperative close first: actual deposit | 1792031536 | status1 included |
| cooperative close first: B alone starts challenge | 1792031537 | status1 included |
| independent fee payer cannot redirect fixed cooperative payout | 1792031545 | reverted InvalidSignature |
| cooperative close first pays fixed A | 1792031546 | status1 included |
| fallback after cooperative close rejects | 1792031737 | reverted ChannelAlreadySettled |
| fallback first: actual deposit | 1792031836 | status1 included |
| fallback first: B alone starts challenge | 1792031837 | status1 included |
| fallback first: independent relayer fallback | 1792032037 | status1 included |
| cooperative close after fallback rejects | 1792032038 | reverted ChannelAlreadySettled |
| cooperative close after expiry: actual deposit | 1792032136 | status1 included |
| cooperative close after expiry: B alone starts challenge | 1792032137 | status1 included |
| cooperative close remains valid after expiry if fallback unset | 1792032238 | status1 included |
| unsafe bypass negative control: actual deposit | 1792032336 | status1 included |
| unsafe bypass negative control: B alone starts challenge | 1792032337 | status1 included |
| unsafe bypass negative control: independent relayer fallback | 1792032377 | status1 included |

Every reverted EVM transaction verifies the expected custom error against native eth_call at the unchanged state and verifies only the payer loses gas. Successful receipts reconcile exact recipient principal, gas payer cost and contract balance. All six channels settle: two M payouts to A, four M fallbacks to B, all K balances zero, contract balance zero. The complete aggregate ledger reconciles deployment plus all receipt fees. Four untouched XEC outputs remain explicitly listed synthetic unspent test state; they are not labeled settled/refunded pair evidence.

## Deliberate unsafe negative control

If admission is intentionally bypassed and A stays inactive, B receives EVM fallback and subsequently uses ordinary K to spend the unrefunded XEC claim branch after T_X. The proof names the violated strict horizon (105seconds short of its declared lower bound), both actual principal outcomes and admissible=false. It is timing evidence only; there is no secret extraction or claim that this path can safely complete a swap.

## Reproduction and cleanup

```
export TSX_TSCONFIG_PATH=packages/bot/tsconfig.json
export ADAPTOR_ABC_ARCHIVE=/tmp/frank-adaptor-abc.tar.gz
export FRANK_BITCOIN_ABC_BIN_DIR=/tmp/frank-adaptor-abc-verified/bitcoin-abc-0.34.0/bin
node --import tsx --test packages/bot/demo/regtest/pair-recovery-clock-fixture.test.cjs
node --import tsx --test packages/bot/demo/regtest/cltv-consensus-fixture.test.cjs
yarn --cwd packages/swap-protocol test --runInBand
yarn typecheck:fast
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/bot/demo/regtest/pair-recovery-clock-fixture.ts packages/bot/demo/regtest/pair-recovery-clock-fixture.test.cjs
node --import tsx packages/bot/demo/regtest/pair-recovery-clock-fixture.ts > /tmp/pair-clock-public-proof.json
```

Existing cached pinned ABC archive/binary is mandatory and verified by unchanged readiness fixture. Anvil uses the existing installed executable, literal loopback RPC, one thread, synthetic default development accounts and an owned temporary log directory. Its actual RPC native ID and client version are verified; provider's static network setting only avoids startup retries and does not substitute for RPC identity checks. @frank dependency overlays resolve this worktree; wallet Chronik4.3.1; no dependency manifest changed or new package downloaded.

Logs: `/tmp/frank-pair-tests.log`, `/tmp/frank-pair-helper-tests.log`, `/tmp/frank-pair-helper-typecheck.log`, `/tmp/frank-pair-policy-tests.log`, `/tmp/frank-pair-typecheck.log`, `/tmp/frank-pair-format-check.log`, `/tmp/frank-pair-policy-format.log`. Pure imports trap process/network/key generation/state writes/exitCode/listener effects. Error probe invalidates entropy only after real ABC+Anvil startup; no mocked native success. Startup timeout and SIGTERM during native pair execution remove only owned state and stop all owned processes. Port closure assertions and tempdir snapshots return to baseline. Post-gate process inspection found no owned ABC/Anvil. Dependency links are removed only after all gates and processes finish, before commit.

Unchanged approved readiness source/API, contract source/artifact, crypto/protocol implementations, main checkout, and paused broad B1 source. No threshold/adaptor sessions, EVM/XEC reorg experiments, production state/journal/transport, merge, PR, deployment or publication. Still unproved: dealerless J/two sequential J/T presignatures, durable public package before release, actual malicious burn, observed native signature extraction, bidirectional in-envelope reorg recovery, monotonic secret knowledge, late-reveal safety and external cryptographic assurance. Independent Astra exact-tip review and corrected-base integration gates remain required.
