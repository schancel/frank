import { secp256k1 } from '@noble/curves/secp256k1'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils'
import { chacha20poly1305 } from '@noble/ciphers/chacha'

export const DEVICE_PAIRING_PROTOCOL_VERSION = 1 as const
export const DEVICE_PAIRING_DATA_CHANNEL_LABEL = 'frank-device-pair-v1' as const
export const DEFAULT_PAIRING_TTL_MS = 180_000 as const

const SESSION_ID_HEX_REGEX = /^[0-9a-f]{32}$/i
const COMPRESSED_PUBKEY_HEX_REGEX = /^(02|03)[0-9a-f]{64}$/i
const DEVICE_ID_REGEX = /^[\x21-\x7e]{1,128}$/
const DTLS_SHA256_FINGERPRINT_REGEX =
  /^(?:sha-256\s+)?([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31})$/

/**
 * 64 high-contrast, unambiguous English verification words (6 bits per word = 24 bits across 4 words)
 * used alongside the 6-digit numeric SAS (`sasDigits`).
 */
export const SAS_WORDLIST: readonly string[] = [
  'amber',
  'anchor',
  'apollo',
  'arctic',
  'atlas',
  'aurora',
  'badger',
  'bamboo',
  'beacon',
  'bison',
  'breeze',
  'bronze',
  'canyon',
  'carbon',
  'cedar',
  'cobalt',
  'comet',
  'coral',
  'cosmos',
  'crystal',
  'cypress',
  'dagger',
  'delta',
  'dolphin',
  'dragon',
  'dynamo',
  'eclipse',
  'ember',
  'emerald',
  'falcon',
  'fjord',
  'forest',
  'galaxy',
  'garnet',
  'glacier',
  'granite',
  'harbor',
  'helios',
  'horizon',
  'indigo',
  'island',
  'jasper',
  'jungle',
  'lagoon',
  'lantern',
  'legend',
  'lotus',
  'magnet',
  'marble',
  'meadow',
  'meteor',
  'mirage',
  'monarch',
  'nebula',
  'nectar',
  'nickel',
  'obsidian',
  'onyx',
  'orchid',
  'osprey',
  'oxygen',
  'panther',
  'pegasus',
  'phoenix',
] as const

export interface DevicePairingQrPayload {
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  initiatorDeviceId: string
  initiatorEphemeralPubKeyHex: string
  dtlsFingerprintSha256: string
  expiresAtMs: number
  relayUrl?: string
}

export interface DevicePairingSession {
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  initiatorDeviceId: string
  ephemeralPrivKey: Uint8Array
  ephemeralPubKeyHex: string
  dtlsFingerprintSha256: string
  createdAtMs: number
  expiresAtMs: number
  relayUrl?: string
  payload: DevicePairingQrPayload
}

export interface DerivedDevicePairingKeys {
  encryptionKey: Uint8Array
  transcriptHashHex: string
  sasDigits: string
  sasWords: [string, string, string, string]
}

export interface DeviceSyncContactEntry {
  address: string
  name?: string
  username?: string
  bio?: string
  avatar?: string
}

export interface DeviceSyncConversationEntry {
  id: string
  address: string
  name?: string
  topic?: string
  updatedAt: number
}

export interface DeviceSyncBundle {
  schemaVersion: 1
  exportedAtMs: number
  sourceDeviceId: string
  accountAddress: string
  mnemonicOrSeedHex: string
  contacts: DeviceSyncContactEntry[]
  conversations: DeviceSyncConversationEntry[]
  syncJournalCursorHex?: string
}

export interface EncryptedDeviceSyncBundle {
  ciphertextBase64: string
  nonceBase64: string
  bundleDigestHex: string
}

/**
 * Normalizes a SHA-256 DTLS fingerprint into canonical uppercase `AA:BB:...:FF` (32 colon-separated hex bytes).
 * Rejects weak hashes (e.g. `sha-1`, `md5`), wrong lengths, or degenerate all-zero / all-FF fingerprints.
 */
export function normalizeDtlsFingerprintSha256(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const match = DTLS_SHA256_FINGERPRINT_REGEX.exec(trimmed)
  if (!match) return null
  const canonical = match[1].toUpperCase()
  const hexOnly = canonical.replace(/:/g, '')
  if (/^0+$/.test(hexOnly) || /^F+$/.test(hexOnly)) {
    return null
  }
  return canonical
}

function isValidCompressedSecp256k1PubKeyHex(pubHex: string): boolean {
  if (typeof pubHex !== 'string' || !COMPRESSED_PUBKEY_HEX_REGEX.test(pubHex)) {
    return false
  }
  try {
    secp256k1.ProjectivePoint.fromHex(pubHex.toLowerCase())
    return true
  } catch {
    return false
  }
}

function isValidRelayUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 512) {
    return false
  }
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'wss:' ||
      parsed.protocol === 'ws:'
    )
  } catch {
    return false
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bytesA = utf8ToBytes(a)
  const bytesB = utf8ToBytes(b)
  if (bytesA.length !== bytesB.length) return false
  let diff = 0
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i]
  }
  return diff === 0
}

