/**
 * The blackjack hand state machine -- shared, isomorphic, and this is the ONE place hand rules
 * live. Both a bot dealer (as its own live authoritative state, updated as it acts) and the
 * frontend (replaying a chat's `blackjack-move` items from scratch, e.g. after a page reload) call
 * `reduceBlackjackState` to fold the exact same sequence of moves into state -- they can never
 * disagree about whose turn it is or what a hand's current total is, because there is only one
 * implementation of "what happens when this move is applied."
 *
 * ## Dealing order convention
 *
 * `deriveDeck` (`./deck.ts`) only produces an ordered 52-card permutation; *which* cards go to
 * whom is a separate convention, fixed here so `verifyRevealedHand` can deterministically replay
 * it: `deck[0]`/`deck[2]` -> the player's first two cards, `deck[1]`/`deck[3]` -> the dealer's
 * (card 1 up, card 3 hidden until reveal), then every subsequent player `hit` consumes the next
 * undealt card in order, and once the player stands the dealer continues drawing from wherever the
 * player's hits left off, stopping at a total of 17 or more (a simplified "hits soft 17" is not
 * distinguished from "stands on soft 17" here -- a real casino's exact house rule on this point is
 * a menu choice, not a fairness property, and out of scope for this demo).
 */
import type {
  BlackjackHandV3Item,
  BlackjackItem as BlackjackMoveItem,
} from '@frank/codec'

import { Card, cardRank, deriveDeck, handValue, sha256Hex } from './deck'
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
  awaitedRole,
  buildAccept,
  buildBet,
  buildChallenge,
  challengeLimitWei,
  checkWager,
  commitmentOf,
  DEALER_COVER_MULTIPLE,
  handEventsOf,
  isGameId,
  maxDealerBetWei,
  maxPlayerBetWei,
  refundBetStep,
  refundShortfallWei,
  roleOf,
  seedFromBytes,
  soleHandItem,
  type HandMessage,
  type HandMoneyError,
  type HandPhase,
  type HandRejection,
  type HandRole,
} from './hand'

export type { BlackjackMoveItem }

/** Default table limits. A dealer advertises its real limits in its `welcome` item (see
 * {@link BlackjackWelcome}); these constants are only the shared FALLBACK for a chat that holds no
 * welcome (a dealer that never greeted, or an older one), and the bot's `BLACKJACK_BOT_MIN_WAGER_WEI`
 * / `BLACKJACK_BOT_MAX_WAGER_WEI` default to them. A dealer configured differently may still reject
 * a bet the UI allows under the fallback; the bot then refunds the verified stake. */
export const BLACKJACK_DEFAULT_MIN_WAGER_WEI = 10n ** 16n // 0.01 MON
export const BLACKJACK_DEFAULT_MAX_WAGER_WEI = 10n ** 18n // 1 MON

/**
 * Conservative allowance for what sending the bet MESSAGE costs beyond the wager itself: the
 * stamp's own funding transfers and gas (a message spends its stamp value plus the fee reserves of
 * the sub-accounts that pay it; ~0.013 MON of funding was observed on the local chain on top of a
 * 0.01 MON stamp). The wallet does not expose a synchronous estimate, so this is a fixed margin.
 * A wager paid with no funds left for the message is stranded (the dealer only acts on messages it
 * receives), so the inline bet control requires `bet + stamp + this` up front. Lives here (not in the app)
 * so the demo launcher can check its faucet amount against the same constant.
 */
export const BET_MESSAGE_FEE_RESERVE_WEI = 5n * 10n ** 16n // 0.05 MON

/** Returns an error message if `wei` is not an acceptable bet at the default table limits. */
export function validateBetWei(
  wei: bigint,
  minWei: bigint = BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  maxWei: bigint = BLACKJACK_DEFAULT_MAX_WAGER_WEI,
): string | undefined {
  if (typeof wei !== 'bigint' || wei <= 0n) return 'Bet must be greater than zero'
  if (wei < minWei) return 'Bet is below the table minimum'
  if (wei > maxWei) return 'Bet is above the table maximum'
  return undefined
}

/** True when a freshly-dealt 2-card hand is a pair of matching rank (`cardRank(c0) === cardRank(c1)`). */
export function isSplittablePair(cards: readonly Card[]): boolean {
  return cards.length === 2 && cardRank(cards[0]) === cardRank(cards[1])
}

function splitSingleHandPayoutWei(
  outcome: BlackjackOutcome,
  wager: bigint,
): bigint | undefined {
  switch (outcome) {
    // Split hands pay 1:1 on any win (no 3:2 natural blackjack bonus on split hands).
    case 'player_blackjack':
    case 'player_win':
      return wager * 2n
    case 'push':
      return wager
    case 'dealer_win':
      return 0n
    default:
      return undefined
  }
}

/** What the dealer sends back for a resolved hand, in wei: 2.5x the effective wager on a natural,
 * 2x on a win, the wager on a push, nothing on a loss. Mirrors the dealer bot's own
 * `payoutMultiplier` (`packages/bot/blackjack-bot.livecheck.ts`). The effective wager only counts
 * transfers verified on chain (`verifiedWagerWei`, plus `verifiedDoubleWagerWei` for a double or
 * `verifiedSplitWagerWei` for a split); `undefined` when the outcome is not final, the wager is not
 * verified, or a double/split is recorded without its verified second transfer (the amount is
 * unknown, and a smaller figure would under-report what is owed). */
export function blackjackPayoutWei(
  state: Pick<
    BlackjackGameState,
    | 'phase'
    | 'outcome'
    | 'verifiedWagerWei'
    | 'verifiedDoubleWagerWei'
    | 'doubled'
    | 'split'
    | 'verifiedSplitWagerWei'
    | 'splitOutcomes'
  >,
): bigint | undefined {
  if (state.phase !== 'resolved' || state.verifiedWagerWei === undefined) {
    return undefined
  }
  if (state.split) {
    if (
      state.verifiedSplitWagerWei === undefined ||
      !state.splitOutcomes ||
      state.splitOutcomes.length !== 2
    ) {
      return undefined
    }
    const p0 = splitSingleHandPayoutWei(
      state.splitOutcomes[0],
      state.verifiedWagerWei,
    )
    const p1 = splitSingleHandPayoutWei(
      state.splitOutcomes[1],
      state.verifiedSplitWagerWei,
    )
    if (p0 === undefined || p1 === undefined) return undefined
    return p0 + p1
  }
  if (state.doubled && state.verifiedDoubleWagerWei === undefined) return undefined
  const wager = state.doubled
    ? state.verifiedWagerWei + (state.verifiedDoubleWagerWei ?? 0n)
    : state.verifiedWagerWei
  switch (state.outcome) {
    case 'player_blackjack':
      return (wager * 5n) / 2n
    case 'player_win':
      return wager * 2n
    case 'push':
      return wager
    case 'dealer_win':
      return 0n
    default:
      return undefined
  }
}

/** The dealer's rejection text. Keeps the readable "Blackjack: <text>" prefix (old clients show it
 * as is) and appends a parseable, JSON-quoted gameId token so a client can tell WHICH game an
 * error is about. */
export function formatBlackjackError(gameId: string, text: string): string {
  return `Blackjack: ${text} [game=${JSON.stringify(gameId)}]`
}

