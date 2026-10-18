/**
 * Peer-to-peer commit-reveal glue for 1v1 Satoshi Dice (`dice`) and Rock-Paper-Scissors (`rps`).
 *
 * Mirrors `blackjack-hand.ts`:
 * - Secrets/salts are derived deterministically from the wallet identity private key + game ID
 *   (with an in-memory + localStorage fallback when no identity key is present) so page reloads
 *   never orphan an open commitment.
 * - Reveals that owe nothing (`payWei === 0n`: peer lost, or free practice round) are returned by
 *   `automaticP2pGameSteps` so `Chat.vue` sends them automatically.
 * - Reveals that pay money (`payWei > 0n`: peer won or tied a staked round) require the dealer's
 *   explicit confirmation button in `ChatMessageDice.vue` / `ChatMessageRps.vue`.
 */
import type {
  MessageItem,
  RpsItem,
  SatoshiDiceItem,
} from '@frank/cashweb/types/messages'
import { fromHex } from '@frank/codec'
import { sha256Hex } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  diceCommitment,
  diceMultiplier,
  dicePayoutWei,
  diceRoll,
  isDiceTarget,
} from '@frank/wallet/message-item-plugins/dice/fair'
import {
  evaluateRps,
  RPS_MOVES,
  rpsCommitment,
  rpsPayoutWei,
  type RpsMove,
} from '@frank/wallet/message-item-plugins/rps/fair'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { newGameId } from './blackjack-hand'
import { randomHex } from './chat-game-items'
import { messagingWallet } from './monad-identity-session'

export interface P2pGameChatMessage {
  outbound?: boolean
  status?: string
  items?: readonly MessageItem[]
  stampValueWei?: bigint
}

export interface DealerDiceStep {
  key: string
  rollId: string
  luckyNumber: number
  target: number
  isWin: boolean
  wagerWei: bigint
  payWei: bigint
  item: SatoshiDiceItem
  refundItem: SatoshiDiceItem
}

export interface DealerRpsStep {
  key: string
  matchId: string
  ownMove: RpsMove
  peerMove: RpsMove
  outcome: 'win' | 'lose' | 'tie'
  wagerWei: bigint
  payWei: bigint
  item: RpsItem
}

const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()
const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

const memoryDiceSecrets = new Map<string, string>()
const memoryRpsSecrets = new Map<string, { move: RpsMove; salt: string }>()

const diceStorageKey = (own: string, peer: string, rollId: string) =>
  `frank:p2p-dice:${(own || 'self').toLowerCase()}:${peer.toLowerCase()}:${rollId}`

const dicePeerKey = (peer: string, rollId: string) =>
  `frank:p2p-dice:*:${peer.toLowerCase()}:${rollId}`

const rpsStorageKey = (own: string, peer: string, matchId: string) =>
  `frank:p2p-rps:${(own || 'self').toLowerCase()}:${peer.toLowerCase()}:${matchId}`

const rpsPeerKey = (peer: string, matchId: string) =>
  `frank:p2p-rps:*:${peer.toLowerCase()}:${matchId}`

function walletPrivateKeyHex(): string | undefined {
  try {
    const wallet = messagingWallet() as any
    return wallet?.identity?.toPrivateKeyHex?.() ?? wallet?.toPrivateKeyHex?.()
  } catch {
    return undefined
  }
}

export function deriveDiceSecret(
  rollId: string,
  own: string,
  privateKeyHex: string,
): string {
  const ikm = fromHex(privateKeyHex.replace(/^0x/, ''))
  const salt = new TextEncoder().encode(rollId)
  const info = new TextEncoder().encode(`frank-dice-v1:${own.toLowerCase()}`)
  return bytesToHex(hkdf(sha256, ikm, salt, info, 32))
}

export function deriveRpsSalt(
  matchId: string,
  own: string,
  privateKeyHex: string,
): string {
  const ikm = fromHex(privateKeyHex.replace(/^0x/, ''))
  const salt = new TextEncoder().encode(matchId)
  const info = new TextEncoder().encode(`frank-rps-v1:${own.toLowerCase()}`)
  return bytesToHex(hkdf(sha256, ikm, salt, info, 16))
}