/**
 * Formats a `DevicePairingQrPayload` into a canonical `frank://pair?...` URI suitable for QR encoding.
 */
export function formatDevicePairingUri(payload: DevicePairingQrPayload): string {
  if (payload.version !== DEVICE_PAIRING_PROTOCOL_VERSION) {
    throw new Error(`Unsupported device pairing protocol version: ${String(payload.version)}`)
  }
  if (!SESSION_ID_HEX_REGEX.test(payload.sessionId)) {
    throw new Error('Invalid sessionId: expected 32 hex characters (16 bytes)')
  }
  if (!DEVICE_ID_REGEX.test(payload.initiatorDeviceId)) {
    throw new Error('Invalid initiatorDeviceId: must be 1..128 printable ASCII characters')
  }
  if (!isValidCompressedSecp256k1PubKeyHex(payload.initiatorEphemeralPubKeyHex)) {
    throw new Error('Invalid initiatorEphemeralPubKeyHex: expected 33-byte compressed secp256k1 key')
  }
  const normalizedFp = normalizeDtlsFingerprintSha256(payload.dtlsFingerprintSha256)
  if (!normalizedFp) {
    throw new Error('Invalid dtlsFingerprintSha256: expected canonical SHA-256 fingerprint')
  }
  if (!Number.isSafeInteger(payload.expiresAtMs) || payload.expiresAtMs <= 0) {
    throw new Error('Invalid expiresAtMs: expected positive safe integer')
  }
  if (payload.relayUrl !== undefined && !isValidRelayUrl(payload.relayUrl)) {
    throw new Error('Invalid relayUrl')
  }

  const params = new URLSearchParams()
  params.set('v', String(payload.version))
  params.set('sid', payload.sessionId.toLowerCase())
  params.set('dev', payload.initiatorDeviceId)
  params.set('pub', payload.initiatorEphemeralPubKeyHex.toLowerCase())
  params.set('fp', normalizedFp)
  params.set('exp', String(payload.expiresAtMs))
  if (payload.relayUrl !== undefined) {
    params.set('relay', payload.relayUrl)
  }

  return `frank://pair?${params.toString()}`
}

/**
 * Parses and validates a `frank://pair?...` URI.
 * Returns `null` if malformed, unsupported, or expired relative to `options.nowMs`.
 */
export function parseDevicePairingUri(
  rawUri: string,
  options?: { nowMs?: number },
): DevicePairingQrPayload | null {
  if (typeof rawUri !== 'string') return null
  const trimmed = rawUri.trim()
  if (!/^frank:\/\/pair\?/i.test(trimmed)) {
    return null
  }

  const queryIndex = trimmed.indexOf('?')
  if (queryIndex < 0) return null
  const queryString = trimmed.slice(queryIndex + 1)
  if (!queryString || queryString.includes('#')) return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(queryString)
  } catch {
    return null
  }

  const versionStr = params.get('v')
  if (versionStr !== String(DEVICE_PAIRING_PROTOCOL_VERSION)) {
    return null
  }

  const sessionId = params.get('sid')
  if (!sessionId || !SESSION_ID_HEX_REGEX.test(sessionId)) {
    return null
  }

  const initiatorDeviceId = params.get('dev')
  if (!initiatorDeviceId || !DEVICE_ID_REGEX.test(initiatorDeviceId)) {
    return null
  }

  const pubKeyHex = params.get('pub')
  if (!pubKeyHex || !isValidCompressedSecp256k1PubKeyHex(pubKeyHex)) {
    return null
  }

  const rawFp = params.get('fp')
  const dtlsFingerprintSha256 = rawFp ? normalizeDtlsFingerprintSha256(rawFp) : null
  if (!dtlsFingerprintSha256) {
    return null
  }

  const expStr = params.get('exp')
  if (!expStr || !/^\d+$/.test(expStr)) {
    return null
  }
  const expiresAtMs = Number(expStr)
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
    return null
  }

  if (options?.nowMs !== undefined) {
    if (!Number.isFinite(options.nowMs) || options.nowMs >= expiresAtMs) {
      return null
    }
  }

  const relayUrl = params.get('relay') ?? undefined
  if (relayUrl !== undefined && !isValidRelayUrl(relayUrl)) {
    return null
  }

  return {
    version: DEVICE_PAIRING_PROTOCOL_VERSION,
    sessionId: sessionId.toLowerCase(),
    initiatorDeviceId,
    initiatorEphemeralPubKeyHex: pubKeyHex.toLowerCase(),
    dtlsFingerprintSha256,
    expiresAtMs,
    ...(relayUrl !== undefined ? { relayUrl } : {}),
  }
}

export function isDevicePairingUri(raw: string): boolean {
  return parseDevicePairingUri(raw) !== null
}

/**
 * Creates a fresh initiator device pairing session with an ephemeral secp256k1 keypair,
 * 128-bit random session ID, and bound WebRTC DTLS SHA-256 certificate fingerprint.
 */
