/**
 * Peer-to-peer blackjack: one hand as one explicit state machine, shared by both roles, by the app
 * and by the headless bot. Design and money rules: `docs/protocol/blackjack-p2p.md`.
 *
 * Pure and deterministic. It reads nothing but the events it is given: who sent a message to whom,
 * the item, the message's own verified stamp value and the message's payload digest. Money is only
 * ever the stamp of a message; no amount is read from an item.
 *
 * Card rules, the deck derivation and the dealer's play are the existing ones (`./deck.ts`,
 * `playOutDealer` in `./game.ts`). The dealer commits to its seed before the bet exists; the
 * player's contribution to the shuffle is the payload digest of the bet message.
 */
import type { BlackjackHandItem } from '@frank/codec'

import { Card, deriveDeck, handValue, sha256Hex } from './deck'
import { BlackjackOutcome, dealInitialCards, playOutDealer } from './game'

export type HandRole = 'dealer' | 'player'

/** The application shape of a type-18 schema-2 item. */
export type HandItem = BlackjackHandItem
export type HandAction = HandItem['action']

/** One message of a hand, as either side sees it. */
export interface HandEvent {
  item: HandItem
  /** Sender and recipient account addresses (compared case-insensitively). */
  from: string
  to: string
  /** The message's own verified stamp value. */
  stampWei: bigint
  /** The message's payload digest (bare lowercase hex), the same value on both sides. */
  digest: string
}

export type HandPhase =
  /** A player challenged; the challenged user has not yet accepted as dealer. */
  | 'challenged'
  /** The dealer's commitment and max bet are known; waiting for the player's bet. */
  | 'open'
  | 'awaiting_deal'
  | 'player_turn'
  /** The player hit or doubled; waiting for the dealer's card. */
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
  | 'bad-amount'
  | 'bad-cards'
  | 'bad-commitment'
  | 'bad-reveal'
  | 'bad-ref'

export interface HandState {
  gameId: string
  phase: HandPhase
  dealer: string
  player: string
  /** Which role sent the challenge. */
  challenger: HandRole
  /** The challenge's max bet; the dealer's accept may lower it. */
  maxBetWei: bigint
  commitment?: string
  betDigest?: string
  /** The accepted bet: the bet message's own stamp. */
  wagerWei: bigint
  doubled: boolean
  /** Why the hand is in `awaiting_card`. */
  pending?: 'hit' | 'double'
  playerCards: Card[]
  dealerUpCard?: Card
  dealerCards: Card[]
  seed?: string
  outcome?: BlackjackOutcome
  /** `resolved` only: what the dealer owed and what the reveal's stamp actually paid. */
  owedWei?: bigint
  paidWei?: bigint
  /** `refunded` only: what the refund's stamp returned. */
  refundedWei?: bigint
  /** Money the player sent that the hand did not accept (a bet above the limit, a second bet, a
   * double of the wrong amount...). The dealer owes each back as a `refund` naming its digest. */
  rejected: { digest: string; stampWei: bigint; refundedWei?: bigint }[]
  /** Digests already folded, so a redelivered message never counts twice. */
  seen: string[]
}

