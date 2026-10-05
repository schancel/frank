# Blackjack between two peers, each with several frontends (design)

Status: design. Extends `blackjack-p2p.md` (schema 3) and `blackjack-escrow.md`, and fixes the
escrow findings E1–E6, D1, D2 and the nonce findings C2/C3 of the Oct 2026 security review.

## Setting

Two wallets, P and Q. Each wallet may run any number of frontends at once (phone, laptop, bot),
all from the same wallet secret. A frontend may be closed at any moment and a new one opened later
from the seed alone. The relay stores messages and can drop, delay, reorder or replay them, but
cannot read or forge them.

Goal: the hand is fair and its money safe no matter how many frontends each side runs, and **any
frontend of either side can rebuild the whole hand from the mailbox and verify the result.**

## What this design relies on from the transport

These are the invariants restored by the regression fixes (`fix/mailbox-both-directions`,
`fix/dm-open-self`, `fix/client-mailbox-echo`). Blackjack must not be shipped without them.

| | invariant | used for |
| --- | --- | --- |
| T1 | An address's mailbox holds both directions of every conversation. | Every frontend sees its own side's messages, from any device. |
| T2 | The sender can decrypt its own messages with the wallet secret alone (self-open). | A new frontend reads what its other frontends sent. |
| T3 | A send counts as done only when the relay echoes the stored record on the mailbox websocket. | Frontends learn of each other's sends in real time. |
| T4 | Resubmitting identical bytes is idempotent (same payload hash returns the stored record, no second charge). | Retries after a lost answer never double up. |
| T5 | Slot claims (below): the relay stores at most one message per `(recipient, slot)`. | Two frontends of one wallet can't both take the same turn. |

T5 is new. It is a hint enforced by an honest relay; nothing in this design becomes unsafe if
the relay ignores it, only noisier (see "If the relay cheats").

## Principles

1. **The mailbox is the only state.** A game is the fold (replay) of its messages from both
   directions. No game state is held in localStorage, in memory across sessions, or in peer
   messages. Caches may exist but are always rebuildable from the mailbox.
2. **Every secret is a function of the wallet secret and the transcript.** Any randomness a
   frontend picks is written into its own message, so every other frontend can derive the same
   secrets from the mailbox. No OS randomness enters a game secret, a nonce or a key share.
3. **Never answer two different peer messages at the same point.** A different-content fork by
   the peer freezes the game. Nothing secret is ever sent in reply to a forked point.
4. **Choices carry no secrets.** A user's choice (bet, hit, stand, double) is a message without
   any opening. Secret-bearing messages follow from the winning choice, deterministically, and only
   from the game's driver frontend.
5. **Side effects follow the claim.** A frontend broadcasts a transaction or sends money only
   after its message for that step has been echoed as stored in its slot.

## Game messages (type 18, schema 4)

Exactly one game item per message. Every item:

| field | meaning |
| --- | --- |
| `gameId` | 16 bytes, chosen at random by the challenger. |
| `seq` | 0 for the challenge, then +1 per accepted message of either side. |
| `prev` | game digest of the message at `seq − 1` (absent on the challenge). |
| `kind` | `challenge`, `accept`, `choice`, `open`, `round`, `abort`, `handoff`, `funded`, `settled`. |
| `body` | kind-specific, below. |
| `driver` | 8 bytes, the sending frontend's driver tag (see "Drivers"). |
| `sig` | the sender's identity signature over the game digest (deterministic, RFC 6979 / BIP-340 style). |

**Game digest** `gd = SHA-256("frank/bj/msg/v4" ‖ chainId ‖ sender ‖ recipient ‖ CBOR(item without sig))`.
`prev` names `gd`, not the envelope's payload hash. The envelope differs between two
transmissions of the same item (message id, self-open nonce, stamp proof), the game digest does
not, so identical items sent twice by two frontends are one game message.

`sig` makes a fork provable: two signed items from the same sender with the same `gameId` and
`seq` and different `gd` are a portable proof of equivocation. DM authentication alone is
deniable and is not enough for that.

### Kinds

