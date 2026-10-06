/**
 * Texas Hold'em Poker Table State Machine (GAME-2).
 *
 * Implements 2 to 6 player No-Limit Texas Hold'em:
 * blinds, dealer rotation, betting rounds (Preflop, Flop, Turn, River),
 * all-in side pots, showdown evaluation, and pot distribution.
 */
import { derivePokerDeck, formatCard } from './deck'
import { evaluate7CardHand, type HandEvaluation } from './evaluator'
import { randomBytes } from 'crypto'

export type PokerStreet =
  | 'waiting'
  | 'preflop'
  | 'flop'
  | 'turn'
  | 'river'
  | 'showdown'
  | 'settled'

export type PokerAction = 'check' | 'call' | 'bet' | 'raise' | 'fold' | 'all_in'

export interface PokerPlayer {
  address: string
  chips: number
  holeCards: [number, number]
  currentStreetBet: number
  totalHandBet: number
  folded: boolean
  isAllIn: boolean
  hasActedThisStreet: boolean
}

export interface PotWinner {
  address: string
  amount: number
  evaluation?: HandEvaluation
}

export interface PokerGameState {
  tableId: string
  buyInChips: number
  smallBlind: number
  bigBlind: number
  maxPlayers: number
  players: PokerPlayer[]
  dealerIndex: number
  street: PokerStreet
  boardCards: number[]
  pot: number
  currentBet: number
  minRaise: number
  activePlayerIndex: number
  deck: number[]
  handNumber: number
  winners?: PotWinner[]
  lastAction?: {
    player: string
    action: PokerAction
    amount: number
  }
}

export function createPokerTable(params: {
  tableId: string
  buyInChips?: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers?: number
}): PokerGameState {
  const sb = params.smallBlind ?? 10
  const bb = params.bigBlind ?? sb * 2
  return {
    tableId: params.tableId,
    buyInChips: params.buyInChips ?? 1000,
    smallBlind: sb,
    bigBlind: bb,
    maxPlayers: params.maxPlayers ?? 6,
    players: [],
    dealerIndex: -1,
    street: 'waiting',
    boardCards: [],
    pot: 0,
    currentBet: 0,
    minRaise: bb,
    activePlayerIndex: 0,
    deck: [],
    handNumber: 0,
  }
}

export function joinPokerTable(
  state: PokerGameState,
  address: string,
  chips?: number,
): { success: boolean; error?: string } {
  if (state.street !== 'waiting' && state.street !== 'settled') {
    return { success: false, error: 'Cannot join while hand is in progress' }
  }
  if (state.players.length >= state.maxPlayers) {
    return { success: false, error: 'Table is full' }
  }
  if (state.players.some(p => p.address.toLowerCase() === address.toLowerCase())) {
    return { success: false, error: 'Player already at table' }
  }

  state.players.push({
    address,
    chips: chips ?? state.buyInChips,
    holeCards: [-1, -1],
    currentStreetBet: 0,
    totalHandBet: 0,
    folded: false,
    isAllIn: false,
    hasActedThisStreet: false,
  })

  return { success: true }
}

function nextActiveIndex(state: PokerGameState, fromIndex: number): number {
  const n = state.players.length
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n
    const p = state.players[idx]
    if (!p.folded && !p.isAllIn && p.chips > 0) {
      return idx
    }
  }
  return fromIndex
}

export function startNewHand(
  state: PokerGameState,
  serverSeed?: string,
  clientSeed?: string,
): { success: boolean; error?: string } {
  const eligible = state.players.filter(p => p.chips > 0)
  if (eligible.length < 2) {
    return { success: false, error: 'Need at least 2 players with chips to start a hand' }
  }

  state.handNumber += 1
  state.street = 'preflop'
  state.boardCards = []
  state.pot = 0
  state.winners = undefined
  state.lastAction = undefined

  // Shuffle deck
  const sSeed = serverSeed ?? randomBytes(32).toString('hex')
  const cSeed = clientSeed ?? randomBytes(32).toString('hex')
  state.deck = derivePokerDeck(sSeed, cSeed)
  let deckIdx = 0

  // Move dealer button clockwise
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length
  while (state.players[state.dealerIndex].chips <= 0) {
    state.dealerIndex = (state.dealerIndex + 1) % state.players.length
  }

  // Reset players for new hand & deal 2 hole cards
  for (const p of state.players) {
    p.folded = p.chips <= 0
    p.isAllIn = false
    p.currentStreetBet = 0
    p.totalHandBet = 0
    p.hasActedThisStreet = false
    if (!p.folded) {
      p.holeCards = [state.deck[deckIdx++], state.deck[deckIdx++]]
    } else {
      p.holeCards = [-1, -1]
    }
  }

  // Determine SB and BB positions
  const n = state.players.length
  let sbIdx: number
  let bbIdx: number

  if (eligible.length === 2) {
    // Heads-up: dealer is SB and acts first pre-flop, BB acts second
    sbIdx = state.dealerIndex
    bbIdx = nextActiveIndex(state, sbIdx)
  } else {
    sbIdx = nextActiveIndex(state, state.dealerIndex)
    bbIdx = nextActiveIndex(state, sbIdx)
  }

  // Post Small Blind
  const sbPlayer = state.players[sbIdx]
  const sbAmount = Math.min(sbPlayer.chips, state.smallBlind)
  sbPlayer.chips -= sbAmount
  sbPlayer.currentStreetBet = sbAmount
  sbPlayer.totalHandBet = sbAmount
  if (sbPlayer.chips === 0) sbPlayer.isAllIn = true

  // Post Big Blind
  const bbPlayer = state.players[bbIdx]
  const bbAmount = Math.min(bbPlayer.chips, state.bigBlind)
  bbPlayer.chips -= bbAmount
  bbPlayer.currentStreetBet = bbAmount
  bbPlayer.totalHandBet = bbAmount
  if (bbPlayer.chips === 0) bbPlayer.isAllIn = true

  state.currentBet = Math.max(sbAmount, bbAmount)
  state.minRaise = state.bigBlind

  // First player to act preflop: after BB
  state.activePlayerIndex = nextActiveIndex(state, bbIdx)

  return { success: true }
}