export function createDevicePairingSession(params: {
  initiatorDeviceId: string
  dtlsFingerprintSha256: string
  nowMs?: number
  ttlMs?: number
  relayUrl?: string
}): { session: DevicePairingSession; qrUri: string } {
  const nowMs = params.nowMs ?? Date.now()
  const ttlMs = params.ttlMs ?? DEFAULT_PAIRING_TTL_MS
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw new Error('Invalid nowMs')
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    throw new Error('Invalid ttlMs: must be between 1ms and 900000ms (15 minutes)')
  }

  const normalizedFp = normalizeDtlsFingerprintSha256(params.dtlsFingerprintSha256)
  if (!normalizedFp) {
    throw new Error('Invalid dtlsFingerprintSha256: expected canonical SHA-256 fingerprint')
  }
  if (!DEVICE_ID_REGEX.test(params.initiatorDeviceId)) {
    throw new Error('Invalid initiatorDeviceId')
  }

  const ephemeralPrivKey = secp256k1.utils.randomPrivateKey()
  const ephemeralPubKeyHex = bytesToHex(
    secp256k1.getPublicKey(ephemeralPrivKey, true),
  ).toLowerCase()
  const sessionId = bytesToHex(randomBytes(16)).toLowerCase()
  const expiresAtMs = nowMs + ttlMs

  const payload: DevicePairingQrPayload = {
    version: DEVICE_PAIRING_PROTOCOL_VERSION,
    sessionId,
    initiatorDeviceId: params.initiatorDeviceId,
    initiatorEphemeralPubKeyHex: ephemeralPubKeyHex,
    dtlsFingerprintSha256: normalizedFp,
    expiresAtMs,
    ...(params.relayUrl !== undefined ? { relayUrl: params.relayUrl } : {}),
  }

  const qrUri = formatDevicePairingUri(payload)
  const session: DevicePairingSession = {
    version: DEVICE_PAIRING_PROTOCOL_VERSION,
    sessionId,
    initiatorDeviceId: params.initiatorDeviceId,
    ephemeralPrivKey,
    ephemeralPubKeyHex,
    dtlsFingerprintSha256: normalizedFp,
    createdAtMs: nowMs,
    expiresAtMs,
    ...(params.relayUrl !== undefined ? { relayUrl: params.relayUrl } : {}),
    payload,
  }

  return { session, qrUri }
}

/**
 * Derives the mutual E2EE encryption key and Short Authentication String (SAS) from:
 * - Ephemeral secp256k1 ECDH shared secret
 * - Session ID (`sessionId`)
 * - Initiator WebRTC DTLS SHA-256 certificate fingerprint
 * - Responder WebRTC DTLS SHA-256 certificate fingerprint
 * - Both peers' ephemeral compressed secp256k1 public keys
 *
 * Any MITM substituting either the WebRTC DTLS certificate or the ephemeral public key
 * alters the HKDF info transcript, producing a completely different `encryptionKey`,
 * `sasDigits`, and `sasWords`.
 */
export function deriveDevicePairingKeys(params: {
  localEphemeralPrivKey: Uint8Array
  remoteEphemeralPubKeyHex: string
  sessionId: string
  initiatorDtlsFingerprintSha256: string
  responderDtlsFingerprintSha256: string
}): DerivedDevicePairingKeys {
  if (
    !(params.localEphemeralPrivKey instanceof Uint8Array) ||
    params.localEphemeralPrivKey.length !== 32
  ) {
    throw new Error('Invalid localEphemeralPrivKey: expected 32-byte secp256k1 private key')
  }
  if (!SESSION_ID_HEX_REGEX.test(params.sessionId)) {
    throw new Error('Invalid sessionId: expected 32 hex characters')
  }
  if (!isValidCompressedSecp256k1PubKeyHex(params.remoteEphemeralPubKeyHex)) {
    throw new Error('Invalid remoteEphemeralPubKeyHex: expected 33-byte compressed secp256k1 key')
  }

  const initiatorFp = normalizeDtlsFingerprintSha256(
    params.initiatorDtlsFingerprintSha256,
  )
  const responderFp = normalizeDtlsFingerprintSha256(
    params.responderDtlsFingerprintSha256,
  )
  if (!initiatorFp) {
    throw new Error('Invalid initiatorDtlsFingerprintSha256')
  }
  if (!responderFp) {
    throw new Error('Invalid responderDtlsFingerprintSha256')
  }

  const localPubHex = bytesToHex(
    secp256k1.getPublicKey(params.localEphemeralPrivKey, true),
  ).toLowerCase()
  const remotePubHex = params.remoteEphemeralPubKeyHex.toLowerCase()
  if (constantTimeStringEqual(localPubHex, remotePubHex)) {
    throw new Error('Ephemeral public key reflection detected: local and remote keys must differ')
  }

  const sharedSecretPoint = secp256k1.getSharedSecret(
    params.localEphemeralPrivKey,
    hexToBytes(remotePubHex),
    true,
  )

  const [pubKeyLow, pubKeyHigh] =
    localPubHex < remotePubHex
      ? [localPubHex, remotePubHex]
      : [remotePubHex, localPubHex]

  const canonicalSessionId = params.sessionId.toLowerCase()
  const salt = sha256(
    utf8ToBytes(`frank-device-pair-salt-v1:${canonicalSessionId}`),
  )
  const transcriptString = [
    'frank-device-pair-transcript-v1',
    canonicalSessionId,
    initiatorFp,
    responderFp,
    pubKeyLow,
    pubKeyHigh,
  ].join('|')
  const info = utf8ToBytes(transcriptString)

  const okm = hkdf(sha256, sharedSecretPoint, salt, info, 64)
  sharedSecretPoint.fill(0)

  const encryptionKey = okm.slice(0, 32)
  const sasMaterial = okm.slice(32, 64)
  const transcriptHashHex = bytesToHex(sha256(sasMaterial))

  const sasInt =
    (((sasMaterial[0] << 24) |
      (sasMaterial[1] << 16) |
      (sasMaterial[2] << 8) |
      sasMaterial[3]) >>>
      0) %
    1_000_000
  const sasDigits = String(sasInt).padStart(6, '0')

  const sasWords: [string, string, string, string] = [
    SAS_WORDLIST[sasMaterial[4] & 0x3f],
    SAS_WORDLIST[sasMaterial[5] & 0x3f],
    SAS_WORDLIST[sasMaterial[6] & 0x3f],
    SAS_WORDLIST[sasMaterial[7] & 0x3f],
  ]

  sasMaterial.fill(0)
  okm.fill(0)

  return {
    encryptionKey,
    transcriptHashHex,
    sasDigits,
    sasWords,
  }
}

