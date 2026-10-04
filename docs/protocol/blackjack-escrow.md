# Blackjack escrow and shared entropy (stage 1: design and feasibility)

Status: proposal, nothing implemented. It replaces the trust-based settlement of
`blackjack-p2p.md`. Experiments that back the claims are in `experiments/blackjack-escrow/`.

## Verdict

- **Cards: solved with what is in the repo.** Both sides commit to entropy before money moves and
  open it one card at a time. Nobody picks the deck, nobody sees a card early, there is no hole
  card to leak.
- **Theft: solved with what is in the repo.** Both stakes sit in one-off accounts whose key is
  split between the two players. Neither can spend alone, and the relay never says what was paid.
- **Forced payment: not achievable on Monad without a contract.** A loser who goes silent cannot
  be made to pay, by any signature scheme. Without a clock on chain, the best that exists is: the
  money stays locked for both, and the one who walked away loses a deposit as well.
- **Adaptor signatures do not enforce anything here.** The package works on EVM transactions
  (experiment 1), but a pre-signature is only binding if the signing key is jointly held, and
  even then a blackjack payout depends on a computed result, not on one secret. What this design
  uses from `@frank/adaptor-signatures` is its secret, point and proof of knowledge, as key shares.

## Threat model

- **Cheating dealer:** pick or foresee the deck; look at the hand and decline it; deal false cards;
  not pay a winner; take the bet and vanish.
- **Cheating player:** foresee a card before hitting or doubling; bet without paying; refuse to
  let go of the dealer's own cover after losing; quit when the cards are bad.
- **Dishonest relay:** report a payment that never happened; reorder, drop or replay messages.
  It cannot read or forge messages (they are sealed and authenticated end to end).
- Out of scope: both players colluding, a stolen device, a chain reorganisation deeper than the
  wallet's confirmation rule.

## Cards: entropy from both, one card at a time

Each side makes a hash chain: `link[52]` random, `link[k-1] = SHA-256(link[k])`, and publishes
`link[0]` as its commitment. The dealer's commitment is in the `challenge` or `accept` as today;
the player's is in the `bet`. Both exist before either side locks money.

Draw `k` is `SHA-256("frank/blackjack/draw/v1" | gameId | k | dealerLink[k+1] | playerLink[k+1])`
reduced over the cards still in the deck. A link is checked by hashing it back to the last link
already seen, so a side can only open the chain it committed to, and opening one link says nothing
about the next (experiment 3).

Order of opening, chosen so that money is locked before knowledge and a player who busts is
never the only one who knows it:

| draw | opened first | opened second | who knows the card first |
| ---- | ------------ | ------------- | ------------------------ |
| first three cards (player, dealer up, player) | dealer, in `deal`, after locking its cover | player, in its first move | player, for one message |
| a hit or double card | player, in `hit` / `double` | dealer, in `card` | dealer, then both |
| dealer's hole card and draws | player, in `stand` | dealer, in `reveal` | dealer, then both |

The hole card is not dealt until the dealer's turn. Blackjack never needs the dealer to know it,
so there is nothing hidden to leak. A player natural is opened by an automatic `stand`.

What this prevents: choosing the deck, the dealer's free look (it locks cover before it can know
any card), look-ahead by either side. What it does not prevent: the side that learns a card
first can stop answering. That is abandonment, handled below. A full seed reveal up front, the
simpler option, would leave whoever opens second knowing the whole hand before playing.

## Escrow: accounts with a split key

An escrow account is an ordinary Monad account whose key is `a + b`: the player knows `a`, the
dealer knows `b`, each publishes its point with a proof of knowledge (without the proof one side
could choose its point so that it alone holds the key; experiment 2). The address also commits to
the hand's terms through a public tweak. A plain transfer pays one address, so money that can go
to different people sits in different accounts, each with independent shares:

| account | funded by, when | amount | goes to the player on |
| ------- | --------------- | ------ | --------------------- |
| stake | player, `bet` | wager W | push, win, natural |
| player deposit | player, `bet` | D | always, after settling |
| double | player, `double` | W | push, win |
| match | dealer, `deal` | W | win, natural |
| bonus | dealer, `deal` | W/2 rounded down | natural, doubled win |
| extra | dealer, `deal` | the rest of W | doubled win |
| dealer deposit | dealer, `deal` | D | never (returns to dealer) |

Paying is handing over a share. The receiver checks it against the published point, now holds the
whole key, and sweeps the account with a transaction it signs then, at the current fee. So there
is no pre-signed transaction, no fee guess, no nonce to reserve and no signing nonce to reuse.
Shares travel only inside the sealed message, are derived from the wallet's root and the hand
(a lost device or cleared storage loses nothing), and are never logged.

