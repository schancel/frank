# Cross-Chain Atomic Swaps (HTLC)

**Status**: Implemented for testnet only: eCash testnet (`xec-testnet`) XEC for Monad testnet (`monad-testnet`) MON. Owner QA on testnet is still pending.

**Implementation**: `packages/swap-protocol` (negotiation, pure decision core, runner), `packages/wallet` (eCash script, keys, EVM calls), `packages/contracts/contracts/GenericHTLC.sol`, `app/src/swap` (composition and card).

**Specification**: `docs/atomic-swap-specification.md` (section "Implemented: the HTLC swap") and the build plan `docs/plans/htlc-swaps/README.md`.

---

## 1. Overview

Two Frank users swap XEC for MON in a chat. Each side locks its coins in a hash time-locked contract (HTLC): an eCash P2SH script on one side and the `GenericHTLC` contract on Monad on the other. One 32-byte secret opens both locks. Whoever reveals it to take one side's coins makes it public, so the other party can take the other side. If something goes wrong, each party gets its own coins back after its deadline.

Frank's relay only carries the signed offer and the reply. It never holds coins or the secret, and it does not decide what happened on chain. After the accept, the two parties send each other nothing more: both compute where the locks are from the signed terms and watch the chains.

Roles:

- **A** makes the offer, puts up XEC and holds the secret.
- **B** answers the offer and puts up MON.

## 2. The flow

```mermaid
sequenceDiagram
    autonumber
    participant A as A (offers XEC, holds the secret)
    participant B as B (offers MON)
    participant X as eCash testnet
    participant M as Monad testnet (GenericHTLC)

    A->>B: Signed offer (amounts, hash lock, A's refund key, A's MON address, deadlines E, T_B, T_A)
    B->>A: Signed accept (B's claim key, B's MON address)
    A->>X: Lock XEC in the P2SH HTLC (automatic on the accept; refund after T_A)
    B->>M: Lock MON in GenericHTLC once A's XEC is final (refund from T_B)
    A->>M: Withdraw MON with the secret (the secret is now on chain)
    B->>M: Read the secret from locks(lockId)
    B->>X: Claim XEC with the secret
```

Signing the offer is A's permission for the XEC lock; there is no separate Lock button. Accepting is B's permission for the MON lock. After that, a background runner on each side does every step by itself, including refunds.

## 3. The secret and the swap ID

- The secret (preimage) is 32 bytes derived from A's account: `frank/swap-htlc-preimage/v1` (`packages/wallet/swap-preimage.ts`), from the account's messaging root, the policy name and the swap ID. It is never stored; every device of A's account computes the same one. The hash lock is `sha256(preimage)`.
- A derives the swap ID itself: an HMAC-SHA256, under A's private account salt, of the `frank/swap-offer-id/v1` transcript of the offer's facts (`deriveOfferSwapId` in `packages/swap-protocol/src/negotiation.ts`). Nobody else can compute it, and A never takes a swap ID from a peer. A signs an offer only for the swap ID its own account derives, and the runner asks for the secret only for such a swap ID.

## 4. The two locks

### eCash HTLC (P2SH)

```text
OP_IF
  OP_SIZE <0x20> OP_EQUALVERIFY OP_SHA256 <hashLock:32> OP_EQUALVERIFY <B claim key:33>
OP_ELSE
  <T_A> OP_CHECKLOCKTIMEVERIFY OP_DROP <A refund key:33>
OP_ENDIF OP_CHECKSIG
```

- Claim (B): scriptSig `<sig‖0x41> <preimage:32> OP_1 <redeem>`, nLockTime 0, sequence `0xffffffff`.
- Refund (A): scriptSig `<sig‖0x41> OP_0 <redeem>`, nLockTime T_A, sequence `0xfffffffe`. It is valid once the median time of the last 11 blocks is past T_A.
- A funds exactly `principal + 1000` sats. A claim or refund has one input and one output of exactly the principal to the spender's own address, so its fee is exactly 1000 sats. The principal must be at least 546 sats.
- Signatures are SIGHASH_ALL | FORKID with deterministic nonces, and the per-swap keys come from `frank/xec-htlc-key/v1` (`packages/wallet/ecash-htlc-keys.ts`). So two devices of one account build the same spend with the same txid.
- Code: `packages/wallet/ecash-htlc.ts`.