/**
 * Zeroizes sensitive pairing secret material in place.
 */
export function zeroizePairingKeys(
  target:
    | Uint8Array
    | {
        encryptionKey?: Uint8Array | null
        ephemeralPrivKey?: Uint8Array | null
      }
    | null
    | undefined,
): void {
  if (!target) return
  if (target instanceof Uint8Array) {
    target.fill(0)
    return
  }
  if (target.encryptionKey instanceof Uint8Array) {
    target.encryptionKey.fill(0)
  }
  if (target.ephemeralPrivKey instanceof Uint8Array) {
    target.ephemeralPrivKey.fill(0)
  }
}

function isAllZeroKey(key: Uint8Array): boolean {
  let acc = 0
  for (let i = 0; i < key.length; i++) {
    acc |= key[i]
  }
  return acc === 0
}

function validateDeviceSyncBundle(bundle: unknown): asserts bundle is DeviceSyncBundle {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('Invalid DeviceSyncBundle: expected object')
  }
  const candidate = bundle as Record<string, unknown>
  if (candidate.schemaVersion !== 1) {
    throw new Error(`Unsupported DeviceSyncBundle schemaVersion: ${String(candidate.schemaVersion)}`)
  }
  if (
    typeof candidate.exportedAtMs !== 'number' ||
    !Number.isSafeInteger(candidate.exportedAtMs) ||
    candidate.exportedAtMs <= 0
  ) {
    throw new Error('Invalid DeviceSyncBundle exportedAtMs')
  }
  if (
    typeof candidate.sourceDeviceId !== 'string' ||
    !DEVICE_ID_REGEX.test(candidate.sourceDeviceId)
  ) {
    throw new Error('Invalid DeviceSyncBundle sourceDeviceId')
  }
  if (
    typeof candidate.accountAddress !== 'string' ||
    candidate.accountAddress.trim().length === 0
  ) {
    throw new Error('Invalid DeviceSyncBundle accountAddress')
  }
  if (
    typeof candidate.mnemonicOrSeedHex !== 'string' ||
    candidate.mnemonicOrSeedHex.trim().length === 0
  ) {
    throw new Error('Invalid DeviceSyncBundle mnemonicOrSeedHex')
  }
  if (!Array.isArray(candidate.contacts)) {
    throw new Error('Invalid DeviceSyncBundle contacts: expected array')
  }
  for (const contact of candidate.contacts) {
    if (
      !contact ||
      typeof contact !== 'object' ||
      typeof (contact as DeviceSyncContactEntry).address !== 'string' ||
      (contact as DeviceSyncContactEntry).address.trim().length === 0
    ) {
      throw new Error('Invalid DeviceSyncContactEntry in bundle')
    }
  }
  if (!Array.isArray(candidate.conversations)) {
    throw new Error('Invalid DeviceSyncBundle conversations: expected array')
  }
  for (const conv of candidate.conversations) {
    if (
      !conv ||
      typeof conv !== 'object' ||
      typeof (conv as DeviceSyncConversationEntry).id !== 'string' ||
      typeof (conv as DeviceSyncConversationEntry).address !== 'string' ||
      typeof (conv as DeviceSyncConversationEntry).updatedAt !== 'number'
    ) {
      throw new Error('Invalid DeviceSyncConversationEntry in bundle')
    }
  }
  if (
    candidate.syncJournalCursorHex !== undefined &&
    (typeof candidate.syncJournalCursorHex !== 'string' ||
      !/^[0-9a-f]*$/i.test(candidate.syncJournalCursorHex))
  ) {
    throw new Error('Invalid DeviceSyncBundle syncJournalCursorHex')
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string' || b64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('Invalid base64 encoding')
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

function buildBundleAad(sessionId: string): Uint8Array {
  if (!SESSION_ID_HEX_REGEX.test(sessionId)) {
    throw new Error('Invalid sessionId for DeviceSyncBundle AEAD AAD')
  }
  return utf8ToBytes(`frank-device-pair-bundle-v1:${sessionId.toLowerCase()}`)
}

/**
 * Encrypts a `DeviceSyncBundle` using ChaCha20-Poly1305 with session-bound AAD.
 */
export function encryptDeviceSyncBundle(
  bundle: DeviceSyncBundle,
  encryptionKey: Uint8Array,
  sessionId: string,
): EncryptedDeviceSyncBundle {
  validateDeviceSyncBundle(bundle)
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.length !== 32) {
    throw new Error('Invalid encryptionKey: expected 32-byte key')
  }
  if (isAllZeroKey(encryptionKey)) {
    throw new Error('Refusing to encrypt with zeroized encryptionKey')
  }

  const aad = buildBundleAad(sessionId)
  const nonce = randomBytes(12)
  const plaintextBytes = utf8ToBytes(JSON.stringify(bundle))
  const bundleDigestHex = bytesToHex(sha256(plaintextBytes))

  const cipher = chacha20poly1305(encryptionKey, nonce, aad)
  const ciphertext = cipher.encrypt(plaintextBytes)
  plaintextBytes.fill(0)

  return {
    ciphertextBase64: bytesToBase64(ciphertext),
    nonceBase64: bytesToBase64(nonce),
    bundleDigestHex,
  }
}

