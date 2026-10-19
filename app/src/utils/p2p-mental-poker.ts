/**
 * Peer-to-peer automation & action builders for 1:1 Heads-Up Mental Poker (`mental-poker-v1`, Issue #62).
 *
 * - Derives per-hand SRA / Pohlig-Hellman shuffle and per-card lock scalars deterministically
 *   from the wallet identity private key (with an in-memory + localStorage fallback seed so
 *   reloads never orphan an in-progress hand).
 * - Automatically advances non-monetary cryptographic protocol steps (`lock_and_deal`,
 *   `unlock_hole_cards`, and street/showdown key reveals) via `automaticMentalPokerSteps`.
 * - Provides builders for `challenge`, `accept` (`shuffle_and_lock`), `check`, `call`,
 *   `raise`, `fold`, and `settle`.
 */
import type {
  ApplicationMessageItem,
  MessageItem,
} from '@frank/cashweb/types/messages'
import {
  accepterShuffleAndLockDeck,
  challengerEncryptInitialDeck,
  challengerStripAndLockDeck,
  deriveMentalPokerSecrets,
  extractMentalPokerPayload,
  foldMentalPokerState,
  toMentalPokerApplicationItem,
  type FoldedMentalPokerState,
  type MentalPokerBetSubAction,
  type MentalPokerPayload,
  type MentalPokerRole,
  type MentalPokerSecrets,
} from '@frank/wallet/message-item-plugins/mental-poker'

import { newGameId } from './blackjack-hand'
import { randomHex } from './chat-game-items'
import { messagingWallet } from './identity-session'

export interface P2pMentalPokerChatMessage {
  outbound?: boolean
  status?: string
  items?: readonly MessageItem[]
  stampValueWei?: bigint
  senderAddress?: string
}

export interface AutomaticMentalPokerStep {
  key: string
  handId: string
  payload: MentalPokerPayload
  item: ApplicationMessageItem
}

const memorySeedByHand = new Map<string, string>()

function storageKeyForHand(own: string, peer: string, handId: string): string {
  return `frank:p2p-mental-poker:${(own || 'self').toLowerCase()}:${(
    peer || 'peer'
  ).toLowerCase()}:${handId}`
}

function peerFallbackStorageKey(peer: string, handId: string): string {
  return `frank:p2p-mental-poker:*:${(peer || 'peer').toLowerCase()}:${handId}`
}

function walletPrivateKeyHex(): string | undefined {
  try {
    const wallet = messagingWallet() as {
      identity?: { toPrivateKeyHex?: () => string }
      toPrivateKeyHex?: () => string
    } | null
    return wallet?.identity?.toPrivateKeyHex?.() ?? wallet?.toPrivateKeyHex?.()
  } catch {
    return undefined
  }
}

export function getOrCreateMentalPokerSeedHex(
  handId: string,
  own = '',
  peer = '',
  explicitPrivateKeyHex?: string,
): string {
  if (explicitPrivateKeyHex && explicitPrivateKeyHex.trim().length > 0) {
    return explicitPrivateKeyHex.trim()
  }
  const walletKey = walletPrivateKeyHex()
  if (walletKey) {
    return walletKey
  }

  const primaryKey = storageKeyForHand(own, peer, handId)
  const fallbackKey = peerFallbackStorageKey(peer, handId)
  const mem =
    memorySeedByHand.get(primaryKey) ?? memorySeedByHand.get(fallbackKey)
  if (mem) return mem

  try {
    if (typeof localStorage !== 'undefined') {
      const stored =
        localStorage.getItem(primaryKey) ?? localStorage.getItem(fallbackKey)
      if (stored) {
        memorySeedByHand.set(primaryKey, stored)
        memorySeedByHand.set(fallbackKey, stored)
        return stored
      }
    }
  } catch {
    // localStorage unavailable
  }

  const generated = randomHex(32)
  memorySeedByHand.set(primaryKey, generated)
  memorySeedByHand.set(fallbackKey, generated)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(primaryKey, generated)
      localStorage.setItem(fallbackKey, generated)
    }
  } catch {
    // localStorage unavailable
  }
  return generated
}

export function getOrCreateMentalPokerSecrets(
  handId: string,
  role: MentalPokerRole,
  own = '',
  peer = '',
  explicitPrivateKeyHex?: string,
): MentalPokerSecrets {
  const seedHex = getOrCreateMentalPokerSeedHex(
    handId,
    own,
    peer,
    explicitPrivateKeyHex,
  )
  return deriveMentalPokerSecrets(seedHex, handId, role)
}

function pickKeySubset(
  secrets: MentalPokerSecrets,
  indices: readonly number[],
): Record<number, string> {
  const out: Record<number, string> = {}
  for (const idx of indices) {
    if (secrets.lockScalars[idx]) {
      out[idx] = secrets.lockScalars[idx]
    }
  }
  return out
}