/** Inverse of `formatBlackjackError`; `undefined` for anything that is not a game-tagged dealer
 * error (including untagged "Blackjack: ..." text). */
export function parseBlackjackError(
  raw: string,
): { gameId: string; text: string } | undefined {
  const match = /^Blackjack: ([\s\S]*) \[game=("(?:[^"\\]|\\.)*")\]$/.exec(raw)
  if (!match) return undefined
  try {
    const gameId: unknown = JSON.parse(match[2])
    return typeof gameId === 'string' ? { gameId, text: match[1] } : undefined
  } catch {
    return undefined
  }
}

export type BlackjackAction =
  | 'bet'
  | 'deal'
  | 'hit'
  | 'stand'
  | 'double'
  | 'split'
  | 'reveal'
export type BlackjackOutcome =
  | 'player_win'
  | 'dealer_win'
  | 'push'
  | 'player_blackjack'
export type BlackjackPhase =
  | 'awaiting_deal'
  | 'player_turn'
  | 'dealer_turn'
  | 'resolved'

export interface BlackjackGameState {
  gameId: string
  phase: BlackjackPhase
  playerAddress: string
  /** The wager's own tx hash -- doubles as the shuffle's client-seed entropy, so it's captured
   * once at `bet` time and never needs re-deriving later. */
  wagerTxHash?: string
  /** Only ever set from `hydrate()`'s on-chain verification, never from a self-reported field --
   * see the message-item plugin (`./plugin.ts`) for how it's produced. */
  verifiedWagerWei?: bigint
  /** Set once a `double` move is accepted -- payout math (bot-side) doubles the effective wager
   * for this hand. Never inferred from `playerCards.length` alone (a 3-card hand can also happen
   * from an ordinary `hit`), always from an explicit `double` move having been folded in. */
  doubled?: boolean
  /** True while the player's own `double` request has been folded but the dealer's broadcast card
   * has not (the optimistic window). Only a bot error reply can end it early -- see
   * `applyDoubleRejection`. */
  doublePending?: boolean
  /** Only present once `doubled` is true, and only ever from `hydrate()`'s own verification of the
   * *second* wager transfer -- same trust rule as `verifiedWagerWei`. */
  verifiedDoubleWagerWei?: bigint
  /** Set once a `split` move is folded for an initial pair. */
  split?: boolean
  /** True while the player's own `split` request has been folded but the dealer's broadcast of the
   * two split hands has not yet landed. */
  splitPending?: boolean
  /** Only present once `split` is true, from `hydrate()`'s verification of the second wager. */
  verifiedSplitWagerWei?: bigint
  /** The two split hands `[hand0, hand1]` once split. */
  splitHands?: [Card[], Card[]]
  /** Which split hand (`0` or `1`) is currently acting during `player_turn`. */
  activeSplitHand?: 0 | 1
  /** Per-hand outcomes `[outcome0, outcome1]` for a resolved split hand. */
  splitOutcomes?: [BlackjackOutcome, BlackjackOutcome]
  serverSeedHash?: string
  serverSeed?: string
  playerCards: Card[]
  dealerUpCard?: Card
  dealerCards: Card[]
  outcome?: BlackjackOutcome
  /** Drives both the bot's own move-validation and the frontend's follow-up buttons -- see
   * `blackjack-move`'s own header on the message type for why this is the single source of truth
   * for "what's legal right now" rather than duplicated logic in each consumer. */
  availableActions: BlackjackAction[]
}

/**
 * The dealer's opening message (#395): the table's limits and rules, sent once to each new
 * registration next to a plain-text greeting. It is an ADDITIVE action of the existing
 * `blackjack-move` item, so no wire format changes: message items are application-level JSON inside
 * the end-to-end encrypted envelope (the relay stores and forwards opaque bytes and never inspects
 * items), and `deserializeMessageItems` accepts any `action` string. A client that predates it
 * renders an empty blackjack block (its reducer returns no state for an unknown action) and shows
 * the accompanying text item, which the dealer always sends LAST so an older client's chat-list
 * preview (the last item) stays a string. The welcome belongs to no game: its `gameId` is the
 * fixed {@link BLACKJACK_WELCOME_GAME_ID}, and it never carries or moves value.
 */
export interface BlackjackWelcome {
  minWagerWei: bigint
  maxWagerWei: bigint
  /** Dealer's hint of the stamp plus fees a bet message costs beyond the wager, if it gave one. */
  feeHintWei?: bigint
  /** House rules summary, plain text, at most {@link BLACKJACK_WELCOME_RULES_MAX} characters. */
  rules?: string
}

export const BLACKJACK_WELCOME_GAME_ID = 'welcome'
export const BLACKJACK_WELCOME_RULES_MAX = 400
/** Bounds a wei string so a hostile item cannot make the client do unbounded bigint work. */
const MAX_WELCOME_WEI_DIGITS = 40

/** What the dealer bot says about its own house rules (English; it is dealer text, not app UI). */
export const BLACKJACK_RULES_SUMMARY =
  'A natural pays 3:2, a win pays 1:1, a push returns your bet. The dealer draws to 17 and does not peek. Double down on your first two cards; no splitting. Every hand is provably fair: the dealer commits to its shuffle first and reveals the seed afterwards.'

function parseWei(value: unknown): bigint | undefined {
  if (
    typeof value !== 'string' ||
    !/^[0-9]+$/.test(value) ||
    value.length > MAX_WELCOME_WEI_DIGITS
  ) {
    return undefined
  }
  return BigInt(value)
}

/**
 * Strictly parses a `welcome` item's untrusted table fields. Returns `undefined` (the whole welcome
 * is ignored, the fallback limits apply) unless the limits are canonical positive decimal strings
 * with min <= max. A bad optional field is dropped, never trusted.
 */
export function parseBlackjackWelcome(item: {
  action?: unknown
  minWagerWei?: unknown
  maxWagerWei?: unknown
  feeHintWei?: unknown
  rules?: unknown
}): BlackjackWelcome | undefined {
  if (item.action !== 'welcome') return undefined
  const minWagerWei = parseWei(item.minWagerWei)
  const maxWagerWei = parseWei(item.maxWagerWei)
  if (
    minWagerWei === undefined ||
    maxWagerWei === undefined ||
    minWagerWei <= 0n ||
    minWagerWei > maxWagerWei
  ) {
    return undefined
  }
  const feeHintWei = parseWei(item.feeHintWei)
  const rules =
    typeof item.rules === 'string' && item.rules.trim() !== ''
      ? item.rules.trim().slice(0, BLACKJACK_WELCOME_RULES_MAX)
      : undefined
  return { minWagerWei, maxWagerWei, feeHintWei, rules }
}

/** Builds the `welcome` item a dealer sends (the inverse of {@link parseBlackjackWelcome}). */
export function buildBlackjackWelcomeItem(table: {
  minWagerWei: bigint
  maxWagerWei: bigint
  feeHintWei?: bigint
  rules?: string
}): BlackjackMoveItem {
  return {
    type: 'blackjack-move',
    gameId: BLACKJACK_WELCOME_GAME_ID,
    action: 'welcome',
    minWagerWei: table.minWagerWei.toString(),
    maxWagerWei: table.maxWagerWei.toString(),
    ...(table.feeHintWei !== undefined
      ? { feeHintWei: table.feeHintWei.toString() }
      : {}),
    ...(table.rules !== undefined ? { rules: table.rules } : {}),
  }
}

