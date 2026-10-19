/**
 * Zero-backend Ephemeral Bearer Claim Links (Issue #1706).
 *
 * Implements the `https://signet.mx/#claim=<token>` viral onboarding protocol:
 * - Deterministic secp256k1 bearer account, ChaCha20-Poly1305 AEAD metadata key,
 *   and public claim ID derived via HKDF-SHA256 from a 16-byte or 32-byte random seed.
 * - URL fragment (`#claim=...`) placement guarantees the bearer secret is never sent
 *   over HTTP request paths, query strings, or Referer headers.
 * - Gas + first-reply stamp reserve math so newly onboarded recipients can sweep
 *   funds and immediately send stamped replies without an external faucet.
 * - Multi-device claim deduplication and sender clawback state evaluation.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

export const CLAIM_LINK_VERSION = 1 as const
export const CLAIM_HASH_PARAM = 'claim' as const
export const DEFAULT_CLAIM_BASE_URL = 'https://signet.mx/' as const
export const DEFAULT_CLAIM_CHAIN_KEY = 'monad' as const
export const DEFAULT_SWEEP_GAS_LIMIT = 21_000n

const HKDF_SALT = utf8ToBytes('frank-claim-link-v1')
const INFO_PRIVKEY = utf8ToBytes('secp256k1-privkey')
const INFO_AEAD_KEY = utf8ToBytes('welcome-note-aead')
const INFO_AEAD_NONCE = utf8ToBytes('welcome-note-nonce')
const INFO_CLAIM_ID = utf8ToBytes('claim-id')

const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export interface ClaimLinkParams {
  version: 1
  seedBytes: Uint8Array
  chainKey: string
  senderAddress: string
  senderName?: string
  amountAtomic: bigint
  note?: string
  createdAtMs: number
  expiresAtMs?: number
}

export interface DerivedClaimBearerAccount {
  /** 32-byte secp256k1 private key hex derived via HKDF-SHA256. */
  privateKeyHex: string
  /** Compressed 33-byte secp256k1 public key hex. */
  publicKeyHex: string
  /** EIP-55 checksummed 0x... EVM address derived via keccak_256. */
  evmAddress: string
  /** 32-byte ChaCha20-Poly1305 key derived via HKDF-SHA256. */
  noteEncryptionKey: Uint8Array
  /** 16-byte public claim identifier hex derived via HKDF-SHA256. */
  claimIdHex: string
}

export interface ClaimLinkMetadata {
  version: 1
  chainKey: string
  senderAddress: string
  senderName?: string
  amountAtomic: bigint
  note?: string
  createdAtMs: number
  expiresAtMs?: number
}

export interface CreatedClaimLink {
  url: string
  fragmentToken: string
  bearerAccount: DerivedClaimBearerAccount
  metadata: ClaimLinkMetadata
}

export interface ParsedClaimLink extends ClaimLinkMetadata {
  bearerAccount: DerivedClaimBearerAccount
  seedBytes: Uint8Array
}

export interface ClaimFundingBreakdown {
  giftAmountWei: bigint
  gasPriceWei: bigint
  sweepGasLimit: bigint
  sweepFeeReserveWei: bigint
  replyStampReserveWei: bigint
  totalFundingRequiredWei: bigint
  netSweepableAmountWei: (
    observedBalanceWei: bigint,
    currentGasPriceWei?: bigint,
    sweepGasLimit?: bigint,
  ) => bigint
}

export type ClaimBearerStatus =
  | 'claimable'
  | 'already_claimed'
  | 'empty_or_swept'
  | 'expired_clawback_eligible'

export interface ClaimBearerStateEvaluation {
  status: ClaimBearerStatus
  netSweepableWei: bigint
  canRecipientClaim: boolean
  canSenderClawback: boolean
}

function csprngBytes(length: number): Uint8Array {
  const host = (
    globalThis as {
      crypto?: { getRandomValues?: (out: Uint8Array) => Uint8Array }
    }
  ).crypto
  if (!host || typeof host.getRandomValues !== 'function') {
    throw new Error('claim-link: crypto.getRandomValues is unavailable')
  }
  const out = new Uint8Array(length)
  host.getRandomValues(out)
  return out
}

