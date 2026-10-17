/**
 * Texas Hold'em Poker Table State Machine (GAME-2).
 *
 * Implements 2 to 6 player No-Limit Texas Hold'em:
 * blinds, dealer rotation, betting rounds (Preflop, Flop, Turn, River),
 * all-in side pots, showdown evaluation, and pot distribution.
 */
import {
  commitHoleCards,
  commitSeed,
  deriveJointPokerSeed,
  derivePokerDeck,
  formatCard,
  generatePokerSeed,
  sha256Hex,
  verifyHoleCardsCommitment,
} from './deck'
import { evaluate7CardHand, type HandEvaluation } from './evaluator'
import type { PokerItem } from '@frank/cashweb/types/messages'

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
  seedCommit?: string
  seed?: string
  holeCardsSalt?: string
  holeCardsCommit?: string
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
  serverSeed?: string
  serverCommit?: string
  jointSeed?: string
  playerCommits?: Record<string, string>
  playerSeeds?: Record<string, string>
  holeCardCommits?: Record<string, string>
  holeCardSalts?: Record<string, string>
  winners?: PotWinner[]
  lastAction?: {
    player: string
    action: PokerAction
    amount: number
  }
}

const stripHex = (hex: string) => hex.replace(/^0x/, '').toLowerCase()

export function createPokerTable(params: {
  tableId: string
  buyInChips?: number
  smallBlind?: number
  bigBlind?: number
  maxPlayers?: number
  serverSeed?: string
}): PokerGameState {
  const sb = params.smallBlind ?? 10
  const bb = params.bigBlind ?? sb * 2
  const serverSeed = params.serverSeed ?? generatePokerSeed()
  const serverCommit = commitSeed(serverSeed)
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
    serverSeed,
    serverCommit,
    playerCommits: {},
    playerSeeds: {},
    holeCardCommits: {},
    holeCardSalts: {},
  }
}

export function joinPokerTable(
  state: PokerGameState,
  address: string,
  chips?: number,
  seedCommit?: string,
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

  const normalizedCommit = seedCommit ? stripHex(seedCommit) : undefined
  state.players.push({
    address,
    chips: chips ?? state.buyInChips,
    holeCards: [-1, -1],
    currentStreetBet: 0,
    totalHandBet: 0,
    folded: false,
    isAllIn: false,
    hasActedThisStreet: false,
    seedCommit: normalizedCommit,
  })
  if (normalizedCommit) {
    state.playerCommits = state.playerCommits ?? {}
    state.playerCommits[address.toLowerCase()] = normalizedCommit
  }

  return { success: true }
}

export function setPokerPlayerCommit(
  state: PokerGameState,
  playerAddress: string,
  commit: string,
): { success: boolean; error?: string } {
  const player = state.players.find(
    p => p.address.toLowerCase() === playerAddress.toLowerCase(),
  )
  if (!player) {
    return { success: false, error: 'Player not found at table' }
  }
  const normalized = stripHex(commit)
  player.seedCommit = normalized
  state.playerCommits = state.playerCommits ?? {}
  state.playerCommits[player.address.toLowerCase()] = normalized
  return { success: true }
}