export interface HydratedBlackjackMove {
  gameId: string
  action: BlackjackAction | 'welcome'
  /** Only present for `welcome`: the strictly parsed table (undefined if malformed). */
  welcome?: BlackjackWelcome
  wagerTxHash?: string
  /** Only present for `double`: the hash `verifiedDoubleWager` was looked up by. The bot claims it
   * in the same global keyspace as wager hashes so one transfer can back exactly one stake. */
  doubleWagerTxHash?: string
  /** Only present for `split`: the hash `verifiedSplitWager` was looked up by. */
  splitWagerTxHash?: string
  serverSeedHash?: string
  playerCards?: Card[]
  splitHands?: [Card[], Card[]]
  splitOutcomes?: [BlackjackOutcome, BlackjackOutcome]
  dealerUpCard?: Card
  dealerCards?: Card[]
  serverSeed?: string
  outcome?: BlackjackOutcome
  /** Only present for `bet` -- the on-chain-verified wager, or `undefined` if verification failed
   * (unconfirmed, wrong sender, wrong recipient, ...). Never derived from a self-reported field. */
  verifiedWager?: {
    fromAddress: string
    toAddress: string
    valueWei: bigint
  }
  /** Only present for `double` -- same trust rule as `verifiedWager`, for the *second* transfer a
   * double-down needs (see `BlackjackMoveItem.doubleWagerTxHash`'s own header). */
  verifiedDoubleWager?: {
    fromAddress: string
    toAddress: string
    valueWei: bigint
  }
  /** Only present for `split` -- same trust rule as `verifiedWager`, for the equal second transfer
   * a split needs. */
  verifiedSplitWager?: {
    fromAddress: string
    toAddress: string
    valueWei: bigint
  }
  senderAddress: string
}

/** Resolves the dealer's outcome against the player's already-known-not-bust hand. Assumes the
 * player didn't bust (that's decided earlier, in the `hit` case, before the dealer ever plays). */
function resolveOutcome(
  playerValue: ReturnType<typeof handValue>,
  dealerValue: ReturnType<typeof handValue>,
): BlackjackOutcome {
  if (playerValue.blackjack && !dealerValue.blackjack) return 'player_blackjack'
  if (dealerValue.blackjack && !playerValue.blackjack) return 'dealer_win'
  if (dealerValue.bust) return 'player_win'
  if (playerValue.total > dealerValue.total) return 'player_win'
  if (playerValue.total < dealerValue.total) return 'dealer_win'
  return 'push'
}

/** Resolves one split hand against the dealer's final cards. A 2-card 21 after splitting counts as
 * 21 (`player_win` at 1:1), never a 3:2 natural (`player_blackjack`). */
export function resolveSplitHandOutcome(
  handCards: Card[],
  dealerCards: Card[],
): BlackjackOutcome {
  const pv = handValue(handCards)
  if (pv.bust) return 'dealer_win'
  const dv = handValue(dealerCards)
  const raw = resolveOutcome({ ...pv, blackjack: false }, dv)
  return raw === 'player_blackjack' ? 'player_win' : raw
}

/** Combines the two split-hand outcomes into a summary outcome for the overall hand based on net
 * result against the total 2x stake. */
export function combineSplitOutcomes(
  outcomes: [BlackjackOutcome, BlackjackOutcome],
): BlackjackOutcome {
  const scoreOf = (o: BlackjackOutcome): number =>
    o === 'player_win' || o === 'player_blackjack'
      ? 1
      : o === 'dealer_win'
      ? -1
      : 0
  const score = scoreOf(outcomes[0]) + scoreOf(outcomes[1])
  if (score > 0) return 'player_win'
  if (score < 0) return 'dealer_win'
  return 'push'
}