/**
 * Decrypts and authenticates an `EncryptedDeviceSyncBundle` using ChaCha20-Poly1305.
 * Throws if AEAD authentication fails, if `sessionId` or `encryptionKey` is wrong,
 * if `bundleDigestHex` mismatches, or if the decrypted payload fails schema validation.
 */
export function decryptDeviceSyncBundle(
  encrypted: {
    ciphertextBase64: string
    nonceBase64: string
    bundleDigestHex?: string
  },
  encryptionKey: Uint8Array,
  sessionId: string,
): DeviceSyncBundle {
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.length !== 32) {
    throw new Error('Invalid encryptionKey: expected 32-byte key')
  }
  if (isAllZeroKey(encryptionKey)) {
    throw new Error('Refusing to decrypt with zeroized encryptionKey')
  }

  const aad = buildBundleAad(sessionId)
  const nonce = base64ToBytes(encrypted.nonceBase64)
  if (nonce.length !== 12) {
    throw new Error('Invalid nonceBase64: expected 12-byte ChaCha20-Poly1305 nonce')
  }
  const ciphertext = base64ToBytes(encrypted.ciphertextBase64)
  if (ciphertext.length <= 16) {
    throw new Error('Invalid ciphertextBase64: too short for Poly1305 tag')
  }

  const cipher = chacha20poly1305(encryptionKey, nonce, aad)
  let plaintextBytes: Uint8Array
  try {
    plaintextBytes = cipher.decrypt(ciphertext)
  } catch {
    throw new Error('DeviceSyncBundle AEAD authentication failed')
  }

  try {
    if (encrypted.bundleDigestHex !== undefined) {
      const actualDigest = bytesToHex(sha256(plaintextBytes))
      if (
        !constantTimeStringEqual(
          actualDigest.toLowerCase(),
          encrypted.bundleDigestHex.toLowerCase(),
        )
      ) {
        throw new Error('DeviceSyncBundle digest mismatch')
      }
    }

    const parsed: unknown = JSON.parse(Buffer.from(plaintextBytes).toString('utf8'))
    validateDeviceSyncBundle(parsed)
    return parsed
  } finally {
    plaintextBytes.fill(0)
  }
}

export type DevicePairingPhase =
  | 'awaiting_responder_hello'
  | 'awaiting_sas_confirmation'
  | 'awaiting_sync_bundle'
  | 'awaiting_sync_ack'
  | 'completed'
  | 'failed'
  | 'expired'

export interface ResponderHelloMessage {
  type: 'responder_hello'
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  responderDeviceId: string
  responderEphemeralPubKeyHex: string
  responderDtlsFingerprintSha256: string
}

export interface SyncBundleMessage {
  type: 'sync_bundle'
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  ciphertextBase64: string
  nonceBase64: string
  bundleDigestHex: string
}

export interface SyncAckMessage {
  type: 'sync_ack'
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  responderDeviceId: string
  bundleDigestHex: string
}

export interface PairingAbortMessage {
  type: 'pairing_abort'
  version: typeof DEVICE_PAIRING_PROTOCOL_VERSION
  sessionId: string
  reason: string
}