export interface HandResult {
  state: HandState | undefined
  /** Set when the event did not advance the hand. */
  error?: HandRejection
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const HEX64 = /^[0-9a-f]{64}$/
const WEI = /^[0-9]{1,40}$/
const wei = (value: unknown): bigint | undefined =>
  typeof value === 'string' && WEI.test(value) ? BigInt(value) : undefined
const validCards = (cards: readonly number[]) =>
  cards.every(c => Number.isInteger(c) && c >= 0 && c <= 51) &&
  new Set(cards).size === cards.length

/** The stake that is at risk in the hand: the wager, twice that after a double. */
export function totalStakeWei(
  state: Pick<HandState, 'wagerWei' | 'doubled'>,
): bigint {
  return state.doubled ? state.wagerWei * 2n : state.wagerWei
}

/** What the dealer sends back: stake plus winnings. A natural pays 3:2, a win 1:1, a push
 * returns the stake, a loss nothing. */
export function payoutWei(
  outcome: BlackjackOutcome,
  wagerWei: bigint,
  doubled: boolean,
): bigint {
  const stake = doubled ? wagerWei * 2n : wagerWei
  switch (outcome) {
    case 'player_blackjack':
      return (stake * 5n) / 2n
    case 'player_win':
      return stake * 2n
    case 'push':
      return stake
    case 'dealer_win':
      return 0n
  }
}

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

/** A fresh dealer seed (64 lowercase hex characters) from 32 random bytes. */
export function seedFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error('a dealer seed needs 32 random bytes')
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/** The commitment a dealer publishes before the bet: SHA-256 of the seed text. */
export function commitmentOf(seed: string): string {
  return sha256Hex(seed)
}

function deckOf(seed: string, betDigest: string): Card[] {
  return deriveDeck(seed, betDigest, 0)
}

function reject(state: HandState | undefined, error: HandRejection): HandResult {
  return { state, error }
}

/** Fold one message into the hand. Never throws; an event that does not belong is rejected and the
 * state returned unchanged, except that money the player sent is remembered as owed back. */
export function applyHandEvent(
  prev: HandState | undefined,
  event: HandEvent,
): HandResult {
  const { item, from, to, stampWei, digest } = event
  if (prev && prev.gameId !== item.gameId) return reject(prev, 'no-hand')
  if (prev?.seen.includes(digest)) return reject(prev, 'duplicate')

  if (item.action === 'challenge') {
    if (prev) return reject(prev, 'hand-exists')
    const maxBetWei = wei(item.maxBetWei)
    if (same(from, to)) return reject(prev, 'wrong-sender')
    if (maxBetWei === undefined || maxBetWei <= 0n)
      return reject(prev, 'bad-amount')
    if (item.role === 'dealer' && !HEX64.test(item.commitment))
      return reject(prev, 'bad-commitment')
    const base = {
      gameId: item.gameId,
      challenger: item.role,
      maxBetWei,
      wagerWei: 0n,
      doubled: false,
      playerCards: [],
      dealerCards: [],
      rejected: [],
      seen: [digest],
    }
    return {
      state:
        item.role === 'dealer'
          ? {
              ...base,
              phase: 'open',
              dealer: from,
              player: to,
              commitment: item.commitment,
            }
          : { ...base, phase: 'challenged', dealer: to, player: from },
    }
  }
  if (!prev) return reject(prev, 'no-hand')

  const fromDealer = same(from, prev.dealer) && same(to, prev.player)
  const fromPlayer = same(from, prev.player) && same(to, prev.dealer)
  if (!fromDealer && !fromPlayer) return reject(prev, 'wrong-sender')
  const next = (changes: Partial<HandState>): HandResult => ({
    state: { ...prev, ...changes, seen: [...prev.seen, digest] },
  })
  /** The player's money that the hand does not accept is owed back by the dealer. */
  const owedBack = (error: HandRejection): HandResult =>
    stampWei > 0n
      ? {
          state: {
            ...prev,
            rejected: [...prev.rejected, { digest, stampWei }],
            seen: [...prev.seen, digest],
          },
          error,
        }
      : reject(prev, error)

  switch (item.action) {
    case 'accept': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'challenged') return reject(prev, 'wrong-phase')
      const maxBetWei = wei(item.maxBetWei)
      if (
        maxBetWei === undefined ||
        maxBetWei <= 0n ||
        maxBetWei > prev.maxBetWei
      )
        return reject(prev, 'bad-amount')
      if (!HEX64.test(item.commitment)) return reject(prev, 'bad-commitment')
      return next({ phase: 'open', maxBetWei, commitment: item.commitment })
    }
    case 'bet': {
      if (!fromPlayer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'open') return owedBack('wrong-phase')
      if (stampWei <= 0n || stampWei > prev.maxBetWei)
        return owedBack('bad-amount')
      return next({
        phase: 'awaiting_deal',
        wagerWei: stampWei,
        betDigest: digest,
      })
    }
    case 'deal': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_deal') return reject(prev, 'wrong-phase')
      const cards = [...item.playerCards]
      if (cards.length !== 2 || !validCards([...cards, item.dealerUpCard]))
        return reject(prev, 'bad-cards')
      return next({
        phase: handValue(cards).blackjack ? 'dealer_turn' : 'player_turn',
        playerCards: cards,
        dealerUpCard: item.dealerUpCard,
      })
    }
    case 'hit':
    case 'stand': {
      if (!fromPlayer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'player_turn') return reject(prev, 'wrong-phase')
      return item.action === 'hit'
        ? next({ phase: 'awaiting_card', pending: 'hit' })
        : next({ phase: 'dealer_turn' })
    }
    case 'double': {
      if (!fromPlayer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'player_turn' || prev.playerCards.length !== 2)
        return owedBack('wrong-phase')
      if (stampWei !== prev.wagerWei) return owedBack('bad-amount')
      return next({ phase: 'awaiting_card', pending: 'double', doubled: true })
    }
    case 'card': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_card') return reject(prev, 'wrong-phase')
      const cards = [...item.playerCards]
      const had = prev.playerCards
      if (
        cards.length !== had.length + 1 ||
        had.some((card, i) => cards[i] !== card) ||
        !validCards([...cards, prev.dealerUpCard as Card])
      )
        return reject(prev, 'bad-cards')
      const done = handValue(cards).bust || prev.pending === 'double'
      return next({
        phase: done ? 'dealer_turn' : 'player_turn',
        pending: undefined,
        playerCards: cards,
      })
    }
    case 'reveal': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'dealer_turn') return reject(prev, 'wrong-phase')
      if (
        !HEX64.test(item.seed) ||
        commitmentOf(item.seed) !== prev.commitment ||
        !prev.betDigest
      )
        return reject(prev, 'bad-reveal')
      const expected = replay(item.seed, prev.betDigest, prev.playerCards.length)
      if (
        !sameCards(expected.playerCards, prev.playerCards) ||
        expected.dealerUpCard !== prev.dealerUpCard ||
        !sameCards(expected.dealerCards, item.dealerCards) ||
        expected.outcome !== item.outcome
      )
        return reject(prev, 'bad-reveal')
      return next({
        phase: 'resolved',
        seed: item.seed,
        dealerCards: expected.dealerCards,
        outcome: expected.outcome,
        owedWei: payoutWei(expected.outcome, prev.wagerWei, prev.doubled),
        paidWei: stampWei,
      })
    }
    case 'refund': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase === 'awaiting_deal' && item.ref === prev.betDigest)
        return next({ phase: 'refunded', refundedWei: stampWei })
      const index = prev.rejected.findIndex(
        r => r.digest === item.ref && r.refundedWei === undefined,
      )
      if (index < 0) return reject(prev, 'bad-ref')
      return next({
        rejected: prev.rejected.map((r, i) =>
          i === index ? { ...r, refundedWei: stampWei } : r,
        ),
      })
    }
  }
}

