import {
  decodeCanonical,
  encodeCanonical,
  standaloneItemBudget,
  type Encodable,
  type FrankValue,
} from '@frank/codec'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'
import type {
  ApplicationItemPlugin,
  MessageItemDecodeContext,
  MessageItemPlugin,
  MessageItemPluginCapabilities,
  MessageItemRegistry,
} from '../registry'
import {
  filterCandidateForIcePolicy,
  sanitizeSdpForIcePolicy,
} from './turn-policy'

export const WEBRTC_CALL_PLUGIN_ID = 'webrtc-call-v1' as const
export const WEBRTC_CALL_ITEM_TYPE = WEBRTC_CALL_PLUGIN_ID
export const WEBRTC_CALL_SCHEMA_VERSION = 1 as const
export const WEBRTC_DATA_CHANNEL_LABEL = 'frank-call-control-v1' as const

export const WEBRTC_MAX_SDP_UTF8_BYTES = 65536
export const WEBRTC_MAX_CANDIDATES = 64
export const WEBRTC_MAX_CANDIDATE_CHARS = 512
export const WEBRTC_MAX_REASON_CHARS = 280
export const WEBRTC_MAX_DEVICE_ID_CHARS = 128

export type WebRtcCallAction =
  | 'invite'
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'hangup'
  | 'ice_batch'

export type WebRtcMediaIntent = 'audio' | 'video' | 'screen'

export type WebRtcIceTransportPolicy =
  | 'direct-preferred'
  | 'relay-only'
  | 'direct-only'

export interface WebRtcCallPayload {
  schemaVersion: 1
  callId: string
  action: WebRtcCallAction
  sequence: number
  senderDeviceId: string
  mediaIntent?: WebRtcMediaIntent
  icePolicy?: WebRtcIceTransportPolicy
  sdp?: string
  dtlsFingerprintSha256?: string
  candidates?: string[]
  expiresAtMs?: number
  reason?: string
}

export type WebRtcDataChannelMessage =
  | {
      type: 'mute_state'
      muted: boolean
      videoEnabled: boolean
      screenSharing: boolean
      seq: number
    }
  | {
      type: 'renegotiate_offer'
      mediaIntent: WebRtcMediaIntent
      sdp: string
      dtlsFingerprintSha256: string
      seq: number
    }
  | {
      type: 'renegotiate_answer'
      sdp: string
      dtlsFingerprintSha256: string
      seq: number
    }
  | {
      type: 'hangup'
      reason?: string
      seq: number
    }
  | {
      type: 'ping'
      timestampMs: number
    }
  | {
      type: 'pong'
      timestampMs: number
    }

const ALLOWED_PAYLOAD_KEYS = new Set<string>([
  'schemaVersion',
  'callId',
  'action',
  'sequence',
  'senderDeviceId',
  'mediaIntent',
  'icePolicy',
  'sdp',
  'dtlsFingerprintSha256',
  'candidates',
  'expiresAtMs',
  'reason',
])

const VALID_ACTIONS = new Set<WebRtcCallAction>([
  'invite',
  'accept',
  'reject',
  'cancel',
  'hangup',
  'ice_batch',
])

const VALID_MEDIA_INTENTS = new Set<WebRtcMediaIntent>([
  'audio',
  'video',
  'screen',
])

const VALID_ICE_POLICIES = new Set<WebRtcIceTransportPolicy>([
  'direct-preferred',
  'relay-only',
  'direct-only',
])

const CBOR_KEY_SCHEMA_VERSION = 0
const CBOR_KEY_CALL_ID = 1
const CBOR_KEY_ACTION = 2
const CBOR_KEY_SEQUENCE = 3
const CBOR_KEY_SENDER_DEVICE_ID = 4
const CBOR_KEY_MEDIA_INTENT = 5
const CBOR_KEY_ICE_POLICY = 6
const CBOR_KEY_SDP = 7
const CBOR_KEY_DTLS_FINGERPRINT_SHA256 = 8
const CBOR_KEY_CANDIDATES = 9
const CBOR_KEY_EXPIRES_AT_MS = 10
const CBOR_KEY_REASON = 11

const utf8Encoder = new TextEncoder()

function constantTimeEqualStrings(a: string, b: string): boolean {
  const bytesA = utf8Encoder.encode(a)
  const bytesB = utf8Encoder.encode(b)
  if (bytesA.byteLength !== bytesB.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < bytesA.byteLength; i += 1) {
    diff |= bytesA[i]! ^ bytesB[i]!
  }
  return diff === 0
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) return true
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

function assertCleanString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`webrtc-call ${field} must be a string`)
  }
  if (hasLoneSurrogate(value)) {
    throw new TypeError(
      `webrtc-call ${field} must be valid UTF-8 without lone surrogates`,
    )
  }
  return value
}

