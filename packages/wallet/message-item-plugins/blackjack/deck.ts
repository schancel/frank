/**
 * Provably-fair deck derivation and hand-value math for the blackjack demo (shared, isomorphic --
 * no Vue, no bot-specific imports -- so the bot's own dealing logic and the frontend's independent
 * verification use the exact same code, never two hand-written reimplementations that could drift
 * apart). See `./plugin.ts` for how this plugs into the message-item
 * registry, and its own header for the fairness-ordering property this module's derivation
 * depends on (the server seed must be generated *before* the client seed it's combined with here
 * is known).
 *
 * Uses `node-forge` (already a dependency, already used for isomorphic crypto elsewhere -- see
 * `packages/cashweb/relay/crypto.ts`) for a synchronous, isomorphic HMAC-SHA256. Deliberately not
 * `crypto.subtle` (Node/browser-compatible but async-only, which `reduceState`'s synchronous
 * contract in the message-item registry can't accommodate) and not Node's `crypto` module
 * (Node-only, unusable from the browser frontend that must also run this same derivation to verify
 * a hand independently).
 */
import * as forge from 'node-forge'

export type Card = number // 0-51: rank = card % 13 (0=Ace..12=King), suit = Math.floor(card / 13)

export function cardRank(card: Card): number {
  return card % 13
}

/** Blackjack value of a single card, treating every Ace as 11 -- `handValue` below downgrades
 * Aces to 1 (soft -> hard) as needed once the hand's total is known. */
function cardValue(card: Card): number {
  const rank = cardRank(card)
  if (rank === 0) return 11 // Ace, provisionally high
  if (rank >= 9) return 10 // 10, J, Q, K
  return rank + 1 // 2-9
}

export function cardLabel(card: Card): string {
  const rank = cardRank(card)
  const suit = ['♠', '♥', '♦', '♣'][Math.floor(card / 13)]
  const rankLabel = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][rank]
  return `${rankLabel}${suit}`
}

export interface HandValue {
  total: number
  /** True if an Ace is still being counted as 11 (i.e. the hand could take another card without
   * necessarily busting even if that reasoning looks tight at first glance -- the standard
   * blackjack "soft 17" terminology). */
  soft: boolean
  bust: boolean
  blackjack: boolean
}

export function handValue(cards: Card[]): HandValue {
  let total = cards.reduce((sum, card) => sum + cardValue(card), 0)
  let aces = cards.filter(card => cardRank(card) === 0).length
  // Downgrade Aces from 11 to 1 (i.e. subtract 10 each) until under 22 or out of Aces to downgrade.
  while (total > 21 && aces > 0) {
    total -= 10
    aces -= 1
  }
  const stillSoft = aces > 0 // at least one Ace still counted as 11
  return {
    total,
    soft: stillSoft,
    bust: total > 21,
    blackjack: cards.length === 2 && total === 21,
  }
}

/** Deterministic, counter-mode HMAC-SHA256 expansion: `HMAC(serverSeed, `${clientSeed}:${nonce}:${counter}`)`
 * for successive integer `counter`s, truncated to a 32-bit unsigned integer each time -- enough
 * randomness for a Fisher-Yates shuffle without needing a general-purpose CSPRNG dependency. */
function* deterministicRandomStream(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): Generator<number> {
  let counter = 0
  for (;;) {
    const hmac = forge.hmac.create()
    hmac.start('sha256', serverSeed)
    hmac.update(`${clientSeed}:${nonce}:${counter}`)
    const digest = hmac.digest().toHex()
    // First 8 hex chars = 32 bits, plenty for an unbiased-enough mod-52-scaled Fisher-Yates draw at
    // this stakes level (a demo casino game, not a regulatory-grade RNG certification target).
    yield parseInt(digest.slice(0, 8), 16)
    counter += 1
  }
}

/** Derives a full, deterministically-shuffled 52-card deck from `serverSeed` (the bot's committed-
 * in-advance secret, revealed at showdown) and `clientSeed` (the player's own unpredictable
 * contribution -- see this module's header on why `wagerTxHash` is used for that in practice, not
 * a message payload hash). Same inputs always produce the same deck: this determinism, not
 * secrecy of the algorithm, is what lets the player recompute and verify it after `serverSeed` is
 * revealed. */
export function deriveDeck(
  serverSeed: string,
  clientSeed: string,
  nonce: number,
): Card[] {
  const deck: Card[] = Array.from({ length: 52 }, (_, i) => i)
  const stream = deterministicRandomStream(serverSeed, clientSeed, nonce)
  // Fisher-Yates, drawing from the deterministic stream instead of Math.random().
  for (let i = deck.length - 1; i > 0; i--) {
    const r = stream.next().value
    const j = r % (i + 1)
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }
  return deck
}

export function sha256Hex(input: string): string {
  const md = forge.md.sha256.create()
  md.update(input)
  return md.digest().toHex()
}
