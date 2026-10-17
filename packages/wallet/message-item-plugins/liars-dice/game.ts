/**
 * Table State Machine for Liar's Dice (Perudo) (GAME-1).
 *
 * Manages player registration, round commitments, turn rotations,
 * challenge resolution, elimination, and table settlement.
 */
import {
  commitDiceCup,
  commitSeed,
  countMatchingDice,
  deriveJointDiceSeed,
  derivePlayerDice,
  generateSeed,
  sha256Hex,
  validateBid,
  verifyDiceCupCommitment,
  type Bid,
} from './dice'
import type { LiarsDiceItem } from '@frank/cashweb/types/messages'

export const DEFAULT_DICE_PER_PLAYER = 5
export const DEFAULT_BUY_IN_WEI = 50_000_000_000_000_000n // 0.05 MON
export const TURN_TIMEOUT_SECONDS = 45

export interface PlayerState {
  address: string
  diceCount: number
  seedCommit?: string
  seed?: string
  cupSalt?: string
  cupCommit?: string
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
  jointSeed?: string
  playerCommits?: Record<string, string>
  playerSeeds?: Record<string, string>
  cupCommits?: Record<string, string>
  cupSalts?: Record<string, string>
  potWei: bigint
  lastActionTimestamp: number
  lastResolution?: ChallengeResolution
  winnerAddress?: string
}

const stripHex = (hex: string) => hex.replace(/^0x/, '').toLowerCase()

export function createLiarsDiceGame(params: {
  tableId: string
  hostAddress: string
  buyInWei?: bigint
  maxPlayers?: number
  dicePerPlayer?: number
  serverSeed?: string
}): LiarsDiceGameState {
  const serverSeed = params.serverSeed ?? generateSeed()
  const serverCommit = commitSeed(serverSeed)

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
    playerCommits: {},
    playerSeeds: {},
    cupCommits: {},
    cupSalts: {},
    potWei: 0n,
    lastActionTimestamp: Date.now(),
  }
}

export function joinGame(
  state: LiarsDiceGameState,
  playerAddress: string,
  seedCommit?: string,
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

  const normalizedCommit = seedCommit ? stripHex(seedCommit) : undefined
  state.players.push({
    address: playerAddress,
    diceCount: state.dicePerPlayer,
    seedCommit: normalizedCommit,
    eliminated: false,
  })
  if (normalizedCommit) {
    state.playerCommits = state.playerCommits ?? {}
    state.playerCommits[playerAddress.toLowerCase()] = normalizedCommit
  }
  state.potWei += state.buyInWei
  state.lastActionTimestamp = Date.now()

  return { success: true }
}

function recomputeRoundDice(state: LiarsDiceGameState) {
  const activePlayers = state.players.filter(p => !p.eliminated)
  const activeOrder = activePlayers.map(p => p.address.toLowerCase())
  const seedsMap: Record<string, string> = {}
  const commitsMap: Record<string, string> = {}

  for (const p of activePlayers) {
    const key = p.address.toLowerCase()
    if (p.seed) {
      seedsMap[key] = p.seed
    }
    if (p.seedCommit) {
      commitsMap[key] = stripHex(p.seedCommit)
    }
  }

  state.playerCommits = commitsMap
  state.playerSeeds = seedsMap
  state.cupCommits = state.cupCommits ?? {}
  state.cupSalts = state.cupSalts ?? {}

  if (Object.keys(seedsMap).length === activePlayers.length && activePlayers.length > 0) {
    state.jointSeed = deriveJointDiceSeed(state.serverSeed, seedsMap, activeOrder)
    for (const p of activePlayers) {
      const key = p.address.toLowerCase()
      p.currentDice = derivePlayerDice(
        state.serverSeed,
        p.seed!,
        p.diceCount,
        state.jointSeed,
        p.address,
      )
      const salt = sha256Hex(
        `liars-dice-salt:${state.jointSeed}:${key}:${state.roundNumber}`,
      )
      const cCommit = commitDiceCup(p.currentDice, salt)
      p.cupSalt = salt
      p.cupCommit = cCommit
      state.cupSalts[key] = salt
      state.cupCommits[key] = cCommit
    }
  }
}