export function generateCallId(): string {
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: {
        randomUUID?: () => string
        getRandomValues?: <T extends Uint8Array>(arr: T) => T
      }
    }
  ).crypto
  if (runtimeCrypto?.randomUUID) {
    return runtimeCrypto.randomUUID().replace(/-/g, '')
  }
  const bytes = new Uint8Array(16)
  if (runtimeCrypto?.getRandomValues) {
    runtimeCrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Validates a 32-byte SHA-256 DTLS certificate fingerprint and normalizes it
 * to canonical uppercase colon-separated form (`AA:BB:...:FF`).
 *
 * Rejects weak algorithms (`sha-1`, `md5`, etc.) or wrong byte lengths.
 */
export function normalizeDtlsFingerprintSha256(raw: string): string {
  if (typeof raw !== 'string') {
    throw new TypeError('DTLS fingerprint must be a string')
  }
  let trimmed = raw.trim()
  if (!trimmed) {
    throw new TypeError('DTLS fingerprint must not be empty')
  }

  const algoPrefixMatch = /^([a-zA-Z0-9-]+)\s+(.+)$/.exec(trimmed)
  if (algoPrefixMatch) {
    const algo = algoPrefixMatch[1]!.toLowerCase()
    if (algo !== 'sha-256') {
      throw new TypeError(
        `Unsupported DTLS fingerprint hash algorithm '${algo}'; only sha-256 is permitted`,
      )
    }
    trimmed = algoPrefixMatch[2]!.trim()
  }

  if (/^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){31}$/.test(trimmed)) {
    return trimmed.toUpperCase()
  }

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const pairs: string[] = []
    for (let i = 0; i < 64; i += 2) {
      pairs.push(trimmed.slice(i, i + 2).toUpperCase())
    }
    return pairs.join(':')
  }

  throw new TypeError(
    'DTLS fingerprint must be a 32-byte SHA-256 hex digest (AA:BB:... or 64 hex chars)',
  )
}

/**
 * Extracts and validates the `a=fingerprint:sha-256 ...` attribute from an SDP offer or answer.
 *
 * Security invariants:
 * - Rejects SDPs with no `a=fingerprint:` attribute.
 * - Rejects SDPs containing any weak/non-SHA-256 fingerprint (`sha-1`, `md5`, etc.).
 * - Ensures every `a=fingerprint:` line across session and media (`m=`) sections carries
 *   the exact same canonical 32-byte `sha-256` fingerprint.
 * - Ensures that if no session-level `a=fingerprint:` is present, every `m=` media section
 *   contains its own matching `a=fingerprint:sha-256` attribute.
 */
export function extractSdpDtlsFingerprintSha256(sdp: string): string | null {
  if (typeof sdp !== 'string' || !sdp.trim()) {
    return null
  }

  const lines = sdp.split(/\r?\n/)
  let sessionFingerprint: string | null = null
  let currentMediaIndex = -1
  const mediaSectionFingerprints: Array<string | null> = []
  let canonicalFingerprint: string | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (line.startsWith('m=')) {
      currentMediaIndex += 1
      mediaSectionFingerprints.push(null)
      continue
    }

    if (line.toLowerCase().startsWith('a=fingerprint:')) {
      const rest = line.slice('a=fingerprint:'.length).trim()
      const match = /^([a-zA-Z0-9-]+)\s+(\S+)$/.exec(rest)
      if (!match) {
        return null
      }
      const algo = match[1]!.toLowerCase()
      if (algo !== 'sha-256') {
        return null
      }
      let normalized: string
      try {
        normalized = normalizeDtlsFingerprintSha256(match[2]!)
      } catch {
        return null
      }

      if (canonicalFingerprint === null) {
        canonicalFingerprint = normalized
      } else if (!constantTimeEqualStrings(canonicalFingerprint, normalized)) {
        return null
      }

      if (currentMediaIndex === -1) {
        sessionFingerprint = normalized
      } else {
        const existingMediaFp = mediaSectionFingerprints[currentMediaIndex]
        if (
          existingMediaFp !== null &&
          existingMediaFp !== undefined &&
          !constantTimeEqualStrings(existingMediaFp, normalized)
        ) {
          return null
        }
        mediaSectionFingerprints[currentMediaIndex] = normalized
      }
    }
  }

  if (canonicalFingerprint === null) {
    return null
  }

  if (
    sessionFingerprint === null &&
    mediaSectionFingerprints.length > 0 &&
    mediaSectionFingerprints.some(fp => fp === null)
  ) {
    return null
  }

  return canonicalFingerprint
}