export function newDiceSecret(rollId: string, own?: string): string {
  if (own) {
    const priv = walletPrivateKeyHex()
    if (priv) return deriveDiceSecret(rollId, own, priv)
  }
  return randomHex(32)
}

export function newRpsSalt(matchId: string, own?: string): string {
  if (own) {
    const priv = walletPrivateKeyHex()
    if (priv) return deriveRpsSalt(matchId, own, priv)
  }
  return randomHex(16)
}

export function saveDiceSecret(
  own: string,
  peer: string,
  rollId: string,
  secret: string,
): void {
  const normalized = strip(secret)
  const key = diceStorageKey(own, peer, rollId)
  const pKey = dicePeerKey(peer, rollId)
  memoryDiceSecrets.set(key, normalized)
  memoryDiceSecrets.set(pKey, normalized)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, normalized)
      localStorage.setItem(pKey, normalized)
    }
  } catch {
    // Ignore storage quota/availability errors in headless environments
  }
}

export function loadDiceSecret(
  own: string,
  peer: string,
  rollId: string,
): string | undefined {
  const key = diceStorageKey(own, peer, rollId)
  const pKey = dicePeerKey(peer, rollId)
  const mem = memoryDiceSecrets.get(key) ?? memoryDiceSecrets.get(pKey)
  if (mem) return mem
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(key) ?? localStorage.getItem(pKey)
      if (stored) {
        memoryDiceSecrets.set(key, stored)
        memoryDiceSecrets.set(pKey, stored)
        return stored
      }
    }
  } catch {
    // Ignore
  }
  const priv = walletPrivateKeyHex()
  if (priv && own) {
    const derived = deriveDiceSecret(rollId, own, priv)
    memoryDiceSecrets.set(key, derived)
    memoryDiceSecrets.set(pKey, derived)
    return derived
  }
  return undefined
}

export function saveRpsSecret(
  own: string,
  peer: string,
  matchId: string,
  move: RpsMove,
  salt: string,
): void {
  const normalizedSalt = strip(salt)
  const key = rpsStorageKey(own, peer, matchId)
  const pKey = rpsPeerKey(peer, matchId)
  const entry = { move, salt: normalizedSalt }
  memoryRpsSecrets.set(key, entry)
  memoryRpsSecrets.set(pKey, entry)
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.stringify(entry)
      localStorage.setItem(key, raw)
      localStorage.setItem(pKey, raw)
    }
  } catch {
    // Ignore
  }
}

export function loadRpsSecret(
  own: string,
  peer: string,
  matchId: string,
  commitHash?: string,
): { move: RpsMove; salt: string } | undefined {
  const key = rpsStorageKey(own, peer, matchId)
  const pKey = rpsPeerKey(peer, matchId)
  const mem = memoryRpsSecrets.get(key) ?? memoryRpsSecrets.get(pKey)
  if (mem) return mem
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key) ?? localStorage.getItem(pKey)
      if (raw) {
        const parsed = JSON.parse(raw) as { move: RpsMove; salt: string }
        if (parsed && RPS_MOVES.includes(parsed.move) && parsed.salt) {
          memoryRpsSecrets.set(key, parsed)
          memoryRpsSecrets.set(pKey, parsed)
          return parsed
        }
      }
    }
  } catch {
    // Ignore
  }
  const priv = walletPrivateKeyHex()
  if (priv && own && commitHash) {
    const salt = deriveRpsSalt(matchId, own, priv)
    const targetCommit = strip(commitHash)
    const move = RPS_MOVES.find(m => rpsCommitment(m, salt) === targetCommit)
    if (move) {
      const entry = { move, salt }
      memoryRpsSecrets.set(key, entry)
      memoryRpsSecrets.set(pKey, entry)
      return entry
    }
  }
  return undefined
}

