# Peer-to-peer blackjack

Any user can challenge any other user to one hand of blackjack from the chat composer. The
challenger picks dealer or player; the other user takes the opposite role. All money moves as the
ordinary stamp of a chat message, paid to the recipient's one-off derived address. There is no
separate wager transfer and no amount field on the wire: **a message's money is its own stamp.**

The same state machine (`packages/wallet/message-item-plugins/blackjack/hand.ts`) runs in both
users' apps and in the headless bot. It is pure: it folds `(sender, recipient, item, stamp value,
payload digest)` events and nothing else.

## Messages

Type 18, schema 2, min reader 2 (`blackjack-hand` in the app). Schema 1 (the old dealer-only
shapes) is still read but no longer written by the app. Every item carries `gameId`.

| action      | sender     | fields                              | what the message's stamp means |
| ----------- | ---------- | ----------------------------------- | ------------------------------ |
| `challenge` | challenger | `role`, `maxBetWei`, `commitment` (only when `role` = dealer) | ordinary stamp |
| `accept`    | dealer     | `maxBetWei` (≤ the challenge's), `commitment` | ordinary stamp |
| `bet`       | player     | none                                | **the wager**                  |
| `deal`      | dealer     | `playerCards` (2), `dealerUpCard`   | ordinary stamp                 |
| `hit`       | player     | none                                | ordinary stamp                 |
| `stand`     | player     | none                                | ordinary stamp                 |
| `double`    | player     | none                                | **a second wager, exactly equal to the first** |
| `card`      | dealer     | `playerCards` (the whole hand)      | ordinary stamp                 |
| `reveal`    | dealer     | `dealerCards`, `seed`, `outcome`    | **the payout** (stake + winnings) when the player is owed anything |
| `refund`    | dealer     | `ref` (digest of the message whose money is returned) | **the refunded amount** |

An ordinary stamp is the usual per-message stamp. It goes to the other side like any chat stamp and
is not part of the hand's accounting.

## States

| state           | who may send              | next state |
| --------------- | ------------------------- | ---------- |
| (none)          | anyone: `challenge`       | `open` if the challenger deals, `challenged` if the challenger plays |
| `challenged`    | dealer: `accept`          | `open` |
| `open`          | player: `bet`             | `awaiting_deal` |
| `awaiting_deal` | dealer: `deal`, or `refund` of the bet | `player_turn` (`dealer_turn` on a natural); `refunded` |
| `player_turn`   | player: `hit`, `stand`, `double` (first two cards only) | `awaiting_card`, `dealer_turn`, `awaiting_card` |
| `awaiting_card` | dealer: `card`            | `player_turn`; `dealer_turn` after a bust or a double |
| `dealer_turn`   | dealer: `reveal`          | `resolved` |
| `resolved`, `refunded` | nobody             | final |

Anything else is rejected and the state does not change: a message from the wrong side or a third
address, a move in the wrong state, a second challenge for a `gameId`, a `card` that does not extend
the hand by exactly one card, a `reveal` that does not match the commitment. A message whose digest
was already folded is ignored, so redelivery never counts twice. A message that arrives before the
one it depends on is rejected like any other out-of-turn message.

If a rejected message was the **player's money** (a bet above the limit, a second bet, a bet or
double in the wrong state, a double of the wrong amount), the hand records it and the dealer owes
it back: a `refund` whose `ref` is that message's digest and whose stamp equals what was sent.
Dealer steps that involve no choice (`deal`, `card`, a `reveal` that pays nothing) are sent
automatically; a human dealer confirms only messages that pay (`accept`, a paying `reveal`, a
`refund`).

## Cards

Unchanged from the existing game: the dealer commits to a seed, the player's contribution comes
from their bet, and the reveal lets the player check the deck.

- `commitment` = SHA-256 of the dealer's 64-hex-character seed. It is in the `challenge` when the
  challenger deals and in the `accept` when the challenged user deals, so it always exists before
  the player's bet message does.
- The player's contribution is the **payload digest of the bet message**, which both sides hold.
- `deck = deriveDeck(seed, betDigest, 0)`; the dealing order and "dealer draws to 17" are the
  existing rules (`deck.ts`, `playOutDealer`).
- On `reveal` the state machine recomputes the deck and rejects the reveal unless the seed matches
  the commitment and the player's cards, the up card, the dealer's cards and the outcome are exactly
  what the deck gives.

The dealer knows the deck during the hand but has no decisions to make with it. This detects a
dealer that deals false cards; it does not stop one from walking away (see below).

## Money rules

`spendable` is the balance of the wallet's own account. Stamps a wallet has **received** cannot be
spent yet (#837), so they never count.

1. **Dealer's limit.** A dealer may offer or accept a max bet of at most
   `(spendable − fee reserve) / 4`. Worst case is a doubled win: the dealer sends back 4× the bet
   (2× stake and 2× winnings), and today all of it comes from the dealer's own balance because the
   stake it received is not spendable. A natural costs 2.5×. When #837 lands the divisor becomes 2.
2. **Player's limit.** A challenging player's max bet is at most `spendable − fee reserve`. A bet
   must be greater than zero and at most the hand's max bet; it also cannot be below the chain's
   minimum stamp, because it is one. Double is offered only if the player can send the wager again.
3. **Accepting as dealer.** The dealer's `accept` names its own max bet, at most the challenge's and
   at most rule 1. The lower figure is the hand's limit.
4. **Payout.** Natural: 2.5× the wager. Win: 2× the stake. Push: the stake. Loss: nothing. The stake
   is the wager, or twice it after a double. The payout is the stamp of the `reveal`. The hand
   records what was owed and what was paid; a short payment shows as such.
5. **Refund.** A refund is a reply whose stamp equals the money being returned. Before dealing, the
   dealer may refund the accepted bet instead of dealing (`refunded`).
6. **Exactly once.** The bot writes each payout or refund to a durable outbox keyed by hand and
   message before sending and never builds a second payment for the same key.

## When the other side stops responding

There are no timeouts and no claims. Until escrow exists:

- Nobody answers a challenge, or the dealer never accepts: nothing was staked, nothing happens.
- The dealer goes silent after the bet, or reveals without paying: **the player loses the stake.**
- The player goes silent mid-hand: the dealer keeps the stake and owes nothing.
- A dealer that owes a refund and does not send it keeps the money.

## The headless bot

`packages/bot/blackjack-p2p-bot.ts` is an ordinary account driving this same state machine with
these same messages. It accepts any challenge in the opposite role, and it challenges, as dealer,
each account it meets for the first time: an account that sends it any message, or an address from
an optional feed of new accounts (for example a relay's list of new registrations). Each address
is challenged once. Its payouts, refunds and bets go through a durable outbox, one message per
hand position, so a crash or a lost relay answer never pays twice.

## Later: adaptor-signature escrow

Not part of this work. The states and messages above stay as they are. Only what a money-carrying
stamp *is* changes: `bet`/`double` fund an escrow instead of paying the dealer outright, `accept`
(or the challenge) locks the dealer's cover, and `reveal`/`refund` complete the settlement that the
seed reveal unlocks. The abandonment cases above then resolve by the escrow instead of by trust.
