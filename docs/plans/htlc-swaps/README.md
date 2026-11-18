# Plan: rebuild Frank atomic swaps on HTLCs (xec-testnet ↔ monad-testnet)

Owner-approved 2026-11-17: rebuild on HTLC (testnet only), fix GenericHTLC edge cases, redeploy once. PR 0 (fix/atomic-swap-records-and-locks) already landed as #2059.

## Protocol shape
A = offerer, XEC depositor, secret holder. A locks XEC first (long deadline T_A); B locks MON second (short deadline T_B). A claims MON (reveals preimage); B reads the preimage from chain and claims XEC. No coordination messages after accept: both compute lock identities from the signed terms (XEC: P2SH script hash; EVM: lockId from sender+terms) and find locks on chain.

## Ownership
- Preimage (A): custody; deterministic `swapPreimage(swapId)` on the canonical role owner beside `conversationIdSalt` (packages/wallet/evm-wallet-material.ts): HKDF from messaging root, label `frank/swap-htlc-preimage/v1`, info = policy name ‖ swapId. Never stored. Explicit new derivation (AGENTS §6).
- Per-swap XEC keys (A refund key, B claim key): EcashWallet custody, derived from XEC account root under `frank/xec-htlc-key/v1`, info = chainIdentifier ‖ swapId ‖ role. New methods `htlcPublicKey(swapId, role)`, `signHtlcSpend(...)`. Keys never leave the wallet. Explicit new derivation.
- XEC funding tx/reservation/exposure: EcashWallet native-operation ledger, operationId `swap:<swapId>:xec-lock` (prepareNativeOperation / recordNativeOperationExposure / submitNativeOperation; p2sh cashaddr recipient).
- EVM lock/withdraw/refund: EVM native-operation journal via `sendContractCall`; new `EvmContractCallRecord` `{kind:'htlc', action:'lock'|'withdraw'|'refund', swapId, lockId}` (update journal validator + sync dispatcher together).
- Signed XEC HTLC spend (claim/refund): swap record, write-ahead before broadcast; deterministic bytes (fixed fee, own primary address, deterministic sigs) so two devices produce the same txid.
- Terms/hash lock/keys/deadlines: negotiation journal (signed events); swap record binds termsHash only.
- Lock state, reveal, finality, outcome: the chain, re-derived each tick, never persisted as authority.
- Timers/watching/auto claim+refund: headless `HtlcSwapRunner` in @frank/swap-protocol, started by app composition at session activation (`startSwapExecution` hook in app/src/utils/identity-session.ts), ticks ~15 s + wallet block events, independent of any card.
- Presentation: SignedNegotiationCard.vue reads the runner snapshot; only issues `authorizeFunding(swapId)`.

Dependency direction: @frank/swap-protocol depends only on @frank/codec, @noble/hashes and its own capability interfaces (XecHtlcCapability, EvmHtlcCapability, SwapSecretCapability, Clock); never imports @frank/wallet (check-deps enforces). @frank/wallet owns the eCash script/tx construction (packages/wallet/ecash-htlc.ts) and EVM HTLC calldata/readers (rewritten packages/wallet/swap-escrow.ts). app composes wallet handles + Chronik (relay proxy /chain-rpc/xec-testnet/chronik). Offer carries the HTLC address; runner checks it equals DEPLOYMENTS[evmChain].contracts.GenericHTLC.address for testnet policy; injected for regtest policy.

## Wire/persistent formats (no compat, §6)
Negotiation payload v2, pair policy `xec-monad-testnet-v2` / `xec-monad-regtest-proof-v2`.
- Offer adds: hashLock (32 B sha256 of 32 B preimage), xecRefundPublicKey (A, 33 B), evmRecipient (A main account, 20 B), xecRefundTime T_A (u64 s), evmExpiry T_B (u64 s), evmHtlcContract (20 B). `expiry` = acceptance deadline E.
- Accept adds: xecClaimPublicKey (B, 33 B), evmSender (B main account = refund address, 20 B). Reject unchanged.
- Reducer validation (failure = violation, never accepted): deadline rules, valid distinct points, non-zero addresses, evmRecipient ≠ evmSender, xecPrincipal ≥ 546. Golden vectors updated. Old v1 negotiation rows fail clearly; reset = delete that namespace.
- New swap record store `frank-swap-htlc-v1-<ns>` (keep CAS IndexedDB mechanics of storage/execution-browser.ts). Record v1: `{version:1, swapId, conversationId, owner:{accountIncarnation, localPublicKey}, role:'A'|'B', termsHash, fundingAuthorizedAt?, xecLockOperationId?, evmLockOperationId?, evmWithdrawOperationId?, evmRefundOperationId?, xecSpend?:{branch:'claim'|'refund', rawTx, txid}}`. Old execution DB fails clearly; reset = delete it.
- packages/contracts/deployments/monad-testnet.json gets the new GenericHTLC address.