export type DevicePairingWireMessage =
  | ResponderHelloMessage
  | SyncBundleMessage
  | SyncAckMessage
  | PairingAbortMessage

/**
 * Stateful 3-step DataChannel pairing handshake machine (`responder_hello` -> SAS user confirmation -> `sync_bundle` -> `sync_ack`)
 * with mandatory DTLS fingerprint verification, deterministic expiry enforcement, and automatic secret zeroization.
 */
export class DevicePairingHandshakeMachine {
  public readonly role: 'initiator' | 'responder'
  public readonly sessionId: string
  public readonly expiresAtMs: number
  public readonly initiatorDeviceId: string
  public readonly initiatorDtlsFingerprintSha256: string

  private _phase: DevicePairingPhase
  private _failureReason: string | null = null
  private _localEphemeralPrivKey: Uint8Array
  private readonly _localEphemeralPubKeyHex: string
  private _responderDeviceId: string | null = null
  private _responderDtlsFingerprintSha256: string | null = null
  private _derivedKeys: DerivedDevicePairingKeys | null = null
  private _sasConfirmedByUser = false
  private _expectedBundleDigestHex: string | null = null

  private constructor(params: {
    role: 'initiator' | 'responder'
    sessionId: string
    expiresAtMs: number
    initiatorDeviceId: string
    initiatorDtlsFingerprintSha256: string
    localEphemeralPrivKey: Uint8Array
    localEphemeralPubKeyHex: string
    responderDeviceId?: string
    responderDtlsFingerprintSha256?: string
    derivedKeys?: DerivedDevicePairingKeys
    initialPhase: DevicePairingPhase
  }) {
    this.role = params.role
    this.sessionId = params.sessionId
    this.expiresAtMs = params.expiresAtMs
    this.initiatorDeviceId = params.initiatorDeviceId
    this.initiatorDtlsFingerprintSha256 = params.initiatorDtlsFingerprintSha256
    this._localEphemeralPrivKey = params.localEphemeralPrivKey
    this._localEphemeralPubKeyHex = params.localEphemeralPubKeyHex
    this._responderDeviceId = params.responderDeviceId ?? null
    this._responderDtlsFingerprintSha256 =
      params.responderDtlsFingerprintSha256 ?? null
    this._derivedKeys = params.derivedKeys ?? null
    this._phase = params.initialPhase
  }

  public static createInitiator(session: DevicePairingSession): DevicePairingHandshakeMachine {
    return new DevicePairingHandshakeMachine({
      role: 'initiator',
      sessionId: session.sessionId,
      expiresAtMs: session.expiresAtMs,
      initiatorDeviceId: session.initiatorDeviceId,
      initiatorDtlsFingerprintSha256: session.dtlsFingerprintSha256,
      localEphemeralPrivKey: session.ephemeralPrivKey,
      localEphemeralPubKeyHex: session.ephemeralPubKeyHex,
      initialPhase: 'awaiting_responder_hello',
    })
  }

  public static createResponder(params: {
    qrPayload: DevicePairingQrPayload
    responderDeviceId: string
    responderDtlsFingerprintSha256: string
    observedInitiatorSdpDtlsFingerprintSha256: string
    nowMs?: number
  }): DevicePairingHandshakeMachine {
    const nowMs = params.nowMs ?? Date.now()
    if (nowMs >= params.qrPayload.expiresAtMs) {
      throw new Error('Pairing QR session has already expired')
    }
    if (!DEVICE_ID_REGEX.test(params.responderDeviceId)) {
      throw new Error('Invalid responderDeviceId')
    }
    const normalizedResponderFp = normalizeDtlsFingerprintSha256(
      params.responderDtlsFingerprintSha256,
    )
    if (!normalizedResponderFp) {
      throw new Error('Invalid responderDtlsFingerprintSha256')
    }
    const normalizedObservedInitiatorFp = normalizeDtlsFingerprintSha256(
      params.observedInitiatorSdpDtlsFingerprintSha256,
    )
    const normalizedQrInitiatorFp = normalizeDtlsFingerprintSha256(
      params.qrPayload.dtlsFingerprintSha256,
    )
    if (
      !normalizedObservedInitiatorFp ||
      !normalizedQrInitiatorFp ||
      !constantTimeStringEqual(normalizedObservedInitiatorFp, normalizedQrInitiatorFp)
    ) {
      throw new Error(
        'WebRTC DTLS fingerprint mismatch: initiator SDP fingerprint does not match QR payload',
      )
    }

    const localPriv = secp256k1.utils.randomPrivateKey()
    const localPubHex = bytesToHex(
      secp256k1.getPublicKey(localPriv, true),
    ).toLowerCase()

    const derivedKeys = deriveDevicePairingKeys({
      localEphemeralPrivKey: localPriv,
      remoteEphemeralPubKeyHex: params.qrPayload.initiatorEphemeralPubKeyHex,
      sessionId: params.qrPayload.sessionId,
      initiatorDtlsFingerprintSha256: normalizedQrInitiatorFp,
      responderDtlsFingerprintSha256: normalizedResponderFp,
    })

    return new DevicePairingHandshakeMachine({
      role: 'responder',
      sessionId: params.qrPayload.sessionId,
      expiresAtMs: params.qrPayload.expiresAtMs,
      initiatorDeviceId: params.qrPayload.initiatorDeviceId,
      initiatorDtlsFingerprintSha256: normalizedQrInitiatorFp,
      localEphemeralPrivKey: localPriv,
      localEphemeralPubKeyHex: localPubHex,
      responderDeviceId: params.responderDeviceId,
      responderDtlsFingerprintSha256: normalizedResponderFp,
      derivedKeys,
      initialPhase: 'awaiting_sas_confirmation',
    })
  }

