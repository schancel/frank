# EVM spend path: coin heap, bundles, broadcast queue

Status: draft for owner review. This replaces the EVM spend machinery listed under "What this deletes". It does not cover UTXO or Solana wallets: each family keeps its own coin list in its own shape. Only the wallet interface above them is shared.

## The rules this implements

1. A wallet has a keyring and one coin list. The keyring derives fresh keys, and scans and restores. The send path signs with the key stored on the coin and never touches the keyring.
2. Selecting and signing hold a short lock and do no network I/O. Network waits never hold the lock, so messages are built in parallel and sent as they are built.
3. A message's own payments are persisted, then handed to the relay, then broadcast. The wallet never broadcasts a message payment before the relay has the message.
4. The only queue is for resending broken messages, with the same signed bytes.
5. Every send leaves the account set tidy: change goes to change accounts, and dust is never left behind.

## Coin

One record per `[account, nonce]`. A wallet serves one chain, so a coin has no chain field.

| Field | Meaning |
|---|---|
| `account`, `nonce` | Identity of the coin. |
| `privateKey` | The account's key. |
| `valueWei` | What the account will hold at this nonce. |
| `origin` | `stealth` (received from a message), `change` (a change account), `root`, `identity`. |
| `changeIndex` | For `change` coins: the change account number. |
| `state` | `unspent`, `spend_pending`, `pending_receipt`, `spent`. |
| `holder` | The operation that took it. |
| `spendingTx` | The signed transaction that spends it. Set on `pending_receipt` and `spent`. |
| `after` | For a dependency coin: the `[account, nonce]` whose transaction must be in flight first. |
| `spendableFromBlock` | Not selectable before this block. It comes from the chain's spend rule. |

The states:

- `unspent` coins are in the heap.
- `spend_pending` exists in memory only, while a bundle is being built under the lock. A crash forgets it, and the coin is `unspent` again.
- `pending_receipt` means the spending transaction is stored on the coin and may have left the wallet. The coin leaves this state only on chain evidence: included, or its nonce taken by a different transaction. A timeout, a restart, a relay refusal or a deleted message is not chain evidence.
- `spent` means the chain included its transaction. A background job prunes old `spent` coins.

## The heap

The heap is a sorted index over the `unspent` coins whose `spendableFromBlock` has been reached and whose `after` dependency is in flight. Pop order:

1. `stealth` coins, largest value first;
2. then `change` coins by `[changeIndex ascending, value descending]`;
3. then `root` and `identity` coins last.

(Open question 1 below covers the root and identity coins.)

Several wallets can share one heap. For example, the bots on one host share one coin list, injected into each wallet. Each coin carries its own key, so any of those wallets can spend it.

## Building a bundle (under the lock)

Input: the amount to pay, the fee price `P`, the dust threshold, and the current head block. `P` is read before taking the lock (see Fees).

1. Pop coins until the coins popped so far cover the amount plus their fees. Each popped coin pays one transaction to its own address. The address is derived with the message's KDF: the stamp address for the stamp, or the per-index stealth address for a payment. Popped coins become `spend_pending` and carry the holder.
2. The last coin may pay only part of its value. For its account:
   - **Remainder below dust:** add it to that coin's payment as a gift. The account is emptied exactly; see Fees.
   - **Remainder that can be moved now:** sign change moves from the account to the next change accounts (see the open question on how they are numbered). The amounts come from the geometric radix split in `evm-change-distribution.ts`, and each move empties exactly.
   - **Remainder that can't be moved now** (blocked by the chain's spend rule): add a dependency coin `[account, n+1]` with the remainder, `after = [account, n]`, and `spendableFromBlock` from the rule. Nothing else can pop it until its predecessor is in flight and the rule allows it. The background split moves it later.
3. Nonces: give each account's transactions in the bundle (payment and change moves) the account's next nonces in **random order**. The payment is not always the lowest nonce.
4. Sign every transaction with `coin.privateKey`. Every popped coin becomes `pending_receipt`, with `spendingTx` set.
5. Release the lock.

None of these steps waits on the network. The lock is held for the time it takes to sign a handful of transactions.

## After the lock

1. **Persist** the message, its payments, its change moves and the coin states in one write. A crash before this write leaves nothing anyone can broadcast; on restart those coins are `unspent`.
2. **Hand the message to the relay** with its payments only. Change moves never go into the message or the relay payload: they would reveal which output was change, and the recipient would try to derive keys for them.
3. **Enqueue** every transaction in the broadcast queue.

## Broadcast queue

- Each queued transaction carries a promise: its predecessor `[account, nonce-1]` from this wallet is in flight (accepted by a node or seen pending), or there is no such predecessor.
- **Change moves** are released as soon as their predecessor promise resolves.
- **Message payments** are released when their predecessor promise resolves *and* the relay has accepted the message.
- Released transactions are broadcast in nonce order per account, outside any lock. A failed broadcast retries the same bytes with backoff.
- When the chain accepts a change move, its output becomes a new `change` coin, `[changeAccount, its next nonce]`, with `spendableFromBlock` from the spend rule.
- The relay, the recipient and the sender may all broadcast the same payment bytes. That is harmless, because they are identical.

## Settlement

`pending_receipt` coins are checked against the chain together, in one look per interval for the whole wallet:

- **Included:** the coin becomes `spent`, and its successor (if not already present) gets the account's real remaining balance.
- **Nonce taken by a different transaction:** the coin's transaction is gone. If the coin was a payment of a message the relay never accepted, the message goes to the resend queue (see below). This is the only case where the coin's value can return as a fresh coin.
- **Neither:** keep waiting.