/**
 * Constant-time verification that the SDP's `a=fingerprint:sha-256` attribute matches
 * the Frank-authenticated `expectedFingerprintSha256`.
 */
export function verifyRemoteSdpFingerprint(
  sdp: string,
  expectedFingerprintSha256: string,
): boolean {
  const sdpFingerprint = extractSdpDtlsFingerprintSha256(sdp)
  if (!sdpFingerprint) {
    return false
  }
  let normalizedExpected: string
  try {
    normalizedExpected = normalizeDtlsFingerprintSha256(
      expectedFingerprintSha256,
    )
  } catch {
    return false
  }
  return constantTimeEqualStrings(sdpFingerprint, normalizedExpected)
}

/**
 * Computes a domain-separated SHA-256 transcript binding hash over the authenticated
 * call parameters and DTLS fingerprints.
 */
export function computeCallTranscriptBindingHash(params: {
  callId: string
  callerAddress: string
  calleeAddress: string
  offerFingerprintSha256: string
  answerFingerprintSha256?: string
  mediaIntent: WebRtcMediaIntent
  expiresAtMs: number
}): string {
  const callId = assertCallId(params.callId)
  const callerAddress = assertCleanString(
    params.callerAddress,
    'callerAddress',
  ).trim()
  const calleeAddress = assertCleanString(
    params.calleeAddress,
    'calleeAddress',
  ).trim()
  if (!callerAddress || !calleeAddress) {
    throw new TypeError('callerAddress and calleeAddress must not be empty')
  }
  if (!VALID_MEDIA_INTENTS.has(params.mediaIntent)) {
    throw new TypeError(`Invalid mediaIntent: ${String(params.mediaIntent)}`)
  }
  if (
    typeof params.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(params.expiresAtMs) ||
    params.expiresAtMs <= 0
  ) {
    throw new TypeError('expiresAtMs must be a positive safe integer')
  }

  const offerFp = normalizeDtlsFingerprintSha256(params.offerFingerprintSha256)
  const answerFp =
    params.answerFingerprintSha256 !== undefined
      ? normalizeDtlsFingerprintSha256(params.answerFingerprintSha256)
      : ''

  const canonicalTranscript = encodeCanonical([
    'frank-webrtc-call-transcript-v1',
    callId,
    callerAddress.toLowerCase(),
    calleeAddress.toLowerCase(),
    offerFp,
    answerFp,
    params.mediaIntent,
    params.expiresAtMs,
  ])

  return bytesToHex(sha256(canonicalTranscript))
}

/**
 * Deterministic glare resolution tie-breaker when two peers send simultaneous `invite` offers.
 * Compares normalized `callerAddress` lexically, breaking ties by `callId`.
 */
export function resolveGlareWinner(
  offerA: { callerAddress: string; callId: string },
  offerB: { callerAddress: string; callId: string },
): 'A' | 'B' {
  const addrA = offerA.callerAddress.trim().toLowerCase()
  const addrB = offerB.callerAddress.trim().toLowerCase()
  if (addrA !== addrB) {
    return addrA < addrB ? 'A' : 'B'
  }
  return offerA.callId <= offerB.callId ? 'A' : 'B'
}

function assertCallId(value: unknown): string {
  const id = assertCleanString(value, 'callId')
  if (!/^[a-zA-Z0-9_-]{16,64}$/.test(id)) {
    throw new TypeError(
      'webrtc-call callId must be 16..64 alphanumeric, hyphen, or underscore characters',
    )
  }
  return id
}

function assertSenderDeviceId(value: unknown): string {
  const deviceId = assertCleanString(value, 'senderDeviceId').trim()
  if (
    deviceId.length < 1 ||
    deviceId.length > WEBRTC_MAX_DEVICE_ID_CHARS ||
    !/^[\x21-\x7e]+$/.test(deviceId)
  ) {
    throw new TypeError(
      `webrtc-call senderDeviceId must be 1..${WEBRTC_MAX_DEVICE_ID_CHARS} printable non-whitespace ASCII characters`,
    )
  }
  return deviceId
}

/**
 * Validates and normalizes a `WebRtcCallPayload`.
 *
 * When `icePolicy === 'relay-only'`, automatically sanitizes `sdp` and filters `candidates`
 * so no host or server-reflexive IP addresses can remain in a validated payload.
 */