| kind | sender | body | carries secrets? |
| --- | --- | --- | --- |
| `challenge` | challenger | terms (below), challenger's card commitments, `salt` | no (commitments only) |
| `accept` | acceptor | the acceptor's card commitments, `salt`, its payout address | no |
| `choice` | the side whose turn it is | `bet` amount, `hit`, `stand`, `double` | **no** |
| `open` | driver of the side due to open | card openings due at this point, plus the `choice` it follows (`ref`) | yes |
| `round` | driver | a batch of two-party crypto round messages (keygen, pre-sign, sign) with session ids | yes |
| `funded` | funder | the signed funding transaction, raw | no |
| `settled` | either | payout transaction hashes | no |
| `abort` | either | reason, the offending `gd`s if any | no |
| `handoff` | any frontend of the side | the new driver tag | no |

A driver that makes the choice itself may send `choice` and `open` merged as one `open` with an
inline choice; that is the common single-frontend case and costs no extra message.

### Terms (fixed in the challenge/accept, never renegotiated)

`chainId`, roles, max bet, deposit rule, both payout addresses (EOAs, checked with `getCode`),
fee cap per transfer and the fee reserve, the independent RPC endpoint class, the escrow key's
session id (below), and each side's per-card Pedersen commitments `C = s·G + v·H`. A message that
contradicts the terms is rejected by the fold.

## Secrets

All game secrets come from one wallet-derived key `K_bj` (its own derivation path, never the
identity key):

```
seedGame = HKDF(K_bj, "frank/bj/v4/game" ‖ chainId ‖ self ‖ peer ‖ gameId ‖ ownSalt)
x(purpose, index) = HKDF(seedGame, purpose ‖ u32(index) ‖ bindings)
```

- `ownSalt` is 16 random bytes the side writes into its own first message (`challenge` or
  `accept`). A replayed `gameId` therefore never repeats secrets, and every frontend recovers
  `ownSalt` from the mailbox (T1, T2).
- Card numbers `v_k` and blindings `s_k`: `purpose = "card"`, `index = k`.
- Escrow keygen randomness: `purpose = "keygen"`, `index = attempt`. **The key share is not
  stored**; any frontend recomputes it by replaying the keygen transcript with its derived
  randomness. This needs the DKLs/threshold-ecdsa entry points to take an explicit seed (no
  internal `OsRng`); that is a required change.
- Signing nonces: `purpose = "sign"`, `index = session`, `bindings = digest ‖ H(all peer round
  messages received so far in this session)`. This is the C5 hedge made deterministic.
- Session ids (fixes E5): `sha256("frank/bj/v4/session" ‖ lp(purpose) ‖ gameId ‖ lp(P) ‖ lp(Q) ‖ u32(attempt))`,
  full width, no truncation.

This replaces the localStorage seeds `own|peer|gameId`. Schema 3 games in progress keep their
stored seeds until they finish; new games use schema 4 only.

Determinism alone does not stop nonce reuse. A round-1 message commits a nonce, so answering
two different round-2 peer messages with it leaks the key (C2/C3). That is what principle 3 and
the driver rule prevent.

## Drivers

Each game has, per side, one **driver**: the only frontend of that side that sends `open` and
`round` messages. Other frontends of that side can view, verify and send `choice` messages.

- The driver tag is 8 random bytes a frontend keeps locally (one per frontend). The frontend
  that sends a side's first message for a game (`challenge` or `accept`) is that side's driver.
  Its tag is in the message, so all frontends of that side know who drives.
- A frontend answers a peer's message only if it is the driver, and only after checking
  durably (IndexedDB, written before sending) that it has not answered a different message at
  that point.
- **Handoff.** If the driver is gone (device closed, uninstalled), another frontend of that side
  sends `handoff` with its own tag. Once the handoff is in the mailbox:
  1. the old driver stops on sight of it;
  2. every crypto session that was in flight on that side is aborted (`abort` naming the
     session), and restarted with `attempt + 1`, so fresh nonces;
  3. card openings need no restart: they are deterministic values with no nonce.

  A late answer by the old driver and the handoff compete for the same slot; whichever is stored
  first wins and the other frontend re-reads the mailbox. Even if both land (relay cheat), only
  one answer exists per session, because the new driver aborts and restarts instead of
  answering.

Result: no crypto session ever has two answering frontends, whether the relay behaves or not.

## Slots (relay assist against own-side races)

Every game message carries a cleartext slot tag in its envelope:

```
slotKey = HKDF(ECDH(own static, peer static), "frank/bj/v4/slot" ‖ gameId)
slot    = HMAC(slotKey, sender ‖ u32(seq))[0..16]
```

