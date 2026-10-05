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
import { BlackjackOutcome, playOutDealer } from './game'

export type HandRole = 'dealer' | 'player'

/** The application shape of a type-18 schema-3 item. */
export type HandItem = BlackjackHandV3Item
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

export interface HandState {
  gameId: string
  phase: HandPhase
  dealer: string
  player: string
  /** Which role sent the challenge. */
  challenger: HandRole
  /** The challenge's max bet; the dealer's accept may lower it. */
  maxBetWei: bigint
  /** The dealer's commitment: link 0 of its entropy chain. */
  commitment?: string
  /** The player's commitment, from the bet. */
  playerCommitment?: string
  /** The last link each side has opened (position 0 is the commitment itself). */
  dealerLink?: OpenedLink
  playerLink?: OpenedLink
  /** Digest of the hand's last accepted message, and how many there are: the next message must
   * carry `prev` = `head` and `seq` = `count`. */
  head: string
  count: number
  betDigest?: string
  /** The accepted bet: the bet message's own stamp. */
  wagerWei: bigint
  doubled: boolean
  /** Why the hand is in `awaiting_card`. */
  pending?: 'hit' | 'double'
  /** The cards both sides can compute so far, in draw order: player, dealer up, player, then
   * the player's further cards. Empty until the player's first move opens its links. */
  draws: Card[]
  playerCards: Card[]
  dealerUpCard?: Card
  dealerCards: Card[]
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

/** The first three cards (player, dealer up, player), once both sides' third links are known. */
function initialDraws(
  gameId: string,
  dealer: OpenedLink,
  player: OpenedLink,
): Card[] | undefined {
  const draws: Card[] = []
  for (let k = 0; k < 3; k++) {
    const d = linkAt(dealer, k + 1)
    const p = linkAt(player, k + 1)
    if (d === undefined || p === undefined) return undefined
    draws.push(drawCard(gameId, k, d, p, draws))
  }
  return draws
}

/**
 * The end of a hand, once the player is done and the dealer's last link is known: the dealer's
 * cards and the outcome. After a player bust the dealer draws nothing and shows only its up card
 * (the player never opened the links a hole card would need). Otherwise the dealer's hole card
 * and its further cards are the next draws, played by the shared dealer rule.
 */
function settle(
  state: HandState,
  dealerLast: OpenedLink,
): { dealerCards: Card[]; outcome: BlackjackOutcome } | undefined {
  const [first, up, second, ...hits] = state.draws
  if (up === undefined || second === undefined) return undefined
  if (handValue(state.playerCards).bust)
    return { dealerCards: [up], outcome: 'dealer_win' }
  const player = state.playerLink
  if (!player || player.index !== CHAIN_LENGTH) return undefined
  if (dealerLast.index !== CHAIN_LENGTH) return undefined
  const dealerLinks = linksUpTo(dealerLast)
  const playerLinks = linksUpTo(player)
  const drawn = [...state.draws]
  const rest: Card[] = []
  for (let k = drawn.length; k < CHAIN_LENGTH; k++) {
    const card = drawCard(
      state.gameId,
      k,
      dealerLinks[k + 1],
      playerLinks[k + 1],
      drawn,
    )
    drawn.push(card)
    rest.push(card)
  }
  // The dealing order `playOutDealer` expects: player, up, player, hole, hits, dealer's draws.
  const [hole, ...more] = rest
  const deck = [first, up, second, hole, ...hits, ...more]
  const played = playOutDealer(deck, state.playerCards, 4 + hits.length)
  if (played.dealerCards.some(card => card === undefined)) return undefined
  return { dealerCards: played.dealerCards, outcome: played.outcome }
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
    if (item.seq !== 0) return reject(prev, 'out-of-order')
    if (maxBetWei === undefined || maxBetWei <= 0n)
      return reject(prev, 'bad-amount')
    if (item.role === 'dealer' && !HEX64.test(item.commitment))
      return reject(prev, 'bad-commitment')
    const base = {
      gameId: item.gameId,
      challenger: item.role,
      maxBetWei,
      head: digest,
      count: 1,
      wagerWei: 0n,
      doubled: false,
      draws: [],
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
              dealerLink: { index: 0, link: item.commitment },
            }
          : { ...base, phase: 'challenged', dealer: to, player: from },
    }
  }
  if (!prev) return reject(prev, 'no-hand')

  const fromDealer = same(from, prev.dealer) && same(to, prev.player)
  const fromPlayer = same(from, prev.player) && same(to, prev.dealer)
  if (!fromDealer && !fromPlayer) return reject(prev, 'wrong-sender')
  /** The message is accepted: it becomes the head of the hand's chain. */
  const next = (changes: Partial<HandState>): HandResult => ({
    state: {
      ...prev,
      ...changes,
      head: digest,
      count: prev.count + 1,
      seen: [...prev.seen, digest],
    },
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

  if (item.action === 'refund') {
    // A refund is tied to the message whose money it returns, not to a place in the chain.
    if (!fromDealer) return reject(prev, 'wrong-sender')
    if (prev.phase === 'awaiting_deal' && item.ref === prev.betDigest)
      return next({ phase: 'refunded', refundedWei: stampWei })
    const index = prev.rejected.findIndex(
      r => r.digest === item.ref && r.refundedWei === undefined,
    )
    if (index < 0) return reject(prev, 'bad-ref')
    return {
      state: {
        ...prev,
        rejected: prev.rejected.map((r, i) =>
          i === index ? { ...r, refundedWei: stampWei } : r,
        ),
        seen: [...prev.seen, digest],
      },
    }
  }

  const moneyFromPlayer =
    fromPlayer && (item.action === 'bet' || item.action === 'double')
  // Everything else must be the hand's next message: a replayed, reordered or forked message
  // names another position or another predecessor.
  if (item.seq !== prev.count || item.prev !== prev.head)
    return moneyFromPlayer ? owedBack('out-of-order') : reject(prev, 'out-of-order')

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
      return next({
        phase: 'open',
        maxBetWei,
        commitment: item.commitment,
        dealerLink: { index: 0, link: item.commitment },
      })
    }
    case 'bet': {
      if (!fromPlayer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'open') return owedBack('wrong-phase')
      if (stampWei <= 0n || stampWei > prev.maxBetWei)
        return owedBack('bad-amount')
      if (!HEX64.test(item.commitment)) return owedBack('bad-commitment')
      return next({
        phase: 'awaiting_deal',
        wagerWei: stampWei,
        betDigest: digest,
        playerCommitment: item.commitment,
        playerLink: { index: 0, link: item.commitment },
      })
    }
    case 'deal': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_deal') return reject(prev, 'wrong-phase')
      // The dealer opens its links for the first three cards. The cards stay unknown to it until
      // the player's first move opens the player's.
      if (!prev.dealerLink || !verifyLink(item.link, 3, prev.dealerLink))
        return reject(prev, 'bad-link')
      return next({
        phase: 'player_turn',
        dealerLink: { index: 3, link: item.link },
      })
    }
    case 'hit':
    case 'stand':
    case 'double': {
      if (!fromPlayer) return reject(prev, 'wrong-sender')
      const refuse = (error: HandRejection) =>
        item.action === 'double' ? owedBack(error) : reject(prev, error)
      if (prev.phase !== 'player_turn') return refuse('wrong-phase')
      if (!prev.playerLink || !prev.dealerLink) return refuse('wrong-phase')
      // A hit opens the link of the card it asks for; a stand or a double ends the player's
      // choices and opens the rest of its chain.
      const cardsOut = Math.max(prev.draws.length, 3)
      const index = item.action === 'hit' ? cardsOut + 1 : CHAIN_LENGTH
      if (!verifyLink(item.link, index, prev.playerLink)) return refuse('bad-link')
      const playerLink = { index, link: item.link }
      const draws = prev.draws.length
        ? prev.draws
        : initialDraws(prev.gameId, prev.dealerLink, playerLink)
      if (!draws) return refuse('bad-link')
      const playerCards = prev.draws.length ? prev.playerCards : [draws[0], draws[2]]
      // A natural is final as dealt: the only move is to stand.
      if (item.action !== 'stand' && handValue(playerCards).blackjack)
        return refuse('wrong-phase')
      if (item.action === 'double') {
        if (playerCards.length !== 2) return owedBack('wrong-phase')
        if (stampWei !== prev.wagerWei) return owedBack('bad-amount')
      }
      const opened = { playerLink, draws, playerCards, dealerUpCard: draws[1] }
      if (item.action === 'stand') return next({ ...opened, phase: 'dealer_turn' })
      return next({
        ...opened,
        phase: 'awaiting_card',
        pending: item.action,
        ...(item.action === 'double' ? { doubled: true } : {}),
      })
    }
    case 'card': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_card') return reject(prev, 'wrong-phase')
      const k = prev.draws.length
      const playerLink = prev.playerLink && linkAt(prev.playerLink, k + 1)
      if (
        !prev.dealerLink ||
        playerLink === undefined ||
        !verifyLink(item.link, k + 1, prev.dealerLink)
      )
        return reject(prev, 'bad-link')
      const card = drawCard(prev.gameId, k, item.link, playerLink, prev.draws)
      const cards = [...prev.playerCards, card]
      const done = handValue(cards).bust || prev.pending === 'double'
      return next({
        phase: done ? 'dealer_turn' : 'player_turn',
        pending: undefined,
        dealerLink: { index: k + 1, link: item.link },
        draws: [...prev.draws, card],
        playerCards: cards,
      })
    }
    case 'reveal': {
      if (!fromDealer) return reject(prev, 'wrong-sender')
      if (prev.phase !== 'dealer_turn') return reject(prev, 'wrong-phase')
      if (!prev.dealerLink || !verifyLink(item.link, CHAIN_LENGTH, prev.dealerLink))
        return reject(prev, 'bad-link')
      const dealerLink = { index: CHAIN_LENGTH, link: item.link }
      const end = settle(prev, dealerLink)
      if (!end) return reject(prev, 'bad-reveal')
      return next({
        phase: 'resolved',
        dealerLink,
        dealerCards: end.dealerCards,
        outcome: end.outcome,
        owedWei: payoutWei(end.outcome, prev.wagerWei, prev.doubled),
        paidWei: stampWei,
      })
    }
  }
}