End of hand, in this order, so that each side still has something to wait for when it must act:

1. `reveal` (dealer): its last link, plus its shares of the accounts the player takes.
2. `settle` (player, new, automatic): its shares of everything the dealer takes, including the
   dealer's deposit.
3. `release` (dealer, new, automatic): its share of the player's deposit.

Before dealing, `refund` hands back the dealer's shares of the stake and the player's deposit.

## Verifying money on chain

A money-carrying message names an amount; the receiver derives the escrow address itself and
reads its balance from the chain at the wallet's confirmation rule. The event enters the state
machine only then. The relay's delivery frame plays no part in game money.

Found while checking this: the app's wallet reads the chain **through the relay's own RPC proxy**
(`monad-chain.ts`, `/chain-rpc/…/rpc`). Reading the balance there is still trusting the relay.
The escrow check needs a second endpoint the relay operator does not run. The bot already uses the
operator's own.

## If the other side stops

No timeout exists. "Locked" means nobody can spend it until the silent side returns.

| the hand stops | who can cause it | player's worst case | dealer's worst case |
| -------------- | ---------------- | ------------------- | ------------------- |
| before `bet` | either | nothing | nothing |
| after `bet`, before `deal` | dealer | W + D locked | nothing |
| after `deal`, any point up to `reveal` | either | W + D locked (2W + D doubled) | 2W + D locked |
| player withholds `settle` | player | its deposit D locked | winnings and own cover locked |
| dealer withholds `release` | dealer | its deposit D locked | nothing |
| crash and restart, any step | — | nothing: secrets re-derive, messages resend unchanged | same |

Nobody ever gains by stopping. Two cases cost the one who stops nothing: a dealer who never
deals, and a dealer who withholds the last `release`. With D = 0 a losing player's refusal to
`settle` is free as well.

## State machine and messages

The eight states and their order do not change. Type 18, schema 3:

