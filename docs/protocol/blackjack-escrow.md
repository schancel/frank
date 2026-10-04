# Blackjack escrow (design, not implemented)

Status: the shared-entropy part is built (`blackjack-p2p.md`, type 18 schema 3). The escrow below
is a design for stage 2. Experiments that back its claims are in `experiments/blackjack-escrow/`.

## Decisions taken by the owner

- No contract. The accepted end state: no theft, no free look, quitting never pays.
- Each side locks a deposit equal to the bet, returned when the hand finishes.
- The bet is a separate transfer into a joint two-party address; the bet message carries an
  ordinary stamp.
- The escrow is the two-party (threshold) address of `@frank/threshold-ecdsa`, not handed-over key
  shares. The `escrow` module keeps one boundary so tests can simulate the joint key.
- Testnet only. Naturals keep paying 3:2. Escrow checks read the chain from a configurable
  endpoint that the relay operator does not run.

## Verdict on "adaptor signatures and two-party signing"

The owner's intuition is right, and my stage-1 sentence "adaptor pre-signing adds no guarantee" was
wrong. Once the money sits in a jointly held account, a pre-signature is binding (neither side can
sign a competing transfer alone), and it can make **opening a card and taking your money the same
act** (experiment 4). What that buys, exactly:

- The side that opens first can never be held hostage afterwards. A loser cannot keep the
  winner's money by refusing to sign the payout, because the payout was signed before the card.
- The side that opens last can only collect anything, its deposit included, by opening.

What it does not buy: the side that opens last can still walk away from a hand it has just seen
it lost. It then forfeits its deposit and whatever else the hand would have returned to it, and
the other side's money stays locked. No construction without a clock on chain removes this.

It has three costs, each a point where the plan could still fail (see "Open risks"):

1. Card entropy must change from hash links to small committed numbers, one per card.
2. One two-party adaptor pre-signature per possible card, per transfer, per locked card: about a
   hundred signing sessions for each card that can end the hand.
3. The adaptor scheme must be used without its per-point proof of knowledge, as DLCs use it.

## Threat model

- **Cheating dealer:** pick or foresee cards; decline a hand after looking; not pay a winner;
  take the bet and vanish.
- **Cheating player:** foresee a card; bet without paying; refuse to release the dealer's money
  after losing; quit when the cards are bad.
- **Dishonest relay:** report a payment that never happened; reorder, drop or replay messages.
  It cannot read or forge messages.
- Out of scope: both players colluding, a stolen device, a deep chain reorganisation.

## Cards with locked reveals

Today (schema 3) each card is a hash of one link from each side. A hash preimage cannot lock a
signature, so for the escrow each side's contribution to card `k` becomes a number `v` in
`[0, 52 - k)`, committed before any money moves as `C = s·G + v·H` (`H` is a fixed point with no
known discrete log). The card is the `(u + v) mod (52 - k)`-th card left in the deck, for the
player's `u` and the dealer's `v`. Either side choosing uniformly makes the card uniform, and
knowing one's own number says nothing about the card. All commitments (about 24 per side, 33
bytes each) go in the `challenge`/`accept` and the `bet`.

For every possible `v` the point `T_v = C - v·H` is public, and its owner knows the discrete log
of exactly one of them. A transfer pre-signed under `T_v` can be completed only if the committed
number is `v`, and completing it publishes `s`.

The order of opening does not change from schema 3. The dealer opens last on every card that can
end the hand:

| card | first to open | last to open, learns the result first | can it end the hand? |
| ---- | ------------- | ------------------------------------- | -------------------- |
| first three | dealer (`deal`) | player | no |
| hit, double | player | dealer | yes, on a bust |
| each dealer draw | player | dealer | yes |

For a card that can end the hand:

1. The player opens its number in the clear (`hit`, `double`, or one message per dealer draw).
2. For every `v` that would end the hand, both pre-sign two transfers from the joint address,
   locked under the dealer's `T_v`: **nonce 0** pays the dealer its share and deposit for that
   result, **nonce 1** pays the player the rest. The player does not know yet which `v` is real,
   so it has no reason to refuse. The dealer does know; a dealer that refuses here is abandoning
   a hand it lost, the one case that cannot be removed (below).
3. If the card ends the hand, the dealer completes its nonce-0 transfer and broadcasts it. That is
   the reveal. The player reads `s` from the signature, which identifies the card, and completes
   its own nonce-1 transfer. Neither needs the other again.
4. If the card does not end the hand, the dealer opens its number in a message and play goes on.

All nonce-0 alternatives share one nonce, so at most one ever lands. Transfers for different cards
with the same result are byte-identical; only their signatures differ, so the chain shows the
amounts but not the cards.

Fees: a pre-signed transfer cannot be repriced. Each names a generous fee cap (Monad charges the
actual price up to the cap, times the 21,000 gas limit), and the joint address holds a fee reserve
for two transfers at that cap. If the price rises above the cap the transfers wait; nothing is
lost. What is left of the reserve stays in the address unless both sign once more. Monad lets an
account go below its 10 MON reserve only if it sent nothing in the last few blocks, so the
nonce-1 transfer has to wait that long after nonce 0 (to be confirmed on testnet).