export function validateWebRtcCallPayload(raw: unknown): WebRtcCallPayload {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    (Object.getPrototypeOf(raw) !== Object.prototype &&
      Object.getPrototypeOf(raw) !== null)
  ) {
    throw new TypeError('Expected plain webrtc-call-v1 payload object')
  }

  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !ALLOWED_PAYLOAD_KEYS.has(key)) {
      throw new TypeError(`Unexpected webrtc-call-v1 property: ${String(key)}`)
    }
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    if (!desc || !desc.enumerable || !('value' in desc)) {
      throw new TypeError(
        `webrtc-call-v1 property ${key} must be an enumerable data property`,
      )
    }
  }

  const record = raw as Record<string, unknown>

  if (record.schemaVersion !== WEBRTC_CALL_SCHEMA_VERSION) {
    throw new TypeError(
      `webrtc-call-v1 schemaVersion must be ${WEBRTC_CALL_SCHEMA_VERSION}`,
    )
  }

  const callId = assertCallId(record.callId)

  if (
    typeof record.action !== 'string' ||
    !VALID_ACTIONS.has(record.action as WebRtcCallAction)
  ) {
    throw new TypeError(
      `webrtc-call-v1 action must be one of invite, accept, reject, cancel, hangup, ice_batch`,
    )
  }
  const action = record.action as WebRtcCallAction

  if (
    typeof record.sequence !== 'number' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0 ||
    Object.is(record.sequence, -0)
  ) {
    throw new TypeError(
      'webrtc-call-v1 sequence must be a non-negative safe integer',
    )
  }
  const sequence = record.sequence

  const senderDeviceId = assertSenderDeviceId(record.senderDeviceId)

  let mediaIntent: WebRtcMediaIntent | undefined
  if (record.mediaIntent !== undefined) {
    if (
      typeof record.mediaIntent !== 'string' ||
      !VALID_MEDIA_INTENTS.has(record.mediaIntent as WebRtcMediaIntent)
    ) {
      throw new TypeError(
        'webrtc-call-v1 mediaIntent must be audio, video, or screen',
      )
    }
    mediaIntent = record.mediaIntent as WebRtcMediaIntent
  }

  let icePolicy: WebRtcIceTransportPolicy | undefined
  if (record.icePolicy !== undefined) {
    if (
      typeof record.icePolicy !== 'string' ||
      !VALID_ICE_POLICIES.has(record.icePolicy as WebRtcIceTransportPolicy)
    ) {
      throw new TypeError(
        'webrtc-call-v1 icePolicy must be direct-preferred, relay-only, or direct-only',
      )
    }
    icePolicy = record.icePolicy as WebRtcIceTransportPolicy
  }

  const effectivePolicy: WebRtcIceTransportPolicy =
    icePolicy ?? 'direct-preferred'

  let sdp: string | undefined
  if (record.sdp !== undefined) {
    const cleanSdp = assertCleanString(record.sdp, 'sdp')
    const sdpBytes = utf8Encoder.encode(cleanSdp).byteLength
    if (
      sdpBytes < 1 ||
      sdpBytes > WEBRTC_MAX_SDP_UTF8_BYTES ||
      cleanSdp.trim().length === 0
    ) {
      throw new RangeError(
        `webrtc-call-v1 sdp must be 1..${WEBRTC_MAX_SDP_UTF8_BYTES} non-empty UTF-8 bytes`,
      )
    }
    sdp =
      effectivePolicy !== 'direct-preferred'
        ? sanitizeSdpForIcePolicy(cleanSdp, effectivePolicy)
        : cleanSdp
  }

  let dtlsFingerprintSha256: string | undefined
  if (record.dtlsFingerprintSha256 !== undefined) {
    dtlsFingerprintSha256 = normalizeDtlsFingerprintSha256(
      assertCleanString(record.dtlsFingerprintSha256, 'dtlsFingerprintSha256'),
    )
  }

  let candidates: string[] | undefined
  if (record.candidates !== undefined) {
    if (
      !Array.isArray(record.candidates) ||
      Object.getPrototypeOf(record.candidates) !== Array.prototype
    ) {
      throw new TypeError('webrtc-call-v1 candidates must be a plain array')
    }
    if (Object.keys(record.candidates).length !== record.candidates.length) {
      throw new TypeError('webrtc-call-v1 candidates must be a dense array')
    }
    if (record.candidates.length > WEBRTC_MAX_CANDIDATES) {
      throw new RangeError(
        `webrtc-call-v1 candidates may contain at most ${WEBRTC_MAX_CANDIDATES} items`,
      )
    }
    const validatedCandidates = record.candidates.map((cand, idx) => {
      const str = assertCleanString(cand, `candidates[${idx}]`).trim()
      if (str.length < 1 || str.length > WEBRTC_MAX_CANDIDATE_CHARS) {
        throw new RangeError(
          `webrtc-call-v1 candidates[${idx}] must be 1..${WEBRTC_MAX_CANDIDATE_CHARS} chars`,
        )
      }
      return str
    })
    candidates =
      effectivePolicy !== 'direct-preferred'
        ? validatedCandidates.filter(c =>
            filterCandidateForIcePolicy(c, effectivePolicy),
          )
        : validatedCandidates
  }

  let expiresAtMs: number | undefined
  if (record.expiresAtMs !== undefined) {
    if (
      typeof record.expiresAtMs !== 'number' ||
      !Number.isSafeInteger(record.expiresAtMs) ||
      record.expiresAtMs <= 0 ||
      Object.is(record.expiresAtMs, -0)
    ) {
      throw new TypeError(
        'webrtc-call-v1 expiresAtMs must be a positive safe integer',
      )
    }
    expiresAtMs = record.expiresAtMs
  }

  let reason: string | undefined
  if (record.reason !== undefined) {
    const cleanReason = assertCleanString(record.reason, 'reason').trim()
    if (cleanReason.length > WEBRTC_MAX_REASON_CHARS) {
      throw new RangeError(
        `webrtc-call-v1 reason must be at most ${WEBRTC_MAX_REASON_CHARS} characters`,
      )
    }
    if (cleanReason.length > 0) {
      reason = cleanReason
    }
  }

  if (action === 'invite') {
    if (sdp === undefined) {
      throw new TypeError('webrtc-call-v1 invite requires bundled sdp offer')
    }
    if (dtlsFingerprintSha256 === undefined) {
      throw new TypeError(
        'webrtc-call-v1 invite requires dtlsFingerprintSha256',
      )
    }
    if (expiresAtMs === undefined) {
      throw new TypeError('webrtc-call-v1 invite requires expiresAtMs')
    }
  } else if (action === 'accept') {
    if (sdp === undefined) {
      throw new TypeError('webrtc-call-v1 accept requires bundled sdp answer')
    }
    if (dtlsFingerprintSha256 === undefined) {
      throw new TypeError(
        'webrtc-call-v1 accept requires dtlsFingerprintSha256',
      )
    }
  }

  const result: WebRtcCallPayload = {
    schemaVersion: WEBRTC_CALL_SCHEMA_VERSION,
    callId,
    action,
    sequence,
    senderDeviceId,
  }

  if (mediaIntent !== undefined) result.mediaIntent = mediaIntent
  if (icePolicy !== undefined) result.icePolicy = icePolicy
  if (sdp !== undefined) result.sdp = sdp
  if (dtlsFingerprintSha256 !== undefined) {
    result.dtlsFingerprintSha256 = dtlsFingerprintSha256
  }
  if (candidates !== undefined) result.candidates = candidates
  if (expiresAtMs !== undefined) result.expiresAtMs = expiresAtMs
  if (reason !== undefined) result.reason = reason

  return result
}