export function setPokerPlayerSeed(
  state: PokerGameState,
  playerAddress: string,
  seed: string,
): { success: boolean; error?: string } {
  const player = state.players.find(
    p => p.address.toLowerCase() === playerAddress.toLowerCase(),
  )
  if (!player) {
    return { success: false, error: 'Player not found at table' }
  }
  const computedCommit = commitSeed(seed)
  if (player.seedCommit && stripHex(player.seedCommit) !== computedCommit) {
    return { success: false, error: 'Player seed does not match committed hash' }
  }
  player.seed = seed
  player.seedCommit = player.seedCommit ?? computedCommit
  state.playerCommits = state.playerCommits ?? {}
  state.playerSeeds = state.playerSeeds ?? {}
  state.playerCommits[player.address.toLowerCase()] = player.seedCommit
  state.playerSeeds[player.address.toLowerCase()] = seed
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
  clientSeed?: string | Record<string, string>,
): { success: boolean; error?: string } {
  const eligible = state.players.filter(p => p.chips > 0)
  if (eligible.length < 2) {
    return { success: false, error: 'Need at least 2 players with chips to start a hand' }
  }

  const sSeed = serverSeed ?? generatePokerSeed()
  const sCommit = commitSeed(sSeed)

  const playerSeedsMap: Record<string, string> = {}
  const playerCommitsMap: Record<string, string> = {}
  const providedMap =
    clientSeed && typeof clientSeed === 'object' ? clientSeed : undefined

  for (const p of eligible) {
    const key = p.address.toLowerCase()
    const candidateSeed =
      providedMap?.[p.address] ??
      providedMap?.[key] ??
      p.seed ??
      generatePokerSeed()
    const computedCommit = commitSeed(candidateSeed)
    if (p.seedCommit && stripHex(p.seedCommit) !== computedCommit) {
      return {
        success: false,
        error: `Seed mismatch for player ${p.address}: revealed seed does not match commitment`,
      }
    }
    p.seed = candidateSeed
    p.seedCommit = p.seedCommit ?? computedCommit
    playerSeedsMap[key] = candidateSeed
    playerCommitsMap[key] = p.seedCommit
  }

  state.handNumber += 1
  state.street = 'preflop'
  state.boardCards = []
  state.pot = 0
  state.winners = undefined
  state.lastAction = undefined
  state.serverSeed = sSeed
  state.serverCommit = sCommit
  state.playerCommits = playerCommitsMap
  state.playerSeeds = playerSeedsMap
  state.holeCardCommits = {}
  state.holeCardSalts = {}

  const eligibleOrder = eligible.map(p => p.address.toLowerCase())
  if (typeof clientSeed === 'string') {
    state.jointSeed = deriveJointPokerSeed(sSeed, clientSeed)
    state.deck = derivePokerDeck(sSeed, clientSeed)
  } else {
    state.jointSeed = deriveJointPokerSeed(sSeed, playerSeedsMap, eligibleOrder)
    state.deck = derivePokerDeck(sSeed, playerSeedsMap, eligibleOrder)
  }
  let deckIdx = 0

  // Move dealer button clockwise
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length
  while (state.players[state.dealerIndex].chips <= 0) {
    state.dealerIndex = (state.dealerIndex + 1) % state.players.length
  }

  // Reset players for new hand & deal 2 hole cards with cryptographic commitments
  for (const p of state.players) {
    const key = p.address.toLowerCase()
    p.folded = p.chips <= 0
    p.isAllIn = false
    p.currentStreetBet = 0
    p.totalHandBet = 0
    p.hasActedThisStreet = false
    if (!p.folded) {
      p.holeCards = [state.deck[deckIdx++], state.deck[deckIdx++]]
      const salt = sha256Hex(
        `poker-salt:${state.jointSeed}:${key}:${state.handNumber}`,
      )
      const hcCommit = commitHoleCards(p.holeCards, salt)
      p.holeCardsSalt = salt
      p.holeCardsCommit = hcCommit
      state.holeCardSalts[key] = salt
      state.holeCardCommits[key] = hcCommit
    } else {
      p.holeCards = [-1, -1]
      p.holeCardsSalt = undefined
      p.holeCardsCommit = undefined
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

export interface PokerShowdownVerificationParams {
  serverCommit?: string
  serverSeed?: string
  playerCommits?: Record<string, string>
  playerSeeds?: Record<string, string>
  clientSeed?: string
  players: ReadonlyArray<{
    address: string
    folded?: boolean
    holeCards?: readonly number[]
    seedCommit?: string
    seed?: string
    holeCardsCommit?: string
    holeCardsSalt?: string
  }>
  boardCards?: readonly number[]
  holeCardCommits?: Record<string, string>
  holeCardSalts?: Record<string, string>
  winners?: ReadonlyArray<{
    address: string
    amount: number
    handDescription?: string
    best5Cards?: readonly number[]
  }>
  handNumber?: number
}

export interface PokerVerificationResult {
  verified: boolean
  valid: boolean
  reason?: string
}

function invalidPoker(reason: string): PokerVerificationResult {
  return { verified: false, valid: false, reason }
}

/**
 * Deterministically verifies a Poker hand's showdown or settlement against:
 * 1. The dealer's `serverCommit === SHA256(serverSeed)`.
 * 2. Every player's `playerCommits[addr] === SHA256(playerSeeds[addr])`.
 * 3. The joint multi-party seed deck derivation (`derivePokerDeck`).
 * 4. Every player's initial hole card commitment and revealed hole cards.
 * 5. Community board cards and 7-card showdown hand evaluation.
 */
export function verifyPokerShowdown(
  params: PokerShowdownVerificationParams | PokerGameState,
): PokerVerificationResult {
  const serverCommit = params.serverCommit
  const serverSeed = params.serverSeed
  if (!serverCommit || !serverSeed) {
    return invalidPoker('Missing server seed or server commitment')
  }
  if (commitSeed(serverSeed) !== stripHex(serverCommit)) {
    return invalidPoker('Server seed does not match committed hash')
  }

  const players = params.players ?? []
  if (players.length < 2) {
    return invalidPoker('At least 2 players required to verify hand')
  }

  const commitsRecord: Record<string, string> = {}
  if (params.playerCommits) {
    for (const [k, v] of Object.entries(params.playerCommits)) {
      commitsRecord[k.toLowerCase()] = stripHex(v)
    }
  }
  const seedsRecord: Record<string, string> = {}
  if (params.playerSeeds) {
    for (const [k, v] of Object.entries(params.playerSeeds)) {
      seedsRecord[k.toLowerCase()] = v
    }
  }

  for (const p of players) {
    const key = p.address.toLowerCase()
    if (p.seedCommit && !commitsRecord[key]) {
      commitsRecord[key] = stripHex(p.seedCommit)
    }
    if (p.seed && !seedsRecord[key]) {
      seedsRecord[key] = p.seed
    }
  }

  const clientSeed = 'clientSeed' in params ? params.clientSeed : undefined
  const hasPlayerCommitments =
    Object.keys(commitsRecord).length > 0 || Object.keys(seedsRecord).length > 0

  const playerOrder = players.map(p => p.address.toLowerCase())

  if (hasPlayerCommitments && !clientSeed) {
    for (const p of players) {
      const key = p.address.toLowerCase()
      const commit = commitsRecord[key]
      const seed = seedsRecord[key]
      if (!commit || !seed) {
        return invalidPoker(`Missing seed or commitment for player ${p.address}`)
      }
      if (commitSeed(seed) !== stripHex(commit)) {
        return invalidPoker(
          `Revealed seed for player ${p.address} does not match commitment`,
        )
      }
    }
  } else if (!clientSeed) {
    return invalidPoker('Missing player seed commitments and reveals')
  }

  const deck = clientSeed
    ? derivePokerDeck(serverSeed, clientSeed)
    : derivePokerDeck(serverSeed, seedsRecord, playerOrder)
  const jointSeed = clientSeed
    ? deriveJointPokerSeed(serverSeed, clientSeed)
    : deriveJointPokerSeed(serverSeed, seedsRecord, playerOrder)

  const holeCardCommits: Record<string, string> = {}
  if (params.holeCardCommits) {
    for (const [k, v] of Object.entries(params.holeCardCommits)) {
      holeCardCommits[k.toLowerCase()] = stripHex(v)
    }
  }
  const holeCardSalts: Record<string, string> = {}
  if (params.holeCardSalts) {
    for (const [k, v] of Object.entries(params.holeCardSalts)) {
      holeCardSalts[k.toLowerCase()] = v
    }
  }

  const handNumber = params.handNumber ?? 1
  let deckIdx = 0
  let dealtPlayersCount = 0

  for (const p of players) {
    const key = p.address.toLowerCase()
    const expectedHole: [number, number] = [deck[deckIdx++], deck[deckIdx++]]
    dealtPlayersCount++

    const commit = holeCardCommits[key] ?? (p.holeCardsCommit ? stripHex(p.holeCardsCommit) : undefined)
    const salt =
      holeCardSalts[key] ??
      p.holeCardsSalt ??
      sha256Hex(`poker-salt:${jointSeed}:${key}:${handNumber}`)

    const revealedHole =
      p.holeCards && p.holeCards.length === 2 && p.holeCards[0] !== -1 && p.holeCards[1] !== -1
        ? p.holeCards
        : undefined

    if (commit) {
      const cardsToCheck = revealedHole ?? expectedHole
      if (!verifyHoleCardsCommitment(cardsToCheck, salt, commit)) {
        return invalidPoker(
          `Hole cards for player ${p.address} do not match initial commitment`,
        )
      }
    }

    if (!p.folded || revealedHole) {
      if (!revealedHole) {
        return invalidPoker(
          `Active showdown player ${p.address} did not reveal hole cards`,
        )
      }
      if (
        revealedHole[0] !== expectedHole[0] ||
        revealedHole[1] !== expectedHole[1]
      ) {
        return invalidPoker(
          `Revealed hole cards for player ${p.address} do not match joint seed deal`,
        )
      }
    }
  }

  const boardCards = params.boardCards ?? []
  if (boardCards.length > 0) {
    const dealtSoFar = dealtPlayersCount * 2
    const expectedBoard: number[] = []
    if (boardCards.length >= 3) {
      // Flop: burn 1 card, deal 3
      const flopStart = dealtSoFar + 1
      expectedBoard.push(deck[flopStart], deck[flopStart + 1], deck[flopStart + 2])
    }
    if (boardCards.length >= 4) {
      // Turn: burn 1 card (at dealtSoFar + 4), deal 1 (at dealtSoFar + 5)
      expectedBoard.push(deck[dealtSoFar + 5])
    }
    if (boardCards.length >= 5) {
      // River: burn 1 card (at dealtSoFar + 6), deal 1 (at dealtSoFar + 7)
      expectedBoard.push(deck[dealtSoFar + 7])
    }
    if (
      expectedBoard.length !== boardCards.length ||
      boardCards.some((c, i) => c !== expectedBoard[i])
    ) {
      return invalidPoker('Board cards do not match joint seed deck deal')
    }
  }

  const surviving = players.filter(p => !p.folded)
  if (surviving.length > 1 && boardCards.length === 5 && params.winners && params.winners.length > 0) {
    const evaluations = surviving.map(p => ({
      address: p.address.toLowerCase(),
      evalResult: evaluate7CardHand([...(p.holeCards as number[]), ...boardCards]),
    }))
    evaluations.sort((a, b) => b.evalResult.score - a.evalResult.score)
    const topScore = evaluations[0].evalResult.score
    const expectedWinners = new Set(
      evaluations.filter(e => e.evalResult.score === topScore).map(e => e.address),
    )
    const announcedWinners = new Set(
      params.winners.map(w => w.address.toLowerCase()),
    )
    if (
      expectedWinners.size !== announcedWinners.size ||
      [...expectedWinners].some(w => !announcedWinners.has(w))
    ) {
      return invalidPoker('Announced showdown winners do not match evaluated hands')
    }
  }

  return { verified: true, valid: true }
}

export type PokerMessageEnvelope =
  | (PokerItem & {
      serverCommit?: string
      serverSeed?: string
      playerCommits?: Record<string, string>
      playerSeeds?: Record<string, string>
      holeCardCommits?: Record<string, string>
      holeCardSalts?: Record<string, string>
      handNumber?: number
    })
  | {
      senderAddress?: string
      peerAddress?: string
      items: ReadonlyArray<any>
    }

export interface FoldedPokerState extends PokerGameState {
  verified: boolean
  verificationError?: string
}

function extractPokerItems(
  messages: ReadonlyArray<PokerMessageEnvelope>,
): Array<{
  item: PokerItem & {
    serverCommit?: string
    serverSeed?: string
    playerCommits?: Record<string, string>
    playerSeeds?: Record<string, string>
    holeCardCommits?: Record<string, string>
    holeCardSalts?: Record<string, string>
    handNumber?: number
  }
  senderAddress?: string
}> {
  const out: Array<{ item: any; senderAddress?: string }> = []
  for (const msg of messages) {
    if ('type' in msg && msg.type === 'poker') {
      out.push({ item: msg })
    } else if ('items' in msg && Array.isArray(msg.items)) {
      const sender = msg.senderAddress ?? msg.peerAddress
      for (const it of msg.items) {
        if (it && it.type === 'poker') {
          out.push({ item: it, senderAddress: sender })
        }
      }
    }
  }
  return out
}

/**
 * Deterministically folds a sequence of Poker messages from a mailbox into a
 * reconstructed table state, verifying cryptographic commitments and reveals
 * at showdown/settlement and flagging any tampered or unverified reveal as
 * `verified: false`.
 */
export function foldPokerState(
  messages: ReadonlyArray<PokerMessageEnvelope>,
): FoldedPokerState | undefined {
  const entries = extractPokerItems(messages)
  if (entries.length === 0) return undefined

  const first = entries[0].item
  const state: FoldedPokerState = {
    ...createPokerTable({
      tableId: first.tableId,
      smallBlind: first.smallBlind ?? 10,
      bigBlind: first.bigBlind ?? 20,
    }),
    serverCommit: undefined,
    serverSeed: undefined,
    playerCommits: {},
    playerSeeds: {},
    holeCardCommits: {},
    holeCardSalts: {},
    verified: true,
  }

  let hasCommitmentsInHand = false
  let commitmentTampered = false
  let commitmentTamperReason: string | undefined

  for (const { item, senderAddress } of entries) {
    if (item.tableId !== state.tableId) continue

    if (item.action === 'create') {
      state.smallBlind = item.smallBlind ?? state.smallBlind
      state.bigBlind = item.bigBlind ?? state.bigBlind
      if (item.players && item.players.length > 0) {
        state.players = item.players.map(pv => ({
          address: pv.address,
          chips: pv.chips,
          holeCards:
            pv.holeCards && pv.holeCards.length === 2
              ? [pv.holeCards[0], pv.holeCards[1]]
              : [-1, -1],
          currentStreetBet: pv.currentStreetBet,
          totalHandBet: pv.totalHandBet,
          folded: pv.folded,
          isAllIn: pv.isAllIn,
          hasActedThisStreet: false,
        }))
      } else if (senderAddress) {
        joinPokerTable(state, senderAddress)
      }
      if (item.serverCommit) {
        state.serverCommit = stripHex(item.serverCommit)
        hasCommitmentsInHand = true
      }
      if (item.playerCommits) {
        for (const [k, v] of Object.entries(item.playerCommits)) {
          state.playerCommits![k.toLowerCase()] = stripHex(v)
        }
        hasCommitmentsInHand = true
      }
      continue
    }

    if (item.action === 'join') {
      if (item.players && item.players.length > 0) {
        for (const pv of item.players) {
          if (!state.players.some(p => p.address.toLowerCase() === pv.address.toLowerCase())) {
            joinPokerTable(state, pv.address, pv.chips)
          }
        }
      } else if (senderAddress) {
        joinPokerTable(state, senderAddress)
      }
      if (item.playerCommits) {
        for (const [k, v] of Object.entries(item.playerCommits)) {
          state.playerCommits![k.toLowerCase()] = stripHex(v)
        }
        hasCommitmentsInHand = true
      }
      continue
    }

    if (item.action === 'deal') {
      state.handNumber = item.handNumber ?? state.handNumber + 1
      state.street = item.street ?? 'preflop'
      state.pot = item.pot
      state.currentBet = item.currentBet ?? state.bigBlind
      state.minRaise = item.minRaise ?? state.bigBlind
      state.boardCards = item.boardCards ? [...item.boardCards] : []
      state.winners = undefined
      commitmentTampered = false
      commitmentTamperReason = undefined

      if (item.serverCommit) {
        state.serverCommit = stripHex(item.serverCommit)
        hasCommitmentsInHand = true
      }
      if (item.playerCommits) {
        state.playerCommits = {}
        for (const [k, v] of Object.entries(item.playerCommits)) {
          state.playerCommits[k.toLowerCase()] = stripHex(v)
        }
        hasCommitmentsInHand = true
      }
      if (item.holeCardCommits) {
        state.holeCardCommits = {}
        for (const [k, v] of Object.entries(item.holeCardCommits)) {
          state.holeCardCommits[k.toLowerCase()] = stripHex(v)
        }
        hasCommitmentsInHand = true
      }
      if (item.players) {
        state.players = item.players.map((pv, idx) => {
          if (pv.isDealerButton) state.dealerIndex = idx
          return {
            address: pv.address,
            chips: pv.chips,
            holeCards:
              pv.holeCards && pv.holeCards.length === 2
                ? [pv.holeCards[0], pv.holeCards[1]]
                : [-1, -1],
            currentStreetBet: pv.currentStreetBet,
            totalHandBet: pv.totalHandBet,
            folded: pv.folded,
            isAllIn: pv.isAllIn,
            hasActedThisStreet: false,
            seedCommit: state.playerCommits?.[pv.address.toLowerCase()],
            holeCardsCommit: state.holeCardCommits?.[pv.address.toLowerCase()],
          }
        })
      }
      if (item.activePlayer) {
        const idx = state.players.findIndex(
          p => p.address.toLowerCase() === item.activePlayer!.toLowerCase(),
        )
        if (idx >= 0) state.activePlayerIndex = idx
      }
      continue
    }

    // Track commitments on action/showdown/settle and detect conflicting commitment changes
    if (item.serverCommit) {
      const normalized = stripHex(item.serverCommit)
      if (state.serverCommit && state.serverCommit !== normalized) {
        commitmentTampered = true
        commitmentTamperReason = 'Conflicting server commitment mid-hand'
      } else {
        state.serverCommit = normalized
      }
      hasCommitmentsInHand = true
    }
    if (item.playerCommits) {
      for (const [k, v] of Object.entries(item.playerCommits)) {
        const key = k.toLowerCase()
        const normalized = stripHex(v)
        if (state.playerCommits?.[key] && state.playerCommits[key] !== normalized) {
          commitmentTampered = true
          commitmentTamperReason = `Conflicting commitment for player ${k}`
        } else {
          state.playerCommits![key] = normalized
        }
      }
      hasCommitmentsInHand = true
    }
    if (item.holeCardCommits) {
      for (const [k, v] of Object.entries(item.holeCardCommits)) {
        const key = k.toLowerCase()
        const normalized = stripHex(v)
        if (state.holeCardCommits?.[key] && state.holeCardCommits[key] !== normalized) {
          commitmentTampered = true
          commitmentTamperReason = `Conflicting hole card commitment for player ${k}`
        } else {
          state.holeCardCommits![key] = normalized
        }
      }
      hasCommitmentsInHand = true
    }
    if (item.serverSeed) {
      state.serverSeed = item.serverSeed
    }
    if (item.playerSeeds) {
      for (const [k, v] of Object.entries(item.playerSeeds)) {
        state.playerSeeds![k.toLowerCase()] = v
      }
    }
    if (item.holeCardSalts) {
      for (const [k, v] of Object.entries(item.holeCardSalts)) {
        state.holeCardSalts![k.toLowerCase()] = v
      }
    }

    if (item.action === 'action') {
      if (item.street) state.street = item.street
      state.pot = item.pot
      if (item.currentBet !== undefined) state.currentBet = item.currentBet
      if (item.minRaise !== undefined) state.minRaise = item.minRaise
      if (item.boardCards) state.boardCards = [...item.boardCards]
      if (item.lastAction) {
        state.lastAction = {
          player: item.lastAction.player,
          action: item.lastAction.action,
          amount: item.lastAction.amount ?? 0,
        }
      }
      if (item.players) {
        state.players = item.players.map((pv, idx) => {
          if (pv.isDealerButton) state.dealerIndex = idx
          return {
            address: pv.address,
            chips: pv.chips,
            holeCards:
              pv.holeCards && pv.holeCards.length === 2
                ? [pv.holeCards[0], pv.holeCards[1]]
                : [-1, -1],
            currentStreetBet: pv.currentStreetBet,
            totalHandBet: pv.totalHandBet,
            folded: pv.folded,
            isAllIn: pv.isAllIn,
            hasActedThisStreet: false,
            seedCommit: state.playerCommits?.[pv.address.toLowerCase()],
            seed: state.playerSeeds?.[pv.address.toLowerCase()],
            holeCardsCommit: state.holeCardCommits?.[pv.address.toLowerCase()],
            holeCardsSalt: state.holeCardSalts?.[pv.address.toLowerCase()],
          }
        })
      } else if (item.lastAction && state.street !== 'waiting') {
        applyPlayerAction(
          state,
          item.lastAction.player,
          item.lastAction.action,
          item.lastAction.amount,
        )
      }
      if (item.activePlayer) {
        const idx = state.players.findIndex(
          p => p.address.toLowerCase() === item.activePlayer!.toLowerCase(),
        )
        if (idx >= 0) state.activePlayerIndex = idx
      }
      continue
    }

    if (item.action === 'showdown' || item.action === 'settle') {
      state.street = item.action === 'showdown' ? 'showdown' : 'settled'
      state.pot = item.pot
      if (item.boardCards) state.boardCards = [...item.boardCards]
      if (item.players) {
        state.players = item.players.map((pv, idx) => {
          if (pv.isDealerButton) state.dealerIndex = idx
          return {
            address: pv.address,
            chips: pv.chips,
            holeCards:
              pv.holeCards && pv.holeCards.length === 2
                ? [pv.holeCards[0], pv.holeCards[1]]
                : [-1, -1],
            currentStreetBet: pv.currentStreetBet,
            totalHandBet: pv.totalHandBet,
            folded: pv.folded,
            isAllIn: pv.isAllIn,
            hasActedThisStreet: false,
            seedCommit: state.playerCommits?.[pv.address.toLowerCase()],
            seed: state.playerSeeds?.[pv.address.toLowerCase()],
            holeCardsCommit: state.holeCardCommits?.[pv.address.toLowerCase()],
            holeCardsSalt: state.holeCardSalts?.[pv.address.toLowerCase()],
          }
        })
      }
      if (item.winners) {
        state.winners = item.winners.map(w => ({
          address: w.address,
          amount: w.amount,
        }))
      }

      if (commitmentTampered) {
        state.verified = false
        state.verificationError = commitmentTamperReason
        continue
      }

      const surviving = state.players.filter(p => !p.folded)
      const isShowdown = item.action === 'showdown' || surviving.length > 1

      if (
        hasCommitmentsInHand ||
        state.serverSeed ||
        Object.keys(state.playerSeeds ?? {}).length > 0 ||
        isShowdown
      ) {
        const check = verifyPokerShowdown({
          serverCommit: state.serverCommit,
          serverSeed: state.serverSeed,
          playerCommits: state.playerCommits,
          playerSeeds: state.playerSeeds,
          players: state.players,
          boardCards: state.boardCards,
          holeCardCommits: state.holeCardCommits,
          holeCardSalts: state.holeCardSalts,
          winners: item.winners,
          handNumber: state.handNumber || 1,
        })
        state.verified = check.verified
        state.verificationError = check.reason
      }
    }
  }

  return state
}

