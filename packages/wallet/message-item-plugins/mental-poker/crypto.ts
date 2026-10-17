/**
 * Commutative Mental Poker Cryptography over secp256k1 (Issue #62).
 *
 * Implements the Shamir-Rivest-Adleman (SRA) / Pohlig-Hellman commutative
 * card encryption scheme using scalar multiplication over secp256k1:
 *
 * 1. Each canonical card c in 0..51 maps deterministically to a generator
 *    point P_c = scalar_c * G on secp256k1 (33-byte compressed hex).
 * 2. Challenger (Alice) permutes the 52 card points by pi_A and locks all
 *    cards with a deck-wide secret scalar s_A:
 *      X_j = s_A * P_{pi_A[j]}
 * 3. Accepter (Bob) verifies X contains 52 distinct valid curve points,
 *    permutes X by pi_B, and locks each card i with an independent per-card
 *    secret scalar k_{B,i}:
 *      Y_i = k_{B,i} * X_{pi_B[i]} = (k_{B,i} * s_A mod n) * P_{card_i}
 * 4. Challenger (Alice) verifies Y contains 52 distinct valid curve points,
 *    strips her deck-wide scalar s_A, and locks each card i with an
 *    independent per-card secret scalar k_{A,i}:
 *      Z_i = (k_{A,i} * s_A^{-1} mod n) * Y_i
 *          = (k_{A,i} * k_{B,i} mod n) * P_{card_i}
 * 5. To reveal card i to a player, the counterparty reveals their per-card
 *    scalar for index i. Only when both k_{A,i} and k_{B,i} are known can
 *    anyone compute:
 *      P_{card_i} = (k_{A,i} * k_{B,i})^{-1} mod n * Z_i
 */
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

import {
  evaluate5CardHand,
  evaluate7CardHand,
  HandCategory,
  type HandEvaluation,
} from '../poker/evaluator'

export { evaluate5CardHand, evaluate7CardHand, HandCategory, type HandEvaluation }

export type MentalPokerRole = 'challenger' | 'accepter'

export const DECK_SIZE = 52 as const

/** Canonical 52-card deck indices 0..51. */
export const FULL_DECK: readonly number[] = Object.freeze(
  Array.from({ length: DECK_SIZE }, (_, i) => i),
)

const CURVE_N = secp256k1.CURVE.n
const DOMAIN_PREFIX = 'frank-mental-poker-v1'
const utf8Encoder = new TextEncoder()

function utf8Bytes(text: string): Uint8Array {
  return utf8Encoder.encode(text)
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').trim().toLowerCase()
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new TypeError('Expected valid even-length hex string')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n
  for (let i = 0; i < bytes.length; i += 1) {
    result = (result << 8n) | BigInt(bytes[i])
  }
  return result
}

function scalarToHex(scalar: bigint): string {
  const normalized = ((scalar % CURVE_N) + CURVE_N) % CURVE_N
  if (normalized === 0n) {
    throw new RangeError('Mental poker scalar must be non-zero modulo curve order')
  }
  return normalized.toString(16).padStart(64, '0')
}

export function parseScalar(scalar: string | bigint): bigint {
  if (typeof scalar === 'bigint') {
    if (scalar <= 0n || scalar >= CURVE_N) {
      throw new RangeError('Scalar out of secp256k1 range [1, n-1]')
    }
    return scalar
  }
  if (typeof scalar !== 'string') {
    throw new TypeError('Scalar must be a hex string or bigint')
  }
  const clean = scalar.replace(/^0x/i, '').trim().toLowerCase()
  if (!/^[0-9a-f]{1,64}$/.test(clean)) {
    throw new TypeError('Scalar must be a 1..64 char hex string')
  }
  const value = BigInt(`0x${clean}`)
  if (value <= 0n || value >= CURVE_N) {
    throw new RangeError('Scalar out of secp256k1 range [1, n-1]')
  }
  return value
}

export function isValidScalarHex(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    return false
  }
  try {
    parseScalar(value)
    return true
  } catch {
    return false
  }
}

export function isValidCompressedPointHex(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/.test(value)) {
    return false
  }
  try {
    const pt = secp256k1.ProjectivePoint.fromHex(value)
    return !pt.equals(secp256k1.ProjectivePoint.ZERO)
  } catch {
    return false
  }
}

/**
 * Extended Euclidean Algorithm modular inverse: computes a^{-1} mod m.
 */
