/**
 * Table State Machine for Liar's Dice (Perudo) (GAME-1).
 *
 * Manages player registration, round commitments, turn rotations,
 * challenge resolution, elimination, and table settlement.
 */
import {
  derivePlayerDice,
  countMatchingDice,
  generateSeed,
  sha256Hex,
  validateBid,
  type Bid,
} from './dice'

export const DEFAULT_DICE_PER_PLAYER = 5
export const DEFAULT_BUY_IN_WEI = 50_000_000_000_000_000n // 0.05 MON
export const TURN_TIMEOUT_SECONDS = 45

export interface PlayerState {
  address: string
  diceCount: number
  seedCommit?: string
  seed?: string
  currentDice?: number[]
  eliminated: boolean
}

export interface ChallengeResolution {
  bid: Bid
  challenger: string
  totalMatchingDice: number
  wildAcesCount: number
  challengerWon: boolean
  loserAddress: string
  loserRemainingDice: number
  eliminated: boolean
}

export interface LiarsDiceGameState {
  tableId: string
  hostAddress: string
  buyInWei: bigint
  maxPlayers: number
  dicePerPlayer: number
  players: PlayerState[]
  roundNumber: number
  turnIndex: number
  currentBid?: Bid
  status: 'waiting_for_players' | 'round_active' | 'showdown' | 'resolved'
  serverSeed: string
  serverCommit: string
  potWei: bigint
  lastActionTimestamp: number
  lastResolution?: ChallengeResolution
  winnerAddress?: string
}

export function createLiarsDiceGame(params: {
  tableId: string
  hostAddress: string
  buyInWei?: bigint
  maxPlayers?: number
  dicePerPlayer?: number
}): LiarsDiceGameState {
  const serverSeed = generateSeed()
  const serverCommit = sha256Hex(serverSeed)

  return {
    tableId: params.tableId,
    hostAddress: params.hostAddress,
    buyInWei: params.buyInWei ?? DEFAULT_BUY_IN_WEI,
    maxPlayers: params.maxPlayers ?? 4,
    dicePerPlayer: params.dicePerPlayer ?? DEFAULT_DICE_PER_PLAYER,
    players: [],
    roundNumber: 0,
    turnIndex: 0,
    status: 'waiting_for_players',
    serverSeed,
    serverCommit,
    potWei: 0n,
    lastActionTimestamp: Date.now(),
  }
}

export function joinGame(
  state: LiarsDiceGameState,
  playerAddress: string,
): { success: boolean; error?: string } {
  if (state.status !== 'waiting_for_players') {
    return { success: false, error: 'Table is not accepting new players' }
  }
  if (state.players.length >= state.maxPlayers) {
    return { success: false, error: 'Table is full' }
  }
  if (state.players.some(p => p.address.toLowerCase() === playerAddress.toLowerCase())) {
    return { success: false, error: 'Player already joined' }
  }

  state.players.push({
    address: playerAddress,
    diceCount: state.dicePerPlayer,
    eliminated: false,
  })
  state.potWei += state.buyInWei
  state.lastActionTimestamp = Date.now()

  return { success: true }
}

export function startNextRound(
  state: LiarsDiceGameState,
  newServerSeed?: string,
): { success: boolean; error?: string } {
  const activePlayers = state.players.filter(p => !p.eliminated)
  if (activePlayers.length < 2) {
    return { success: false, error: 'Need at least 2 active players to start a round' }
  }

  state.roundNumber += 1
  state.currentBid = undefined
  state.lastResolution = undefined
  state.status = 'round_active'
  state.lastActionTimestamp = Date.now()

  state.serverSeed = newServerSeed ?? generateSeed()
  state.serverCommit = sha256Hex(state.serverSeed)

  // Reset player per-round secrets
  for (const player of state.players) {
    if (!player.eliminated) {
      player.seed = undefined
      player.seedCommit = undefined
      player.currentDice = undefined
    }
  }

  // First active player begins turn
  state.turnIndex = state.players.findIndex(p => !p.eliminated)

  return { success: true }
}

export function setPlayerRoundCommit(
  state: LiarsDiceGameState,
  playerAddress: string,
  commit: string,
): { success: boolean; error?: string } {
  const player = state.players.find(
    p => p.address.toLowerCase() === playerAddress.toLowerCase() && !p.eliminated,
  )
  if (!player) {
    return { success: false, error: 'Player not found or eliminated' }
  }
  player.seedCommit = commit
  return { success: true }
}