export function isBettingRoundComplete(state: PokerGameState): boolean {
  const activeUnfolded = state.players.filter(p => !p.folded)
  if (activeUnfolded.length <= 1) return true

  const playersWhoCanAct = activeUnfolded.filter(p => !p.isAllIn && p.chips > 0)
  if (playersWhoCanAct.length === 0) return true

  // All players who can act must have acted and matched the current bet
  return playersWhoCanAct.every(
    p => p.hasActedThisStreet && p.currentStreetBet === state.currentBet,
  )
}

function advanceStreet(state: PokerGameState) {
  // Collect street bets into pot
  for (const p of state.players) {
    state.pot += p.currentStreetBet
    p.currentStreetBet = 0
    p.hasActedThisStreet = false
  }

  state.currentBet = 0
  state.minRaise = state.bigBlind

  // Check if hand ends early (everyone folded except one)
  const remaining = state.players.filter(p => !p.folded)
  if (remaining.length === 1) {
    settleHand(state)
    return
  }

  // Next street
  let nextCardCount = 0
  if (state.street === 'preflop') {
    state.street = 'flop'
    nextCardCount = 3
  } else if (state.street === 'flop') {
    state.street = 'turn'
    nextCardCount = 1
  } else if (state.street === 'turn') {
    state.street = 'river'
    nextCardCount = 1
  } else if (state.street === 'river') {
    state.street = 'showdown'
    settleHand(state)
    return
  }

  // Deal community cards
  // Preflop dealt 2 * active cards. Burn 1 card before flop/turn/river
  const dealtSoFar = state.players.filter(p => p.holeCards[0] !== -1).length * 2
  const burnedCards = state.street === 'flop' ? 1 : state.street === 'turn' ? 2 : 3
  const boardStart = dealtSoFar + burnedCards + state.boardCards.length
  for (let i = 0; i < nextCardCount; i++) {
    state.boardCards.push(state.deck[boardStart + i])
  }

  // Action begins with first active player after dealer button
  state.activePlayerIndex = nextActiveIndex(state, state.dealerIndex)

  // If remaining players are all-in, automatically advance to next street
  const canAct = state.players.filter(p => !p.folded && !p.isAllIn && p.chips > 0)
  if (canAct.length <= 1) {
    if (state.street !== 'showdown' && state.street !== 'settled') {
      advanceStreet(state)
    }
  }
}

