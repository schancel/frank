# Peer-to-peer blackjack

Any user can challenge any other user to one hand of blackjack from the chat composer. The
challenger picks dealer or player; the other user takes the opposite role. All money moves as the
ordinary stamp of a chat message, paid to the recipient's one-off derived address. There is no
separate wager transfer and no amount field on the wire: **a message's money is its own stamp.**

The same state machine (`packages/wallet/message-item-plugins/blackjack/hand.ts`) runs in both
users' apps and in the headless bot. It is pure: it folds `(sender, recipient, item, stamp value,
payload digest)` events and nothing else.

## Messages

Type 18, schema 3 (`blackjack-hand` in the app; codec name `blackjack-hand-v3`). Schemas 1 and 2
are still read by the codec but no longer written or played. Every item carries `gameId`, exactly
32 lowercase hex characters, and its place in the hand's chain (see "Order and replay"). A message
may carry at most one hand item: its stamp is one amount of money, so a message with two or more
counts for no hand and credits nothing.

**No message states a card, a seed or an outcome.** Both sides compute them from the links the
messages open (see "Cards").

| action      | sender     | fields                              | what the message's stamp means |
| ----------- | ---------- | ----------------------------------- | ------------------------------ |
| `challenge` | challenger | `role`, `maxBetWei`, `commitment` (only when `role` = dealer) | ordinary stamp |
| `accept`    | dealer     | `maxBetWei` (≤ the challenge's), `commitment` | ordinary stamp |
| `bet`       | player     | `commitment` (the player's)         | **the wager**                  |
| `deal`      | dealer     | `link` (the dealer's link 3)        | ordinary stamp                 |
| `hit`       | player     | `link` (of the card asked for)      | ordinary stamp                 |
| `stand`     | player     | `link` (the player's last link)     | ordinary stamp                 |
| `double`    | player     | `link` (the player's last link)     | **a second wager, exactly equal to the first** |
| `card`      | dealer     | `link` (of the card asked for)      | ordinary stamp                 |
| `reveal`    | dealer     | `link` (the dealer's last link)     | **the payout** (stake + winnings) when the player is owed anything |
| `refund`    | dealer     | `ref` (digest of the message whose money is returned) | **the refunded amount** |

Every item except the challenge also carries `seq` and `prev`.

An ordinary stamp is the usual per-message stamp. It goes to the other side like any chat stamp and
is not part of the hand's accounting.

## States

| state           | who may send              | next state |
| --------------- | ------------------------- | ---------- |
| (none)          | anyone: `challenge`       | `open` if the challenger deals, `challenged` if the challenger plays |
| `challenged`    | dealer: `accept`          | `open` |
| `open`          | player: `bet`             | `awaiting_deal` |
| `awaiting_deal` | dealer: `deal`, or `refund` of the bet | `player_turn`; `refunded` |
| `player_turn`   | player: `hit`, `stand`, `double` (first two cards only) | `awaiting_card`, `dealer_turn`, `awaiting_card` |
| `awaiting_card` | dealer: `card`            | `player_turn`; `dealer_turn` after a bust or a double |
| `dealer_turn`   | dealer: `reveal`          | `resolved` |
| `resolved`, `refunded` | nobody             | final |

After the `deal` the state is always `player_turn`: the dealer cannot know whether the player
holds a natural. A player with a natural can only `stand`, and its client sends that by itself.

Anything else is rejected and the state does not change: a message from the wrong side or a third
address, a move in the wrong state, a second challenge for a `gameId`, a link that is not the next
one of its sender's chain, a message that is not the hand's next. A message whose digest was
already folded is ignored, so redelivery never counts twice.

If a rejected message was the **player's money** (a bet above the limit, a second bet, a bet or
double in the wrong state, a double of the wrong amount), the hand records it and the dealer owes
it back: a `refund` whose `ref` is that message's digest and whose stamp equals what was sent.
Dealer steps that involve no choice (`deal`, `card`, a `reveal` that pays nothing) are sent
automatically; a human dealer only accepts a challenge and confirms messages that pay (a paying
`reveal`, a `refund`).

## Cards

Each side has a secret 64-hex-character seed and turns it into a hash chain of 33 links
(`entropy.ts`):

```
link[32]   = SHA-256("frank/blackjack/entropy/v1|" + seed)
link[k-1]  = SHA-256(link[k])        over the 32 raw bytes
commitment = link[0]
```

- The dealer's `commitment` is in the `challenge` when the challenger deals and in the `accept`
  when the challenged user deals. The player's is in the `bet`. So both exist before any card can
  be known, and the player's money moves with its commitment.
- Draw `k` (0, 1, 2, ...) is
  `SHA-256("frank/blackjack/draw/v1|" + gameId + "|" + k + "|" + dealerLink[k+1] + "|" + playerLink[k+1])`
  taken modulo the number of cards still in the deck, picking among them in ascending order. Cards
  never repeat.
- Draw order: player, dealer's up card, player, then the player's further cards, then the dealer's
  hole card and draws. The dealer's play ("draws to 17") is the existing rule (`playOutDealer`).
- A link is accepted only if hashing it back gives the last link its sender opened. A side can
  therefore open only the one chain it committed to, and an opened link says nothing about the
  next.

Who opens what, and when:

| message | opens | cards that become known |
| ------- | ----- | ----------------------- |
| `deal` | dealer's links 1 to 3 | the first three, **to the player only** |
| the player's first move | player's links 1 to 3 (and more) | the first three, to both |
| `hit` | the player's link for the next card | none yet |
| `card` | the dealer's link for that card | that card, to both |
| `stand`, `double` | the rest of the player's chain | none yet |
| `reveal` | the rest of the dealer's chain | the dealer's hole card and draws, the outcome |

What this gives:

- Neither side picks or foresees a card: each card needs a link the other side has not opened.
- The dealer has no look at the hand before dealing. When it sends `deal` it knows no card.
- There is no hidden hole card: it is not drawn until the dealer's turn. After a player bust it is
  never drawn, and the dealer shows only its up card.
- A wrong link is rejected and the rejection names its sender (`foldHand`'s `rejected`). A withheld
  link leaves the hand waiting for the side that owes it (`awaitedRole`).

What it does not give: the side that learns a card first can stop answering. The player sees its
first cards before its first move; the dealer sees a hit or double card before its `card`, and the
whole result before its `reveal`. Stopping gains nothing but, until escrow exists, a dealer that
sees it lost can still not pay (see below).

A side that loses its seed mid-hand cannot open further links: a dealer cannot deal or reveal, a
player cannot move.

## Order and replay

A hand's messages form a chain. `seq` is the number of messages the hand has accepted before this
one (0 for the challenge), `prev` the payload digest of the last of them (absent on the challenge).
A message is accepted only if both name the hand's current end, so a replayed, reordered or
forked message does not count, and a message of one hand never fits another.

- Folding does not depend on clocks or on the order messages were stored: each step takes the
  message that continues the chain. Of two messages that continue the same point, the one the
  other side built on is the hand's; otherwise the earlier one.
- A `refund` is tied to the message whose money it returns (`ref`), not to a place in the chain.
  A refund of money the hand did not accept does not move the chain.
- A player's `bet` or `double` that does not continue the chain is money the hand did not accept,
  and is owed back like any other.

## Money rules

`spendable` is the balance of the wallet's own account. Stamps a wallet has **received** cannot be
spent yet (#837), so they never count.

The amount credited for a message is what the relay's delivery says was paid as its stamp. The
recipient does not yet check the chain itself, so a dishonest relay could credit a bet that was
never paid.

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
   dealer may refund the accepted bet instead of dealing (`refunded`). A refund whose stamp is less
   than what was owed leaves the rest owed, and is shown as such.
6. **Exactly once.** The bot writes each payout or refund to a durable outbox keyed by hand and
   message before sending and never builds a second payment for the same key.

## When the other side stops responding

There are no timeouts and no claims. Until escrow exists:

- Nobody answers a challenge, or the dealer never accepts: nothing was staked, nothing happens.
- The dealer goes silent after the bet, or reveals without paying: **the player loses the stake.**
- The player goes silent mid-hand: the dealer keeps the stake and owes nothing.
- A dealer that owes a refund and does not send it keeps the money.
- Each side keeps its seed on one device. A dealer that loses it after dealing can neither deal
  further nor reveal, and the game cannot return the player's stake; a player that loses it
  cannot move, and the dealer keeps the stake.

## The headless bot

`packages/bot/blackjack-p2p-bot.ts` is an ordinary account driving this same state machine with
these same messages. It accepts any challenge in the opposite role, and it challenges, as dealer,
each account it meets for the first time: an account that sends it any message, or an address from
a feed of new accounts. Each address is challenged once.

What it puts at risk is bounded by configuration: one hand with money at stake per account at a
time, a small bet when it plays, a limit on its total stake as player, its own max bet when it
deals, and a limit on how many hands are open at once (a silent opponent keeps a hand open for
good). Money sent to a hand it does not take is returned.

Its payouts, refunds and bets go through a durable outbox with one row per debt or move, so a crash
or a lost relay answer never pays twice, and a message that cannot be sent does not hold up others.

## Later: escrow

Not part of this work; see `blackjack-escrow.md`. The states and messages above stay as they are.
Only what a money-carrying step *is* changes: `bet`/`double` and the dealer's cover lock money in
escrow instead of paying the other side outright. The abandonment cases above then resolve by the
escrow instead of by trust, as far as a chain without contracts allows.