/** Does this event continue the hand from `state` (or, for a refund, return money it owes)? */
function fitsNext(state: HandState | undefined, event: HandEvent): boolean {
  const { item } = event
  if (!state) return item.action === 'challenge'
  if (item.action === 'challenge') return false
  if (item.action === 'refund')
    return (
      (state.phase === 'awaiting_deal' && item.ref === state.betDigest) ||
      state.rejected.some(r => r.digest === item.ref && r.refundedWei === undefined)
    )
  return item.seq === state.count && item.prev === state.head
}

/**
 * Fold a whole conversation's hand messages. The order given matters only where the chain leaves
 * a choice: each step takes the message that continues the chain (`seq`, `prev`), so messages
 * that were delivered or stored out of order still fold the same way on both sides. Of two
 * messages that continue the same point (a fork by their sender), the one the other side built
 * on wins; otherwise the earlier in the given order. What never fits is rejected.
 */
export function foldHand(events: readonly HandEvent[]): {
  state: HandState | undefined
  rejected: { digest: string; error: HandRejection; from: string }[]
} {
  let state: HandState | undefined
  const rejected: { digest: string; error: HandRejection; from: string }[] = []
  const pending = [...events]
  const apply = (index: number) => {
    const [event] = pending.splice(index, 1)
    const result = applyHandEvent(state, event)
    state = result.state
    if (result.error)
      rejected.push({ digest: event.digest, error: result.error, from: event.from })
  }
  while (pending.length) {
    const fits = pending.flatMap((event, i) => (fitsNext(state, event) ? [i] : []))
    if (fits.length) {
      const builtOn = fits.find(i =>
        pending.some(
          other =>
            other.item.action !== 'challenge' &&
            other.item.prev === pending[i].digest &&
            !same(other.from, pending[i].from),
        ),
      )
      apply(builtOn ?? fits[0])
      continue
    }
    // Nothing continues the chain. Whatever is left is rejected, money first, so that a refund
    // of rejected money finds what it returns.
    const other = pending.findIndex(event => event.item.action !== 'refund')
    apply(other < 0 ? 0 : other)
  }
  return { state, rejected }
}