export function buildDiceChallenge(
  own: string,
  peer: string,
  rollId: string = newGameId(),
): { item: SatoshiDiceItem; secret: string } {
  const secret = newDiceSecret(rollId, own)
  saveDiceSecret(own, peer, rollId, secret)
  return {
    secret,
    item: {
      type: 'dice',
      action: 'table',
      rollId,
      commitment: diceCommitment(secret),
    },
  }
}

export function buildRpsChallenge(
  own: string,
  peer: string,
  move: RpsMove,
  matchId: string = newGameId(),
  wagerWei?: bigint,
): { item: RpsItem; move: RpsMove; salt: string } {
  const salt = newRpsSalt(matchId, own)
  saveRpsSecret(own, peer, matchId, move, salt)
  const peerTrimmed = peer.trim()
  const isEvmPeer = /^0x[0-9a-fA-F]{40}$/.test(peerTrimmed)
  return {
    move,
    salt,
    item: {
      type: 'rps',
      action: 'start',
      matchId,
      commitHash: rpsCommitment(move, salt),
      ...(wagerWei !== undefined ? { wagerWei: wagerWei.toString() } : {}),
      ...(isEvmPeer ? { opponentAddress: peerTrimmed } : {}),
    },
  }
}

export function clearP2pGameSecretsForTests(): void {
  memoryDiceSecrets.clear()
  memoryRpsSecrets.clear()
}

export function dealerDiceStepForRoll(
  messages: readonly P2pGameChatMessage[],
  own: string,
  peer: string,
  rollId: string,
): DealerDiceStep | undefined {
  if (!rollId) return undefined

  let offeredCommitment: string | undefined
  let betItem: SatoshiDiceItem | undefined
  let alreadyAnswered = false

  for (const msg of messages) {
    for (const item of msg.items ?? []) {
      if (item.type !== 'dice') continue
      if (msg.outbound) {
        if (item.action === 'table' && item.rollId === rollId) {
          offeredCommitment = item.commitment
        } else if (item.action === 'result' && item.nextRollId === rollId) {
          offeredCommitment = item.nextCommitment
        } else if (
          (item.action === 'result' || item.action === 'rejected') &&
          item.rollId === rollId
        ) {
          alreadyAnswered = true
        }
      } else if (item.action === 'roll' && item.rollId === rollId && !betItem) {
        betItem = item
      }
    }
  }

  if (!offeredCommitment || !betItem || alreadyAnswered) return undefined

  const secret = loadDiceSecret(own, peer, rollId)
  if (!secret) return undefined
  const commitment = diceCommitment(secret)
  if (
    strip(offeredCommitment) !== commitment ||
    !betItem.commitment ||
    strip(betItem.commitment) !== commitment
  ) {
    return undefined
  }
  const clientSeed = (betItem.clientSeed ?? '').toLowerCase()
  if (!/^(?:[0-9a-f]{2}){8,64}$/.test(clientSeed)) return undefined
  if (!isDiceTarget(betItem.target)) return undefined

  let wagerWei: bigint
  try {
    wagerWei = BigInt(betItem.wagerWei ?? '0')
  } catch {
    return undefined
  }
  if (wagerWei < 0n) return undefined

  const luckyNumber = diceRoll(secret, clientSeed)
  const isWin = luckyNumber < betItem.target
  const payWei = isWin ? dicePayoutWei(wagerWei, betItem.target) : 0n

  const nextRollId = sha256Hex(`frank-dice-next:${rollId}`).slice(0, 32)
  const nextSecret =
    loadDiceSecret(own, peer, nextRollId) ?? newDiceSecret(nextRollId, own)
  saveDiceSecret(own, peer, nextRollId, nextSecret)

  return {
    key: `dice:${rollId}`,
    rollId,
    luckyNumber,
    target: betItem.target,
    isWin,
    wagerWei,
    payWei,
    item: {
      type: 'dice',
      action: 'result',
      rollId,
      commitment,
      clientSeed,
      target: betItem.target,
      multiplier: diceMultiplier(betItem.target),
      wagerWei: wagerWei.toString(),
      serverSecret: secret,
      luckyNumber,
      isWin,
      payoutWei: payWei.toString(),
      nextRollId,
      nextCommitment: diceCommitment(nextSecret),
    },
    refundItem: {
      type: 'dice',
      action: 'rejected',
      rollId,
      rejectionReason: 'payout-limit',
    },
  }
}