## Contract (GenericHTLC v2, one redeploy)
```
struct Lock { address sender; address recipient; address refundAddress; address token;
              bytes32 hashLock; uint256 amount; uint64 expiresAt; uint8 state; /*0 none,1 open,2 withdrawn,3 refunded*/ bytes32 preimage; }
mapping(bytes32 => Lock) public locks;
mapping(address => mapping(address => uint256)) public owed;
function lockIdOf(address sender, address recipient, address refundAddress, address token, uint256 amount, bytes32 hashLock, uint64 expiresAt) public pure returns (bytes32) // keccak256(abi.encode(all seven))
function lock(address recipient, address refundAddress, address token, uint256 amount, bytes32 hashLock, uint64 expiresAt) external payable returns (bytes32 lockId)
function withdraw(bytes32 lockId, bytes32 preimage) external
function refund(bytes32 lockId) external
function batchWithdraw(bytes32[] calldata lockIds, bytes32 preimage) external
function batchDistribute(bytes32[] calldata lockIds, Payout[] calldata payouts, bytes32 preimage) external // recipient-only
function claimOwed(address token) external
```
- lockId bound to msg.sender + all terms (no squatting); duplicate reverts LockAlreadyExists.
- Absolute deadline: block.timestamp < expiresAt ≤ block.timestamp + 30 days. withdraw requires < expiresAt; refund requires ≥ expiresAt.
- sha256 only, bytes32 preimage, sha256(abi.encodePacked(preimage)) == hashLock; preimage stored in locks[id].preimage; keep Withdrawn(lockId, recipient, bytes32 preimage). Remove keccak support.
- All payouts via `_pay`: failed native call or token transfer credits owed[to][token] + emits PaymentDeferred; claimOwed pays msg.sender. All entry points nonReentrant.
- Fee-on-transfer: refuse (balance delta must equal amount, else UnsupportedToken). Native requires msg.value == amount; token path msg.value == 0.
- Remove old overloads, lockWithPermit, and refundAddress==0 defaulting (explicit non-zero).
- Redeploy via CREATE2 scripts/deploy.ts (existing salt; new initcode → new address), then scripts/htlc-round.ts (new ABI) on monad-testnet as proof.
- Other users: game-escrow.ts encodes batchDistribute (switch to bytes32 preimage); poker/liars-dice bots compute keccak hash locks but never actually call lock — follow-up ticket. Solana generic-htlc untouched (follow-up).

## Deadline rules (policy constants per chain) — margins pending owner confirmation
testnet: M_evm = 600 s (final = read at latest−10 blocks or `finalized` tag if Monad supports it); M_xec = 3 h (final = Chronik isFinal/Avalanche); S_xec = 2 h MTP skew; W = 1 h watcher downtime.
R1 T_A − T_B ≥ M_xec + S_xec + W = 6 h. R2 T_B − E ≥ 8 h. R3 T_A − E ≤ 72 h. UI defaults E = now+1h, T_B = E+12h, T_A = T_B+12h.
Cutoffs (runner re-checks before acting): A funds XEC only if now ≤ T_B − 6h; B locks MON only if A's XEC output is final with exact script+value and now ≤ T_B − 2h; A withdraws only if now ≤ T_B − M_evm; B claims XEC whenever it knows s and output unspent; B refunds MON once block.timestamp ≥ T_B and lock open; A refunds XEC once MTP(tip) > T_A, output unspent, and A has no landed MON withdraw.
regtest-proof policy: same formulas, margins in seconds (M_evm 5, M_xec 30, S 0, W 10); tests move time with setmocktime / evm_increaseTime.