/** The cards a side can see. Both sides compute the same cards from the links opened so far,
 * except for one moment: after the deal the player holds both sides' links for the first three
 * cards and sees them before its first move opens them to the dealer. */
export function handView(
  state: HandState | undefined,
  seed?: string,
): { playerCards: Card[]; dealerUpCard?: Card; dealerCards: Card[] } {
  if (!state) return { playerCards: [], dealerCards: [] }
  if (
    state.phase === 'player_turn' &&
    state.draws.length === 0 &&
    seed &&
    state.dealerLink &&
    commitmentOf(seed) === state.playerCommitment
  ) {
    const draws = initialDraws(state.gameId, state.dealerLink, {
      index: 3,
      link: entropyChain(seed)[3],
    })
    if (draws)
      return {
        playerCards: [draws[0], draws[2]],
        dealerUpCard: draws[1],
        dealerCards: [],
      }
  }
  return {
    playerCards: state.playerCards,
    dealerUpCard: state.dealerUpCard,
    dealerCards: state.dealerCards,
  }
}

/** What the player may send now, given the seed it committed to in its bet. A bet's and a
 * double's stamp is the money. Without its seed a player can bet but cannot move. */
export function playerMoves(
  state: HandState | undefined,
  seed?: string,
): ('bet' | 'hit' | 'stand' | 'double')[] {
  if (state?.phase === 'open') return ['bet']
  if (state?.phase !== 'player_turn') return []
  if (!seed || commitmentOf(seed) !== state.playerCommitment) return []
  const cards = handView(state, seed).playerCards
  if (cards.length < 2) return []
  // A natural is final as dealt: standing opens it to the dealer.
  if (handValue(cards).blackjack) return ['stand']
  return cards.length === 2 ? ['hit', 'stand', 'double'] : ['hit', 'stand']
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

/** The player's move, with the link it opens: a hit opens the link of the card it asks for, a
 * stand or a double the rest of the player's chain. */
export function playerStep(
  state: HandState | undefined,
  move: 'hit' | 'stand' | 'double',
  seed: string,
): HandItem | undefined {
  if (!state || !playerMoves(state, seed).includes(move)) return undefined
  const index =
    move === 'hit' ? Math.max(state.draws.length, 3) + 1 : CHAIN_LENGTH
  return { ...chained(state), action: move, link: entropyChain(seed)[index] }
}

/** A message the dealer must send, and the stamp it must carry when the stamp is money. */
export interface DealerStep {
  item: HandItem
  /** Present for a payout or a refund: the exact stamp to pay. Absent: an ordinary stamp. */
  payWei?: bigint
}

/**
 * The dealer's next message, if it is the dealer's turn. No choice is involved in any of these:
 * each opens the next link of the chain the dealer committed to, and the amounts come from the
 * hand. The same state always gives the same step, so a retry after a crash sends the same
 * message.
 */
export function dealerStep(
  state: HandState | undefined,
  seed: string,
): DealerStep | undefined {
  if (!state) return undefined
  const base = chained(state)
  const owed = state.rejected.find(r => r.refundedWei === undefined)
  if (owed)
    return {
      item: { ...base, action: 'refund', ref: owed.digest },
      payWei: owed.stampWei,
    }
  if (!HEX64.test(seed)) return undefined
  const chain = entropyChain(seed)
  if (chain[0] !== state.commitment) return undefined
  switch (state.phase) {
    case 'awaiting_deal':
      return { item: { ...base, action: 'deal', link: chain[3] } }
    case 'awaiting_card':
      return {
        item: { ...base, action: 'card', link: chain[state.draws.length + 1] },
      }
    case 'dealer_turn': {
      const link = chain[CHAIN_LENGTH]
      const end = settle(state, { index: CHAIN_LENGTH, link })
      if (!end) return undefined
      const owedWei = payoutWei(end.outcome, state.wagerWei, state.doubled)
      return {
        item: { ...base, action: 'reveal', link },
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
