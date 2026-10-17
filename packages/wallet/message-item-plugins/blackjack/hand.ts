/**
 * Peer-to-peer blackjack: one hand as one explicit state machine, shared by both roles, by the app
 * and by the headless bot. Design and money rules: `docs/protocol/blackjack-p2p.md`.
 *
 * Pure and deterministic. It reads nothing but the events it is given: who sent a message to whom,
 * the item, the message's own verified stamp value and the message's payload digest. Money is only
 * ever the stamp of a message; no amount is read from an item.
 *
 * No message states a card. Both sides commit to a hash chain before any money moves and open one
 * link per card (`./entropy.ts`); the state machine computes every card and the outcome from the
 * links opened so far. The card rules and the dealer's play are the existing ones (`./deck.ts`,
 * `playOutDealer` in `./game.ts`).
 *
 * The hand's messages form a chain: each names its position (`seq`) and the digest of the message
 * before it (`prev`), so a replayed or reordered message never counts.
 */
import type { BlackjackHandV3Item } from '@frank/codec'

import { Card, handValue } from './deck'
import {
  CHAIN_LENGTH,
  drawCard,
  entropyChain,
  linkAt,
  linksUpTo,
  verifyLink,
  type OpenedLink,
} from './entropy'
import {
  applyHandEvent,
  dealerStep,
  foldHand,
  handPreviewText,
  handView,
  payoutWei,
  playerMoves,
  playerStep,
  totalStakeWei,
  type DealerStep,
  type HandAction,
  type HandEvent,
  type HandItem,
  type HandResult,
  type HandState,
} from './game'

export {
  applyHandEvent,
  dealerStep,
  foldHand,
  handPreviewText,
  handView,
  payoutWei,
  playerMoves,
  playerStep,
  totalStakeWei,
  type DealerStep,
  type HandAction,
  type HandEvent,
  type HandItem,
  type HandResult,
  type HandState,
}

export type HandRole = 'dealer' | 'player'

export type HandPhase =
  /** A player challenged; the challenged user has not yet accepted as dealer. */
  | 'challenged'
  /** The dealer's commitment and max bet are known; waiting for the player's bet. */
  | 'open'
  | 'awaiting_deal'
  | 'player_turn'
  /** The player hit or doubled; waiting for the dealer's link for that card. */
  | 'awaiting_card'
  /** The player is done; waiting for the dealer's reveal (whose stamp is the payout). */
  | 'dealer_turn'
  | 'resolved'
  /** The dealer returned the accepted bet instead of dealing. */
  | 'refunded'