export function startNextRound(
  state: LiarsDiceGameState,
  newServerSeed?: string,
  playerSeeds?: Record<string, string>,
): { success: boolean; error?: string } {
  const activePlayers = state.players.filter(p => !p.eliminated)
  if (activePlayers.length < 2) {
    return { success: false, error: 'Need at least 2 active players to start a round' }
  }

  const sSeed = newServerSeed ?? generateSeed()
  const sCommit = commitSeed(sSeed)

  for (const player of activePlayers) {
    const key = player.address.toLowerCase()
    const providedSeed = playerSeeds?.[player.address] ?? playerSeeds?.[key]
    if (providedSeed !== undefined) {
      if (player.seedCommit && stripHex(player.seedCommit) !== commitSeed(providedSeed)) {
        return {
          success: false,
          error: `Seed for player ${player.address} does not match committed hash`,
        }
      }
      player.seed = providedSeed
      player.seedCommit = player.seedCommit ?? commitSeed(providedSeed)
    } else {
      const freshSeed = generateSeed()
      player.seed = freshSeed
      player.seedCommit = commitSeed(freshSeed)
    }
  }

  state.roundNumber += 1
  state.currentBid = undefined
  state.lastResolution = undefined
  state.status = 'round_active'
  state.lastActionTimestamp = Date.now()
  state.serverSeed = sSeed
  state.serverCommit = sCommit
  state.cupCommits = {}
  state.cupSalts = {}

  recomputeRoundDice(state)

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
  const normalized = stripHex(commit)
  player.seedCommit = normalized
  player.seed = undefined
  player.currentDice = undefined
  state.playerCommits = state.playerCommits ?? {}
  state.playerCommits[player.address.toLowerCase()] = normalized
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
  if (player.seedCommit && stripHex(player.seedCommit) !== commitSeed(seed)) {
    return { success: false, error: 'Seed does not match committed hash' }
  }
  player.seed = seed
  player.seedCommit = player.seedCommit ?? commitSeed(seed)
  recomputeRoundDice(state)
  if (!player.currentDice) {
    player.currentDice = derivePlayerDice(state.serverSeed, seed, player.diceCount)
  }
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

  // Ensure all active players have their committed seeds and dice derived
  let needsRecompute = false
  for (const player of state.players) {
    if (!player.eliminated) {
      if (!player.seed) {
        if (player.seedCommit) {
          return {
            success: false,
            error: `Player ${player.address} has not revealed their committed seed`,
          }
        }
        player.seed = generateSeed()
        player.seedCommit = commitSeed(player.seed)
        needsRecompute = true
      } else if (player.seedCommit && stripHex(player.seedCommit) !== commitSeed(player.seed)) {
        return {
          success: false,
          error: `Revealed seed for ${player.address} does not match commitment`,
        }
      }
      if (!player.currentDice) {
        needsRecompute = true
      }
    }
  }
  if (needsRecompute) {
    recomputeRoundDice(state)
  }

  const allCups: Record<string, number[]> = {}
  for (const player of state.players) {
    if (!player.eliminated && player.currentDice) {
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

export interface LiarsDiceRevealVerificationParams {
  serverCommit?: string
  serverSeed?: string
  playerCommits?: Record<string, string>
  playerSeeds?: Record<string, string>
  players?: readonly string[]
  diceCounts?: readonly number[]
  revealedCups?: Record<string, readonly number[]>
  cupCommits?: Record<string, string>
  cupSalts?: Record<string, string>
  roundNumber?: number
  currentBid?: Bid
  challenger?: string
  challengeResult?: LiarsDiceItem['challengeResult']
}

export interface LiarsDiceVerificationResult {
  verified: boolean
  valid: boolean
  reason?: string
}

function invalidLiarsDice(reason: string): LiarsDiceVerificationResult {
  return { verified: false, valid: false, reason }
}

/**
 * Deterministically verifies a Liar's Dice showdown reveal against:
 * 1. `serverCommit === SHA256(serverSeed)`
 * 2. Every active player's `playerCommits[addr] === SHA256(playerSeeds[addr])`
 * 3. Joint multi-party seed derivation (`deriveJointDiceSeed`) and each player's dice roll (`derivePlayerDice`)
 * 4. Optional initial dice cup commitments (`cupCommits`)
 * 5. Challenge resolution math (`countMatchingDice`, `challengerWon`, `loserAddress`)
 */
export function verifyLiarsDiceReveal(
  params: LiarsDiceRevealVerificationParams | LiarsDiceGameState,
): LiarsDiceVerificationResult {
  const serverCommit = params.serverCommit
  const serverSeed = params.serverSeed
  if (!serverCommit || !serverSeed) {
    return invalidLiarsDice('Missing server seed or server commitment')
  }
  if (commitSeed(serverSeed) !== stripHex(serverCommit)) {
    return invalidLiarsDice('Server seed does not match committed hash')
  }

  let activeAddresses: string[] = []
  const diceCountByAddr = new Map<string, number>()
  const commitsByAddr = new Map<string, string>()
  const seedsByAddr = new Map<string, string>()
  const revealedByAddr = new Map<string, readonly number[]>()
  const cupCommitsByAddr = new Map<string, string>()
  const cupSaltsByAddr = new Map<string, string>()

  if ('status' in params && Array.isArray(params.players) && typeof params.players[0] === 'object') {
    const gameState = params as LiarsDiceGameState
    for (const p of gameState.players) {
      const key = p.address.toLowerCase()
      const hadDiceInRound =
        p.currentDice !== undefined ? p.currentDice.length : p.diceCount
      if (hadDiceInRound > 0) {
        activeAddresses.push(p.address)
        diceCountByAddr.set(key, hadDiceInRound)
        if (p.seedCommit) commitsByAddr.set(key, stripHex(p.seedCommit))
        if (p.seed) seedsByAddr.set(key, p.seed)
        if (p.currentDice) revealedByAddr.set(key, p.currentDice)
        if (p.cupCommit) cupCommitsByAddr.set(key, stripHex(p.cupCommit))
        if (p.cupSalt) cupSaltsByAddr.set(key, p.cupSalt)
      }
    }
  } else {
    const p = params as LiarsDiceRevealVerificationParams
    if (p.playerCommits) {
      for (const [k, v] of Object.entries(p.playerCommits)) {
        commitsByAddr.set(k.toLowerCase(), stripHex(v))
      }
    }
    if (p.playerSeeds) {
      for (const [k, v] of Object.entries(p.playerSeeds)) {
        seedsByAddr.set(k.toLowerCase(), v)
      }
    }
    if (p.revealedCups) {
      for (const [k, v] of Object.entries(p.revealedCups)) {
        revealedByAddr.set(k.toLowerCase(), v)
      }
    }
    if (p.cupCommits) {
      for (const [k, v] of Object.entries(p.cupCommits)) {
        cupCommitsByAddr.set(k.toLowerCase(), stripHex(v))
      }
    }
    if (p.cupSalts) {
      for (const [k, v] of Object.entries(p.cupSalts)) {
        cupSaltsByAddr.set(k.toLowerCase(), v)
      }
    }
    if (p.players && p.players.length > 0) {
      activeAddresses = [...p.players]
      p.players.forEach((addr, idx) => {
        const key = addr.toLowerCase()
        const count =
          p.diceCounts?.[idx] ?? revealedByAddr.get(key)?.length ?? DEFAULT_DICE_PER_PLAYER
        if (count > 0) {
          diceCountByAddr.set(key, count)
        }
      })
      activeAddresses = activeAddresses.filter(addr =>
        diceCountByAddr.has(addr.toLowerCase()),
      )
    } else {
      const allKeys = new Set<string>([
        ...commitsByAddr.keys(),
        ...seedsByAddr.keys(),
        ...revealedByAddr.keys(),
      ])
      activeAddresses = [...allKeys]
      for (const key of activeAddresses) {
        const count = revealedByAddr.get(key)?.length ?? DEFAULT_DICE_PER_PLAYER
        diceCountByAddr.set(key, count)
      }
    }
  }

  if (activeAddresses.length === 0) {
    return invalidLiarsDice('No active players to verify')
  }

  const seedsRecord: Record<string, string> = {}
  for (const addr of activeAddresses) {
    const key = addr.toLowerCase()
    const count = diceCountByAddr.get(key) ?? 0
    if (count <= 0) continue
    const commit = commitsByAddr.get(key)
    const seed = seedsByAddr.get(key)
    if (!commit || !seed) {
      return invalidLiarsDice(`Missing seed or commitment for player ${addr}`)
    }
    if (commitSeed(seed) !== stripHex(commit)) {
      return invalidLiarsDice(
        `Revealed seed for player ${addr} does not match commitment`,
      )
    }
    seedsRecord[key] = seed
  }

  const activeOrder = activeAddresses.map(a => a.toLowerCase())
  const jointSeed = deriveJointDiceSeed(serverSeed, seedsRecord, activeOrder)
  const roundNumber = params.roundNumber ?? 1

  const verifiedCups: Record<string, number[]> = {}
  for (const addr of activeAddresses) {
    const key = addr.toLowerCase()
    const count = diceCountByAddr.get(key) ?? 0
    if (count <= 0) continue

    const seed = seedsRecord[key]
    const expectedJointDice = derivePlayerDice(
      serverSeed,
      seed,
      count,
      jointSeed,
      addr,
    )
    const expectedDirectDice = derivePlayerDice(serverSeed, seed, count)

    const revealed = revealedByAddr.get(key)
    if (!revealed) {
      return invalidLiarsDice(`Missing revealed dice cup for player ${addr}`)
    }
    if (revealed.length !== count) {
      return invalidLiarsDice(
        `Revealed dice count (${revealed.length}) does not match expected (${count}) for ${addr}`,
      )
    }

    const sortedRevealed = [...revealed].sort((a, b) => a - b)
    const matchesJoint =
      sortedRevealed.length === expectedJointDice.length &&
      sortedRevealed.every((d, i) => d === expectedJointDice[i])
    const matchesDirect =
      sortedRevealed.length === expectedDirectDice.length &&
      sortedRevealed.every((d, i) => d === expectedDirectDice[i])

    if (!matchesJoint && !matchesDirect) {
      return invalidLiarsDice(
        `Revealed dice for player ${addr} do not match derived dice from committed seeds`,
      )
    }

    const cupCommit = cupCommitsByAddr.get(key)
    if (cupCommit) {
      const salt =
        cupSaltsByAddr.get(key) ??
        sha256Hex(`liars-dice-salt:${jointSeed}:${key}:${roundNumber}`)
      if (!verifyDiceCupCommitment(sortedRevealed, salt, cupCommit)) {
        return invalidLiarsDice(
          `Revealed dice for player ${addr} do not match initial cup commitment`,
        )
      }
    }

    verifiedCups[key] = sortedRevealed
  }

  const challengeResult =
    'challengeResult' in params
      ? params.challengeResult
      : 'lastResolution' in params && params.lastResolution
      ? {
          bidQuantity: params.lastResolution.bid.quantity,
          bidFace: params.lastResolution.bid.face,
          actualCount: params.lastResolution.totalMatchingDice,
          wildAcesCount: params.lastResolution.wildAcesCount,
          challengerWon: params.lastResolution.challengerWon,
          loserAddress: params.lastResolution.loserAddress,
          eliminated: params.lastResolution.eliminated,
        }
      : undefined

  if (challengeResult) {
    const { totalCount, wildAces } = countMatchingDice(
      verifiedCups,
      challengeResult.bidFace,
    )
    if (challengeResult.actualCount !== totalCount) {
      return invalidLiarsDice(
        `Challenge actualCount (${challengeResult.actualCount}) does not match derived count (${totalCount})`,
      )
    }
    if (challengeResult.wildAcesCount !== wildAces) {
      return invalidLiarsDice(
        `Challenge wildAcesCount (${challengeResult.wildAcesCount}) does not match derived wild Aces (${wildAces})`,
      )
    }
    const expectedChallengerWon = totalCount < challengeResult.bidQuantity
    if (challengeResult.challengerWon !== expectedChallengerWon) {
      return invalidLiarsDice('Challenge outcome (challengerWon) does not match dice count')
    }
    const bid = 'currentBid' in params ? params.currentBid : undefined
    const challenger =
      'challenger' in params
        ? params.challenger
        : 'lastResolution' in params
        ? params.lastResolution?.challenger
        : undefined
    if (bid && challenger) {
      const expectedLoser = expectedChallengerWon ? bid.bidder : challenger
      if (challengeResult.loserAddress.toLowerCase() !== expectedLoser.toLowerCase()) {
        return invalidLiarsDice('Challenge loserAddress does not match resolution')
      }
    }
  }

  return { verified: true, valid: true }
}

export type LiarsDiceMessageEnvelope =
  | (LiarsDiceItem & {
      cupCommits?: Record<string, string>
      cupSalts?: Record<string, string>
    })
  | {
      senderAddress?: string
      peerAddress?: string
      items: ReadonlyArray<any>
    }

export interface FoldedLiarsDiceState extends LiarsDiceGameState {
  verified: boolean
  verificationError?: string
}

function extractLiarsDiceItems(
  messages: ReadonlyArray<LiarsDiceMessageEnvelope>,
): Array<{
  item: LiarsDiceItem & {
    cupCommits?: Record<string, string>
    cupSalts?: Record<string, string>
  }
  senderAddress?: string
}> {
  const out: Array<{ item: any; senderAddress?: string }> = []
  for (const msg of messages) {
    if ('type' in msg && msg.type === 'liars-dice') {
      out.push({ item: msg })
    } else if ('items' in msg && Array.isArray(msg.items)) {
      const sender = msg.senderAddress ?? msg.peerAddress
      for (const it of msg.items) {
        if (it && it.type === 'liars-dice') {
          out.push({ item: it, senderAddress: sender })
        }
      }
    }
  }
  return out
}

/**
 * Deterministically folds a sequence of Liar's Dice messages from a mailbox into
 * a reconstructed table state, verifying server and player seed commitments and
 * dice cup reveals at showdown/settlement and flagging any tampered or unverified
 * reveal as `verified: false`.
 */
export function foldLiarsDiceState(
  messages: ReadonlyArray<LiarsDiceMessageEnvelope>,
): FoldedLiarsDiceState | undefined {
  const entries = extractLiarsDiceItems(messages)
  if (entries.length === 0) return undefined

  const first = entries[0].item
  const state: FoldedLiarsDiceState = {
    ...createLiarsDiceGame({
      tableId: first.tableId,
      hostAddress: first.players?.[0] ?? entries[0].senderAddress ?? '0x0',
      buyInWei: first.buyInWei ? BigInt(first.buyInWei) : DEFAULT_BUY_IN_WEI,
      maxPlayers: first.maxPlayers ?? 4,
      dicePerPlayer: first.dicePerPlayer ?? DEFAULT_DICE_PER_PLAYER,
    }),
    serverCommit: '',
    serverSeed: '',
    playerCommits: {},
    playerSeeds: {},
    cupCommits: {},
    cupSalts: {},
    verified: true,
  }

  let roundStartDiceCounts: number[] = []
  let commitmentTampered = false
  let commitmentTamperReason: string | undefined

  const syncPlayersFromItem = (item: LiarsDiceItem) => {
    if (!item.players) return
    item.players.forEach((addr, idx) => {
      const existing = state.players.find(
        p => p.address.toLowerCase() === addr.toLowerCase(),
      )
      const count = item.diceCounts?.[idx] ?? existing?.diceCount ?? state.dicePerPlayer
      if (!existing) {
        state.players.push({
          address: addr,
          diceCount: count,
          eliminated: count <= 0,
        })
      } else {
        existing.diceCount = count
        existing.eliminated = count <= 0
      }
    })
  }

  for (const { item, senderAddress } of entries) {
    if (item.tableId !== state.tableId) continue

    if (item.action === 'create') {
      if (item.buyInWei) state.buyInWei = BigInt(item.buyInWei)
      if (item.maxPlayers) state.maxPlayers = item.maxPlayers
      if (item.dicePerPlayer) state.dicePerPlayer = item.dicePerPlayer
      syncPlayersFromItem(item)
      if (state.players.length === 0 && senderAddress) {
        joinGame(state, senderAddress)
      }
      if (item.potWei) {
        state.potWei = BigInt(item.potWei)
      } else {
        state.potWei = state.buyInWei * BigInt(state.players.length)
      }
      if (item.serverCommit) {
        state.serverCommit = stripHex(item.serverCommit)
      }
      continue
    }

    if (item.action === 'join') {
      syncPlayersFromItem(item)
      if (senderAddress && !state.players.some(p => p.address.toLowerCase() === senderAddress.toLowerCase())) {
        joinGame(state, senderAddress)
      }
      if (item.potWei) {
        state.potWei = BigInt(item.potWei)
      } else {
        state.potWei = state.buyInWei * BigInt(state.players.length)
      }
      continue
    }

    if (item.action === 'round_start') {
      syncPlayersFromItem(item)
      state.roundNumber = item.roundNumber ?? state.roundNumber + 1
      state.status = 'round_active'
      state.currentBid = undefined
      state.lastResolution = undefined
      commitmentTampered = false
      commitmentTamperReason = undefined

      roundStartDiceCounts = state.players.map(p => p.diceCount)

      state.serverCommit = item.serverCommit ? stripHex(item.serverCommit) : ''
      state.serverSeed = ''
      state.playerCommits = {}
      state.playerSeeds = {}
      state.cupCommits = {}
      state.cupSalts = {}

      if (item.playerCommits) {
        for (const [k, v] of Object.entries(item.playerCommits)) {
          state.playerCommits[k.toLowerCase()] = stripHex(v)
        }
      }
      if (item.cupCommits) {
        for (const [k, v] of Object.entries(item.cupCommits)) {
          state.cupCommits[k.toLowerCase()] = stripHex(v)
        }
      }
      for (const p of state.players) {
        const key = p.address.toLowerCase()
        p.seedCommit = state.playerCommits[key]
        p.cupCommit = state.cupCommits[key]
        p.seed = undefined
        p.currentDice = undefined
      }
      if (item.activePlayer) {
        const idx = state.players.findIndex(
          p => p.address.toLowerCase() === item.activePlayer!.toLowerCase(),
        )
        if (idx >= 0) state.turnIndex = idx
      }
      continue
    }

    if (item.action === 'bid') {
      if (item.serverCommit) {
        const norm = stripHex(item.serverCommit)
        if (state.serverCommit && state.serverCommit !== norm) {
          commitmentTampered = true
          commitmentTamperReason = 'Conflicting serverCommit during bidding'
        } else {
          state.serverCommit = norm
        }
      }
      if (item.playerCommits) {
        for (const [k, v] of Object.entries(item.playerCommits)) {
          const key = k.toLowerCase()
          const norm = stripHex(v)
          if (state.playerCommits?.[key] && state.playerCommits[key] !== norm) {
            commitmentTampered = true
            commitmentTamperReason = `Conflicting playerCommit for ${k}`
          } else {
            state.playerCommits![key] = norm
          }
        }
      }
      if (item.currentBid) {
        state.currentBid = {
          bidder: item.currentBid.bidder,
          quantity: item.currentBid.quantity,
          face: item.currentBid.face,
        }
      }
      if (item.activePlayer) {
        const idx = state.players.findIndex(
          p => p.address.toLowerCase() === item.activePlayer!.toLowerCase(),
        )
        if (idx >= 0) state.turnIndex = idx
      }
      continue
    }

    if (item.action === 'challenge') {
      if (item.challenger && state.currentBid) {
        state.lastResolution = {
          bid: state.currentBid,
          challenger: item.challenger,
          totalMatchingDice: 0,
          wildAcesCount: 0,
          challengerWon: false,
          loserAddress: '',
          loserRemainingDice: 0,
          eliminated: false,
        }
      }
      continue
    }

    if (item.action === 'showdown' || item.action === 'settle') {
      if (item.serverCommit) {
        const norm = stripHex(item.serverCommit)
        if (state.serverCommit && state.serverCommit !== norm) {
          commitmentTampered = true
          commitmentTamperReason = 'Showdown serverCommit does not match round_start serverCommit'
        } else if (!state.serverCommit) {
          state.serverCommit = norm
        }
      }
      if (item.playerCommits) {
        for (const [k, v] of Object.entries(item.playerCommits)) {
          const key = k.toLowerCase()
          const norm = stripHex(v)
          if (state.playerCommits?.[key] && state.playerCommits[key] !== norm) {
            commitmentTampered = true
            commitmentTamperReason = `Showdown playerCommit for ${k} does not match round_start commitment`
          } else if (!state.playerCommits?.[key]) {
            state.playerCommits![key] = norm
          }
        }
      }
      if (item.serverSeed) {
        state.serverSeed = item.serverSeed
      }
      if (item.playerSeeds) {
        for (const [k, v] of Object.entries(item.playerSeeds)) {
          state.playerSeeds![k.toLowerCase()] = v
        }
      }
      if (item.cupSalts) {
        for (const [k, v] of Object.entries(item.cupSalts)) {
          state.cupSalts![k.toLowerCase()] = v
        }
      }
      if (item.revealedCups) {
        for (const p of state.players) {
          const cup =
            item.revealedCups[p.address] ??
            item.revealedCups[p.address.toLowerCase()]
          if (cup) {
            p.currentDice = [...cup]
          }
        }
      }

      if (item.challengeResult) {
        const cr = item.challengeResult
        const bid = state.currentBid ?? {
          bidder: cr.challengerWon ? cr.loserAddress : '',
          quantity: cr.bidQuantity,
          face: cr.bidFace,
        }
        const challenger =
          item.challenger ??
          state.lastResolution?.challenger ??
          (cr.challengerWon ? '' : cr.loserAddress)
        const loser = state.players.find(
          p => p.address.toLowerCase() === cr.loserAddress.toLowerCase(),
        )
        const loserRemaining = item.diceCounts && item.players
          ? item.diceCounts[
              item.players.findIndex(
                a => a.toLowerCase() === cr.loserAddress.toLowerCase(),
              )
            ] ?? Math.max(0, (loser?.diceCount ?? 1) - 1)
          : Math.max(0, (loser?.diceCount ?? 1) - 1)

        state.lastResolution = {
          bid,
          challenger,
          totalMatchingDice: cr.actualCount,
          wildAcesCount: cr.wildAcesCount,
          challengerWon: cr.challengerWon,
          loserAddress: cr.loserAddress,
          loserRemainingDice: loserRemaining,
          eliminated: cr.eliminated,
        }
      }

      if (item.action === 'showdown') {
        const preChallengeCounts =
          roundStartDiceCounts.length === state.players.length
            ? roundStartDiceCounts
            : state.players.map(p => p.diceCount)

        if (commitmentTampered) {
          state.verified = false
          state.verificationError = commitmentTamperReason
        } else {
          const check = verifyLiarsDiceReveal({
            serverCommit: state.serverCommit,
            serverSeed: state.serverSeed,
            playerCommits: state.playerCommits,
            playerSeeds: state.playerSeeds,
            players: state.players.map(p => p.address),
            diceCounts: preChallengeCounts,
            revealedCups: item.revealedCups,
            cupCommits: state.cupCommits,
            cupSalts: state.cupSalts,
            roundNumber: state.roundNumber || 1,
            currentBid: state.currentBid,
            challenger: item.challenger ?? state.lastResolution?.challenger,
            challengeResult: item.challengeResult,
          })
          if (!check.verified) {
            state.verified = false
            state.verificationError = check.reason
          }
        }
      }

      syncPlayersFromItem(item)
      if (item.challengeResult && (!item.players || !item.diceCounts)) {
        const loser = state.players.find(
          p =>
            p.address.toLowerCase() ===
            item.challengeResult!.loserAddress.toLowerCase(),
        )
        if (loser) {
          loser.diceCount = Math.max(0, loser.diceCount - 1)
          if (loser.diceCount <= 0 || item.challengeResult.eliminated) {
            loser.eliminated = true
          }
        }
      }

      if (item.winnerAddress) {
        state.winnerAddress = item.winnerAddress
        state.status = 'resolved'
      } else {
        const surviving = state.players.filter(p => !p.eliminated)
        if (surviving.length === 1 && state.players.length >= 2) {
          state.winnerAddress = surviving[0].address
          state.status = 'resolved'
        } else {
          state.status = item.action === 'settle' ? 'resolved' : 'showdown'
        }
      }
      if (item.potWei) state.potWei = BigInt(item.potWei)
    }
  }

  return state
}