export const readWebRtcCallPayload = validateWebRtcCallPayload

function encodeWebRtcCallCborMap(
  payload: WebRtcCallPayload,
): Map<number, Encodable> {
  const map = new Map<number, Encodable>([
    [CBOR_KEY_SCHEMA_VERSION, payload.schemaVersion],
    [CBOR_KEY_CALL_ID, payload.callId],
    [CBOR_KEY_ACTION, payload.action],
    [CBOR_KEY_SEQUENCE, payload.sequence],
    [CBOR_KEY_SENDER_DEVICE_ID, payload.senderDeviceId],
  ])
  if (payload.mediaIntent !== undefined) {
    map.set(CBOR_KEY_MEDIA_INTENT, payload.mediaIntent)
  }
  if (payload.icePolicy !== undefined) {
    map.set(CBOR_KEY_ICE_POLICY, payload.icePolicy)
  }
  if (payload.sdp !== undefined) {
    map.set(CBOR_KEY_SDP, payload.sdp)
  }
  if (payload.dtlsFingerprintSha256 !== undefined) {
    map.set(CBOR_KEY_DTLS_FINGERPRINT_SHA256, payload.dtlsFingerprintSha256)
  }
  if (payload.candidates !== undefined) {
    map.set(CBOR_KEY_CANDIDATES, payload.candidates)
  }
  if (payload.expiresAtMs !== undefined) {
    map.set(CBOR_KEY_EXPIRES_AT_MS, payload.expiresAtMs)
  }
  if (payload.reason !== undefined) {
    map.set(CBOR_KEY_REASON, payload.reason)
  }
  return map
}

function decodeSafeIntegerField(value: FrankValue, field: string): number {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError(`webrtc-call-v1 ${field} must be a safe integer`)
  }
  return Number(value)
}