export function modInverse(a: bigint, m: bigint = CURVE_N): bigint {
  let t = 0n
  let newT = 1n
  let r = m
  let newR = ((a % m) + m) % m

  if (newR === 0n) {
    throw new RangeError('Cannot invert zero modulo curve order')
  }

  while (newR !== 0n) {
    const quotient = r / newR
    ;[t, newT] = [newT, t - quotient * newT]
    ;[r, newR] = [newR, r - quotient * newR]
  }

  if (r > 1n) {
    throw new RangeError('Value is not invertible modulo curve order')
  }
  if (t < 0n) {
    t += m
  }
  return t
}

function hashToNonZeroScalar(input: Uint8Array): bigint {
  const digest = sha256(input)
  return (bytesToBigInt(digest) % (CURVE_N - 1n)) + 1n
}

/**
 * Deterministically maps each card index 0..51 to a secp256k1 generator point P_c.
 */
const BASE_CARD_POINTS: readonly string[] = Object.freeze(
  FULL_DECK.map(card => {
    const scalar = hashToNonZeroScalar(
      utf8Bytes(`${DOMAIN_PREFIX}:base-card-point:${card}`),
    )
    return secp256k1.ProjectivePoint.BASE.multiply(scalar).toHex(true)
  }),
)

const POINT_TO_CARD = new Map<string, number>(
  BASE_CARD_POINTS.map((pointHex, card) => [pointHex, card]),
)

export function getCardBasePoint(card: number): string {
  if (!Number.isInteger(card) || card < 0 || card >= DECK_SIZE) {
    throw new RangeError(`Card index must be an integer in 0..51, got ${card}`)
  }
  return BASE_CARD_POINTS[card]
}

export function getAllCardBasePoints(): readonly string[] {
  return BASE_CARD_POINTS
}

export interface MentalPokerSecrets {
  handId: string
  role: MentalPokerRole
  /** 64-char hex scalar s in Z_n^* used for initial deck encryption. */
  shuffleScalar: string
  /** 52 64-char hex scalars k_0..k_51 in Z_n^* locking each position in the shuffled deck. */
  lockScalars: string[]
  /** Deterministic permutation of 0..51. */
  permutation: number[]
}

function normalizePrivateKeyInput(walletPrivateKey: string | Uint8Array): Uint8Array {
  if (walletPrivateKey instanceof Uint8Array) {
    if (walletPrivateKey.byteLength === 0) {
      throw new TypeError('walletPrivateKey must not be empty')
    }
    return walletPrivateKey
  }
  if (typeof walletPrivateKey === 'string') {
    const trimmed = walletPrivateKey.trim()
    if (trimmed.length === 0) {
      throw new TypeError('walletPrivateKey must not be empty')
    }
    const cleanHex = trimmed.replace(/^0x/i, '')
    if (cleanHex.length % 2 === 0 && /^[0-9a-f]+$/i.test(cleanHex)) {
      return hexToBytes(cleanHex)
    }
    return utf8Bytes(trimmed)
  }
  throw new TypeError('walletPrivateKey must be a hex string or Uint8Array')
}

function derivePermutationFromSeed(seed: Uint8Array): number[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i)
  let counter = 0

  const nextByte = (): number => {
    const block = sha256(
      utf8Bytes(`${DOMAIN_PREFIX}:perm:${bytesToHex(seed)}:${counter}`),
    )
    counter += 1
    return block[0]
  }

  for (let i = DECK_SIZE - 1; i > 0; i -= 1) {
    const range = i + 1
    const limit = Math.floor(256 / range) * range
    let candidate = nextByte()
    while (candidate >= limit) {
      candidate = nextByte()
    }
    const j = candidate % range
    const tmp = deck[i]
    deck[i] = deck[j]
    deck[j] = tmp
  }

  return deck
}

/**
 * Deterministically derives the mental poker secrets (deck-wide shuffle scalar,
 * 52 per-card lock scalars, and a 52-card Fisher-Yates permutation) from the
 * player's wallet key, handId, and role via HKDF-SHA256.
 */