export function applyPlayerAction(
  state: PokerGameState,
  playerAddress: string,
  action: PokerAction,
  amount?: number,
): { success: boolean; error?: string } {
  if (state.street === 'waiting' || state.street === 'showdown' || state.street === 'settled') {
    return { success: false, error: 'No active betting round' }
  }

  const activePlayer = state.players[state.activePlayerIndex]
  if (!activePlayer || activePlayer.address.toLowerCase() !== playerAddress.toLowerCase()) {
    return { success: false, error: `It is not ${playerAddress}'s turn to act` }
  }

  let actionAmount = 0

  switch (action) {
    case 'fold': {
      activePlayer.folded = true
      activePlayer.hasActedThisStreet = true
      break
    }

    case 'check': {
      if (activePlayer.currentStreetBet < state.currentBet) {
        return { success: false, error: 'Cannot check when facing a bet; must call or raise' }
      }
      activePlayer.hasActedThisStreet = true
      break
    }

    case 'call': {
      const callNeeded = state.currentBet - activePlayer.currentStreetBet
      if (callNeeded <= 0) {
        // Equivalent to check
        activePlayer.hasActedThisStreet = true
        break
      }
      actionAmount = Math.min(activePlayer.chips, callNeeded)
      activePlayer.chips -= actionAmount
      activePlayer.currentStreetBet += actionAmount
      activePlayer.totalHandBet += actionAmount
      if (activePlayer.chips === 0) activePlayer.isAllIn = true
      activePlayer.hasActedThisStreet = true
      break
    }

    case 'bet': {
      if (state.currentBet > 0) {
        return { success: false, error: 'A bet has already been made; use raise' }
      }
      const betAmt = amount ?? state.bigBlind
      if (betAmt < state.bigBlind) {
        return { success: false, error: `Minimum bet is big blind (${state.bigBlind})` }
      }
      if (betAmt > activePlayer.chips) {
        return { success: false, error: 'Cannot bet more chips than you have' }
      }
      actionAmount = betAmt
      activePlayer.chips -= actionAmount
      activePlayer.currentStreetBet = actionAmount
      activePlayer.totalHandBet += actionAmount
      if (activePlayer.chips === 0) activePlayer.isAllIn = true
      state.currentBet = actionAmount
      state.minRaise = actionAmount
      activePlayer.hasActedThisStreet = true
      break
    }

    case 'raise': {
      if (state.currentBet === 0) {
        return { success: false, error: 'No bet to raise; use bet' }
      }
      const minTotal = state.currentBet + state.minRaise
      const targetBet = amount ?? minTotal
      if (targetBet < minTotal && targetBet < activePlayer.currentStreetBet + activePlayer.chips) {
        return { success: false, error: `Minimum raise to is ${minTotal}` }
      }
      const additionalChips = targetBet - activePlayer.currentStreetBet
      actionAmount = Math.min(activePlayer.chips, additionalChips)
      activePlayer.chips -= actionAmount
      activePlayer.currentStreetBet += actionAmount
      activePlayer.totalHandBet += actionAmount
      if (activePlayer.chips === 0) activePlayer.isAllIn = true

      const raiseDiff = activePlayer.currentStreetBet - state.currentBet
      if (raiseDiff > state.minRaise) {
        state.minRaise = raiseDiff
      }
      state.currentBet = activePlayer.currentStreetBet
      activePlayer.hasActedThisStreet = true

      // Re-open action for other non-all-in players
      for (const p of state.players) {
        if (p !== activePlayer && !p.folded && !p.isAllIn) {
          p.hasActedThisStreet = false
        }
      }
      break
    }

    case 'all_in': {
      actionAmount = activePlayer.chips
      activePlayer.chips = 0
      activePlayer.currentStreetBet += actionAmount
      activePlayer.totalHandBet += actionAmount
      activePlayer.isAllIn = true
      activePlayer.hasActedThisStreet = true

      if (activePlayer.currentStreetBet > state.currentBet) {
        const raiseDiff = activePlayer.currentStreetBet - state.currentBet
        if (raiseDiff >= state.minRaise) {
          state.minRaise = raiseDiff
          // Re-open action for others
          for (const p of state.players) {
            if (p !== activePlayer && !p.folded && !p.isAllIn) {
              p.hasActedThisStreet = false
            }
          }
        }
        state.currentBet = activePlayer.currentStreetBet
      }
      break
    }
  }

  state.lastAction = {
    player: playerAddress,
    action,
    amount: actionAmount,
  }

  // Check if street completed
  if (isBettingRoundComplete(state)) {
    advanceStreet(state)
  } else {
    state.activePlayerIndex = nextActiveIndex(state, state.activePlayerIndex)
  }

  return { success: true }
}

export function settleHand(state: PokerGameState) {
  // Move any remaining street bets into pot
  for (const p of state.players) {
    state.pot += p.currentStreetBet
    p.currentStreetBet = 0
  }

  const remaining = state.players.filter(p => !p.folded)
  if (remaining.length === 1) {
    // Lone survivor wins entire pot
    const winner = remaining[0]
    winner.chips += state.pot
    state.winners = [{ address: winner.address, amount: state.pot }]
    state.pot = 0
    state.street = 'settled'
    return
  }

  // Evaluate 7-card hands for all surviving players
  const evaluations: Array<{
    player: PokerPlayer
    evaluation: HandEvaluation
  }> = []

  for (const p of remaining) {
    const fullHand = [...p.holeCards, ...state.boardCards]
    const evalResult = evaluate7CardHand(fullHand)
    evaluations.push({ player: p, evaluation: evalResult })
  }

  // Sort descending by score
  evaluations.sort((a, b) => b.evaluation.score - a.evaluation.score)

  const topScore = evaluations[0].evaluation.score
  const tiedWinners = evaluations.filter(e => e.evaluation.score === topScore)

  const share = Math.floor(state.pot / tiedWinners.length)
  let remainder = state.pot % tiedWinners.length

  state.winners = []
  for (const w of tiedWinners) {
    const payout = share + (remainder > 0 ? 1 : 0)
    remainder = Math.max(0, remainder - 1)
    w.player.chips += payout
    state.winners.push({
      address: w.player.address,
      amount: payout,
      evaluation: w.evaluation,
    })
  }

  state.pot = 0
  state.street = 'settled'
}