export function buildMentalPokerChallenge(
  params: {
    own?: string
    peer?: string
    stakeWei?: bigint | string
    handId?: string
    privateKeyHex?: string
  } = {},
): {
  handId: string
  stakeWei: bigint
  secrets: MentalPokerSecrets
  payload: MentalPokerPayload
  item: ApplicationMessageItem
} {
  const handId = params.handId ?? newGameId('mp')
  const stakeWei = BigInt(params.stakeWei ?? 0n)
  const secrets = getOrCreateMentalPokerSecrets(
    handId,
    'challenger',
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const deckX = challengerEncryptInitialDeck(secrets)
  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId,
    action: 'challenge',
    actor: 'challenger',
    stakeWei: stakeWei.toString(),
    deckX,
  }
  return {
    handId,
    stakeWei,
    secrets,
    payload,
    item: toMentalPokerApplicationItem(payload),
  }
}

export function buildMentalPokerAccept(params: {
  handId: string
  deckX: readonly string[]
  stakeWei?: bigint | string
  own?: string
  peer?: string
  privateKeyHex?: string
}): {
  handId: string
  stakeWei: bigint
  secrets: MentalPokerSecrets
  payload: MentalPokerPayload
  item: ApplicationMessageItem
} {
  const stakeWei = BigInt(params.stakeWei ?? 0n)
  const secrets = getOrCreateMentalPokerSecrets(
    params.handId,
    'accepter',
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const deckY = accepterShuffleAndLockDeck(params.deckX, secrets)
  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId: params.handId,
    action: 'shuffle_and_lock',
    actor: 'accepter',
    stakeWei: stakeWei.toString(),
    deckY,
  }
  return {
    handId: params.handId,
    stakeWei,
    secrets,
    payload,
    item: toMentalPokerApplicationItem(payload),
  }
}

export function buildMentalPokerLockAndDeal(params: {
  handId: string
  deckY: readonly string[]
  own?: string
  peer?: string
  privateKeyHex?: string
}): {
  handId: string
  payload: MentalPokerPayload
  item: ApplicationMessageItem
} {
  const secrets = getOrCreateMentalPokerSecrets(
    params.handId,
    'challenger',
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const deckZ = challengerStripAndLockDeck(params.deckY, secrets)
  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId: params.handId,
    action: 'lock_and_deal',
    actor: 'challenger',
    deckZ,
    revealedKeysA: pickKeySubset(secrets, [2, 3]),
  }
  return {
    handId: params.handId,
    payload,
    item: toMentalPokerApplicationItem(payload),
  }
}

export function buildMentalPokerUnlockHoleCards(params: {
  handId: string
  own?: string
  peer?: string
  privateKeyHex?: string
}): {
  handId: string
  payload: MentalPokerPayload
  item: ApplicationMessageItem
} {
  const secrets = getOrCreateMentalPokerSecrets(
    params.handId,
    'accepter',
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId: params.handId,
    action: 'unlock_hole_cards',
    actor: 'accepter',
    revealedKeysB: pickKeySubset(secrets, [0, 1]),
  }
  return {
    handId: params.handId,
    payload,
    item: toMentalPokerApplicationItem(payload),
  }
}

export function buildMentalPokerBetAction(params: {
  handId: string
  role: MentalPokerRole
  subAction?: MentalPokerBetSubAction
  amountWei?: bigint | string
  revealIndices?: readonly number[]
  own?: string
  peer?: string
  privateKeyHex?: string
}): {
  handId: string
  payload: MentalPokerPayload
  item: ApplicationMessageItem
} {
  const secrets = getOrCreateMentalPokerSecrets(
    params.handId,
    params.role,
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const revealedKeys =
    params.revealIndices && params.revealIndices.length > 0
      ? pickKeySubset(secrets, params.revealIndices)
      : undefined

  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId: params.handId,
    action: 'bet_action',
    actor: params.role,
    ...(params.subAction ? { subAction: params.subAction } : {}),
    ...(params.amountWei !== undefined
      ? { amountWei: BigInt(params.amountWei).toString() }
      : {}),
    ...(revealedKeys ? { revealedKeys } : {}),
  }

  return {
    handId: params.handId,
    payload,
    item: toMentalPokerApplicationItem(payload),
  }
}

export function buildMentalPokerCheck(params: {
  handId: string
  role: MentalPokerRole
  revealIndices?: readonly number[]
  own?: string
  peer?: string
  privateKeyHex?: string
}) {
  return buildMentalPokerBetAction({
    ...params,
    subAction: 'check',
  })
}

export function buildMentalPokerCall(params: {
  handId: string
  role: MentalPokerRole
  amountWei: bigint | string
  revealIndices?: readonly number[]
  own?: string
  peer?: string
  privateKeyHex?: string
}) {
  return buildMentalPokerBetAction({
    ...params,
    subAction: 'call',
  })
}

export function buildMentalPokerRaise(params: {
  handId: string
  role: MentalPokerRole
  amountWei: bigint | string
  own?: string
  peer?: string
  privateKeyHex?: string
}) {
  return buildMentalPokerBetAction({
    ...params,
    subAction: 'raise',
  })
}