export function deriveMentalPokerSecrets(
  walletPrivateKey: string | Uint8Array,
  handId: string,
  role: MentalPokerRole,
): MentalPokerSecrets {
  if (typeof handId !== 'string' || handId.trim().length === 0) {
    throw new TypeError('handId must be a non-empty string')
  }
  if (role !== 'challenger' && role !== 'accepter') {
    throw new TypeError(`Invalid mental poker role: ${String(role)}`)
  }

  const ikm = normalizePrivateKeyInput(walletPrivateKey)
  const salt = sha256(utf8Bytes(`${DOMAIN_PREFIX}:hand:${handId.trim()}`))

  const shuffleKeyBytes = hkdf(
    sha256,
    ikm,
    salt,
    utf8Bytes(`${DOMAIN_PREFIX}:${role}:shuffle-scalar`),
    32,
  )
  const shuffleScalar = scalarToHex(hashToNonZeroScalar(shuffleKeyBytes))

  const lockScalars: string[] = []
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const cardKeyBytes = hkdf(
      sha256,
      ikm,
      salt,
      utf8Bytes(`${DOMAIN_PREFIX}:${role}:lock-scalar:${i}`),
      32,
    )
    lockScalars.push(scalarToHex(hashToNonZeroScalar(cardKeyBytes)))
  }

  const permSeed = hkdf(
    sha256,
    ikm,
    salt,
    utf8Bytes(`${DOMAIN_PREFIX}:${role}:permutation`),
    32,
  )
  const permutation = derivePermutationFromSeed(permSeed)

  return {
    handId: handId.trim(),
    role,
    shuffleScalar,
    lockScalars,
    permutation,
  }
}

export type Secp256k1Point = ReturnType<typeof secp256k1.ProjectivePoint.fromHex>

/**
 * Validates that a deck is an array of 52 distinct valid compressed secp256k1 points.
 */
export function assertValidEncryptedDeck(
  deck: readonly string[],
  label = 'deck',
): Secp256k1Point[] {
  if (!Array.isArray(deck) || deck.length !== DECK_SIZE) {
    throw new TypeError(`${label} must contain exactly ${DECK_SIZE} curve points`)
  }
  const seen = new Set<string>()
  const points: Secp256k1Point[] = []

  for (let i = 0; i < DECK_SIZE; i += 1) {
    const raw = deck[i]
    if (!isValidCompressedPointHex(raw)) {
      throw new TypeError(`${label}[${i}] is not a valid compressed secp256k1 point`)
    }
    const pt = secp256k1.ProjectivePoint.fromHex(raw)
    const normalizedHex = pt.toHex(true)
    if (seen.has(normalizedHex)) {
      throw new TypeError(`${label} contains duplicate curve point at index ${i}`)
    }
    seen.add(normalizedHex)
    points.push(pt)
  }

  return points
}

function assertValidPermutation(permutation: readonly number[]): void {
  if (!Array.isArray(permutation) || permutation.length !== DECK_SIZE) {
    throw new TypeError(`Permutation must have length ${DECK_SIZE}`)
  }
  const seen = new Set<number>()
  for (const idx of permutation) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= DECK_SIZE || seen.has(idx)) {
      throw new TypeError('Permutation must be a bijection over 0..51')
    }
    seen.add(idx)
  }
}

/**
 * Step 1 (Challenger / Alice):
 * Permutes the 52 canonical card points by secretsA.permutation and multiplies
 * each by secretsA.shuffleScalar (s_A), returning 52 compressed points X_{0..51}.
 */
export function challengerEncryptInitialDeck(
  secretsA: Pick<MentalPokerSecrets, 'shuffleScalar' | 'permutation'>,
): string[] {
  assertValidPermutation(secretsA.permutation)
  const sA = parseScalar(secretsA.shuffleScalar)

  return secretsA.permutation.map(cardIndex => {
    const baseHex = getCardBasePoint(cardIndex)
    const pt = secp256k1.ProjectivePoint.fromHex(baseHex)
    return pt.multiply(sA).toHex(true)
  })
}

/**
 * Step 2 (Accepter / Bob):
 * Verifies X contains 52 distinct valid curve points, permutes X by
 * secretsB.permutation, and multiplies each resulting point i by
 * secretsB.lockScalars[i] (k_{B,i}), returning 52 compressed points Y_{0..51}.
 */