function decodeWebRtcCallCborMap(decoded: FrankValue): WebRtcCallPayload {
  if (!(decoded instanceof Map)) {
    throw new TypeError('Expected canonical CBOR map for webrtc-call-v1')
  }
  for (const key of decoded.keys()) {
    if (typeof key !== 'bigint' || key < 0n || key > 11n) {
      throw new TypeError(
        `Unexpected CBOR key in webrtc-call-v1: ${String(key)}`,
      )
    }
  }

  const rawSchemaVersion = decoded.get(BigInt(CBOR_KEY_SCHEMA_VERSION))
  if (rawSchemaVersion !== 1n) {
    throw new TypeError('webrtc-call-v1 schemaVersion must be 1')
  }

  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    callId: decoded.get(BigInt(CBOR_KEY_CALL_ID)),
    action: decoded.get(BigInt(CBOR_KEY_ACTION)),
    sequence: decodeSafeIntegerField(
      decoded.get(BigInt(CBOR_KEY_SEQUENCE)),
      'sequence',
    ),
    senderDeviceId: decoded.get(BigInt(CBOR_KEY_SENDER_DEVICE_ID)),
  }

  if (decoded.has(BigInt(CBOR_KEY_MEDIA_INTENT))) {
    candidate.mediaIntent = decoded.get(BigInt(CBOR_KEY_MEDIA_INTENT))
  }
  if (decoded.has(BigInt(CBOR_KEY_ICE_POLICY))) {
    candidate.icePolicy = decoded.get(BigInt(CBOR_KEY_ICE_POLICY))
  }
  if (decoded.has(BigInt(CBOR_KEY_SDP))) {
    candidate.sdp = decoded.get(BigInt(CBOR_KEY_SDP))
  }
  if (decoded.has(BigInt(CBOR_KEY_DTLS_FINGERPRINT_SHA256))) {
    candidate.dtlsFingerprintSha256 = decoded.get(
      BigInt(CBOR_KEY_DTLS_FINGERPRINT_SHA256),
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_CANDIDATES))) {
    candidate.candidates = decoded.get(BigInt(CBOR_KEY_CANDIDATES))
  }
  if (decoded.has(BigInt(CBOR_KEY_EXPIRES_AT_MS))) {
    candidate.expiresAtMs = decodeSafeIntegerField(
      decoded.get(BigInt(CBOR_KEY_EXPIRES_AT_MS)),
      'expiresAtMs',
    )
  }
  if (decoded.has(BigInt(CBOR_KEY_REASON))) {
    candidate.reason = decoded.get(BigInt(CBOR_KEY_REASON))
  }

  return validateWebRtcCallPayload(candidate)
}

export function encodeWebRtcCallPayload(
  payload: WebRtcCallPayload,
): Uint8Array {
  const validated = validateWebRtcCallPayload(payload)
  return encodeCanonical(encodeWebRtcCallCborMap(validated))
}

export function decodeWebRtcCallPayload(
  bytes: Uint8Array,
  context?: MessageItemDecodeContext,
): WebRtcCallPayload {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new TypeError(
      'Expected non-empty Uint8Array for webrtc-call-v1 payload',
    )
  }
  const decoded = context?.budget
    ? context.budget.decodeCbor(bytes, WEBRTC_CALL_PLUGIN_ID)
    : standaloneItemBudget().decodeCbor(bytes, WEBRTC_CALL_PLUGIN_ID)
  return decodeWebRtcCallCborMap(decoded)
}

export function formatWebRtcCallPreviewText(
  payload: WebRtcCallPayload,
): string {
  const validated = validateWebRtcCallPayload(payload)
  const intentLabel =
    validated.mediaIntent === 'video'
      ? 'Video call'
      : validated.mediaIntent === 'screen'
        ? 'Screen share call'
        : 'Voice call'

  switch (validated.action) {
    case 'invite':
      return `📞 ${intentLabel} invitation`
    case 'accept':
      return '📞 Call accepted'
    case 'reject':
      return '📞 Call declined'
    case 'cancel':
      return '📞 Missed call (cancelled)'
    case 'hangup':
      return '📞 Call ended'
    case 'ice_batch':
      return '📞 Call connectivity update'
  }
}

export function toWebRtcCallApplicationItem(
  payload: WebRtcCallPayload,
): ApplicationMessageItem {
  return {
    type: 'application',
    itemType: WEBRTC_CALL_PLUGIN_ID,
    value: validateWebRtcCallPayload(payload),
  }
}