const sameCards = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((card, i) => card === b[i])

/** The hand a seed and a bet digest determine, for a player who holds `playerCount` cards. */
function replay(seed: string, betDigest: string, playerCount: number) {
  const deck = deckOf(seed, betDigest)
  const initial = dealInitialCards(deck)
  const playerCards = [...initial.playerCards, ...deck.slice(4, 2 + playerCount)]
  const played = playOutDealer(deck, playerCards, 2 + playerCount)
  return {
    playerCards,
    dealerUpCard: initial.dealerCards[0],
    dealerCards: played.dealerCards,
    outcome: played.outcome,
  }
}

/** Fold a whole conversation's hand messages, in the order given. */
export function foldHand(events: readonly HandEvent[]): {
  state: HandState | undefined
  rejected: { digest: string; error: HandRejection }[]
} {
  let state: HandState | undefined
  const rejected: { digest: string; error: HandRejection }[] = []
  for (const event of events) {
    const result = applyHandEvent(state, event)
    state = result.state
    if (result.error) rejected.push({ digest: event.digest, error: result.error })
  }
  return { state, rejected }
}

/** What the player may send now. A bet's and a double's stamp is the money. */
export function playerMoves(
  state: HandState | undefined,
): ('bet' | 'hit' | 'stand' | 'double')[] {
  if (state?.phase === 'open') return ['bet']
  if (state?.phase !== 'player_turn') return []
  return state.playerCards.length === 2
    ? ['hit', 'stand', 'double']
    : ['hit', 'stand']
}