| action | change |
| ------ | ------ |
| every item | `seq` and `prev` (digest of the hand's previous message): order and replay no longer depend on clocks or transport |
| `challenge` | adds `depositWei`; a dealer's also carries its seven points and proofs |
| `accept` | adds the dealer's points and proofs |
| `bet` | adds `wagerWei`, the player's commitment, points and proofs. Money: stake and deposit |
| `deal` | carries a link instead of cards. Money: match, bonus, extra, dealer deposit |
| `hit`, `stand`, `double` | carry a link. `double` money: the double account |
| `card`, `reveal` | carry a link; cards and outcome are computed by both sides, not stated |
| `refund` | carries shares instead of paying |
| `settle`, `release` | new, shares only, sent without a button |

`resolved` is reached at `reveal` as today; "owed" and "paid" become which accounts each side has
received. The fold stays pure: money events carry the balances the wallet verified. One new pure
helper gives the player its own early view of the first three cards. The dealer needs to hold
`2W + D` instead of four times the bet.

The escrow part of each message (points, proofs, shares) is one opaque versioned byte string, so
the escrow scheme can change without touching states or the codec again.

## What the user sees differently

- Betting says "locks W plus a deposit D that returns when the hand finishes".
- A bet counts once the chain confirms it, a second or two later.
- The dealer sees the first cards only after the player's first move.
- A human dealer confirms `deal` (it locks money) and no longer confirms paying: paying is
  automatic and costs it nothing new.
- A stalled hand reads "locked, waiting for X" with the amounts, not "lost".

## Cost per hand

Plain transfers, 21,000 gas each; Monad charges the gas limit.

| | on-chain transactions | gas | messages added |
| --- | --- | --- | --- |
| today | the stamps only | — | — |
| split-key accounts | 6 fundings + 6 sweeps (7 + 7 with a double) | 252,000 (294,000) | 2, automatic |
| split-key, no deposits | 4 + 4 (5 + 5) | 168,000 (210,000) | 1 |
| joint signing (below) | 2 fundings + 2 payouts (3 + 2) | 84,000 (105,000) | 1 per hand, about 4 once per pair |

Message size: about 700 bytes more on `challenge`/`accept` and `bet`, under 100 elsewhere.

## Stamped messages and protocol rounds (#843)

Messages that must stay in durable history, because money or the recovery of money depends on
them: `challenge`, `bet`, `deal`, `double`, `refund`, `reveal`, `settle`, `release`. The rest are
rounds: `accept`, `hit`, `card`, `stand`, and all key-generation and signing rounds.

| per hand with h hits | durable, stamped | rounds |
| -------------------- | ---------------- | ------ |
| split-key accounts | 6 (7 with a double) | 1 + 2h (+1 `accept`) |
| joint signing | 3 (4 with a double) | 3 + 2h (+1 `accept`), plus about 4 once per pair |

In escrow the stamp is no longer the money: the relay checks that a stamp pays an address derived
from the recipient's key, and an escrow address is not one. Funding is a separate transfer next
to an ordinary stamp. Making the stamp itself pay the escrow needs a relay rule change.

What the hand needs from a stampless channel: the same sealing and sender authentication as a
direct message; delivery at least once (the hand orders and de-duplicates by `seq`/`prev`, so the
channel need not); 2 KB per message for split-key, 64 KB if Paillier-based signing rounds ride
on it; survival of a few minutes for a peer that is briefly away. A lost round loses no money:
the sender keeps every round until a later message acknowledges it through `prev`, resends the
same bytes, and falls back to a stamped message. A signing round is never regenerated for the
same session. Every round is an ordinary hand item, so everything works with stamps only.

## What cannot be guaranteed without a contract

1. A loser who goes silent cannot be made to pay; the winnings stay locked.
2. A dealer who never deals leaves the player's bet and deposit locked, at no cost to the dealer.
3. Whoever sends the last message of a hand can leave the other's deposit locked at no cost.
4. Money locked by a party that never returns is locked forever; there is no refund after a wait.
5. A relay that also serves the app's chain data can still lie about balances until the app
   reads the chain somewhere else.
6. The cryptography has had no outside review; the package's own README says not to secure real
   funds with it.

## Options and what they would buy

**Joint signing (`@frank/threshold-ecdsa`, being built).** One key per pair of users, generated
once; each hand's account is that key tweaked by the hand's terms; both fund it; at the end both
sign two transfers from it (nonce 0 to one side, nonce 1 to the other; the second is signed
first). It buys 4 transactions instead of 12, any split, a key that never exists whole, and no
free last move. It does not buy forced payment. Hand steps: key generation before the first
`bet` between a pair; `tweak` at `bet`; `sign` twice across `reveal` and `settle`. Adaptor
pre-signing is not used: I found no step where it adds a guarantee. Requirements for the package:
shares re-derivable from the wallet root and the peer; every session resumable from stored state
with the nonce marked used before the first message leaves; a message-independent first phase so
the final signature costs one message each way; an explicit 32-byte digest in, low-s signature
and recovery bit out; both signatures available to both parties; proofs sound against a
malicious peer; usable in a browser without blocking; message sizes stated.

**State-committed keys.** The tweak costs nothing and works for ECDSA keys (experiment 2). At
funding it ties the address to the terms; adopted above. Moving the money to a new address for
every state costs a transfer and a joint signature per move, and buys nothing on Monad, because
no rule on chain reads the commitment. Tweaks of one key are related: with split-key handover
each account needs its own key.

**Schnorr and account code.** Monad supports EIP-7702 (its documentation, read 2026-10-04). Once
code verifies the cooperative path, two ordinary signatures checked with `ecrecover` do the job;
aggregated Schnorr through the `ecrecover` trick saves about 3,000 gas and needs a multi-signature
scheme the repo does not have. Not worth it. Two-party ECDSA itself: the repo has no piece of it
(no Paillier, no oblivious transfer); written here it is my estimate of 1,500 to 2,500 lines with
its proofs. I did not evaluate outside libraries, and built no prototype once the package started.

**A fallback path, like taproot's script path.** Only this removes items 1 to 4.
- *EIP-7702 delegation of the escrow account:* does not work for these stakes. Monad reverts any
  transaction that takes a delegated account below 10 MON, so the code could not pay the money out.
- *One adjudicator contract, deployed once:* before funding, both sign (jointly) a transaction
  that moves the escrow into the contract under the hand's terms. Either side can broadcast it
  alone; a cooperative payout uses the same nonce and so cancels it. In the contract the latest
  state signed by both wins, and the side whose move is due when the wait ends forfeits. This is
  also the pre-signed exit: nobody deposits without a way out. Cooperative hands cost and reveal
  nothing extra. A dispute costs roughly 200,000 to 300,000 gas and shows the contract, the
  amounts, the posted state and both keys. It needs joint signing, a contract, and for blackjack
  a small on-chain check of a move.

**Hands as off-chain contracts (#842).** The entropy chains, `seq`/`prev`, the verified-balance
events and the opaque escrow payload carry over unchanged. The split-key accounts do not: they
only pay amounts fixed in advance. A general machine needs joint signing plus the adjudicator.