export function dealerRpsStepForMatch(
  messages: readonly P2pGameChatMessage[],
  own: string,
  peer: string,
  matchId: string,
): DealerRpsStep | undefined {
  if (!matchId) return undefined

  let offeredCommitHash: string | undefined
  let offeredWagerWei: bigint | undefined
  let moveItem: RpsItem | undefined
  let alreadyResolved = false

  for (const msg of messages) {
    for (const item of msg.items ?? []) {
      if (item.type !== 'rps') continue
      if (msg.outbound) {
        if (item.action === 'start' && item.matchId === matchId) {
          offeredCommitHash = item.commitHash
          if (item.wagerWei !== undefined) {
            try {
              offeredWagerWei = BigInt(item.wagerWei)
            } catch {
              offeredWagerWei = undefined
            }
          }
        } else if (item.action === 'resolve' && item.matchId === matchId) {
          alreadyResolved = true
        }
      } else if (
        item.action === 'move' &&
        item.matchId === matchId &&
        !moveItem
      ) {
        moveItem = item
      }
    }
  }

  if (!offeredCommitHash || !moveItem || alreadyResolved) return undefined

  const secret = loadRpsSecret(own, peer, matchId, offeredCommitHash)
  if (!secret) return undefined
  const commitHash = rpsCommitment(secret.move, secret.salt)
  if (
    strip(offeredCommitHash) !== commitHash ||
    !moveItem.commitHash ||
    strip(moveItem.commitHash) !== commitHash
  ) {
    return undefined
  }
  const playerMove = moveItem.playerMove
  if (!playerMove || !RPS_MOVES.includes(playerMove)) return undefined

  let wagerWei: bigint
  try {
    wagerWei = BigInt(moveItem.wagerWei ?? '0')
  } catch {
    return undefined
  }
  if (wagerWei < 0n) return undefined
  if (offeredWagerWei !== undefined && wagerWei !== offeredWagerWei) {
    return undefined
  }

  const outcome = evaluateRps(playerMove, secret.move)
  const payWei = rpsPayoutWei(wagerWei, outcome)

  return {
    key: `rps:${matchId}`,
    matchId,
    ownMove: secret.move,
    peerMove: playerMove,
    outcome,
    wagerWei,
    payWei,
    item: {
      type: 'rps',
      action: 'resolve',
      matchId,
      commitHash,
      playerMove,
      botMove: secret.move,
      secretSalt: secret.salt,
      wagerWei: wagerWei.toString(),
      outcome,
    },
  }
}

export function automaticP2pGameSteps(
  messages: readonly P2pGameChatMessage[],
  own: string,
  peer: string,
): { key: string; item: MessageItem }[] {
  const steps: { key: string; item: MessageItem }[] = []
  const seenDice = new Set<string>()
  const seenRps = new Set<string>()

  for (const msg of messages) {
    if (msg.outbound) continue
    for (const item of msg.items ?? []) {
      if (item.type === 'dice' && item.action === 'roll' && item.rollId) {
        if (seenDice.has(item.rollId)) continue
        seenDice.add(item.rollId)
        const step = dealerDiceStepForRoll(messages, own, peer, item.rollId)
        if (step && step.payWei === 0n) {
          steps.push({ key: step.key, item: step.item })
        }
      } else if (
        item.type === 'rps' &&
        item.action === 'move' &&
        item.matchId
      ) {
        if (seenRps.has(item.matchId)) continue
        seenRps.add(item.matchId)
        const step = dealerRpsStepForMatch(messages, own, peer, item.matchId)
        if (step && step.payWei === 0n) {
          steps.push({ key: step.key, item: step.item })
        }
      }
    }
  }

  return steps
}
