# Monad: gas, fees and the reserve balance

The Monad rules a wallet must be built around. All were observed on a local Monad network
(monad-solonet, client v0.16.4, chain ID 20143) on 2026-10-10; the same client rules apply on
Monad testnet and mainnet. Reproduce with `yarn --cwd packages/bot regtest:monad-reserve` and the
commands in `packages/bot/demo/regtest/monad-regtest.ts`.

## Gas is charged on the gas limit

A transaction pays `gas limit x gas price`, not `gas used x gas price`. Observed: a plain
transfer sent with a gas limit of 100,000 had `gasUsed` 100,000 in its receipt and the sender's
balance fell by exactly 100,000 x the gas price. Set the limit to what the transaction needs
(21,000 for a transfer), not to a generous ceiling.

## The fee cap is free; the gas limit is not

Measured on 2026-10-10 from an account holding 100 MON. Base fee 100 gwei in every block;
`eth_gasPrice` answered 102 gwei and `eth_maxPriorityFeePerGas` 2 gwei.

| Transaction (plain transfer, gas limit 21,000) | Block | Charged per gas |
| ---------------------------------------------- | ----- | --------------- |
| type 2, `maxFeePerGas` 500 gwei (5x base), tip 1 gwei | 5671 | 101 gwei (base + tip) |
| type 2, `maxFeePerGas` 500 gwei, tip 0          | 5674  | 100 gwei (base) |
| type 0, `gasPrice` 300 gwei (3x base)           | 5676  | 300 gwei (all of it) |
| type 0, `gasPrice` 100 gwei (= base)            | 5679  | 100 gwei        |

The receipt's `effectiveGasPrice` and the balance change agreed in every row.

- **Type 2 (EIP-1559): a high `maxFeePerGas` costs nothing.** The price is base fee + tip, as
  on Ethereum. Only the tip and the gas limit are paid in full.
- **Type 0 (legacy): the whole `gasPrice` is charged**, as on Ethereum (everything above the
  base fee is the tip). A legacy transaction priced "to be safe" pays for it.
- Either way the price is multiplied by the gas LIMIT, not the gas used.

## Gas estimates

A small contract was deployed (block 5681): a transfer with no data adds one to a storage slot;
a call with 64 bytes of data writes a value to a slot.

- `eth_estimateGas` for a plain transfer to an ordinary account: exactly 21,000.
- A transfer of 1 MON to the contract with gas limit 21,000 (block 5685): mined with status 0,
  no value moved, and the whole 21,000 x price was charged. A recipient that has code needs
  more than 21,000.
- `eth_estimateGas` for that transfer: 49,413. Sent with that limit (block 5687) it succeeded.
- The estimate depends on the state it will meet:

| Call                                             | `eth_estimateGas` |
| ------------------------------------------------ | ----------------- |
| transfer to the contract, slot still zero        | 49,413            |
| the same transfer again, slot now non-zero       | 32,379            |
| write to a fresh slot (zero to non-zero)         | 49,595            |
| write a different value to that slot             | 32,562            |
| write the same value again                       | 29,756            |
| write zero (clear it)                            | 32,550            |

- Each estimate was enough when used as the limit for the call it was made for (blocks 5687,
  5691, 5696, 5701). A first-time write sent with the repeat estimate of 32,562 (block 5704)
  ran out of gas: status 0, 32,562 x price charged.
- So a first write to a slot (a first ERC-20 approval, a first transfer to an address) costs
  about 17,000 gas more than a repeat, and an estimate is only good for the state it was made
  against. Estimate immediately before signing, for the exact call; do not reuse an estimate
  from an earlier call of the same kind. Because the limit is what is paid, every unit of
  margin is paid for too.
- Not measured: how much of an estimate is the node's own margin. The receipt reports the
  limit as `gasUsed`, so the true usage is not visible from outside.
- Seen once: a transaction sent from an account in the instant after its first funding was
  confirmed was refused at submission with "Signer had insufficient balance". Five blocks
  later the same account sent normally.

## Money that has just arrived

Measured on 2026-10-10 on the local network (monad-solonet, client v0.16.4). A new account was
given 0.052437 MON by a transfer mined in block F, and a transfer of 0.002142 MON from it
(gas limit 21,000, fee cap 202 gwei: it needs 0.006384 MON) was offered to the node
(`eth_sendRawTransaction`) when the node's head was F + n.

| n (blocks after the funding block) | Result |
| ---------------------------------- | ------ |
| 0, 1, 2 | refused: "Signer had insufficient balance" (5 of 5) |
| 3 | refused 4 times, accepted 3 times |
| 4, 5, 6 | accepted (18 of 18) |
| 7 to 13 | accepted (24 of 24) |