export function setPlayerRoundSecret(
  state: LiarsDiceGameState,
  playerAddress: string,
  seed: string,
): { success: boolean; error?: string } {
  const player = state.players.find(
    p => p.address.toLowerCase() === playerAddress.toLowerCase() && !p.eliminated,
  )
  if (!player) {
    return { success: false, error: 'Player not found or eliminated' }
  }
  if (player.seedCommit && sha256Hex(seed) !== player.seedCommit) {
    return { success: false, error: 'Seed does not match committed hash' }
  }
  player.seed = seed
  player.currentDice = derivePlayerDice(state.serverSeed, seed, player.diceCount)
  return { success: true }
}

export function getActivePlayer(state: LiarsDiceGameState): PlayerState | undefined {
  if (state.status !== 'round_active') return undefined
  return state.players[state.turnIndex]
}

export function getTotalDiceInPlay(state: LiarsDiceGameState): number {
  return state.players
    .filter(p => !p.eliminated)
    .reduce((sum, p) => sum + p.diceCount, 0)
}

function advanceTurn(state: LiarsDiceGameState) {
  const n = state.players.length
  let next = (state.turnIndex + 1) % n
  while (state.players[next].eliminated) {
    next = (next + 1) % n
  }
  state.turnIndex = next
  state.lastActionTimestamp = Date.now()
}

export function applyBid(
  state: LiarsDiceGameState,
  bidderAddress: string,
  quantity: number,
  face: number,
): { success: boolean; error?: string } {
  if (state.status !== 'round_active') {
    return { success: false, error: 'Round is not in active bidding state' }
  }
  const active = getActivePlayer(state)
  if (!active || active.address.toLowerCase() !== bidderAddress.toLowerCase()) {
    return { success: false, error: `It is not ${bidderAddress}'s turn to bid` }
  }

  const nextBid: Bid = { bidder: bidderAddress, quantity, face }
  const totalDice = getTotalDiceInPlay(state)
  const validation = validateBid(state.currentBid, nextBid, totalDice)
  if (!validation.valid) {
    return { success: false, error: validation.reason }
  }

  state.currentBid = nextBid
  advanceTurn(state)
  return { success: true }
}

export function applyChallenge(
  state: LiarsDiceGameState,
  challengerAddress: string,
): { success: boolean; error?: string; resolution?: ChallengeResolution } {
  if (state.status !== 'round_active') {
    return { success: false, error: 'Round is not in active bidding state' }
  }
  if (!state.currentBid) {
    return { success: false, error: 'Cannot call Liar before an opening bid has been made' }
  }
  const active = getActivePlayer(state)
  if (!active || active.address.toLowerCase() !== challengerAddress.toLowerCase()) {
    return { success: false, error: `It is not ${challengerAddress}'s turn to challenge` }
  }

  // Ensure all active players have their dice derived (if using auto seeds)
  const allCups: Record<string, number[]> = {}
  for (const player of state.players) {
    if (!player.eliminated) {
      if (!player.currentDice) {
        const seed = player.seed ?? generateSeed()
        player.currentDice = derivePlayerDice(state.serverSeed, seed, player.diceCount)
        player.seed = seed
      }
      allCups[player.address] = player.currentDice
    }
  }

  const { totalCount, wildAces } = countMatchingDice(allCups, state.currentBid.face)
  const bidQuantity = state.currentBid.quantity
  // If actual matching dice >= bid: bidder was truthful, challenger loses 1 die
  // If actual matching dice < bid: bidder was lying, bidder loses 1 die
  const challengerWon = totalCount < bidQuantity
  const loserAddress = challengerWon ? state.currentBid.bidder : challengerAddress
  const loser = state.players.find(p => p.address.toLowerCase() === loserAddress.toLowerCase())!

  loser.diceCount -= 1
  if (loser.diceCount <= 0) {
    loser.eliminated = true
  }

  const resolution: ChallengeResolution = {
    bid: state.currentBid,
    challenger: challengerAddress,
    totalMatchingDice: totalCount,
    wildAcesCount: wildAces,
    challengerWon,
    loserAddress,
    loserRemainingDice: Math.max(0, loser.diceCount),
    eliminated: loser.eliminated,
  }

  state.lastResolution = resolution
  state.status = 'showdown'
  state.lastActionTimestamp = Date.now()

  // Check if only 1 player remains
  const surviving = state.players.filter(p => !p.eliminated)
  if (surviving.length === 1) {
    state.status = 'resolved'
    state.winnerAddress = surviving[0].address
  } else {
    // Loser begins the next round if still alive, otherwise next surviving player
    const loserIndex = state.players.findIndex(
      p => p.address.toLowerCase() === loserAddress.toLowerCase(),
    )
    if (!loser.eliminated) {
      state.turnIndex = loserIndex
    } else {
      let next = (loserIndex + 1) % state.players.length
      while (state.players[next].eliminated) {
        next = (next + 1) % state.players.length
      }
      state.turnIndex = next
    }
  }

  return { success: true, resolution }
}