export function reduceBlackjackState(
  prev: BlackjackGameState | undefined,
  hydrated: HydratedBlackjackMove,
): BlackjackGameState {
  switch (hydrated.action) {
    case 'welcome':
      // Not a game move: the table's opening message never creates or changes a hand.
      return prev ?? emptyState(hydrated)
    case 'bet': {
      // A real 'bet' always starts a fresh gameId thread. A duplicate/replayed bet for a thread
      // that already has state is left unchanged rather than clobbering it -- defensive against a
      // resent/duplicated message, not an expected occurrence.
      if (prev) return prev
      return {
        gameId: hydrated.gameId,
        phase: 'awaiting_deal',
        playerAddress: hydrated.senderAddress,
        wagerTxHash: hydrated.wagerTxHash,
        verifiedWagerWei: hydrated.verifiedWager?.valueWei,
        playerCards: [],
        dealerCards: [],
        availableActions: [],
      }
    }
    case 'deal': {
      if (!prev || prev.phase !== 'awaiting_deal') return prev ?? emptyState(hydrated)
      const playerCards = hydrated.playerCards ?? []
      const value = handValue(playerCards)
      const canSplit = !value.blackjack && isSplittablePair(playerCards)
      return {
        ...prev,
        serverSeedHash: hydrated.serverSeedHash,
        playerCards,
        dealerUpCard: hydrated.dealerUpCard,
        phase: value.blackjack ? 'dealer_turn' : 'player_turn',
        // 'double' and 'split' are only ever offered here, on the freshly-dealt two-card hand --
        // never after a 'hit', and never on a natural (already resolved, no actions at all).
        availableActions: value.blackjack
          ? []
          : canSplit
          ? ['hit', 'stand', 'double', 'split']
          : ['hit', 'stand', 'double'],
      }
    }
    case 'split': {
      const awaitingBroadcastSplit =
        prev?.split === true && prev.splitPending === true
      const canInitiateSplit =
        prev !== undefined &&
        prev.phase === 'player_turn' &&
        !prev.split &&
        !prev.doubled &&
        isSplittablePair(prev.playerCards)
      if (!prev || !(canInitiateSplit || awaitingBroadcastSplit)) {
        return prev ?? emptyState(hydrated)
      }
      const verifiedSplitWagerWei =
        hydrated.verifiedSplitWager?.valueWei ?? prev.verifiedSplitWagerWei
      if (!hydrated.splitHands) {
        return {
          ...prev,
          split: true,
          splitPending: true,
          verifiedSplitWagerWei,
          splitHands: [[prev.playerCards[0]], [prev.playerCards[1]]],
          activeSplitHand: 0,
          phase: 'player_turn',
          availableActions: [],
        }
      }
      if (hydrated.splitHands.length !== 2) return prev
      const hand0 = [...hydrated.splitHands[0]]
      const hand1 = [...hydrated.splitHands[1]]
      return {
        ...prev,
        split: true,
        splitPending: false,
        verifiedSplitWagerWei,
        splitHands: [hand0, hand1],
        activeSplitHand: 0,
        playerCards: hand0,
        phase: 'player_turn',
        availableActions: ['hit', 'stand'],
      }
    }
    case 'hit': {
      if (!prev || prev.phase !== 'player_turn' || prev.splitPending)
        return prev ?? emptyState(hydrated)
      if (prev.split && prev.splitHands) {
        const active = prev.activeSplitHand ?? 0
        const hand0 = hydrated.splitHands
          ? [...hydrated.splitHands[0]]
          : active === 0 && hydrated.playerCards
          ? [...hydrated.playerCards]
          : [...prev.splitHands[0]]
        const hand1 = hydrated.splitHands
          ? [...hydrated.splitHands[1]]
          : active === 1 && hydrated.playerCards
          ? [...hydrated.playerCards]
          : [...prev.splitHands[1]]
        const splitHands: [Card[], Card[]] = [hand0, hand1]
        if (active === 0) {
          const v0 = handValue(hand0)
          const done0 = v0.bust || v0.total >= 21
          return {
            ...prev,
            splitHands,
            activeSplitHand: done0 ? 1 : 0,
            playerCards: done0 ? hand1 : hand0,
            phase: 'player_turn',
            availableActions: ['hit', 'stand'],
          }
        }
        const v1 = handValue(hand1)
        const done1 = v1.bust || v1.total >= 21
        const bothBust = handValue(hand0).bust && v1.bust
        return {
          ...prev,
          splitHands,
          activeSplitHand: 1,
          playerCards: hand1,
          phase: done1 ? 'dealer_turn' : 'player_turn',
          ...(bothBust
            ? {
                outcome: 'dealer_win' as const,
                splitOutcomes: ['dealer_win', 'dealer_win'] as [
                  BlackjackOutcome,
                  BlackjackOutcome,
                ],
              }
            : {}),
          availableActions: done1 ? [] : ['hit', 'stand'],
        }
      }
      const playerCards = hydrated.playerCards ?? prev.playerCards
      const value = handValue(playerCards)
      // A bust is a known outcome immediately, but phase only ever reaches 'resolved' via an
      // explicit 'reveal' item, no exceptions -- every hand, busted or not, must publish
      // `serverSeed` so it can be independently verified (`verifyRevealedHand`). Skipping that for
      // a bust would mean the hands most worth checking (the ones the player just lost) could
      // never actually be checked.
      return {
        ...prev,
        playerCards,
        phase: value.bust ? 'dealer_turn' : 'player_turn',
        outcome: value.bust ? 'dealer_win' : undefined,
        availableActions: value.bust ? [] : ['hit', 'stand'],
      }
    }
    case 'double': {
      // Reached twice per hand, same as 'hit' is reached twice -- once from the player's own
      // outgoing request (phase still 'player_turn', carries the verified second transfer, no
      // `playerCards` yet) and once from the dealer's broadcast of the resulting card (phase
      // already moved to 'dealer_turn' by the first fold, since doubling is always exactly one
      // more card then an automatic stand -- never another decision point). `doubled` already
      // being true is what keeps that second fold eligible despite the phase having moved on;
      // once the broadcast card actually lands (`playerCards.length` grows past 2), a third,
      // replayed 'double' is correctly rejected by the length check below, same as every other
      // case here guards against a message that doesn't belong to this point in the hand.
      const awaitingBroadcastCard = prev?.doubled === true && prev.phase === 'dealer_turn'
      if (
        !prev ||
        prev.split ||
        prev.playerCards.length !== 2 ||
        !(prev.phase === 'player_turn' || awaitingBroadcastCard)
      ) {
        return prev ?? emptyState(hydrated)
      }
      const playerCards = hydrated.playerCards ?? prev.playerCards
      const value = handValue(playerCards)
      return {
        ...prev,
        playerCards,
        doubled: true,
        // Pending until the dealer's broadcast card (which carries `playerCards`) lands.
        doublePending: hydrated.playerCards === undefined,
        // 'double' is folded twice per hand -- once from the player's own outgoing request
        // (carries the verified transfer, no `playerCards` yet) and once from the dealer's
        // broadcast of the resulting card (carries `playerCards`, no transfer). Falling back to
        // `prev`'s already-verified value keeps the second fold from clobbering it with
        // `undefined`.
        verifiedDoubleWagerWei:
          hydrated.verifiedDoubleWager?.valueWei ?? prev.verifiedDoubleWagerWei,
        phase: 'dealer_turn',
        outcome: value.bust ? 'dealer_win' : undefined,
        availableActions: [],
      }
    }
    case 'stand': {
      if (!prev || prev.phase !== 'player_turn' || prev.splitPending)
        return prev ?? emptyState(hydrated)
      if (prev.split && prev.splitHands) {
        const active = prev.activeSplitHand ?? 0
        if (active === 0) {
          return {
            ...prev,
            activeSplitHand: 1,
            playerCards: prev.splitHands[1],
            phase: 'player_turn',
            availableActions: ['hit', 'stand'],
          }
        }
        return {
          ...prev,
          activeSplitHand: 1,
          phase: 'dealer_turn',
          availableActions: [],
        }
      }
      return { ...prev, phase: 'dealer_turn', availableActions: [] }
    }
    case 'reveal': {
      if (!prev) return emptyState(hydrated)
      const dealerCards = hydrated.dealerCards ?? []
      if (prev.split || hydrated.splitHands) {
        const splitHands = hydrated.splitHands ?? prev.splitHands
        const splitOutcomes: [BlackjackOutcome, BlackjackOutcome] | undefined =
          hydrated.splitOutcomes ??
          (splitHands && dealerCards.length > 0
            ? [
                resolveSplitHandOutcome(splitHands[0], dealerCards),
                resolveSplitHandOutcome(splitHands[1], dealerCards),
              ]
            : prev.splitOutcomes)
        const outcome =
          hydrated.outcome ??
          (splitOutcomes ? combineSplitOutcomes(splitOutcomes) : prev.outcome)
        return {
          ...prev,
          phase: 'resolved',
          dealerCards,
          serverSeed: hydrated.serverSeed,
          splitHands,
          splitOutcomes,
          outcome,
          availableActions: ['bet'],
        }
      }
      return {
        ...prev,
        phase: 'resolved',
        dealerCards,
        serverSeed: hydrated.serverSeed,
        outcome: hydrated.outcome,
        // Signals a renderer can offer "play again" -- always as a brand-new gameId, never a
        // continuation of this one (see this file's header, "no persistent session concept").
        availableActions: ['bet'],
      }
    }
    default:
      // An action a newer dealer added that this client does not know: ignored, never a crash.
      return prev ?? emptyState(hydrated)
  }
}

/**
 * Undoes the optimistic double lockout when the dealer answered the player's `double` request
 * with an error reply instead of a card. Only acts on the exact optimistic window (doubled, still
 * two cards, no broadcast card, dealer_turn); anything else is returned unchanged, so a stray
 * error can never rewind an authoritative state. Hit/stand are re-offered (not double: a second
 * double needs a fresh transfer). If the dealer did in fact accept and its card broadcast arrives
 * later, the 'double' fold is eligible again from player_turn and re-locks to the real state.
 * Design limit: with no reply at all (old bot) the reducer cannot know, so the UI stays locked.
 */
export function applyDoubleRejection(state: BlackjackGameState): BlackjackGameState {
  if (
    !state.doublePending ||
    state.phase !== 'dealer_turn' ||
    state.playerCards.length !== 2
  ) {
    return state
  }
  return {
    ...state,
    phase: 'player_turn',
    doubled: false,
    doublePending: false,
    verifiedDoubleWagerWei: undefined,
    availableActions: ['hit', 'stand'],
  }
}

/** Undoes the optimistic split lockout when the dealer answered the player's `split` request with
 * an error reply instead of the split hands. */