export type HandRejection =
  | 'duplicate'
  | 'no-hand'
  | 'hand-exists'
  | 'wrong-sender'
  | 'wrong-phase'
  /** Not the hand's next message: its `seq` or `prev` does not continue the chain. */
  | 'out-of-order'
  | 'bad-amount'
  | 'bad-commitment'
  /** The link does not belong to the chain its sender committed to, or is not the one due. */
  | 'bad-link'
  | 'bad-reveal'
  | 'bad-ref'

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * How many times the max bet a dealer must hold, spendable, to open a hand. The worst case is a
 * doubled win: the dealer sends back 4x the bet (2x stake + 2x winnings). Stamps a wallet receives
 * cannot be spent yet (#837), so the returned stake also comes out of the dealer's own balance.
 * When received stamps become spendable this becomes 2 (the dealer's own worst-case loss).
 */
export const DEALER_COVER_MULTIPLE = 4n

/** The largest max bet a dealer with this spendable balance may offer or accept. */
export function maxDealerBetWei(spendableWei: bigint, reserveWei: bigint): bigint {
  const free = spendableWei - reserveWei
  return free > 0n ? free / DEALER_COVER_MULTIPLE : 0n
}

/** The largest max bet a challenging player may name: what they can actually send. */
export function maxPlayerBetWei(spendableWei: bigint, reserveWei: bigint): bigint {
  const free = spendableWei - reserveWei
  return free > 0n ? free : 0n
}

/** A fresh seed (64 lowercase hex characters) from 32 random bytes. Each side of a hand needs
 * one: the dealer before it challenges or accepts, the player before it bets. */
export function seedFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('a seed needs 32 random bytes')
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** The commitment a side publishes before money moves: link 0 of its seed's entropy chain. */
export function commitmentOf(seed: string): string {
  return entropyChain(seed)[0]
}

/** Who must send the hand's next message, if anyone. A side that withholds a link is the side
 * named here for as long as the hand does not move. */
export function awaitedRole(state: HandState | undefined): HandRole | undefined {
  switch (state?.phase) {
    case 'challenged':
    case 'awaiting_deal':
    case 'awaiting_card':
    case 'dealer_turn':
      return 'dealer'
    case 'open':
    case 'player_turn':
      return 'player'
    default:
      return undefined
  }
}

/** The fields every message after the challenge carries: its place in the hand's chain. */
function chained(state: HandState) {
  return {
    type: 'blackjack-hand' as const,
    gameId: state.gameId,
    seq: state.count,
    prev: state.head,
  }
}

/** The player's bet: its commitment goes out with the money, before any card can be known. */
export function buildBet(
  state: HandState | undefined,
  seed: string,
): HandItem | undefined {
  if (state?.phase !== 'open') return undefined
  return { ...chained(state), action: 'bet', commitment: commitmentOf(seed) }
}

/** The dealer's way out before dealing (for example when it can no longer cover the hand):
 * return the accepted bet. The stamp of this message is the bet. */
export function refundBetStep(state: HandState | undefined): DealerStep | undefined {
  if (state?.phase !== 'awaiting_deal' || !state.betDigest) return undefined
  return {
    item: { ...chained(state), action: 'refund', ref: state.betDigest },
    payWei: state.wagerWei,
  }
}

/** What the dealer still owes back: money the hand did not accept, and a bet returned instead of
 * dealt, each counted by what the refund's stamp actually paid. A short refund leaves the rest
 * owed, the same way a short payout shows as owed more than paid. */
export function refundShortfallWei(state: HandState): bigint {
  let owed = 0n
  for (const r of state.rejected) {
    const paid = r.refundedWei ?? 0n
    if (paid < r.stampWei) owed += r.stampWei - paid
  }
  if (state.phase === 'refunded') {
    const paid = state.refundedWei ?? 0n
    if (paid < state.wagerWei) owed += state.wagerWei - paid
  }
  return owed
}

/** The role an address plays in a hand, if any. */
export function roleOf(state: HandState, address: string): HandRole | undefined {
  if (same(state.dealer, address)) return 'dealer'
  if (same(state.player, address)) return 'player'
  return undefined
}

/** Why a challenge, an accept or a bet may not be sent. */
export type HandMoneyError =
  /** Zero, negative or not a whole amount. */
  | 'not-positive'
  /** More than this wallet can cover from its spendable balance. */
  | 'above-own-limit'
  /** More than the hand's max bet. */
  | 'above-max-bet'

/** The largest max bet this wallet may name when challenging in `role`. */
export function challengeLimitWei(
  role: HandRole,
  spendableWei: bigint,
  reserveWei: bigint,
): bigint {
  return role === 'dealer'
    ? maxDealerBetWei(spendableWei, reserveWei)
    : maxPlayerBetWei(spendableWei, reserveWei)
}

/** The challenge item, or why this wallet may not send it. A dealer's seed stays with the dealer;
 * only its commitment goes into the item. */
export function buildChallenge(input: {
  gameId: string
  role: HandRole
  maxBetWei: bigint
  spendableWei: bigint
  reserveWei: bigint
  /** Required when `role` is dealer. */
  seed?: string
}): { item: HandItem } | { error: HandMoneyError } {
  if (input.maxBetWei <= 0n) return { error: 'not-positive' }
  if (
    input.maxBetWei >
    challengeLimitWei(input.role, input.spendableWei, input.reserveWei)
  )
    return { error: 'above-own-limit' }
  const base = {
    type: 'blackjack-hand' as const,
    gameId: input.gameId,
    action: 'challenge' as const,
    seq: 0,
    maxBetWei: input.maxBetWei.toString(),
  }
  if (input.role === 'player') return { item: { ...base, role: 'player' } }
  if (!input.seed) throw new Error('a dealer challenge needs a seed')
  return {
    item: { ...base, role: 'dealer', commitment: commitmentOf(input.seed) },
  }
}

/** The dealer's accept of a player's challenge: the challenge's max bet, lowered to what the
 * dealer can cover (and to `wantedMaxBetWei` if the dealer names less). */
export function buildAccept(input: {
  state: HandState
  spendableWei: bigint
  reserveWei: bigint
  seed: string
  wantedMaxBetWei?: bigint
}): { item: HandItem } | { error: HandMoneyError } {
  const own = maxDealerBetWei(input.spendableWei, input.reserveWei)
  let max = input.state.maxBetWei < own ? input.state.maxBetWei : own
  if (input.wantedMaxBetWei !== undefined) {
    if (input.wantedMaxBetWei <= 0n) return { error: 'not-positive' }
    if (input.wantedMaxBetWei > input.state.maxBetWei)
      return { error: 'above-max-bet' }
    if (input.wantedMaxBetWei > own) return { error: 'above-own-limit' }
    max = input.wantedMaxBetWei
  }
  if (max <= 0n) return { error: 'above-own-limit' }
  return {
    item: {
      ...chained(input.state),
      action: 'accept',
      maxBetWei: max.toString(),
      commitment: commitmentOf(input.seed),
    },
  }
}

/** Why the player may not send `wagerWei` as a bet (or as the equal second wager of a double). */
export function checkWager(
  state: Pick<HandState, 'maxBetWei'>,
  wagerWei: bigint,
  spendableWei: bigint,
  reserveWei: bigint,
): HandMoneyError | undefined {
  if (wagerWei <= 0n) return 'not-positive'
  if (wagerWei > state.maxBetWei) return 'above-max-bet'
  if (wagerWei > maxPlayerBetWei(spendableWei, reserveWei))
    return 'above-own-limit'
  return undefined
}

/** A message as a wallet reports it, sent or received. */
export interface HandMessage {
  items: readonly { type: string }[]
  senderAddress: string
  recipientAddress: string
  stampValueWei?: bigint
  payloadDigest: string
}

/** A game id is exactly 32 lowercase hex characters, so it is always safe to use as a key. */
export function isGameId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
}

/**
 * The one hand item of a message. A message's stamp is one amount of money, so a message may
 * carry at most one hand item: with two or more, none of them counts and no money is credited to
 * any hand.
 */
export function soleHandItem(
  items: readonly { type: string }[],
): HandItem | undefined {
  const hand = items.filter(
    (item): item is HandItem => item.type === 'blackjack-hand',
  )
  // The codec only produces well-formed game ids; anything else is not a hand item at all.
  return hand.length === 1 && isGameId(hand[0].gameId) ? hand[0] : undefined
}

/** The hand event a message carries: none, or exactly one. */
export function handEventsOf(message: HandMessage): HandEvent[] {
  const item = soleHandItem(message.items)
  return item
    ? [
        {
          item,
          from: message.senderAddress,
          to: message.recipientAddress,
          stampWei: message.stampValueWei ?? 0n,
          digest: message.payloadDigest,
        },
      ]
    : []
}