### GenericHTLC v2 (Monad testnet)

- Address on `monad-testnet`: `0x67C3231b8F28309a84004643C592FFc9eAd939cB` (`packages/contracts/deployments/monad-testnet.json`).
- `lockId = keccak256(abi.encode(sender, recipient, refundAddress, token, amount, hashLock, expiresAt))`. The sender is part of the ID, so nobody can take another party's lock ID, and the same lock twice reverts with `LockAlreadyExists`.
- For a swap: sender and refund address are B's main account, the recipient is A's main account, the token is native MON, `expiresAt` is T_B.
- `withdraw(lockId, preimage)` works strictly before `expiresAt` and requires `sha256(preimage) == hashLock` with a 32-byte preimage. The preimage is then stored in `locks(lockId)`, which is where B reads it. `refund(lockId)` works from `expiresAt` on.
- A lock may last at most 30 days (`MAX_LOCK_DURATION`).
- A payment that the destination refuses is credited to `owed` instead of blocking the call. The runner collects it with `claimOwed`.

## 5. Deadlines

The offer carries three absolute times: **E** (accept by), **T_B** (MON lock expiry) and **T_A** (XEC refund time). The reducer treats signed terms that break these rules as a violation, never as an accepted swap:

| Rule | Testnet | Regtest proof |
| --- | --- | --- |
| R1 `T_A − T_B ≥` | 6 h | 40 s |
| R2 `T_B − E ≥` | 8 h | 60 s |
| R3 `T_A − E ≤` | 72 h | 72 h |

Default deadlines in the app: E = now + 1 h, T_B = E + 12 h, T_A = T_B + 12 h.

Lock window: GenericHTLC refuses a lock more than 30 days ahead, so the offer and accept are not signed when T_B is more than 30 days minus 1 h away, and the offer dialog caps E accordingly.

The runners stop starting new steps at these cutoffs:

| Step | Allowed while now ≤ | Testnet | Regtest proof |
| --- | --- | --- | --- |
| A locks XEC | T_B − (M_xec + S_xec + W) | T_B − 6 h | T_B − 40 s |
| B locks MON (A's XEC output final) | T_B − lock margin | T_B − 2 h | T_B − 20 s |
| A withdraws MON | T_B − M_evm | T_B − 600 s | T_B − 5 s |

The margins on testnet: M_evm 600 s (Monad finality), M_xec 3 h (eCash finality), S_xec 2 h (eCash median-time skew), W 1 h (watcher downtime). On regtest: 5 s, 30 s, 0 and 10 s.

Refunds and the claim follow the chains' own clocks: B refunds MON once the Monad block time is ≥ T_B and the lock is still open; A refunds XEC once the eCash median time is > T_A and the output is unspent (once its MON withdraw landed, A refunds only an extra output from a double funding, never the one B is owed); B claims XEC whenever it knows the secret and the output is unspent.

A cutoff counts as passed when either the device clock or the latest Monad block time says so. Once A's withdraw may have exposed the secret, A keeps trying to withdraw until T_B.

## 6. Devices and restarts

- Only the account's active device starts swap work. A device is active when the account's latest device claim names it, or when no device holds a claim. Before its first mailbox read, a device starts nothing. A device that is not active only finishes work it already started and exposed itself.
- Each runner reads the signed negotiation, its own swap record and both chains on every tick (about every 15 s). The record holds only what the chains cannot give back. The XEC lock is written down before it is funded, and every signed eCash claim or refund is written down before it is broadcast and re-sent as the same bytes after a restart.
- If two devices both believe they are active, both may fund the XEC lock. B is owed only one principal; A refunds the extra output after T_A.

## 7. Known gaps

- No owner QA on testnet with tXEC yet.
- A withdraw stuck in the mempool past its cutoff can leak the secret while A goes on to refund (issue #2087, open).
- A second device cannot fund from eCash change made by the first device (issue #2084, open).
- The runner acts only while Frank is open on the active device. There are no block events; it ticks on a timer.
- B's MON lock and A's withdraw are sent from the EVM main account, which must hold the gas. Frank warns but does not move funds there for you.
- Solana's `generic-htlc` program is not part of this swap and is unchanged.