export function applySplitRejection(state: BlackjackGameState): BlackjackGameState {
  if (!state.splitPending || !state.split) {
    return state
  }
  return {
    ...state,
    phase: 'player_turn',
    split: false,
    splitPending: false,
    verifiedSplitWagerWei: undefined,
    splitHands: undefined,
    activeSplitHand: undefined,
    availableActions: ['hit', 'stand'],
  }
}

function emptyState(hydrated: HydratedBlackjackMove): BlackjackGameState {
  return {
    gameId: hydrated.gameId,
    phase: 'awaiting_deal',
    playerAddress: hydrated.senderAddress,
    playerCards: [],
    dealerCards: [],
    availableActions: [],
  }
}

/** The first four dealt cards, per this file's "Dealing order convention": `deck[0]`/`deck[2]` to
 * the player, `deck[1]`/`deck[3]` to the dealer. Shared by the bot (dealing a fresh hand) and
 * `verifyRevealedHand` (replaying one), so neither can drift from the other on this convention. */
export function dealInitialCards(deck: Card[]): {
  playerCards: Card[]
  dealerCards: Card[]
} {
  return { playerCards: [deck[0], deck[2]], dealerCards: [deck[1], deck[3]] }
}

/** Deals the second card to each split hand from `deck[4]` and `deck[5]`: Hand 1 gets
 * `[deck[0], deck[4]]`, Hand 2 gets `[deck[2], deck[5]]`, advancing `dealtCount` to `6`. */
export function dealSplitCards(deck: Card[]): {
  splitHands: [Card[], Card[]]
  dealtCount: number
} {
  return {
    splitHands: [
      [deck[0], deck[4]],
      [deck[2], deck[5]],
    ],
    dealtCount: 6,
  }
}

/** Plays out the dealer against two split hands: draws to 17 if at least one split hand did not
 * bust, then resolves each split hand at 1:1 (no natural 3:2 bonus) and combines the outcomes. */
export function playOutSplitDealer(
  deck: Card[],
  splitHands: [Card[], Card[]],
  dealtCount: number,
): {
  dealerCards: Card[]
  dealtCount: number
  splitOutcomes: [BlackjackOutcome, BlackjackOutcome]
  outcome: BlackjackOutcome
} {
  const v0 = handValue(splitHands[0])
  const v1 = handValue(splitHands[1])
  let dealerCards = dealInitialCards(deck).dealerCards
  let next = dealtCount
  if (!v0.bust || !v1.bust) {
    while (handValue(dealerCards).total < 17) {
      dealerCards = [...dealerCards, deck[next]]
      next += 1
    }
  }
  const splitOutcomes: [BlackjackOutcome, BlackjackOutcome] = [
    resolveSplitHandOutcome(splitHands[0], dealerCards),
    resolveSplitHandOutcome(splitHands[1], dealerCards),
  ]
  return {
    dealerCards,
    dealtCount: next,
    splitOutcomes,
    outcome: combineSplitOutcomes(splitOutcomes),
  }
}

/** The dealer's side of a hand, the ONE implementation of the dealing rules: shared by the dealer
 * bot (resolving a hand) and `verifyRevealedHand` (replaying it), so they cannot drift apart.
 *
 * `dealtCount` is how many cards of the deck are already out (4 + the player's hits/double card).
 * A busted player or a player natural is final as dealt: the dealer draws nothing. Otherwise the
 * dealer draws to 17 or more (stands on all 17s). The outcome is `dealer_win` on a player bust. */
export function playOutDealer(
  deck: Card[],
  playerCards: Card[],
  dealtCount: number,
): { dealerCards: Card[]; dealtCount: number; outcome: BlackjackOutcome } {
  const playerValue = handValue(playerCards)
  let dealerCards = dealInitialCards(deck).dealerCards
  let next = dealtCount
  if (!playerValue.bust && !playerValue.blackjack) {
    while (handValue(dealerCards).total < 17) {
      dealerCards = [...dealerCards, deck[next]]
      next += 1
    }
  }
  const outcome: BlackjackOutcome = playerValue.bust
    ? 'dealer_win'
    : resolveOutcome(playerValue, handValue(dealerCards))
  return { dealerCards, dealtCount: next, outcome }
}

/** Independently replays a resolved hand's committed shuffle against its own recorded
 * player/dealer cards, per this file's "Dealing order convention" -- the actual fairness check a
 * player's own client should run before trusting a `reveal`. Never trusts `state.outcome` either;
 * recomputes it from the recovered hands and compares. */
export function verifyRevealedHand(
  state: BlackjackGameState,
): { valid: boolean; reason?: string } {
  if (!state.serverSeed || !state.serverSeedHash || !state.wagerTxHash) {
    return { valid: false, reason: 'missing seed/commitment/wager data' }
  }
  if (sha256Hex(state.serverSeed) !== state.serverSeedHash) {
    return { valid: false, reason: 'serverSeed does not match the committed hash' }
  }
  const deck = deriveDeck(state.serverSeed, state.wagerTxHash, 0)
  const initial = dealInitialCards(deck)
  if (state.split) {
    if (!isSplittablePair(initial.playerCards)) {
      return {
        valid: false,
        reason: 'initial cards are not a splittable pair',
      }
    }
    if (
      !state.splitHands ||
      state.splitHands.length !== 2 ||
      state.splitHands[0].length < 2 ||
      state.splitHands[1].length < 2
    ) {
      return { valid: false, reason: 'missing or invalid split hands' }
    }
    const { splitHands: initialSplitHands, dealtCount: startNext } =
      dealSplitCards(deck)
    const expectedHand0 = [...initialSplitHands[0]]
    const expectedHand1 = [...initialSplitHands[1]]
    let next = startNext
    const hits0 = Math.max(0, state.splitHands[0].length - 2)
    for (let i = 0; i < hits0; i++) {
      expectedHand0.push(deck[next])
      next += 1
    }
    const hits1 = Math.max(0, state.splitHands[1].length - 2)
    for (let i = 0; i < hits1; i++) {
      expectedHand1.push(deck[next])
      next += 1
    }
    if (
      JSON.stringify([expectedHand0, expectedHand1]) !==
      JSON.stringify(state.splitHands)
    ) {
      return {
        valid: false,
        reason: 'recorded split hands do not match the committed shuffle',
      }
    }
    const {
      dealerCards: expectedDealerCards,
      splitOutcomes: expectedSplitOutcomes,
      outcome: expectedOutcome,
    } = playOutSplitDealer(deck, [expectedHand0, expectedHand1], next)
    if (JSON.stringify(expectedDealerCards) !== JSON.stringify(state.dealerCards)) {
      return {
        valid: false,
        reason: 'recorded dealer cards do not match the committed shuffle',
      }
    }
    if (
      state.splitOutcomes !== undefined &&
      JSON.stringify(expectedSplitOutcomes) !==
        JSON.stringify(state.splitOutcomes)
    ) {
      return {
        valid: false,
        reason: 'recorded split outcomes do not match the committed shuffle',
      }
    }
    if (expectedOutcome !== state.outcome) {
      return {
        valid: false,
        reason: 'recorded outcome does not match the committed shuffle',
      }
    }
    return { valid: true }
  }
  const expectedPlayerCards = [...initial.playerCards]
  let next = 4
  const numHits = Math.max(0, state.playerCards.length - 2)
  for (let i = 0; i < numHits; i++) {
    expectedPlayerCards.push(deck[next])
    next += 1
  }
  const { dealerCards: expectedDealerCards, outcome: expectedOutcome } =
    playOutDealer(deck, expectedPlayerCards, next)
  if (JSON.stringify(expectedPlayerCards) !== JSON.stringify(state.playerCards)) {
    return { valid: false, reason: 'recorded player cards do not match the committed shuffle' }
  }
  if (JSON.stringify(expectedDealerCards) !== JSON.stringify(state.dealerCards)) {
    return { valid: false, reason: 'recorded dealer cards do not match the committed shuffle' }
  }
  if (expectedOutcome !== state.outcome) {
    return { valid: false, reason: 'recorded outcome does not match the committed shuffle' }
  }
  return { valid: true }
}