## eCash HTLC script (P2SH)
```
OP_IF
  OP_SIZE <0x20> OP_EQUALVERIFY OP_SHA256 <hashLock:32> OP_EQUALVERIFY <B.xecClaimPublicKey:33>
OP_ELSE
  <T_A minimal scriptnum ≥500000000> OP_CHECKLOCKTIMEVERIFY OP_DROP <A.xecRefundPublicKey:33>
OP_ENDIF OP_CHECKSIG
```
Claim scriptSig `<sig‖0x41> <preimage32> OP_1 <redeem>`, nLockTime 0, sequence 0xffffffff. Refund scriptSig `<sig‖0x41> OP_0 <redeem>`, nLockTime T_A, sequence 0xfffffffe. SIGHASH_ALL|FORKID, deterministic signatures. Funding output value = xecPrincipal + XEC_HTLC_SPEND_FEE_SATS (1000), A pays. Spends: 1 input, 1 output of exactly xecPrincipal to spender's primary address, fee exactly 1000 sats. B checks one unspent output at hash160(redeem) with exactly that value, final. Reveal: chronik.tx(fundingTxid).outputs[vout].spentBy → spending input script push #2. Tools: ecash-lib 4.14.1 (Script, TxBuilder custom signatory), @frank/nakamoto; prior art packages/bot/demo/regtest/cltv-consensus-fixture.ts.

## State machines
A: offered → (no accept by E) expired. accepted → user clicks Lock; precheck cutoff, EVM main account gas for withdraw, no output already at the HTLC script → persist authorization + operationId, prepare/expose/submit → xecLockPending (wallet re-submits same bytes) → xecLocked(final) → wait for locks(lockIdOf(B…)): final and now ≤ T_B−600 → claiming (read state first, skip if withdrawn) → Withdrawn → claimed (terminal; A never refunds after a landed withdraw). Otherwise → awaitRefund → MTP > T_A and unspent → build refund, persist raw tx, broadcast/re-broadcast → refunded. If B spends with s → claimedByPeer.
B: offerReceived → validate R1–R3 + contract address → Accept (sends accept, persists fundingAuthorizedAt) → awaitXecLock → exact output final and now ≤ T_B−2h → locking (read locks(id) first; LockAlreadyExists counts as locked) | cutoff passes → abandoned. evmLocked → state withdrawn → read preimage → claimingXec (build, persist, broadcast until final) → complete; if A refunded first → lostToRefund. block.timestamp ≥ T_B and open → refunding → refunded. Afterwards claimOwed if owed > 0.
Restart/multi-device: re-derive every state from journal + record + chain each tick; every action reads chain first. Known gap: A double-funding XEC from two devices clicking simultaneously (narrowed by precheck; accepted for testnet).

## Deletions
app/src/swap/live-swap-execution.ts (+tests, SwapExecutionDisabledError, localStorage tags); packages/swap-protocol/src/swap-execution-runtime.ts (+tests) and the v1 record schema in storage/execution-browser.ts (keep CAS adapter); app/src/composables/useSwapEscrow.ts (+test); in packages/wallet/swap-escrow.ts: evaluateSwapStepPhase, SwapStepPhase, deriveSwapSecret, to32ByteHash string hashing, old encoders/decoder → strict encodeHtlcLock/Withdraw/Refund, readHtlcLock, htlcLockId (Solana helpers stay); swap-execution-commands.ts prepare/fund/claim/refund/cancel → authorizeSwapFunding + read model. Follow-up PR 9: swap-handshake-v1 plugin, ChatMessageSwapHandshake.vue, packages/docs/protocol/in-chat-swaps.md. Keep stage0, state-channel-pair, adaptor-signatures, threshold-ecdsa as research. Update docs/atomic-swap-specification.md, packages/docs/protocol/atomic-swaps.md, swap-protocol README.