  public get phase(): DevicePairingPhase {
    return this._phase
  }

  public get failureReason(): string | null {
    return this._failureReason
  }

  public get sasDigits(): string | null {
    return this._derivedKeys?.sasDigits ?? null
  }

  public get sasWords(): [string, string, string, string] | null {
    return this._derivedKeys?.sasWords ?? null
  }

  public get transcriptHashHex(): string | null {
    return this._derivedKeys?.transcriptHashHex ?? null
  }

  public checkTimeout(nowMs: number = Date.now()): boolean {
    if (
      this._phase !== 'completed' &&
      this._phase !== 'failed' &&
      this._phase !== 'expired' &&
      nowMs >= this.expiresAtMs
    ) {
      this._phase = 'expired'
      this._failureReason = 'Pairing session expired'
      this.zeroizeSecrets()
      return true
    }
    return this._phase === 'expired'
  }

  public createResponderHello(): ResponderHelloMessage {
    if (this.role !== 'responder' || !this._responderDeviceId || !this._responderDtlsFingerprintSha256) {
      throw new Error('Only a responder machine can create responder_hello')
    }
    return {
      type: 'responder_hello',
      version: DEVICE_PAIRING_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      responderDeviceId: this._responderDeviceId,
      responderEphemeralPubKeyHex: this._localEphemeralPubKeyHex,
      responderDtlsFingerprintSha256: this._responderDtlsFingerprintSha256,
    }
  }

  public handleResponderHello(
    msg: ResponderHelloMessage,
    observedResponderSdpDtlsFingerprintSha256: string,
    nowMs: number = Date.now(),
  ): DerivedDevicePairingKeys {
    if (this.checkTimeout(nowMs)) {
      throw new Error('Pairing session expired')
    }
    if (this.role !== 'initiator') {
      this.fail('Only initiator can handle responder_hello')
      throw new Error(this._failureReason!)
    }
    if (this._phase !== 'awaiting_responder_hello') {
      this.fail(`Unexpected responder_hello in phase ${this._phase}`)
      throw new Error(this._failureReason!)
    }
    if (
      msg.type !== 'responder_hello' ||
      msg.version !== DEVICE_PAIRING_PROTOCOL_VERSION ||
      !constantTimeStringEqual(msg.sessionId.toLowerCase(), this.sessionId)
    ) {
      this.fail('Invalid responder_hello session or version')
      throw new Error(this._failureReason!)
    }
    if (!DEVICE_ID_REGEX.test(msg.responderDeviceId)) {
      this.fail('Invalid responderDeviceId in responder_hello')
      throw new Error(this._failureReason!)
    }

    const msgFp = normalizeDtlsFingerprintSha256(msg.responderDtlsFingerprintSha256)
    const sdpFp = normalizeDtlsFingerprintSha256(
      observedResponderSdpDtlsFingerprintSha256,
    )
    if (!msgFp || !sdpFp || !constantTimeStringEqual(msgFp, sdpFp)) {
      this.fail(
        'WebRTC DTLS fingerprint mismatch: responder SDP fingerprint does not match responder_hello',
      )
      throw new Error(this._failureReason!)
    }

    try {
      const derived = deriveDevicePairingKeys({
        localEphemeralPrivKey: this._localEphemeralPrivKey,
        remoteEphemeralPubKeyHex: msg.responderEphemeralPubKeyHex,
        sessionId: this.sessionId,
        initiatorDtlsFingerprintSha256: this.initiatorDtlsFingerprintSha256,
        responderDtlsFingerprintSha256: msgFp,
      })
      this._responderDeviceId = msg.responderDeviceId
      this._responderDtlsFingerprintSha256 = msgFp
      this._derivedKeys = derived
      this._phase = 'awaiting_sas_confirmation'
      return derived
    } catch (err) {
      this.fail((err as Error).message)
      throw err
    }
  }