export { resolveOutcome }

// ---------------------------------------------------------------------------
// Peer-to-peer hand state machine with split support (#152)
// ---------------------------------------------------------------------------

export {
  awaitedRole,
  buildAccept,
  buildBet,
  buildChallenge,
  challengeLimitWei,
  checkWager,
  commitmentOf,
  DEALER_COVER_MULTIPLE,
  handEventsOf,
  isGameId,
  maxDealerBetWei,
  maxPlayerBetWei,
  refundBetStep,
  refundShortfallWei,
  roleOf,
  seedFromBytes,
  soleHandItem,
  type HandMessage,
  type HandMoneyError,
  type HandPhase,
  type HandRejection,
  type HandRole,
}

export type HandItem =
  | BlackjackHandV3Item
  | {
      type: 'blackjack-hand'
      gameId: string
      seq: number
      action: 'split'
      link: string
      prev: string
    }
export type HandAction = HandItem['action']

export interface HandEvent {
  item: HandItem
  from: string
  to: string
  stampWei: bigint
  digest: string
}

export interface HandState {
  gameId: string
  phase: HandPhase
  dealer: string
  player: string
  challenger: HandRole
  maxBetWei: bigint
  commitment?: string
  playerCommitment?: string
  dealerLink?: OpenedLink
  playerLink?: OpenedLink
  head: string
  count: number
  betDigest?: string
  wagerWei: bigint
  doubled: boolean
  split?: boolean
  splitHands?: [Card[], Card[]]
  activeSplitHand?: 0 | 1
  splitOutcomes?: [BlackjackOutcome, BlackjackOutcome]
  pending?: 'hit' | 'double' | 'split'
  draws: Card[]
  playerCards: Card[]
  dealerUpCard?: Card
  dealerCards: Card[]
  outcome?: BlackjackOutcome
  owedWei?: bigint
  paidWei?: bigint
  refundedWei?: bigint
  rejected: { digest: string; stampWei: bigint; refundedWei?: bigint }[]
  seen: string[]
}

export interface HandResult {
  state: HandState | undefined
  error?: HandRejection
}