## PR sequence
1. Contracts: GenericHTLC v2, artifact, htlc-round.ts ABI, wallet/swap-escrow.ts EVM encoders/readers checked against artifact, game-escrow.ts bytes32 preimage. Anvil acceptance: no squatting, duplicate reverts, fee-on-transfer refused, refund/withdraw to a rejecting address deferred + claimOwed, sha256 32-byte only, deadline boundaries (withdraw at expiresAt−1 ok, at expiresAt fails; refund at expiresAt ok), preimage readable from locks(), batch paths with deferred payouts, artifact-ABI consistency test, deploy.jest.test.ts on anvil.
2. Redeploy to monad-testnet + htlc-round evidence (deployer wallet ~0.5 MON gas).
3. Wallet eCash HTLC: ecash-htlc.ts + EcashWallet htlcPublicKey/signHtlcSpend. Real xec-regtest via startEcashRegtest (FRANK_BITCOIN_ABC_BIN_DIR=/Users/shammah/repos/bitcoin-abc-test-harness/build/src or `yarn --cwd packages/bot regtest:fetch`, x86_64 under Rosetta): fund via native op, claim with right preimage, wrong/31/33-byte rejected, refund non-final before MTP > T then accepted (mocktime), preimage extracted via Chronik, same keys from two instances of one seed, pinned derivation vector.
4. Wallet swapPreimage + EVM `htlc` contract-call record: vectors (same across handles, differs by swapId/account), journal + note-to-self round trip, malformed rejected, anvil kill-after-sign → resume re-sends same bytes, lands once.
5. Negotiation v2 (terms, policy v2, R1–R3, plugin, app writers, bot install): golden vectors, inverted/tight deadlines are violations, signed-negotiation.flow test on v2, old v1 row fails clearly. Precondition from PR 4: the offer's v2 `swapId` is generated by A (the secret holder) itself, deterministically from A's account material and the offer facts (AGENTS §5), never taken from B or from the wire; see PR 4 notes.
6. Headless HtlcSwapRunner + record store + pure nextAction: table tests of every transition/cutoff; real xec-regtest + anvil two-party integration (happy, B never locks → A refunds, A never claims → both refund, B offline past T_A → lostToRefund, restart after each persisted step without duplicate spend); two-device same account; browser storage suite. The runner asks `SwapSecretCapability` only for swapIds A created (PR 4 notes), and is the first consumer of `htlc-record` notes; the wallet sync dispatcher is extended then, if the runner needs wallet state from them.
7. App composition: runner in identity-session, capability composition replacing live-swap-execution, SignedNegotiationCard phase/deadlines/Lock button, §8 deletions, i18n en/fr; card unmounted still claims/refunds after reload; typecheck; check-deps; Chrome QA testnet happy path.
8. Docs + testnet evidence. 9 (follow-up): delete swap-handshake-v1.

## PR 1 notes (as landed)
- Contract details the plan left open: `State` is a Solidity enum (ABI `uint8`); `MAX_LOCK_DURATION` (30 days) and `PAYMENT_GAS` (100 000) are public constants. Native payouts inside withdraw/refund/batches forward `PAYMENT_GAS` and copy no return data, so a destination that refuses, needs more gas or burns it is deferred to `owed` instead of blocking the other party; `claimOwed(token, to)` (the only claim function) pays the caller's whole credit to `to` (non-zero; the caller itself, or elsewhere for a contract that cannot take the asset), zeroing it first, forwarding all gas and reverting (keeping the credit) if the payment fails. Token payouts are deferred when the token reverts or returns false. New errors: `InvalidExpiry`, `InvalidValue` (msg.value rules), `UnsupportedToken` (fee-on-transfer, or a token address without code), `NothingOwed`, `ReentrantCall`; new event `OwedClaimed(creditor, token, to, amount)`. `Withdrawn(lockId, recipient, preimage)` is emitted per lock by every withdraw path: `withdraw`, `batchWithdraw` and `batchDistribute` (which also emits `BatchDistributed`). `batchWithdraw` stays callable by anyone (pays each lock's recipient); `batchDistribute` stays recipient-only.
- The wallet encoder (`encodeHtlcLock`) additionally refuses `refundAddress == recipient`; the contract permits it (htlc-round pays itself), so `htlcLockId` and `decodeHtlcLock`/`readHtlcLock` accept such locks. The decoder also checks that a withdrawn lock's preimage hashes to its hash lock.
- Removed from `packages/wallet/swap-escrow.ts` with no remaining callers: `deriveSwapSecret`, `evaluateSwapStepPhase`, `SwapStepPhase`, `to32ByteHash`/`toBytes32Hex` (the Solana builders now take exactly 32 bytes, never hashing text into shape).
- Until PR 2 redeploys, `deployments/monad-testnet.json` still names the v1 contract while the artifact and wallet ABI are v2: nothing may call it in between (no live caller does; `app/src/composables/useSwapEscrow.ts`, the only reader, was deleted in PR 1 as planned in §Deletions).

