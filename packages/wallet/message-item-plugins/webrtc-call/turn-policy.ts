import { hmac } from '@noble/hashes/hmac'
import { sha1 } from '@noble/hashes/sha1'
import { utf8ToBytes } from '@noble/hashes/utils'
import type { WebRtcIceTransportPolicy } from './schema'

export interface RTCIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface RtcConfigurationResult {
  iceTransportPolicy: 'all' | 'relay'
  iceServers: RTCIceServer[]
}

export const DEFAULT_TURN_TTL_SECONDS = 300
export const MAX_TURN_TTL_SECONDS = 3600

function constantTimeStringEqual(a: string, b: string): boolean {
  const bytesA = utf8ToBytes(a)
  const bytesB = utf8ToBytes(b)
  if (bytesA.byteLength !== bytesB.byteLength) {
    return false
  }
  let diff = 0
  for (let i = 0; i < bytesA.byteLength; i += 1) {
    diff |= bytesA[i]! ^ bytesB[i]!
  }
  return diff === 0
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/**
 * Evaluates whether a single ICE candidate line is permitted under the active
 * `WebRtcIceTransportPolicy`.
 *
 * - `relay-only`: allows ONLY `typ relay` candidates (blocks `host`, `srflx`, `prflx`).
 * - `direct-only`: allows non-relay candidates (`host`, `srflx`, `prflx`) and blocks `typ relay`.
 * - `direct-preferred`: allows all valid candidate types (`host`, `srflx`, `prflx`, `relay`).
 */
export function filterCandidateForIcePolicy(
  candidate: string,
  policy: WebRtcIceTransportPolicy,
): boolean {
  if (typeof candidate !== 'string') return false
  const trimmed = candidate.trim()
  if (!trimmed) return false

  const match = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(trimmed)
  if (!match || !match[1]) {
    return false
  }

  const candType = match[1].toLowerCase()
  if (policy === 'relay-only') {
    return candType === 'relay'
  }
  if (policy === 'direct-only') {
    return candType !== 'relay'
  }
  return true
}

function stripRelayCandidateReflexiveMetadata(candidateLine: string): string {
  return candidateLine
    .replace(/\s+raddr\s+\S+/gi, '')
    .replace(/\s+rport\s+\S+/gi, '')
}

/**
 * Sanitizes an SDP offer or answer according to the active `WebRtcIceTransportPolicy`.
 *
 * Under `relay-only`:
 * - Strips all `a=candidate:...` lines that are not `typ relay` (including `typ host`, `typ srflx`, `typ prflx`).
 * - Strips `raddr` and `rport` attributes from remaining `typ relay` candidates so the reflexive address
 *   behind the TURN allocation is never disclosed.
 * - Masks `c=IN IP4 <addr>` and `c=IN IP6 <addr>` connection lines to `c=IN IP4 0.0.0.0`.
 * - Masks `o=... IN IP4/IP6 <addr>` and `a=rtcp:<port> IN IP4/IP6 <addr>` addresses to `0.0.0.0`.
 */
export function sanitizeSdpForIcePolicy(
  sdp: string,
  policy: WebRtcIceTransportPolicy,
): string {
  if (typeof sdp !== 'string') {
    throw new TypeError('SDP must be a string')
  }
  if (policy === 'direct-preferred') {
    return sdp
  }

  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(/\r?\n/)
  const outLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()

    if (/^(?:a=)?candidate:/i.test(trimmed)) {
      if (!filterCandidateForIcePolicy(trimmed, policy)) {
        continue
      }
      if (policy === 'relay-only') {
        outLines.push(stripRelayCandidateReflexiveMetadata(line))
      } else {
        outLines.push(line)
      }
      continue
    }

    if (policy === 'relay-only') {
      if (/^c=IN\s+IP[46]\s+\S+/i.test(trimmed)) {
        outLines.push('c=IN IP4 0.0.0.0')
        continue
      }
      if (/^o=\S+\s+\S+\s+\S+\s+IN\s+IP[46]\s+\S+/i.test(trimmed)) {
        outLines.push(
          line.replace(/(\bIN\s+IP)[46]\s+\S+/i, '$14 0.0.0.0'),
        )
        continue
      }
      if (/^a=rtcp:\d+\s+IN\s+IP[46]\s+\S+/i.test(trimmed)) {
        outLines.push(
          line.replace(/(\bIN\s+IP)[46]\s+\S+/i, '$14 0.0.0.0'),
        )
        continue
      }
    }

    outLines.push(line)
  }

  return outLines.join(lineEnding)
}

function hasTurnUrl(server: RTCIceServer): boolean {
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
  return urls.some(
    u => typeof u === 'string' && /^turns?:/i.test(u.trim()),
  )
}

/**
 * Builds the browser/PeerConnection `RTCConfiguration` for the requested `WebRtcIceTransportPolicy`.
 *
 * When `policy === 'relay-only'`, enforces `iceTransportPolicy: 'relay'` and requires at least one
 * valid TURN server, failing closed if none is configured.
 */