/** A message the dealer must send, and the stamp it must carry when the stamp is money. */
export interface DealerStep {
  item: HandItem
  /** Present for a payout or a refund: the exact stamp to pay. Absent: an ordinary stamp. */
  payWei?: bigint
}

/**
 * The dealer's next message, if it is the dealer's turn. No choice is involved in any of these:
 * the cards come from the committed seed and the bet's digest, and the amounts from the hand.
 * The same state always gives the same step, so a retry after a crash sends the same message.
 */
export function dealerStep(
  state: HandState | undefined,
  seed: string,
): DealerStep | undefined {
  if (!state) return undefined
  const base = { type: 'blackjack-hand' as const, gameId: state.gameId }
  const owed = state.rejected.find(r => r.refundedWei === undefined)
  if (owed)
    return {
      item: { ...base, action: 'refund', ref: owed.digest },
      payWei: owed.stampWei,
    }
  if (!state.betDigest || commitmentOf(seed) !== state.commitment)
    return undefined
  switch (state.phase) {
    case 'awaiting_deal': {
      const dealt = replay(seed, state.betDigest, 2)
      return {
        item: {
          ...base,
          action: 'deal',
          playerCards: dealt.playerCards,
          dealerUpCard: dealt.dealerUpCard,
        },
      }
    }
    case 'awaiting_card': {
      const dealt = replay(seed, state.betDigest, state.playerCards.length + 1)
      return {
        item: { ...base, action: 'card', playerCards: dealt.playerCards },
      }
    }
    case 'dealer_turn': {
      const dealt = replay(seed, state.betDigest, state.playerCards.length)
      const owedWei = payoutWei(dealt.outcome, state.wagerWei, state.doubled)
      return {
        item: {
          ...base,
          action: 'reveal',
          dealerCards: dealt.dealerCards,
          seed,
          outcome: dealt.outcome,
        },
        ...(owedWei > 0n ? { payWei: owedWei } : {}),
      }
    }
    default:
      return undefined
  }
}

/** The dealer's way out before dealing (for example when it can no longer cover the hand):
 * return the accepted bet. The stamp of this message is the bet. */
export function refundBetStep(state: HandState | undefined): DealerStep | undefined {
  if (state?.phase !== 'awaiting_deal' || !state.betDigest) return undefined
  return {
    item: {
      type: 'blackjack-hand',
      gameId: state.gameId,
      action: 'refund',
      ref: state.betDigest,
    },
    payWei: state.wagerWei,
  }
}

/** The role an address plays in a hand, if any. */
export function roleOf(state: HandState, address: string): HandRole | undefined {
  if (same(state.dealer, address)) return 'dealer'
  if (same(state.player, address)) return 'player'
  return undefined
}

/** One line for a chat list or a notification. */
export function handPreviewText(item: HandItem): string {
  switch (item.action) {
    case 'challenge':
      return 'Blackjack challenge'
    case 'accept':
      return 'Blackjack challenge accepted'
    case 'bet':
      return 'Placed a blackjack bet'
    case 'deal':
      return 'Blackjack hand dealt'
    case 'hit':
      return 'Hit'
    case 'stand':
      return 'Stood'
    case 'double':
      return 'Doubled down'
    case 'card':
      return 'Blackjack card dealt'
    case 'reveal':
      return 'Blackjack hand resolved'
    case 'refund':
      return 'Blackjack bet refunded'
    default:
      return 'Blackjack'
  }
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
      type: 'blackjack-hand',
      gameId: input.state.gameId,
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