## Money

| | player | dealer |
| --- | --- | --- |
| locked | bet W + deposit W, at `bet` | cover 2W + deposit W, at `deal` |
| on a double | another W | nothing more (cover already holds it) |

Each funding is one plain transfer to the hand's joint address, which is the pair's joint key
tweaked by the hand's terms (experiment 2 shows the tweak). The receiver derives the address
itself and reads its balance from the independent endpoint; the relay's word plays no part.

## If the other side stops

| the hand stops | who can cause it | player's worst case | dealer's worst case |
| -------------- | ---------------- | ------------------- | ------------------- |
| before `bet` | either | nothing | nothing |
| after `bet`, before `deal` | dealer | 2W locked | nothing |
| mid-hand, before a deciding card is opened | either | 2W locked (3W doubled) | 3W locked |
| the dealer does not open a card that it saw lost the hand | dealer | 2W and its winnings locked | 3W locked, of which it had lost W to 2W anyway |
| after the dealer's transfer landed | nobody | nothing | nothing |
| crash and restart | — | nothing, if secrets and pre-signatures are stored before use | same |

Remaining for a spiteful party: a dealer that never deals (costs it nothing, locks 2W of the
player's); a dealer that abandons a lost hand (costs it its deposit and unlost cover). A player
can no longer hurt the dealer after it has opened.

## Cost per hand

| | on chain | two-party signing sessions | extra messages |
| --- | --- | --- | --- |
| today | stamps only | 0 | 0 |
| joint address, plain signing after the result | 4 transfers (5 with a double) | 2 | about 2 |
| joint address, locked reveals | 4 transfers (5) | up to 2 × (52 − k) per card that can end the hand; about 250 in a hand with no hit | about 3 per such card, large |

Key generation between two users is once per pair (about 4 messages). The locked-reveal messages
are protocol rounds, not money: they belong on the stampless channel (#843) and need about 256 KB
per message if signing is Paillier-based. Every round can also be an ordinary stamped message.
How long a hundred sessions take in a browser is unknown until the package exists.

A cheaper middle: lock only the dealer's draws. Then a player who busts can still refuse to sign
the dealer's payout, at the cost of its deposit.

## Open risks

1. **The proof of knowledge.** `@frank/adaptor-signatures` refuses a lock point without a proof
   that someone knows its secret (experiment 4, last test). Here that is impossible for all but
   one point. The underlying scheme was designed for exactly this use in DLCs, but the package
   and the threshold package need a mode for it, and that mode needs a cryptographer's review.
2. **Volume.** Two-party adaptor pre-signing has to be cheap enough to do a hundred times while
   a player waits for a card. If not, lock fewer cards.
3. **First funding.** The player funds before the dealer. No pre-signed exit can protect it: an
   exit that works before the dealer funds also works after, as a free way out of a bad hand.
4. **Schema.** Locked reveals replace schema 3's hash links with commitments and openings
   (a schema 4). States, order of opening and the `seq`/`prev` chain stay.
5. **No outside review** of any of this cryptography.

## Requirements for `@frank/threshold-ecdsa`

Key generation once per pair, with shares re-derivable from the wallet root and the peer; a
tweaked key per hand; plain signing; adaptor pre-signing under a point **without** a proof of
knowledge for that point, in batches of about a hundred with one message each way after a
message-independent first phase; the pre-signature delivered to both parties in the
`@frank/adaptor-signatures` byte format; sessions resumable from stored state, with every signing
nonce marked used before the first message leaves; explicit 32-byte digest in, low-s signature and
recovery bit out; proofs sound against a malicious peer; usable in a browser without blocking.

## What cannot be guaranteed without a contract

1. A dealer that sees it lost can abandon the hand; the player's money stays locked.
2. A dealer that never deals leaves the player's bet and deposit locked at no cost to itself.
3. Money locked by a party that never returns is locked forever.
4. The cryptography has had no outside review.

## Options not taken

- **Handed-over key shares** (experiment 2): no new cryptography, 12 transfers a hand, and the
  loser must still sign away the winner's money.
- **An adjudicator contract** with a jointly pre-signed transfer into it: the only way to give
  the waiting side the money after a timeout. Removes items 1 to 3.
- **EIP-7702 delegation of the escrow account:** Monad supports EIP-7702 but reverts any
  transaction that takes a delegated account below 10 MON, so it cannot pay out these stakes.
- **Schnorr in account code:** not needed once code checks two ordinary signatures.
- **Moving funds to a new state-committed address at every step:** a transfer and a joint
  signature per step, and no rule on chain reads the commitment.

## Carrying over to general off-chain contracts (#842)

The `seq`/`prev` chain, verified-balance events, the joint address and locked reveals carry over
to any two-party game whose deciding steps have a small set of results. A general state machine
with arbitrary results needs the adjudicator.