function toEip55Address(rawAddressLowerHex: string): string {
  const clean = rawAddressLowerHex.toLowerCase()
  const hashHex = bytesToHex(keccak_256(utf8ToBytes(clean)))
  let checksummed = '0x'
  for (let i = 0; i < 40; i++) {
    const ch = clean[i]
    const hashNibble = parseInt(hashHex[i], 16)
    checksummed += hashNibble >= 8 ? ch.toUpperCase() : ch
  }
  return checksummed
}

function normalizeSecp256k1PrivateKey(raw32: Uint8Array): Uint8Array {
  if (secp256k1.utils.isValidPrivateKey(raw32)) {
    return raw32
  }
  let scalar = 0n
  for (const b of raw32) {
    scalar = (scalar << 8n) | BigInt(b)
  }
  const reduced = (scalar % (SECP256K1_ORDER - 1n)) + 1n
  const out = new Uint8Array(32)
  let tmp = reduced
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(tmp & 0xffn)
    tmp >>= 8n
  }
  return out
}

/**
 * Deterministically derives the secp256k1 bearer EOA, ChaCha20-Poly1305 welcome-note key,
 * and 16-byte public claim ID from a 16-byte or 32-byte bearer seed.
 */
export function deriveClaimBearerAccount(
  seedBytes: Uint8Array,
): DerivedClaimBearerAccount {
  if (
    !(seedBytes instanceof Uint8Array) ||
    (seedBytes.length !== 16 && seedBytes.length !== 32)
  ) {
    throw new Error(
      `seedBytes must be a 16-byte or 32-byte Uint8Array, got ${
        seedBytes instanceof Uint8Array ? seedBytes.length : typeof seedBytes
      }`,
    )
  }

  const rawPriv = hkdf(sha256, seedBytes, HKDF_SALT, INFO_PRIVKEY, 32)
  const privBytes = normalizeSecp256k1PrivateKey(rawPriv)
  const compressedPub = secp256k1.getPublicKey(privBytes, true)
  const uncompressedPub = secp256k1.getPublicKey(privBytes, false)
  const addressHash = keccak_256(uncompressedPub.subarray(1))
  const rawAddressHex = bytesToHex(addressHash.subarray(12))
  const evmAddress = toEip55Address(rawAddressHex)

  const noteEncryptionKey = hkdf(
    sha256,
    seedBytes,
    HKDF_SALT,
    INFO_AEAD_KEY,
    32,
  )
  const claimIdBytes = hkdf(sha256, seedBytes, HKDF_SALT, INFO_CLAIM_ID, 16)

  return {
    privateKeyHex: bytesToHex(privBytes),
    publicKeyHex: bytesToHex(compressedPub),
    evmAddress,
    noteEncryptionKey,
    claimIdHex: bytesToHex(claimIdBytes),
  }
}

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function encodeBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i + 2 < bytes.length) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] +
      BASE64URL_ALPHABET[(n >> 12) & 63] +
      BASE64URL_ALPHABET[(n >> 6) & 63] +
      BASE64URL_ALPHABET[n & 63]
    i += 3
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] + BASE64URL_ALPHABET[(n >> 12) & 63]
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out +=
      BASE64URL_ALPHABET[(n >> 18) & 63] +
      BASE64URL_ALPHABET[(n >> 12) & 63] +
      BASE64URL_ALPHABET[(n >> 6) & 63]
  }
  return out
}