export function buildMentalPokerFold(params: {
  handId: string
  role: MentalPokerRole
  own?: string
  peer?: string
  privateKeyHex?: string
}) {
  return buildMentalPokerBetAction({
    ...params,
    subAction: 'fold',
  })
}

export function buildMentalPokerSettle(params: {
  handId: string
  role: MentalPokerRole
  amountWei: bigint | string
  winnerRole?: MentalPokerRole | 'split'
  revealIndices?: readonly number[]
  own?: string
  peer?: string
  privateKeyHex?: string
}): {
  handId: string
  payload: MentalPokerPayload
  item: ApplicationMessageItem
  amountWei: bigint
} {
  const secrets = getOrCreateMentalPokerSecrets(
    params.handId,
    params.role,
    params.own,
    params.peer,
    params.privateKeyHex,
  )
  const revealedKeys =
    params.revealIndices && params.revealIndices.length > 0
      ? pickKeySubset(secrets, params.revealIndices)
      : undefined
  const amountWei = BigInt(params.amountWei)
  const payload: MentalPokerPayload = {
    schemaVersion: 1,
    handId: params.handId,
    action: 'settle',
    actor: params.role,
    amountWei: amountWei.toString(),
    ...(params.winnerRole ? { winnerRole: params.winnerRole } : {}),
    ...(revealedKeys ? { revealedKeys } : {}),
  }
  return {
    handId: params.handId,
    payload,
    item: toMentalPokerApplicationItem(payload),
    amountWei,
  }
}

export function foldMentalPokerHandForChat(
  messages: readonly P2pMentalPokerChatMessage[],
  handId: string,
  own = '',
  peer = '',
  explicitPrivateKeyHex?: string,
): FoldedMentalPokerState | null {
  let viewerRole: MentalPokerRole = 'challenger'
  const handMessages: P2pMentalPokerChatMessage[] = []

  for (const msg of messages) {
    if (msg.status === 'error') continue
    for (const item of msg.items ?? []) {
      const payload = extractMentalPokerPayload(item)
      if (!payload || payload.handId !== handId) continue
      if (payload.action === 'challenge') {
        viewerRole = msg.outbound ? 'challenger' : 'accepter'
      }
      handMessages.push(msg)
    }
  }

  if (handMessages.length === 0) return null

  const secrets = getOrCreateMentalPokerSecrets(
    handId,
    viewerRole,
    own,
    peer,
    explicitPrivateKeyHex,
  )
  return foldMentalPokerState(handMessages, viewerRole, secrets)
}

export function automaticMentalPokerSteps(
  messages: readonly P2pMentalPokerChatMessage[],
  own = '',
  peer = '',
  explicitPrivateKeyHex?: string,
): AutomaticMentalPokerStep[] {
  const handIds = new Set<string>()
  for (const msg of messages) {
    if (msg.status === 'error') continue
    for (const item of msg.items ?? []) {
      const payload = extractMentalPokerPayload(item)
      if (payload?.handId) {
        handIds.add(payload.handId)
      }
    }
  }

  const steps: AutomaticMentalPokerStep[] = []

  for (const handId of handIds) {
    const state = foldMentalPokerHandForChat(
      messages,
      handId,
      own,
      peer,
      explicitPrivateKeyHex,
    )
    if (!state || state.cheatingDetected || state.settled || state.foldedBy) {
      continue
    }

    // 1. Challenger auto-sends lock_and_deal once Accepter sends shuffle_and_lock (deckY)
    if (
      state.viewerRole === 'challenger' &&
      state.street === 'locking' &&
      state.deckY &&
      !state.deckZ
    ) {
      const built = buildMentalPokerLockAndDeal({
        handId,
        deckY: state.deckY,
        own,
        peer,
        privateKeyHex: explicitPrivateKeyHex,
      })
      steps.push({
        key: `mp:lock_and_deal:${handId}`,
        handId,
        payload: built.payload,
        item: built.item,
      })
      continue
    }

    // 2. Accepter auto-sends unlock_hole_cards once Challenger sends lock_and_deal (deckZ)
    if (
      state.viewerRole === 'accepter' &&
      state.street === 'locking' &&
      state.deckZ &&
      (!state.revealedKeysB[0] || !state.revealedKeysB[1])
    ) {
      const built = buildMentalPokerUnlockHoleCards({
        handId,
        own,
        peer,
        privateKeyHex: explicitPrivateKeyHex,
      })
      steps.push({
        key: `mp:unlock_hole:${handId}`,
        handId,
        payload: built.payload,
        item: built.item,
      })
      continue
    }

    // 3. Either player auto-reveals keys for the next street / showdown once betting closes
    if (state.pendingViewerKeyRevealIndices.length > 0) {
      const indices = state.pendingViewerKeyRevealIndices
      const built = buildMentalPokerBetAction({
        handId,
        role: state.viewerRole,
        revealIndices: indices,
        own,
        peer,
        privateKeyHex: explicitPrivateKeyHex,
      })
      steps.push({
        key: `mp:reveal:${handId}:${indices.join(',')}`,
        handId,
        payload: built.payload,
        item: built.item,
      })
    }
  }

  return steps
}