## Resend queue (the only queue)

A message whose relay hand-off failed or got no answer is retried with the same message bytes and the same signed payments, with backoff, until the relay answers definitively.

- **Relay accepts:** the payments are released to the broadcast queue.
- **Relay refuses definitively:**
  - if those payment bytes were never broadcast and the account's nonce is still free on chain, the coins return to `unspent`;
  - otherwise they stay `pending_receipt` until the chain decides.

Retry reuses the existing operation. It never builds a fresh payment for the same message. Later messages never wait on it: they pop other coins, or the dependency coin at `n+1`.

## Fees: fixed and exact

- A plain value transfer always uses 21,000 gas. Set `maxFeePerGas = maxPriorityFeePerGas = P`, or use a legacy `gasPrice = P` where the chain allows. The fee is then exactly `21000 × P`, with no auction leftover. On Monad, which charges the gas limit, the number is the same.
- So "send the whole balance" is exact: `value = balance − 21000 × P`. An account is emptied to zero, or keeps a successor coin worth more than dust. It never keeps sub-dust leftovers.
- `P` comes from chain config plus a fee read made before taking the lock, cached and refreshed off the send path. It must carry headroom over the base fee, because signed bytes can't be repriced (see open question 3).

## Chain spend rule (config)

Each network's config has an optional rule:

```
spendRule: { belowWei: N, waitBlocks: Y }
```

An account holding less than `N` after a spend must wait `Y` blocks before its next spend is included. Without the rule, consecutive nonces from one account may be broadcast back to back. On Monad, the registry currently has `N = 10 MON` and `Y = 3` (`chains-registry.ts`, `MONAD_SPEND_SPACING_BLOCKS`). This rule generalises `spendSpacingBlocks` and the reserve. `Y` is set in config, so it can be raised if Monad needs more blocks.

The rule is used in two places:

- in building, to decide whether a remainder can be moved now or becomes a dependency coin;
- in setting `spendableFromBlock` on new and dependency coins.

## Background maintenance

These are triggered after each send and on a timer, and use the same lock and pop rules. They never take a coin another operation holds.

- **Radix split:** an oversized coin is split across fresh change accounts using `evm-change-distribution.ts`.
- **Sweep:** dependency coins and small change are moved forward once their spend rule allows. A move is skipped if its fee costs more than the value moved.

## Restart

- Load the coin list.
- `spend_pending` doesn't exist on disk, so nothing is half-built.
- Re-enqueue every persisted transaction that isn't settled.
- Put messages the relay hasn't accepted back in the resend queue.
- Run settlement.

## What this deletes

- **Successor-on-mined:** `EvmCoinList.recordMined` adds `[account, n+1]` only after the chain shows `n`. It is replaced by building step 2 and the dependency coin.
- **The waiting loop:** the stamp payer's "waits its turn" loop (`evm-stamp-payer.ts`, the `waiting-for-payment` stage and `blockedBy`).
- **The second inventory:** `EvmSubAccountPool` claims and records (`evm-account-pool.ts`). The coin list becomes the only record of what is held.
- **The fund-ahead lock:** `evm-fund-ahead.ts` and its exclusive lock on the main account. Background maintenance replaces it.
- **`evm-change-pool.ts`:** change accounts become `change` coins in the list.
- **Auction-style fees** on these transfers (`eth_feeHistory` per send).

Each deletion lands in the same change that replaces it, with every consumer updated: app, bots and mail gateway. There is no compatibility layer. Old development data is reset: the development reset path is documented in the PR, and no keys or funded state are deleted.

## Acceptance tests

Unit tests run against the pure heap, builder and queue. An integration run on Monad testnet uses persistent wallets and sweeps its funds back at the end. Tests do not run on anvil, which queues future nonces and has none of Monad's rules.

1. Pop order follows the heap keys.
2. Two bundles built concurrently never share a coin.
3. The lock is held only during the synchronous build: a test fails if any await happens under it.
4. A send right after an undelivered message that holds `[main, n]` goes out at once, in the same conversation and in another conversation. It pops other coins or the dependency coin. It never shows "waiting for the previous payment".
5. Sub-dust remainder goes to the recipient and the account ends at exactly 0.
6. A movable remainder becomes radix-split change moves. A blocked remainder becomes a dependency coin with the correct `after` and `spendableFromBlock`.
7. Nonce order between the payment and the change moves on one account is randomised: both orders occur over many runs.
8. The broadcast queue releases in nonce order, never releases a message payment before relay acceptance, and releases a change move with a lower nonce before the relay answers.
9. A crash at each step is followed by a restart with no double spend, no lost coin, and no fresh payment for an existing message.
10. The resend queue retries with the same bytes. A definitive refusal releases the coins only if the bytes were never broadcast and the nonce is free.
11. Fees: every transfer costs exactly `21000 × P`, and a full-balance send empties the account.
12. The spend rule is read from config. Changing `Y` changes the dependency coin's `spendableFromBlock`.
13. Background maintenance never takes a held coin and skips moves whose fee exceeds the value moved.
14. Several wallets sharing one heap never take the same coin.

## Open questions (defaults applied until the owner answers)

1. **Root and identity in the heap.** Default: popped last, after stealth and change coins. Alternative: treat root as change account 0.
2. **"Next several change account numbers."** Default: the keyring's next unused change indices. The radix split decides how many.
3. **Fixed fee price `P` when the base fee rises above it.** The signed bytes then wait until the base fee falls. Default: `P` = max(config floor, 2 × current base fee).
4. **Dust threshold.** Default: the fee of one transfer, `21000 × P`.