function decodeBase64Url(token: string): Uint8Array | null {
  if (!token || !/^[A-Za-z0-9\-_]+$/.test(token)) {
    return null
  }
  const rem = token.length % 4
  if (rem === 1) {
    return null
  }
  const byteLength =
    Math.floor(token.length / 4) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0)
  const out = new Uint8Array(byteLength)
  let outIdx = 0
  let i = 0
  while (i + 3 < token.length) {
    const a = BASE64URL_ALPHABET.indexOf(token[i])
    const b = BASE64URL_ALPHABET.indexOf(token[i + 1])
    const c = BASE64URL_ALPHABET.indexOf(token[i + 2])
    const d = BASE64URL_ALPHABET.indexOf(token[i + 3])
    const n = (a << 18) | (b << 12) | (c << 6) | d
    out[outIdx++] = (n >> 16) & 0xff
    out[outIdx++] = (n >> 8) & 0xff
    out[outIdx++] = n & 0xff
    i += 4
  }
  if (rem === 2) {
    const a = BASE64URL_ALPHABET.indexOf(token[i])
    const b = BASE64URL_ALPHABET.indexOf(token[i + 1])
    const n = (a << 18) | (b << 12)
    out[outIdx++] = (n >> 16) & 0xff
  } else if (rem === 3) {
    const a = BASE64URL_ALPHABET.indexOf(token[i])
    const b = BASE64URL_ALPHABET.indexOf(token[i + 1])
    const c = BASE64URL_ALPHABET.indexOf(token[i + 2])
    const n = (a << 18) | (b << 12) | (c << 6)
    out[outIdx++] = (n >> 16) & 0xff
    out[outIdx++] = (n >> 8) & 0xff
  }
  if (encodeBase64Url(out) !== token) {
    return null
  }
  return out
}

interface SerializedEnvelopePayload {
  v: 1
  c: string
  sa: string
  sn?: string
  a: string
  n?: string
  t: number
  e?: number
}

function buildHeaderAndAad(
  version: number,
  seedBytes: Uint8Array,
): Uint8Array {
  const header = new Uint8Array(2 + seedBytes.length)
  header[0] = version & 0xff
  header[1] = seedBytes.length & 0xff
  header.set(seedBytes, 2)
  return header
}

function deriveNoteAeadNonce(seedBytes: Uint8Array): Uint8Array {
  return hkdf(sha256, seedBytes, HKDF_SALT, INFO_AEAD_NONCE, 12)
}

function formatClaimUrl(baseUrl: string, fragmentToken: string): string {
  const hashIndex = baseUrl.indexOf('#')
  const cleanBase = hashIndex >= 0 ? baseUrl.slice(0, hashIndex) : baseUrl
  return `${cleanBase}#${CLAIM_HASH_PARAM}=${fragmentToken}`
}

/**
 * Generates an ephemeral bearer claim link (`https://signet.mx/#claim=<token>`)
 * where both the bearer seed and AEAD-authenticated welcome metadata live
 * exclusively inside the URL fragment (`#claim=...`).
 */