In every accepted case at n >= 4 the balance was visible at `head - 4`
(`eth_getBalance(account, head - 4)`); in the mixed cases at n = 3 it was visible at `head - 3`
and not at `head - 4`. An account funded with 5 MON was refused in the same way at n = 0.

- So the node admits a transaction against the sender's balance as it was a few blocks back,
  not the latest one: money is spendable once it is four blocks old.
- **A refused transaction stays refused.** The same signed bytes were offered again 10, 21, 51
  and 151 blocks later and refused each time with the same message, while a different
  transaction of the same account at the same nonce (the fee cap one wei higher) was accepted
  at once. In one run the refused bytes were finally taken about 2,500 blocks (fifteen minutes)
  after the first refusal. Through the relay's JSON-RPC proxy the node's message arrives as
  "upstream RPC error".
- Seen from outside this is "the relay could not broadcast the payment, the message is
  delivered" followed, much later, by the payment being mined.

What it means for the wallet: it signs a transfer only against the balance the account already
had `spendSpacingBlocks + 1` blocks ago and waits those blocks otherwise; a transfer that pays
out of an account the same operation has just funded waits in the same way; and a payment the
node keeps refusing is signed again at the same nonce (other fee fields), which can never pay
twice because a nonce is consumed once.

## The reserve balance

Sources:

- Monad documentation: <https://docs.monad.xyz/developer-essentials/reserve-balance>
- Client source, tag `v0.16.4` of <https://github.com/category-labs/monad>, file
  `category/execution/monad/reserve_balance.cpp`:
  - `monad_default_max_reserve_balance_mon` (lines 46 to 49) returns `10`: the reserve is 10 MON.
  - `dipped_into_reserve` (lines 53 to 138): the check made after a transaction has run.
  - `can_sender_dip_into_reserve` (lines 422 to 449): when the sender is exempt.

### The rule

- Every account that is not a contract has a reserve of `min(10 MON, its balance when the
  transaction starts)`. The documentation: "`user_reserve_balance` is currently set to `10 MON`
  for each EOA."
- A transaction is reverted if it leaves its sender with less than `reserve - gas fees`, where
  gas fees are `gas limit x gas price`. In words: an account under 10 MON may pay its gas, but
  may not send value, unless it is exempt.
- The sender is exempt (the documentation calls this an "emptying transaction") when all of
  these hold:
  1. the sender is not delegated (EIP-7702);
  2. the sender has no other transaction in the same block before this one, and none in the
     parent block or the grandparent block;
  3. nobody sent a delegation or undelegation for the sender in those blocks.
- The window is therefore three blocks counting the current one (the documentation's delay
  factor `k = 3`). A second value transfer from a small account reverts if it is mined in the
  same block as the first, one block later or two blocks later. Three blocks later it succeeds.
- A reverted transaction is still mined: status 0, the nonce is used, the whole gas limit is
  paid, and no value moves.
- An account that stays at or above 10 MON is never affected.
- Consensus has its own, related rule for whether a transaction may be included at all
  (documentation, "Consensus inclusion check"): for an account with pending transactions it
  budgets gas fees against the reserve, counting the balance from `k` blocks back. That rule
  was not exercised here.

### What was observed

An account was funded, left alone for more than six blocks, then sent two transfers.

| Balance | Each transfer | First: block, result | Second: block, result |
| ------- | ------------- | -------------------- | --------------------- |
| 5 MON   | 1 MON         | 610, ok              | 610 (same block), reverted |
| 5 MON   | 1 MON         | 982, ok              | 984 (+2), reverted    |
| 5 MON   | 1 MON         | 936, ok              | 939 (+3), ok          |
| 5 MON   | 1 MON         | 952, ok              | 955 (+3), ok          |
| 12 MON  | 3 MON         | 849, ok              | 850 (+1), reverted    |
| 10.5 MON | 0.1 MON      | 872, ok              | 872 (same block), ok  |
| 50 MON  | 1 MON         | 826, ok              | 827 (+1), ok          |

Seven more 5 MON trials with the second transfer three to eleven blocks after the first all
succeeded. The 12 MON row shows that the first transfer may take the account under 10 MON (it is
exempt), and the next one then reverts. The 10.5 MON row shows that staying above the reserve is
always fine.

### What it means for the wallet

- An account that holds less than 10 MON, or that a payment will take below 10 MON, can make
  one value transfer and must then wait until that transfer is mined and three more blocks
  have passed before its next one.
- A stamp account that is funded once and spends once is exempt by construction: its one spend
  is its first transaction.
- Blocks come about every 0.4 s, so the wait is a little over a second.
- `regtest:monad-reserve` sends paid messages from a wallet whose main account holds 5 MON, reads
  every transaction of the wallet's accounts from the chain, and fails if any reverted.