Both sides and all their frontends can compute it, the relay and third parties can't, and it
doesn't link games. The relay stores at most one message per `(recipient, slot)`. A second
submission with different bytes gets `409` and the stored record. Identical bytes are idempotent
(T4). Slot rows are kept as tombstones after the message is reclaimed.

The relay checks the slot before any stamp is charged, so a losing frontend pays nothing.

Effect for multiple frontends: two frontends of P that both try to take turn `seq` (two clicks,
two automations, a stale view) get exactly one stored. The loser reads the winner from the
mailbox and folds it, so it never diverges.

## The fold

`foldGame(messages)` takes the decrypted game items of one `gameId` from both directions (T1, T2)
and returns state, the valid prefix and any fault:

1. Drop items that fail `sig`, name a third address, or contradict the terms.
2. Dedupe by `gd` (one message however many times it was sent).
3. Walk from `seq` 0. At each `seq`:
   - one item that continues `prev` from the right sender: accept it;
   - several items with **different** `gd` from one sender: **fork**. Stop. The state is frozen
     at `seq − 1` with `fault = {sender, gds}`;
   - a `choice` fork by **our own** side (two of our frontends chose differently, and the relay
     didn't stop it): no secrets are in choices, so the driver resolves it by lowest `gd` and its
     `open` names the winner with `ref`. The peer can't steer this, and has nothing to steer it
     with.
4. Only a complete, contiguous, fork-free prefix is ever acted on.

This changes schema 3's rule "the one the other side built on wins". That rule lets the
responder choose between two of the sender's branches after seeing what both open, which is a
free look for a cheating responder.

Both sides and all frontends run the same fold over the same messages and reach the same state.

## Crossed and concurrent games

- Any number of games with the same peer at once. Each has its own `gameId`, secrets, keygen,
  escrow address and slots. Nothing is shared between games, so one frozen game can't affect
  another.
- Crossed challenges (both challenge at once) are two independent games. The UI shows both; the
  user may accept either, both or neither.
- A frontend that wants to challenge and sees an unanswered incoming challenge from that peer
  shows it first ("they already challenged you"). It does not refuse anything automatically.

## Play and money with escrow

The escrow is a per-game two-party key (DKLs23 fork). The joint address comes from the keygen
transcript. Stamps are only the ordinary per-message stamp; game money moves on chain.

### Order of a hand

1. `challenge` → `accept` (terms, commitments, salts).
2. `round` × ~4: keygen. Both derive the joint address from the transcript.
3. Player `choice: bet` → player `funded` (raw signed funding tx: bet + deposit + its half of the
   fee reserve). Any frontend, or the peer, may broadcast the raw tx. The dealer verifies the
   escrow balance on an independent RPC, never the relay's word. **Fixes E3.**
4. Dealer `funded` (cover + deposit + fee-reserve half), verified likewise by the player.
5. `open` (dealer's first numbers) → the player sees its cards.
6. For each player decision: `choice` → driver's `open` with the player's numbers for that card.
7. For each card that can end the hand (hit/double cards, dealer draws), before the dealer opens
   it:
   - `round` batches pre-sign, for every value `v` that ends the hand, both payout transfers
     locked under the dealer's `T_v = C − v·H`;
   - **nonce 1 (player's share) is completed and stored by both before any nonce-0 session's
     last message is sent** (fixes D2, E2);
   - the payout transactions are built by each side from the fold (outcome → amounts → tx). A
     peer-proposed tx is never signed. One digest per `(key, nonce)` is persisted before the first
     round message and never changed. Retries reuse that digest (fixes E4).
8. The deciding card: the dealer completes its nonce-0 transfer and broadcasts it, which is the
   reveal. The player extracts `t` (trying both `t` and `−t` against `T`), identifies the card and
   completes nonce 1. Neither needs the other again (fixes E1).
9. `settled` with both tx hashes. Any frontend verifies them on chain.

Batching: one `round` message carries all sessions of a step, so a deciding card is about 5
messages each way rather than ~500. The zero-stamp size cap must allow the largest batch.

### Fees and the nonce-1 reserve rule

- Every payout is pre-signed with the fee cap from the terms. The address holds
  `2 × 21000 × feeCap` in reserve. `value + gasLimit·feeCap ≤ balance` is asserted when building
  each transfer (E3, V1).
- Nonce 1 is not broadcast until `block ≥ nonce0Block + k`, simulated with `eth_call` first. For
  each nonce-1 payout, a few variants with rising fee caps are pre-signed at the same nonce, so
  they stay mutually exclusive (D1). The Monad reserve behaviour is confirmed on testnet before
  any of this ships.
- `signedRawTx` rejects high-s and checks the recovered sender (V2). Payout targets must be EOAs.

### Abort and ban

- C1: a `banParty` from the DKLs backend aborts the game and burns that game's key. The `abort`
  is written to the mailbox, so the ban is seen and kept by every frontend (fixes C4's
  durability across devices).
- A peer fork (fold fault) freezes the game. The UI shows the two signed items as proof.
- Money locked in a frozen game is subject to the same limits as abandonment in
  `blackjack-escrow.md` ("What cannot be guaranteed without a contract").

## Verification from any frontend

From the mailbox alone plus an independent RPC, any frontend of either side recomputes and shows:

1. the terms, and that every message is signed by its side and fork-free;
2. every card, from both sides' openings against the committed `C`s;
3. the outcome and the amounts owed;
4. the escrow address, from the public keygen transcript;
5. funding: the escrow's balance and the funding txs, on chain;
6. payouts: the `settled` tx hashes exist on chain, pay the amounts in 3 to the payout addresses
   in the terms, and come from the escrow address.

Frontends that are not drivers can do all of this. They can't send `open` or `round` without a
handoff.

## If the relay cheats

- Drops or delays: the game waits. No secret is sent until the point being answered is
  contiguous and unforked.
- Replays or reorders: ignored through `gd` dedupe and `seq`/`prev`.
- Ignores slots (lets two frontends both take a turn): own `choice` forks resolve by lowest `gd`
  with no secret exposed. Own `open`/`round` can't fork, because only the driver sends them. A
  peer fork freezes the game.
- Colludes with the peer to show our frontends different views (one fork branch to one frontend,
  the other to another): not possible for our own messages, since we see our side's slot through
  T1 and T3. It is possible to hide a peer fork from one of our frontends, but that frontend can't
  act on it unless it is the driver, and the driver answers at most once per point. **Residual:**
  a peer that equivocates and a relay that hides one branch can make our driver answer branch A
  while a non-driver frontend shows branch B. No secret leaks; the views heal once both branches
  are visible, and the fold then freezes the game with proof.

## Required changes (implementation checklist)

Transport/relay:
- [ ] T1–T3 regression fixes (in progress on `fix/*` branches).
- [ ] T4 idempotent resubmission.
- [ ] T5 slot tags: cleartext envelope field, `(recipient, slot)` uniqueness, tombstones, checked
      before stamp charge.
- [ ] Rate limits and storage reclaim sized for game traffic. A zero-stamp size cap that fits the
      largest `round` batch.
- [ ] Take the stamp proof out of the authenticated payload, or derive it, so it doesn't add
      randomness or cost to zero-stamp game messages (R3 handled by "a paid submission supersedes
      an unacked free one with the same T3").

Crypto:
- [ ] Seed-injected entry points for keygen/pre-sign/sign in the DKLs wasm and threshold-ecdsa (no
      internal RNG).
- [ ] Honour `banParty` (C1). Refuse to export or restore round-2 initiator state (C2/C3).
- [ ] Adaptor mode without the per-point proof of knowledge, reviewed (escrow open risk 1).

Game:
- [ ] Schema 4 codec (frank-cbor + TS), `gd`, `sig`, slot tag.
- [ ] `foldGame` with the fork rule above, plus property tests: any interleaving and duplication
      of the same message set folds to the same state; any different-content fork freezes.
- [ ] Driver/handoff, with the durable "answered at this point" record.
- [ ] Escrow flow per "Order of a hand"; remove `startSettlementSigning(tx?)`; independent-RPC
      funding checks; fee reserve; nonce-1 variants.
- [ ] UI: game list per peer, read-only view on non-drivers with "take over", and a verification
      panel showing items 1–6.

Tests across the stack:
- [ ] Two frontends of P and one of Q against a real relay. Both P frontends click at once: one
      message stored, both P frontends converge, Q sees one.
- [ ] A fresh P frontend opened from the seed mid-hand rebuilds the hand, takes over by handoff,
      and finishes the hand with the same cards.
- [ ] The peer sends two different items at one `seq`: the game freezes on every frontend and no
      `open`/`round` follows.
- [ ] A relay that ignores slots: no secret-bearing message is ever sent twice for one point.