export function accepterShuffleAndLockDeck(
  deckX: readonly string[],
  secretsB: Pick<MentalPokerSecrets, 'lockScalars' | 'permutation'>,
): string[] {
  const pointsX = assertValidEncryptedDeck(deckX, 'deckX')
  assertValidPermutation(secretsB.permutation)
  if (!Array.isArray(secretsB.lockScalars) || secretsB.lockScalars.length !== DECK_SIZE) {
    throw new TypeError(`lockScalars must contain ${DECK_SIZE} scalars`)
  }

  const deckY: string[] = []
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const sourceIdx = secretsB.permutation[i]
    const kBi = parseScalar(secretsB.lockScalars[i])
    const lockedPoint = pointsX[sourceIdx].multiply(kBi)
    deckY.push(lockedPoint.toHex(true))
  }

  assertValidEncryptedDeck(deckY, 'deckY')
  return deckY
}

/**
 * Step 3 (Challenger / Alice):
 * Verifies Y contains 52 distinct valid curve points, strips s_A and applies
 * per-card lock scalar k_{A,i} by multiplying Y_i by (k_{A,i} * s_A^{-1} mod n),
 * returning the final double-locked deck Z_{0..51}.
 */
export function challengerStripAndLockDeck(
  deckY: readonly string[],
  secretsA: Pick<MentalPokerSecrets, 'shuffleScalar' | 'lockScalars'>,
): string[] {
  const pointsY = assertValidEncryptedDeck(deckY, 'deckY')
  if (!Array.isArray(secretsA.lockScalars) || secretsA.lockScalars.length !== DECK_SIZE) {
    throw new TypeError(`lockScalars must contain ${DECK_SIZE} scalars`)
  }

  const sA = parseScalar(secretsA.shuffleScalar)
  const sAInv = modInverse(sA, CURVE_N)

  const deckZ: string[] = []
  for (let i = 0; i < DECK_SIZE; i += 1) {
    const kAi = parseScalar(secretsA.lockScalars[i])
    const combinedScalar = (kAi * sAInv) % CURVE_N
    if (combinedScalar === 0n) {
      throw new RangeError('Combined strip-and-lock scalar became zero')
    }
    const lockedPoint = pointsY[i].multiply(combinedScalar)
    deckZ.push(lockedPoint.toHex(true))
  }

  assertValidEncryptedDeck(deckZ, 'deckZ')
  return deckZ
}

/**
 * Decrypts a single double-locked card Z_i given both players' per-card lock
 * scalars scalarA_i and scalarB_i.
 *
 * Computes ((scalarA_i * scalarB_i)^{-1} mod n) * Z_i and looks up the resulting
 * point in the 52 canonical card generator points. Returns the card index 0..51,
 * or null if the unlocked point does not match any canonical card.
 */
export function decryptLockedCard(
  lockedPointZ: string,
  scalarA: string | bigint,
  scalarB: string | bigint,
): number | null {
  try {
    if (!isValidCompressedPointHex(lockedPointZ)) {
      return null
    }
    const pointZ = secp256k1.ProjectivePoint.fromHex(lockedPointZ)
    const kA = parseScalar(scalarA)
    const kB = parseScalar(scalarB)
    const product = (kA * kB) % CURVE_N
    const invProduct = modInverse(product, CURVE_N)
    const unlockedHex = pointZ.multiply(invProduct).toHex(true)
    const card = POINT_TO_CARD.get(unlockedHex)
    return card !== undefined ? card : null
  } catch {
    return null
  }
}

/**
 * Verifies that unlocking Z_i with (scalarA, scalarB) yields expectedCard.
 */
export function verifyLockedCardKey(
  lockedPointZ: string,
  scalarA: string | bigint,
  scalarB: string | bigint,
  expectedCard: number,
): boolean {
  if (!Number.isInteger(expectedCard) || expectedCard < 0 || expectedCard >= DECK_SIZE) {
    return false
  }
  return decryptLockedCard(lockedPointZ, scalarA, scalarB) === expectedCard
}

/**
 * Evaluates the best 5-card Texas Hold'em hand from 5..7 cards.
 */
export function evaluateBest7CardHand(cards: readonly number[]): HandEvaluation {
  return evaluate7CardHand([...cards])
}

/**
 * Compares two 7-card hands or HandEvaluations.
 * Returns 1 if handA > handB, -1 if handA < handB, or 0 on a tie (split pot).
 */
export function compareHandRanks(
  handA: HandEvaluation | readonly number[],
  handB: HandEvaluation | readonly number[],
): number {
  const evalA = 'score' in handA ? handA : evaluateBest7CardHand(handA)
  const evalB = 'score' in handB ? handB : evaluateBest7CardHand(handB)
  if (evalA.score > evalB.score) return 1
  if (evalA.score < evalB.score) return -1
  return 0
}