export function buildRtcConfiguration(params: {
  policy: WebRtcIceTransportPolicy
  stunUrls?: string[]
  turnServers?: RTCIceServer[]
}): RtcConfigurationResult {
  const { policy, stunUrls = [], turnServers = [] } = params

  if (policy === 'relay-only') {
    const validTurnServers = turnServers.filter(hasTurnUrl)
    if (validTurnServers.length === 0) {
      throw new Error(
        'relay-only ICE transport policy requires at least one configured TURN server',
      )
    }
    return {
      iceTransportPolicy: 'relay',
      iceServers: validTurnServers.map(s => ({ ...s })),
    }
  }

  const stunServers: RTCIceServer[] =
    stunUrls.length > 0 ? [{ urls: [...stunUrls] }] : []

  if (policy === 'direct-only') {
    return {
      iceTransportPolicy: 'all',
      iceServers: stunServers,
    }
  }

  return {
    iceTransportPolicy: 'all',
    iceServers: [...stunServers, ...turnServers.map(s => ({ ...s }))],
  }
}

/**
 * Issues short-lived coturn-compatible TURN REST API credentials (`<expires>:<account>:<callId>`)
 * authenticated via HMAC-SHA1.
 */
export function issueTurnRestCredentials(params: {
  sharedSecret: string
  accountAddress: string
  callId: string
  nowSeconds: number
  ttlSeconds?: number
}): { username: string; credential: string; expiresAtSeconds: number } {
  const {
    sharedSecret,
    accountAddress,
    callId,
    nowSeconds,
    ttlSeconds = DEFAULT_TURN_TTL_SECONDS,
  } = params

  if (typeof sharedSecret !== 'string' || sharedSecret.trim().length < 8) {
    throw new TypeError('TURN sharedSecret must be a non-empty secret string')
  }
  if (
    typeof accountAddress !== 'string' ||
    !accountAddress.trim() ||
    accountAddress.includes(':')
  ) {
    throw new TypeError(
      'TURN accountAddress must be a non-empty string without colons',
    )
  }
  if (
    typeof callId !== 'string' ||
    !callId.trim() ||
    callId.includes(':')
  ) {
    throw new TypeError('TURN callId must be a non-empty string without colons')
  }
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new RangeError('nowSeconds must be a non-negative finite number')
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > MAX_TURN_TTL_SECONDS
  ) {
    throw new RangeError(
      `ttlSeconds must be an integer between 1 and ${MAX_TURN_TTL_SECONDS}`,
    )
  }

  const expiresAtSeconds = Math.floor(nowSeconds) + ttlSeconds
  const username = `${expiresAtSeconds}:${accountAddress.trim()}:${callId.trim()}`
  const macBytes = hmac(sha1, utf8ToBytes(sharedSecret), utf8ToBytes(username))
  const credential = bytesToBase64(macBytes)

  return {
    username,
    credential,
    expiresAtSeconds,
  }
}

/**
 * Verifies coturn-compatible TURN REST API credentials against expiry, max TTL,
 * optional account binding, and HMAC-SHA1 signature.
 */
export function verifyTurnRestCredentials(params: {
  sharedSecret: string
  username: string
  credential: string
  expectedAccountAddress?: string
  nowSeconds: number
  maxTtlSeconds?: number
}): { valid: boolean; reason?: string } {
  const {
    sharedSecret,
    username,
    credential,
    expectedAccountAddress,
    nowSeconds,
    maxTtlSeconds = MAX_TURN_TTL_SECONDS,
  } = params

  if (
    typeof sharedSecret !== 'string' ||
    !sharedSecret.trim() ||
    typeof username !== 'string' ||
    typeof credential !== 'string'
  ) {
    return { valid: false, reason: 'malformed_input' }
  }

  const parts = username.split(':')
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed_username' }
  }

  const [expiresStr, accountAddress, callId] = parts
  if (!expiresStr || !accountAddress || !callId || !/^\d+$/.test(expiresStr)) {
    return { valid: false, reason: 'malformed_username' }
  }

  const expiresAtSeconds = Number(expiresStr)
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    return { valid: false, reason: 'malformed_expiry' }
  }

  if (expiresAtSeconds <= nowSeconds) {
    return { valid: false, reason: 'expired' }
  }

  if (expiresAtSeconds - nowSeconds > maxTtlSeconds) {
    return { valid: false, reason: 'ttl_exceeded' }
  }

  if (
    expectedAccountAddress !== undefined &&
    accountAddress !== expectedAccountAddress.trim()
  ) {
    return { valid: false, reason: 'account_mismatch' }
  }

  const expectedMac = hmac(
    sha1,
    utf8ToBytes(sharedSecret),
    utf8ToBytes(username),
  )
  const expectedCredential = bytesToBase64(expectedMac)
  if (!constantTimeStringEqual(credential, expectedCredential)) {
    return { valid: false, reason: 'invalid_signature' }
  }

  return { valid: true }
}
