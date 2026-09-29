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
import { Card, deriveDeck, handValue, sha256Hex } from './deck'

/** Table limits. The client cannot query the dealer, and the bot advertises none in any message,
 * so these documented constants are the shared default (the bot's `BLACKJACK_BOT_MIN_WAGER_WEI` /
 * `BLACKJACK_BOT_MAX_WAGER_WEI` default to them). A dealer configured differently may still
 * reject a bet the UI allows; the bot then refunds the verified stake. */
export const BLACKJACK_DEFAULT_MIN_WAGER_WEI = 10n ** 16n // 0.01 MON
export const BLACKJACK_DEFAULT_MAX_WAGER_WEI = 10n ** 18n // 1 MON

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

export type BlackjackAction =
  | 'bet'
  | 'deal'
  | 'hit'
  | 'stand'
  | 'double'
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

export interface HydratedBlackjackMove {
  gameId: string
  action: BlackjackAction
  wagerTxHash?: string
  /** Only present for `double`: the hash `verifiedDoubleWager` was looked up by. The bot claims it
   * in the same global keyspace as wager hashes so one transfer can back exactly one stake. */
  doubleWagerTxHash?: string
  serverSeedHash?: string
  playerCards?: Card[]
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

export function reduceBlackjackState(
  prev: BlackjackGameState | undefined,
  hydrated: HydratedBlackjackMove,
): BlackjackGameState {
  switch (hydrated.action) {
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
      return {
        ...prev,
        serverSeedHash: hydrated.serverSeedHash,
        playerCards,
        dealerUpCard: hydrated.dealerUpCard,
        phase: value.blackjack ? 'dealer_turn' : 'player_turn',
        // 'double' only ever offered here, on the freshly-dealt two-card hand -- never after a
        // 'hit' (see that case below, which never re-adds it to its own availableActions), and
        // never on a natural (already resolved, no actions at all).
        availableActions: value.blackjack ? [] : ['hit', 'stand', 'double'],
      }
    }
    case 'hit': {
      if (!prev || prev.phase !== 'player_turn') return prev ?? emptyState(hydrated)
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
      if (!prev || prev.phase !== 'player_turn') return prev ?? emptyState(hydrated)
      return { ...prev, phase: 'dealer_turn', availableActions: [] }
    }
    case 'reveal': {
      if (!prev) return emptyState(hydrated)
      return {
        ...prev,
        phase: 'resolved',
        dealerCards: hydrated.dealerCards ?? [],
        serverSeed: hydrated.serverSeed,
        outcome: hydrated.outcome,
        // Signals a renderer can offer "play again" -- always as a brand-new gameId, never a
        // continuation of this one (see this file's header, "no persistent session concept").
        availableActions: ['bet'],
      }
    }
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
  const expectedPlayerCards = [...initial.playerCards]
  const expectedDealerCards = [...initial.dealerCards]
  let next = 4
  const numHits = Math.max(0, state.playerCards.length - 2)
  for (let i = 0; i < numHits; i++) {
    expectedPlayerCards.push(deck[next])
    next += 1
  }
  const playerBust = handValue(expectedPlayerCards).bust
  if (!playerBust) {
    while (handValue(expectedDealerCards).total < 17) {
      expectedDealerCards.push(deck[next])
      next += 1
    }
  }
  if (JSON.stringify(expectedPlayerCards) !== JSON.stringify(state.playerCards)) {
    return { valid: false, reason: 'recorded player cards do not match the committed shuffle' }
  }
  if (
    !playerBust &&
    JSON.stringify(expectedDealerCards) !== JSON.stringify(state.dealerCards)
  ) {
    return { valid: false, reason: 'recorded dealer cards do not match the committed shuffle' }
  }
  const expectedOutcome = playerBust
    ? 'dealer_win'
    : resolveOutcome(handValue(expectedPlayerCards), handValue(expectedDealerCards))
  if (expectedOutcome !== state.outcome) {
    return { valid: false, reason: 'recorded outcome does not match the committed shuffle' }
  }
  return { valid: true }
}

export { resolveOutcome }