export interface DealerStep {
  item: HandItem
  payWei?: bigint
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const HEX64 = /^[0-9a-f]{64}$/
const WEI_RE = /^[0-9]{1,40}$/
const parseWeiStr = (value: unknown): bigint | undefined =>
  typeof value === 'string' && WEI_RE.test(value) ? BigInt(value) : undefined

/** The stake that is at risk in the hand: the wager, twice that after a double or a split. */
export function totalStakeWei(
  state: Pick<HandState, 'wagerWei' | 'doubled' | 'split'>,
): bigint {
  return state.doubled || state.split ? state.wagerWei * 2n : state.wagerWei
}

/** What the dealer sends back: stake plus winnings. A natural pays 3:2, a win 1:1, a push
 * returns the stake, a loss nothing. On a split hand, each split hand is resolved independently
 * at 1:1 (no 3:2 natural bonus). */
export function payoutWei(
  outcome: BlackjackOutcome,
  wagerWei: bigint,
  doubled: boolean,
  split = false,
  splitOutcomes?: [BlackjackOutcome, BlackjackOutcome],
): bigint {
  if (split && splitOutcomes) {
    const p0 = splitSingleHandPayoutWei(splitOutcomes[0], wagerWei) ?? 0n
    const p1 = splitSingleHandPayoutWei(splitOutcomes[1], wagerWei) ?? 0n
    return p0 + p1
  }
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

function settleHand(
  state: HandState,
  dealerLast: OpenedLink,
):
  | {
      dealerCards: Card[]
      outcome: BlackjackOutcome
      splitOutcomes?: [BlackjackOutcome, BlackjackOutcome]
    }
  | undefined {
  const [first, up, second, ...hits] = state.draws
  if (up === undefined || second === undefined) return undefined
  if (state.split && state.splitHands) {
    const [hand0, hand1] = state.splitHands
    if (handValue(hand0).bust && handValue(hand1).bust) {
      return {
        dealerCards: [up],
        outcome: 'dealer_win',
        splitOutcomes: ['dealer_win', 'dealer_win'],
      }
    }
    const player = state.playerLink
    if (!player) return undefined
    if (dealerLast.index !== CHAIN_LENGTH) return undefined
    const dealerLinks = linksUpTo(dealerLast)
    const playerLinks =
      player.index === CHAIN_LENGTH ? linksUpTo(player) : undefined
    const drawn = [...state.draws]
    const rest: Card[] = []
    for (let k = drawn.length; k < CHAIN_LENGTH; k++) {
      const pLink = playerLinks
        ? playerLinks[k + 1]
        : sha256Hex(`${player.link}:${k + 1}`)
      const card = drawCard(
        state.gameId,
        k,
        dealerLinks[k + 1],
        pLink,
        drawn,
      )
      drawn.push(card)
      rest.push(card)
    }
    const [hole, ...more] = rest
    if (hole === undefined) return undefined
    let dealerCards: Card[] = [up, hole]
    let nextIdx = 0
    while (handValue(dealerCards).total < 17) {
      if (nextIdx >= more.length) return undefined
      dealerCards = [...dealerCards, more[nextIdx]]
      nextIdx += 1
    }
    const splitOutcomes: [BlackjackOutcome, BlackjackOutcome] = [
      resolveSplitHandOutcome(hand0, dealerCards),
      resolveSplitHandOutcome(hand1, dealerCards),
    ]
    return {
      dealerCards,
      outcome: combineSplitOutcomes(splitOutcomes),
      splitOutcomes,
    }
  }
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
  const [hole, ...more] = rest
  const deck = [first, up, second, hole, ...hits, ...more]
  const played = playOutDealer(deck, state.playerCards, 4 + hits.length)
  if (played.dealerCards.some(card => card === undefined)) return undefined
  return { dealerCards: played.dealerCards, outcome: played.outcome }
}

function rejectHand(
  state: HandState | undefined,
  error: HandRejection,
): HandResult {
  return { state, error }
}

export function applyHandEvent(
  prev: HandState | undefined,
  event: HandEvent,
): HandResult {
  const { item, from, to, stampWei, digest } = event
  if (prev && prev.gameId !== item.gameId) return rejectHand(prev, 'no-hand')
  if (prev?.seen.includes(digest)) return rejectHand(prev, 'duplicate')

  if (item.action === 'challenge') {
    if (prev) return rejectHand(prev, 'hand-exists')
    const maxBetWei = parseWeiStr(item.maxBetWei)
    if (sameAddr(from, to)) return rejectHand(prev, 'wrong-sender')
    if (item.seq !== 0) return rejectHand(prev, 'out-of-order')
    if (maxBetWei === undefined || maxBetWei <= 0n)
      return rejectHand(prev, 'bad-amount')
    if (item.role === 'dealer' && !HEX64.test(item.commitment))
      return rejectHand(prev, 'bad-commitment')
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
  if (!prev) return rejectHand(prev, 'no-hand')

  const fromDealer = sameAddr(from, prev.dealer) && sameAddr(to, prev.player)
  const fromPlayer = sameAddr(from, prev.player) && sameAddr(to, prev.dealer)
  if (!fromDealer && !fromPlayer) return rejectHand(prev, 'wrong-sender')
  const next = (changes: Partial<HandState>): HandResult => ({
    state: {
      ...prev,
      ...changes,
      head: digest,
      count: prev.count + 1,
      seen: [...prev.seen, digest],
    },
  })
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
      : rejectHand(prev, error)

  if (item.action === 'refund') {
    if (!fromDealer) return rejectHand(prev, 'wrong-sender')
    if (prev.phase === 'awaiting_deal' && item.ref === prev.betDigest)
      return next({ phase: 'refunded', refundedWei: stampWei })
    const index = prev.rejected.findIndex(
      r => r.digest === item.ref && r.refundedWei === undefined,
    )
    if (index < 0) return rejectHand(prev, 'bad-ref')
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
    fromPlayer &&
    (item.action === 'bet' ||
      item.action === 'double' ||
      item.action === 'split')
  if (item.seq !== prev.count || item.prev !== prev.head)
    return moneyFromPlayer
      ? owedBack('out-of-order')
      : rejectHand(prev, 'out-of-order')

  switch (item.action) {
    case 'accept': {
      if (!fromDealer) return rejectHand(prev, 'wrong-sender')
      if (prev.phase !== 'challenged') return rejectHand(prev, 'wrong-phase')
      const maxBetWei = parseWeiStr(item.maxBetWei)
      if (
        maxBetWei === undefined ||
        maxBetWei <= 0n ||
        maxBetWei > prev.maxBetWei
      )
        return rejectHand(prev, 'bad-amount')
      if (!HEX64.test(item.commitment)) return rejectHand(prev, 'bad-commitment')
      return next({
        phase: 'open',
        maxBetWei,
        commitment: item.commitment,
        dealerLink: { index: 0, link: item.commitment },
      })
    }
    case 'bet': {
      if (!fromPlayer) return rejectHand(prev, 'wrong-sender')
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
      if (!fromDealer) return rejectHand(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_deal') return rejectHand(prev, 'wrong-phase')
      if (!prev.dealerLink || !verifyLink(item.link, 3, prev.dealerLink))
        return rejectHand(prev, 'bad-link')
      return next({
        phase: 'player_turn',
        dealerLink: { index: 3, link: item.link },
      })
    }
    case 'hit':
    case 'stand':
    case 'double':
    case 'split': {
      if (!fromPlayer) return rejectHand(prev, 'wrong-sender')
      const refuse = (error: HandRejection) =>
        item.action === 'double' || item.action === 'split'
          ? owedBack(error)
          : rejectHand(prev, error)
      if (prev.phase !== 'player_turn') return refuse('wrong-phase')
      if (!prev.playerLink || !prev.dealerLink) return refuse('wrong-phase')

      if (prev.split && prev.splitHands) {
        if (item.action === 'double' || item.action === 'split')
          return refuse('wrong-phase')
        const active = prev.activeSplitHand ?? 0
        if (item.action === 'hit') {
          if (handValue(prev.splitHands[active]).total >= 21)
            return refuse('wrong-phase')
          const index = prev.draws.length + 1
          if (!verifyLink(item.link, index, prev.playerLink))
            return refuse('bad-link')
          return next({
            playerLink: { index, link: item.link },
            phase: 'awaiting_card',
            pending: 'hit',
          })
        }
        // action === 'stand' during a split hand
        if (active === 0) {
          const sameLink = item.link === prev.playerLink.link
          const finalLink = verifyLink(item.link, CHAIN_LENGTH, prev.playerLink)
          if (!sameLink && !finalLink) return refuse('bad-link')
          return next({
            playerLink: finalLink
              ? { index: CHAIN_LENGTH, link: item.link }
              : prev.playerLink,
            activeSplitHand: 1,
            playerCards: prev.splitHands[1],
            phase: 'player_turn',
          })
        }
        const validEndLink =
          (prev.playerLink.index === CHAIN_LENGTH &&
            item.link === prev.playerLink.link) ||
          verifyLink(item.link, CHAIN_LENGTH, prev.playerLink)
        if (!validEndLink) return refuse('bad-link')
        return next({
          playerLink: { index: CHAIN_LENGTH, link: item.link },
          phase: 'dealer_turn',
        })
      }

      const cardsOut = Math.max(prev.draws.length, 3)
      const index =
        item.action === 'hit'
          ? cardsOut + 1
          : item.action === 'split'
          ? cardsOut + 2
          : CHAIN_LENGTH
      if (!verifyLink(item.link, index, prev.playerLink))
        return refuse('bad-link')
      const playerLink = { index, link: item.link }
      const draws = prev.draws.length
        ? prev.draws
        : initialDraws(prev.gameId, prev.dealerLink, playerLink)
      if (!draws) return refuse('bad-link')
      const playerCards = prev.draws.length
        ? prev.playerCards
        : [draws[0], draws[2]]
      if (item.action !== 'stand' && handValue(playerCards).blackjack)
        return refuse('wrong-phase')
      if (item.action === 'double') {
        if (playerCards.length !== 2) return owedBack('wrong-phase')
        if (stampWei !== prev.wagerWei) return owedBack('bad-amount')
      }
      if (item.action === 'split') {
        if (prev.draws.length !== 0 || !isSplittablePair(playerCards))
          return owedBack('wrong-phase')
        if (stampWei !== prev.wagerWei) return owedBack('bad-amount')
        return next({
          playerLink,
          draws,
          playerCards,
          dealerUpCard: draws[1],
          phase: 'awaiting_card',
          pending: 'split',
          split: true,
          splitHands: [[playerCards[0]], [playerCards[1]]],
          activeSplitHand: 0,
        })
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
      if (!fromDealer) return rejectHand(prev, 'wrong-sender')
      if (prev.phase !== 'awaiting_card') return rejectHand(prev, 'wrong-phase')
      const k = prev.draws.length
      if (prev.pending === 'split') {
        if (
          !prev.dealerLink ||
          !prev.playerLink ||
          !verifyLink(item.link, k + 2, prev.dealerLink)
        )
          return rejectHand(prev, 'bad-link')
        const dealerOpened = { index: k + 2, link: item.link }
        const d1 = linkAt(dealerOpened, k + 1)
        const d2 = linkAt(dealerOpened, k + 2)
        const p1 = linkAt(prev.playerLink, k + 1)
        const p2 = linkAt(prev.playerLink, k + 2)
        if (
          d1 === undefined ||
          d2 === undefined ||
          p1 === undefined ||
          p2 === undefined
        )
          return rejectHand(prev, 'bad-link')
        const card0 = drawCard(prev.gameId, k, d1, p1, prev.draws)
        const draws1 = [...prev.draws, card0]
        const card1 = drawCard(prev.gameId, k + 1, d2, p2, draws1)
        const draws2 = [...draws1, card1]
        const hand0 = [prev.playerCards[0], card0]
        const hand1 = [prev.playerCards[1], card1]
        return next({
          phase: 'player_turn',
          pending: undefined,
          dealerLink: dealerOpened,
          draws: draws2,
          splitHands: [hand0, hand1],
          activeSplitHand: 0,
          playerCards: hand0,
        })
      }
      const playerLink = prev.playerLink && linkAt(prev.playerLink, k + 1)
      if (
        !prev.dealerLink ||
        playerLink === undefined ||
        !verifyLink(item.link, k + 1, prev.dealerLink)
      )
        return rejectHand(prev, 'bad-link')
      const card = drawCard(prev.gameId, k, item.link, playerLink, prev.draws)
      if (prev.split && prev.splitHands) {
        const active = prev.activeSplitHand ?? 0
        if (active === 0) {
          const hand0 = [...prev.splitHands[0], card]
          const hand1 = prev.splitHands[1]
          const done0 = handValue(hand0).total >= 21
          return next({
            phase: 'player_turn',
            pending: undefined,
            dealerLink: { index: k + 1, link: item.link },
            draws: [...prev.draws, card],
            splitHands: [hand0, hand1],
            activeSplitHand: done0 ? 1 : 0,
            playerCards: done0 ? hand1 : hand0,
          })
        }
        const hand0 = prev.splitHands[0]
        const hand1 = [...prev.splitHands[1], card]
        const done1 = handValue(hand1).total >= 21
        return next({
          phase: done1 ? 'dealer_turn' : 'player_turn',
          pending: undefined,
          dealerLink: { index: k + 1, link: item.link },
          draws: [...prev.draws, card],
          splitHands: [hand0, hand1],
          activeSplitHand: 1,
          playerCards: hand1,
        })
      }
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
      if (!fromDealer) return rejectHand(prev, 'wrong-sender')
      if (prev.phase !== 'dealer_turn') return rejectHand(prev, 'wrong-phase')
      if (!prev.dealerLink || !verifyLink(item.link, CHAIN_LENGTH, prev.dealerLink))
        return rejectHand(prev, 'bad-link')
      const dealerLink = { index: CHAIN_LENGTH, link: item.link }
      const end = settleHand(prev, dealerLink)
      if (!end) return rejectHand(prev, 'bad-reveal')
      return next({
        phase: 'resolved',
        dealerLink,
        dealerCards: end.dealerCards,
        outcome: end.outcome,
        ...(end.splitOutcomes ? { splitOutcomes: end.splitOutcomes } : {}),
        owedWei: payoutWei(
          end.outcome,
          prev.wagerWei,
          prev.doubled,
          prev.split,
          end.splitOutcomes,
        ),
        paidWei: stampWei,
      })
    }
  }
}

function fitsNextHand(state: HandState | undefined, event: HandEvent): boolean {
  const { item } = event
  if (!state) return item.action === 'challenge'
  if (item.action === 'challenge') return false
  if (item.action === 'refund')
    return (
      (state.phase === 'awaiting_deal' && item.ref === state.betDigest) ||
      state.rejected.some(
        r => r.digest === item.ref && r.refundedWei === undefined,
      )
    )
  return item.seq === state.count && item.prev === state.head
}

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
      rejected.push({
        digest: event.digest,
        error: result.error,
        from: event.from,
      })
  }
  while (pending.length) {
    const fits = pending.flatMap((event, i) =>
      fitsNextHand(state, event) ? [i] : [],
    )
    if (fits.length) {
      const builtOn = fits.find(i =>
        pending.some(
          other =>
            other.item.action !== 'challenge' &&
            other.item.prev === pending[i].digest &&
            !sameAddr(other.from, pending[i].from),
        ),
      )
      apply(builtOn ?? fits[0])
      continue
    }
    const other = pending.findIndex(event => event.item.action !== 'refund')
    apply(other < 0 ? 0 : other)
  }
  return { state, rejected }
}

export function handView(
  state: HandState | undefined,
  seed?: string,
): {
  playerCards: Card[]
  dealerUpCard?: Card
  dealerCards: Card[]
  splitHands?: [Card[], Card[]]
  activeSplitHand?: 0 | 1
} {
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
    ...(state.splitHands ? { splitHands: state.splitHands } : {}),
    ...(state.activeSplitHand !== undefined
      ? { activeSplitHand: state.activeSplitHand }
      : {}),
  }
}

export function playerMoves(
  state: HandState | undefined,
  seed?: string,
): ('bet' | 'hit' | 'stand' | 'double' | 'split')[] {
  if (state?.phase === 'open') return ['bet']
  if (state?.phase !== 'player_turn') return []
  if (!seed || commitmentOf(seed) !== state.playerCommitment) return []
  if (state.split && state.splitHands) {
    const activeCards = state.splitHands[state.activeSplitHand ?? 0]
    if (activeCards.length < 2) return []
    if (handValue(activeCards).total >= 21) return ['stand']
    return ['hit', 'stand']
  }
  const cards = handView(state, seed).playerCards
  if (cards.length < 2) return []
  if (handValue(cards).blackjack) return ['stand']
  if (cards.length === 2) {
    return isSplittablePair(cards)
      ? ['hit', 'stand', 'double', 'split']
      : ['hit', 'stand', 'double']
  }
  return ['hit', 'stand']
}

function chainedHand(state: HandState) {
  return {
    type: 'blackjack-hand' as const,
    gameId: state.gameId,
    seq: state.count,
    prev: state.head,
  }
}

export function playerStep(
  state: HandState | undefined,
  move: 'hit' | 'stand' | 'double' | 'split',
  seed: string,
): HandItem | undefined {
  if (!state || !playerMoves(state, seed).includes(move)) return undefined
  let index: number
  if (move === 'hit') {
    index = Math.max(state.draws.length, 3) + 1
  } else if (move === 'split') {
    index = Math.max(state.draws.length, 3) + 2
  } else if (
    move === 'stand' &&
    state.split &&
    (state.activeSplitHand ?? 0) === 0
  ) {
    index = state.playerLink?.index ?? Math.max(state.draws.length, 5)
  } else {
    index = CHAIN_LENGTH
  }
  return {
    ...chainedHand(state),
    action: move,
    link: entropyChain(seed)[index],
  }
}

export function dealerStep(
  state: HandState | undefined,
  seed: string,
): DealerStep | undefined {
  if (!state) return undefined
  const base = chainedHand(state)
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
    case 'awaiting_card': {
      const targetIndex =
        state.pending === 'split'
          ? state.draws.length + 2
          : state.draws.length + 1
      return {
        item: { ...base, action: 'card', link: chain[targetIndex] },
      }
    }
    case 'dealer_turn': {
      const link = chain[CHAIN_LENGTH]
      const end = settleHand(state, { index: CHAIN_LENGTH, link })
      if (!end) return undefined
      const owedWei = payoutWei(
        end.outcome,
        state.wagerWei,
        state.doubled,
        state.split,
        end.splitOutcomes,
      )
      return {
        item: { ...base, action: 'reveal', link },
        ...(owedWei > 0n ? { payWei: owedWei } : {}),
      }
    }
    default:
      return undefined
  }
}

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
    case 'split':
      return 'Split'
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