export function parseWebRtcCallApplicationItem(
  itemOrPayload: unknown,
): WebRtcCallPayload | null {
  if (typeof itemOrPayload !== 'object' || itemOrPayload === null) {
    return null
  }
  const candidate = itemOrPayload as {
    type?: unknown
    itemType?: unknown
    value?: unknown
    payload?: unknown
  }

  if (candidate.type === 'application') {
    if (candidate.itemType !== WEBRTC_CALL_PLUGIN_ID) {
      return null
    }
    try {
      return validateWebRtcCallPayload(candidate.value)
    } catch {
      return null
    }
  }

  if (
    candidate.type === WEBRTC_CALL_PLUGIN_ID ||
    candidate.itemType === WEBRTC_CALL_PLUGIN_ID
  ) {
    const inner =
      candidate.value !== undefined
        ? candidate.value
        : candidate.payload !== undefined
          ? candidate.payload
          : itemOrPayload
    try {
      return validateWebRtcCallPayload(inner)
    } catch {
      return null
    }
  }

  try {
    return validateWebRtcCallPayload(itemOrPayload)
  } catch {
    return null
  }
}

export function extractWebRtcCallPayload(
  item: unknown,
): WebRtcCallPayload | null {
  return parseWebRtcCallApplicationItem(item)
}

function unwrapWebRtcCallPayload(
  input: WebRtcCallPayload | ApplicationMessageItem,
): WebRtcCallPayload {
  if (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    input.type === 'application'
  ) {
    if (input.itemType !== WEBRTC_CALL_PLUGIN_ID) {
      throw new TypeError(`Expected ${WEBRTC_CALL_PLUGIN_ID} application item`)
    }
    return validateWebRtcCallPayload(input.value)
  }
  return validateWebRtcCallPayload(input)
}

export interface WebRtcCallPluginContract
  extends ApplicationItemPlugin<WebRtcCallPayload>,
    Omit<
      MessageItemPlugin<ApplicationMessageItem, WebRtcCallPayload>,
      'encode' | 'decode' | 'previewText' | 'hydrate'
    > {
  readonly pluginId: typeof WEBRTC_CALL_PLUGIN_ID
  readonly type: typeof WEBRTC_CALL_PLUGIN_ID
  readonly itemType: typeof WEBRTC_CALL_PLUGIN_ID
  readonly carrier: 'application'
  read(value: unknown): WebRtcCallPayload
  buildSummary(payload: WebRtcCallPayload | ApplicationMessageItem): string
  previewText(payload: WebRtcCallPayload | ApplicationMessageItem): string
  encode(payload: WebRtcCallPayload | ApplicationMessageItem): Uint8Array
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): WebRtcCallPayload
  hydrate(
    raw: ApplicationMessageItem | WebRtcCallPayload,
  ): WebRtcCallPayload
}

export const webrtcCallPlugin: WebRtcCallPluginContract = {
  pluginId: WEBRTC_CALL_PLUGIN_ID,
  type: WEBRTC_CALL_PLUGIN_ID,
  itemType: WEBRTC_CALL_PLUGIN_ID,
  carrier: 'application',
  read: validateWebRtcCallPayload,
  hydrate(raw: ApplicationMessageItem | WebRtcCallPayload): WebRtcCallPayload {
    return unwrapWebRtcCallPayload(raw)
  },
  buildSummary(input: WebRtcCallPayload | ApplicationMessageItem): string {
    return formatWebRtcCallPreviewText(unwrapWebRtcCallPayload(input))
  },
  previewText(input: WebRtcCallPayload | ApplicationMessageItem): string {
    return formatWebRtcCallPreviewText(unwrapWebRtcCallPayload(input))
  },
  encode(input: WebRtcCallPayload | ApplicationMessageItem): Uint8Array {
    return encodeWebRtcCallPayload(unwrapWebRtcCallPayload(input))
  },
  decode(
    bytes: Uint8Array,
    context?: MessageItemDecodeContext,
  ): WebRtcCallPayload {
    return decodeWebRtcCallPayload(bytes, context)
  },
}

export function createWebRtcCallPlugin(): WebRtcCallPluginContract {
  return webrtcCallPlugin
}

export function initWebRtcCallPlugin(
  registry: MessageItemRegistry,
  _capabilities?: MessageItemPluginCapabilities,
): void {
  registry.registerApplication(createWebRtcCallPlugin())
}

// ---------------------------------------------------------------------------
// P2P RTCDataChannel In-Call Control Protocol (#464, #466)
// ---------------------------------------------------------------------------

function validateDataChannelSeq(seq: unknown): number {
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0 ||
    Object.is(seq, -0)
  ) {
    throw new TypeError('DataChannel message seq must be a non-negative integer')
  }
  return seq
}