## PR 4 notes (as landed)
- Preimage derivation `frank/swap-htlc-preimage/v1` (`packages/wallet/swap-preimage.ts`, pinned vectors in `swap-preimage.jest.test.ts`): `prk = HKDF-Extract(SHA-256, salt = utf8(label), ikm = messaging root)`, `preimage = HKDF-Expand(SHA-256, prk, u8(len(policyName)) ‖ utf8(policyName) ‖ swapId(32), 32)`. A historical BIP39 account uses its whole 64-byte seed as ikm, as its conversation-ID salt does. `MonadCanonicalRoleOwner.swapPreimage({policyName, swapId})`; hosts get `swapSecretCapabilityOf(wallet)` (`chain/evm-chain.ts`), a `SwapSecretCapability` that returns preimages only. PR 6 declares the same shape in `@frank/swap-protocol` without importing the wallet.
- Journal record `EvmHtlcCallRecord {kind:'htlc', action, swapId (64 lowercase hex, no 0x), lockId (0x + 64 lowercase hex)}`; the swap record is now `EvmSwapCallRecord` and `EvmContractCallRecord` is their union. Shape is checked on write and load; `sendContractCall` also refuses, before planning, an `htlc` record whose action/lockId is not what the calldata does (`htlcCallOf` in `swap-escrow.ts`; for `lock`, the id from the main account and the encoded terms), and one whose `to` is not this network's GenericHTLC (the registry's `contracts.htlc` deployment, or the regtest run's injected `EvmChainConfig.contracts.htlc`, the same resolution as `getHtlcAddress`; no deployment means every htlc call is refused).
- Note to self: an included HTLC call's note carries a self-only `htlc-record` item beside its `wallet-sync` item (`contractCallRecordItemOf`, plugin `message-item-plugins/htlc-record`). It is a host-consumed record like `swap-record`, not wallet state, so it does not pass through `applyWalletSyncItem`; the app treats it as an internal item. No consumer reads it yet (PR 6 runner). The sync dispatcher (`applyWalletSyncItem`) is deliberately untouched until the PR 6 runner consumes `htlc-record`. A malformed one, or one from anyone but the account, is kept as `unsupported` and the rest of the message is delivered.
- The kill point in the anvil test (`swap/htlc-lock-resume.anvil.jest.test.ts`) is after the bytes were exposed: a contract call signed but never exposed is ended at wallet open by design (never sent without its owner), so only exposed bytes are re-sent. The test runs anvil as `monad-regtest` with the contract injected through `contracts.htlc`; it uses no relay (the host's `emitWalletSync` hook records the note to self).
- Precondition for PR 5/6 (security): the preimage depends only on (account, policy, swapId). The `swapId` of a v2 offer must be generated by A itself, preferably deterministically from A's account material and the offer facts (AGENTS §5, e.g. a keyed hash under a private account salt), and `SwapSecretCapability.swapPreimage` must only be asked for swapIds A created. A swapId supplied by a peer, or an old swapId reused for a new offer, would make A publish (by withdrawing) or reuse the secret of a swap that may still be open.

## Follow-ups
- poker/liars-dice bots (`packages/bot/src/bots/poker-bot.ts`, `liars-dice-bot.ts`) now hold a table escrow from `packages/bot/src/bots/table-htlc.ts`: a 32-byte preimage, `htlcHashLock` (sha256) and buy-in lock ids from `htlcLockId` with the arbiter as recipient (`table-htlc.anvil.jest.test.ts` checks both against GenericHTLC v2 on anvil). Still undecided before any table escrow is wired to the contract: where the table preimage comes from (random per table in memory today; a deterministic one needs a custody derivation and a bot-context capability), and the buy-in lock terms and how the bot learns each player's lock (a game item carrying them, or the `Locked` event). The bots still never call `lock`, and settling a table returns an explicit unsupported result and moves no value (no transaction, no outbox payout).
- The `txHash` fields of the poker and liars-dice game items (`PokerItem`, `LiarsDiceItem` and their codecs) are now never written by the bots; removing or repurposing them is a separate wire change.
- Solana generic-htlc is unchanged (still relative duration, no lockId binding).
- `packages/contracts` jest suites (including these anvil acceptance tests) and the wallet `swap-escrow`/`game-escrow` suites are not run by hosted CI; add them to `.github/workflows/app-lint-and-test.yml`.