export function createClaimLink(params: {
  baseUrl?: string
  seedBytes?: Uint8Array
  chainKey?: string
  senderAddress: string
  senderName?: string
  amountAtomic: bigint
  note?: string
  createdAtMs?: number
  expiresAtMs?: number
}): CreatedClaimLink {
  if (!params.senderAddress || typeof params.senderAddress !== 'string') {
    throw new Error('senderAddress must be a non-empty string')
  }
  if (typeof params.amountAtomic !== 'bigint' || params.amountAtomic < 0n) {
    throw new Error('amountAtomic must be a non-negative bigint')
  }

  const seedBytes = params.seedBytes
    ? new Uint8Array(params.seedBytes)
    : csprngBytes(16)
  const bearerAccount = deriveClaimBearerAccount(seedBytes)
  const chainKey = params.chainKey ?? DEFAULT_CLAIM_CHAIN_KEY
  const createdAtMs = params.createdAtMs ?? Date.now()
  if (!Number.isFinite(createdAtMs) || createdAtMs < 0) {
    throw new Error('createdAtMs must be a non-negative finite timestamp')
  }
  if (
    params.expiresAtMs !== undefined &&
    (!Number.isFinite(params.expiresAtMs) || params.expiresAtMs < createdAtMs)
  ) {
    throw new Error('expiresAtMs must be a finite timestamp >= createdAtMs')
  }

  const metadata: ClaimLinkMetadata = {
    version: CLAIM_LINK_VERSION,
    chainKey,
    senderAddress: params.senderAddress,
    ...(params.senderName !== undefined
      ? { senderName: params.senderName }
      : {}),
    amountAtomic: params.amountAtomic,
    ...(params.note !== undefined ? { note: params.note } : {}),
    createdAtMs,
    ...(params.expiresAtMs !== undefined
      ? { expiresAtMs: params.expiresAtMs }
      : {}),
  }

  const envelopePayload: SerializedEnvelopePayload = {
    v: CLAIM_LINK_VERSION,
    c: metadata.chainKey,
    sa: metadata.senderAddress,
    ...(metadata.senderName !== undefined ? { sn: metadata.senderName } : {}),
    a: metadata.amountAtomic.toString(10),
    ...(metadata.note !== undefined ? { n: metadata.note } : {}),
    t: metadata.createdAtMs,
    ...(metadata.expiresAtMs !== undefined ? { e: metadata.expiresAtMs } : {}),
  }

  const plaintextBytes = utf8ToBytes(JSON.stringify(envelopePayload))
  const header = buildHeaderAndAad(CLAIM_LINK_VERSION, seedBytes)
  const nonce = deriveNoteAeadNonce(seedBytes)
  const ciphertext = chacha20poly1305(
    bearerAccount.noteEncryptionKey,
    nonce,
    header,
  ).encrypt(plaintextBytes)

  const tokenBytes = new Uint8Array(header.length + ciphertext.length)
  tokenBytes.set(header, 0)
  tokenBytes.set(ciphertext, header.length)

  const fragmentToken = encodeBase64Url(tokenBytes)
  const baseUrl = params.baseUrl ?? DEFAULT_CLAIM_BASE_URL
  const url = formatClaimUrl(baseUrl, fragmentToken)

  return {
    url,
    fragmentToken,
    bearerAccount,
    metadata,
  }
}

function extractTokenFromInput(urlOrHashOrToken: string): string | null {
  if (typeof urlOrHashOrToken !== 'string') {
    return null
  }
  const trimmed = urlOrHashOrToken.trim()
  if (!trimmed) {
    return null
  }

  // Full URL: only accept #claim= in the URL fragment, never in query parameters
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      const parsedUrl = new URL(trimmed)
      if (!parsedUrl.hash || parsedUrl.hash.length <= 1) {
        return null
      }
      const hashParams = new URLSearchParams(parsedUrl.hash.slice(1))
      const token = hashParams.get(CLAIM_HASH_PARAM)
      return token && token.length > 0 ? token : null
    } catch {
      return null
    }
  }

  // Reject bare query string inputs (?claim=...) so secrets in query params are never accepted
  if (trimmed.startsWith('?')) {
    return null
  }

  // Location hash (#claim=...)
  if (trimmed.startsWith('#')) {
    const hashParams = new URLSearchParams(trimmed.slice(1))
    const token = hashParams.get(CLAIM_HASH_PARAM)
    return token && token.length > 0 ? token : null
  }

  // Direct key=value fragment string (claim=...)
  if (trimmed.startsWith(`${CLAIM_HASH_PARAM}=`)) {
    const hashParams = new URLSearchParams(trimmed)
    const token = hashParams.get(CLAIM_HASH_PARAM)
    return token && token.length > 0 ? token : null
  }

  // Raw base64url token
  return trimmed
}

/**
 * Checks whether a browser `location.hash` string contains a non-empty `#claim=` bearer token.
 */
export function hasClaimLinkInHash(locationHash: string): boolean {
  if (typeof locationHash !== 'string' || !locationHash) {
    return false
  }
  const trimmed = locationHash.trim()
  if (!trimmed.startsWith('#')) {
    return false
  }
  const params = new URLSearchParams(trimmed.slice(1))
  const token = params.get(CLAIM_HASH_PARAM)
  return Boolean(token && token.trim().length > 0)
}