  public confirmSasAndSendBundle(
    bundle: DeviceSyncBundle,
    nowMs: number = Date.now(),
  ): SyncBundleMessage {
    if (this.checkTimeout(nowMs)) {
      throw new Error('Pairing session expired')
    }
    if (this.role !== 'initiator') {
      this.fail('Only initiator can send sync_bundle')
      throw new Error(this._failureReason!)
    }
    if (this._phase !== 'awaiting_sas_confirmation' || !this._derivedKeys) {
      this.fail(`Cannot send sync_bundle in phase ${this._phase}`)
      throw new Error(this._failureReason!)
    }

    this._sasConfirmedByUser = true
    const encrypted = encryptDeviceSyncBundle(
      bundle,
      this._derivedKeys.encryptionKey,
      this.sessionId,
    )
    this._expectedBundleDigestHex = encrypted.bundleDigestHex
    this._phase = 'awaiting_sync_ack'

    return {
      type: 'sync_bundle',
      version: DEVICE_PAIRING_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      ciphertextBase64: encrypted.ciphertextBase64,
      nonceBase64: encrypted.nonceBase64,
      bundleDigestHex: encrypted.bundleDigestHex,
    }
  }

  public confirmSasOnResponder(nowMs: number = Date.now()): void {
    if (this.checkTimeout(nowMs)) {
      throw new Error('Pairing session expired')
    }
    if (this.role !== 'responder') {
      this.fail('Only responder can call confirmSasOnResponder')
      throw new Error(this._failureReason!)
    }
    if (this._phase !== 'awaiting_sas_confirmation') {
      this.fail(`Cannot confirm SAS in phase ${this._phase}`)
      throw new Error(this._failureReason!)
    }
    this._sasConfirmedByUser = true
    this._phase = 'awaiting_sync_bundle'
  }

  public handleSyncBundle(
    msg: SyncBundleMessage,
    nowMs: number = Date.now(),
  ): { bundle: DeviceSyncBundle; ackMessage: SyncAckMessage } {
    if (this.checkTimeout(nowMs)) {
      throw new Error('Pairing session expired')
    }
    if (this.role !== 'responder') {
      this.fail('Only responder can handle sync_bundle')
      throw new Error(this._failureReason!)
    }
    if (
      this._phase !== 'awaiting_sync_bundle' ||
      !this._sasConfirmedByUser ||
      !this._derivedKeys ||
      !this._responderDeviceId
    ) {
      this.fail('Refusing to decrypt sync_bundle before user SAS confirmation')
      throw new Error(this._failureReason!)
    }
    if (
      msg.type !== 'sync_bundle' ||
      msg.version !== DEVICE_PAIRING_PROTOCOL_VERSION ||
      !constantTimeStringEqual(msg.sessionId.toLowerCase(), this.sessionId)
    ) {
      this.fail('Invalid sync_bundle session or version')
      throw new Error(this._failureReason!)
    }

    try {
      const bundle = decryptDeviceSyncBundle(
        {
          ciphertextBase64: msg.ciphertextBase64,
          nonceBase64: msg.nonceBase64,
          bundleDigestHex: msg.bundleDigestHex,
        },
        this._derivedKeys.encryptionKey,
        this.sessionId,
      )
      this._phase = 'completed'
      this.zeroizeSecrets()

      return {
        bundle,
        ackMessage: {
          type: 'sync_ack',
          version: DEVICE_PAIRING_PROTOCOL_VERSION,
          sessionId: this.sessionId,
          responderDeviceId: this._responderDeviceId,
          bundleDigestHex: msg.bundleDigestHex,
        },
      }
    } catch (err) {
      this.fail((err as Error).message)
      throw err
    }
  }

  public handleSyncAck(msg: SyncAckMessage, nowMs: number = Date.now()): void {
    if (this.checkTimeout(nowMs)) {
      throw new Error('Pairing session expired')
    }
    if (this.role !== 'initiator') {
      this.fail('Only initiator can handle sync_ack')
      throw new Error(this._failureReason!)
    }
    if (this._phase !== 'awaiting_sync_ack' || !this._expectedBundleDigestHex) {
      this.fail(`Unexpected sync_ack in phase ${this._phase}`)
      throw new Error(this._failureReason!)
    }
    if (
      msg.type !== 'sync_ack' ||
      msg.version !== DEVICE_PAIRING_PROTOCOL_VERSION ||
      !constantTimeStringEqual(msg.sessionId.toLowerCase(), this.sessionId) ||
      !constantTimeStringEqual(
        msg.bundleDigestHex.toLowerCase(),
        this._expectedBundleDigestHex.toLowerCase(),
      )
    ) {
      this.fail('Invalid sync_ack digest or sessionId')
      throw new Error(this._failureReason!)
    }

    this._phase = 'completed'
    this.zeroizeSecrets()
  }

  public abort(reason: string = 'User rejected SAS or cancelled pairing'): PairingAbortMessage {
    this.fail(reason)
    return {
      type: 'pairing_abort',
      version: DEVICE_PAIRING_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      reason,
    }
  }

  public zeroizeSecrets(): void {
    zeroizePairingKeys({
      ephemeralPrivKey: this._localEphemeralPrivKey,
      encryptionKey: this._derivedKeys?.encryptionKey ?? null,
    })
  }

  private fail(reason: string): void {
    this._phase = 'failed'
    this._failureReason = reason
    this.zeroizeSecrets()
  }
}