function validateDataChannelMessageStructure(
  msg: unknown,
): WebRtcDataChannelMessage {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    throw new TypeError('Expected DataChannel message object')
  }
  const record = msg as Record<string, unknown>
  const type = record.type

  switch (type) {
    case 'mute_state': {
      if (
        typeof record.muted !== 'boolean' ||
        typeof record.videoEnabled !== 'boolean' ||
        typeof record.screenSharing !== 'boolean'
      ) {
        throw new TypeError(
          'mute_state requires boolean muted, videoEnabled, and screenSharing fields',
        )
      }
      return {
        type: 'mute_state',
        muted: record.muted,
        videoEnabled: record.videoEnabled,
        screenSharing: record.screenSharing,
        seq: validateDataChannelSeq(record.seq),
      }
    }
    case 'renegotiate_offer': {
      if (
        typeof record.mediaIntent !== 'string' ||
        !VALID_MEDIA_INTENTS.has(record.mediaIntent as WebRtcMediaIntent)
      ) {
        throw new TypeError('renegotiate_offer requires valid mediaIntent')
      }
      const sdp = assertCleanString(record.sdp, 'sdp')
      const fp = normalizeDtlsFingerprintSha256(
        assertCleanString(
          record.dtlsFingerprintSha256,
          'dtlsFingerprintSha256',
        ),
      )
      if (!verifyRemoteSdpFingerprint(sdp, fp)) {
        throw new Error(
          'renegotiate_offer SDP fingerprint does not match dtlsFingerprintSha256',
        )
      }
      return {
        type: 'renegotiate_offer',
        mediaIntent: record.mediaIntent as WebRtcMediaIntent,
        sdp,
        dtlsFingerprintSha256: fp,
        seq: validateDataChannelSeq(record.seq),
      }
    }
    case 'renegotiate_answer': {
      const sdp = assertCleanString(record.sdp, 'sdp')
      const fp = normalizeDtlsFingerprintSha256(
        assertCleanString(
          record.dtlsFingerprintSha256,
          'dtlsFingerprintSha256',
        ),
      )
      if (!verifyRemoteSdpFingerprint(sdp, fp)) {
        throw new Error(
          'renegotiate_answer SDP fingerprint does not match dtlsFingerprintSha256',
        )
      }
      return {
        type: 'renegotiate_answer',
        sdp,
        dtlsFingerprintSha256: fp,
        seq: validateDataChannelSeq(record.seq),
      }
    }
    case 'hangup': {
      const seq = validateDataChannelSeq(record.seq)
      if (record.reason !== undefined) {
        const reason = assertCleanString(record.reason, 'reason').trim()
        if (reason.length > WEBRTC_MAX_REASON_CHARS) {
          throw new RangeError('hangup reason exceeds maximum length')
        }
        return {
          type: 'hangup',
          ...(reason ? { reason } : {}),
          seq,
        }
      }
      return { type: 'hangup', seq }
    }
    case 'ping':
    case 'pong': {
      if (
        typeof record.timestampMs !== 'number' ||
        !Number.isSafeInteger(record.timestampMs) ||
        record.timestampMs < 0
      ) {
        throw new TypeError(
          `${type} timestampMs must be a non-negative safe integer`,
        )
      }
      return {
        type,
        timestampMs: record.timestampMs,
      }
    }
    default:
      throw new TypeError(`Unsupported DataChannel message type: ${String(type)}`)
  }
}

/**
 * Validates and encodes an in-call P2P `RTCDataChannel` control message (`frank-call-control-v1`).
 */
export function encodeDataChannelMessage(
  msg: WebRtcDataChannelMessage,
): string {
  const validated = validateDataChannelMessageStructure(msg)
  return JSON.stringify(validated)
}

/**
 * Decodes and validates an incoming P2P `RTCDataChannel` control message, enforcing that any
 * mid-call `renegotiate_offer` or `renegotiate_answer` preserves the peer's initial
 * Frank-authenticated `expectedRemoteFingerprintSha256`.
 */
export function decodeDataChannelMessage(
  raw: string,
  expectedRemoteFingerprintSha256: string,
): WebRtcDataChannelMessage {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new TypeError('DataChannel message must be a non-empty JSON string')
  }
  const normalizedExpectedFp = normalizeDtlsFingerprintSha256(
    expectedRemoteFingerprintSha256,
  )

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new TypeError('DataChannel message is not valid JSON')
  }

  const validated = validateDataChannelMessageStructure(parsed)

  if (
    validated.type === 'renegotiate_offer' ||
    validated.type === 'renegotiate_answer'
  ) {
    if (
      !constantTimeEqualStrings(
        validated.dtlsFingerprintSha256,
        normalizedExpectedFp,
      ) ||
      !verifyRemoteSdpFingerprint(validated.sdp, normalizedExpectedFp)
    ) {
      throw new Error(
        'Mid-call renegotiation rejected: DTLS fingerprint does not match peer authenticated fingerprint',
      )
    }
  }

  return validated
}