/**
 * Parses and authenticates a claim link from a full URL (`https://signet.mx/#claim=...`),
 * a location hash (`#claim=...`), or a raw base64url token.
 *
 * Returns `null` if the token is malformed, placed in a query string instead of a fragment,
 * or fails ChaCha20-Poly1305 AEAD verification.
 */
export function parseClaimLink(
  urlOrHashOrToken: string,
): ParsedClaimLink | null {
  const token = extractTokenFromInput(urlOrHashOrToken)
  if (!token) {
    return null
  }

  const tokenBytes = decodeBase64Url(token)
  if (!tokenBytes || tokenBytes.length < 2 + 16 + 16) {
    return null
  }

  const version = tokenBytes[0]
  const seedLength = tokenBytes[1]
  if (
    version !== CLAIM_LINK_VERSION ||
    (seedLength !== 16 && seedLength !== 32)
  ) {
    return null
  }

  const headerLength = 2 + seedLength
  // Must have at least 16 bytes for Poly1305 tag + non-empty JSON payload
  if (tokenBytes.length <= headerLength + 16) {
    return null
  }

  const header = tokenBytes.subarray(0, headerLength)
  const seedBytes = new Uint8Array(tokenBytes.subarray(2, headerLength))
  const ciphertext = tokenBytes.subarray(headerLength)

  let bearerAccount: DerivedClaimBearerAccount
  try {
    bearerAccount = deriveClaimBearerAccount(seedBytes)
  } catch {
    return null
  }

  const nonce = deriveNoteAeadNonce(seedBytes)
  let plaintextBytes: Uint8Array
  try {
    plaintextBytes = chacha20poly1305(
      bearerAccount.noteEncryptionKey,
      nonce,
      header,
    ).decrypt(ciphertext)
  } catch {
    return null
  }

  let decoded: SerializedEnvelopePayload
  try {
    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(
      plaintextBytes,
    )
    decoded = JSON.parse(jsonText) as SerializedEnvelopePayload
  } catch {
    return null
  }

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    decoded.v !== CLAIM_LINK_VERSION ||
    typeof decoded.c !== 'string' ||
    !decoded.c ||
    typeof decoded.sa !== 'string' ||
    !decoded.sa ||
    typeof decoded.a !== 'string' ||
    !/^\d+$/.test(decoded.a) ||
    typeof decoded.t !== 'number' ||
    !Number.isFinite(decoded.t) ||
    decoded.t < 0
  ) {
    return null
  }

  if (decoded.sn !== undefined && typeof decoded.sn !== 'string') {
    return null
  }
  if (decoded.n !== undefined && typeof decoded.n !== 'string') {
    return null
  }
  if (
    decoded.e !== undefined &&
    (typeof decoded.e !== 'number' ||
      !Number.isFinite(decoded.e) ||
      decoded.e < decoded.t)
  ) {
    return null
  }

  const amountAtomic = BigInt(decoded.a)

  return {
    version: CLAIM_LINK_VERSION,
    bearerAccount,
    seedBytes,
    chainKey: decoded.c,
    senderAddress: decoded.sa,
    ...(decoded.sn !== undefined ? { senderName: decoded.sn } : {}),
    amountAtomic,
    ...(decoded.n !== undefined ? { note: decoded.n } : {}),
    createdAtMs: decoded.t,
    ...(decoded.e !== undefined ? { expiresAtMs: decoded.e } : {}),
  }
}

/**
 * Computes the net sweepable amount after subtracting the EVM gas fee for an EOA sweep (`21_000` gas default).
 */
export function netSweepableAmountWei(
  observedBalanceWei: bigint,
  currentGasPriceWei: bigint,
  sweepGasLimit: bigint = DEFAULT_SWEEP_GAS_LIMIT,
): bigint {
  if (observedBalanceWei <= 0n) {
    return 0n
  }
  const gasPrice = currentGasPriceWei < 0n ? 0n : currentGasPriceWei
  const gasLimit = sweepGasLimit < 0n ? 0n : sweepGasLimit
  const sweepFeeWei = gasLimit * gasPrice
  return observedBalanceWei > sweepFeeWei
    ? observedBalanceWei - sweepFeeWei
    : 0n
}

/**
 * Calculates the total funding required for an ephemeral bearer claim link:
 * - `giftAmountWei`: target net balance delivered to the recipient
 * - `sweepFeeReserveWei`: gas reserve for the recipient's sweep tx (`sweepGasLimit * gasPriceWei`)
 * - `replyStampReserveWei`: optional stamp reserve so a zero-balance new user can reply immediately
 */
export function calculateClaimFundingBreakdown(params: {
  giftAmountWei: bigint
  gasPriceWei: bigint
  sweepGasLimit?: bigint
  replyStampWei?: bigint
  replyCount?: number
}): ClaimFundingBreakdown {
  if (params.giftAmountWei < 0n) {
    throw new Error('giftAmountWei must be >= 0n')
  }
  if (params.gasPriceWei < 0n) {
    throw new Error('gasPriceWei must be >= 0n')
  }
  const sweepGasLimit = params.sweepGasLimit ?? DEFAULT_SWEEP_GAS_LIMIT
  if (sweepGasLimit <= 0n) {
    throw new Error('sweepGasLimit must be > 0n')
  }
  const replyStampWei = params.replyStampWei ?? 0n
  if (replyStampWei < 0n) {
    throw new Error('replyStampWei must be >= 0n')
  }
  const replyCount = params.replyCount ?? 1
  if (!Number.isInteger(replyCount) || replyCount < 0) {
    throw new Error('replyCount must be a non-negative integer')
  }

  const sweepFeeReserveWei = sweepGasLimit * params.gasPriceWei
  const replyStampReserveWei = replyStampWei * BigInt(replyCount)
  const totalFundingRequiredWei =
    params.giftAmountWei + sweepFeeReserveWei + replyStampReserveWei

  return {
    giftAmountWei: params.giftAmountWei,
    gasPriceWei: params.gasPriceWei,
    sweepGasLimit,
    sweepFeeReserveWei,
    replyStampReserveWei,
    totalFundingRequiredWei,
    netSweepableAmountWei: (
      observedBalanceWei: bigint,
      currentGasPriceWei: bigint = params.gasPriceWei,
      overrideGasLimit: bigint = sweepGasLimit,
    ) =>
      netSweepableAmountWei(
        observedBalanceWei,
        currentGasPriceWei,
        overrideGasLimit,
      ),
  }
}

/**
 * Evaluates whether a bearer claim account is claimable by the recipient,
 * already claimed by a synced device, empty/swept on-chain, or expired and
 * eligible for sender clawback.
 */
export function evaluateClaimBearerState(params: {
  observedBalanceWei: bigint
  currentGasPriceWei: bigint
  sweepGasLimit?: bigint
  nowMs?: number
  expiresAtMs?: number
  alreadyClaimedIds?: ReadonlySet<string>
  claimIdHex: string
}): ClaimBearerStateEvaluation {
  const sweepGasLimit = params.sweepGasLimit ?? DEFAULT_SWEEP_GAS_LIMIT
  const netSweepableWei = netSweepableAmountWei(
    params.observedBalanceWei,
    params.currentGasPriceWei,
    sweepGasLimit,
  )

  if (params.alreadyClaimedIds?.has(params.claimIdHex)) {
    return {
      status: 'already_claimed',
      netSweepableWei,
      canRecipientClaim: false,
      canSenderClawback: false,
    }
  }

  if (netSweepableWei === 0n) {
    return {
      status: 'empty_or_swept',
      netSweepableWei: 0n,
      canRecipientClaim: false,
      canSenderClawback: false,
    }
  }

  const nowMs = params.nowMs ?? Date.now()
  if (params.expiresAtMs !== undefined && nowMs >= params.expiresAtMs) {
    return {
      status: 'expired_clawback_eligible',
      netSweepableWei,
      canRecipientClaim: false,
      canSenderClawback: true,
    }
  }

  return {
    status: 'claimable',
    netSweepableWei,
    canRecipientClaim: true,
    canSenderClawback: false,
  }
}
