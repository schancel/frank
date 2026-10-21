import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha512 } from '@noble/hashes/sha512.js'
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js'
import {
  bytesEqual,
  calculateGenerator,
  confirmationTag,
  deriveIsk,
  lvCat,
  sampleScalar,
  scalarMult,
  scalarMultVfy,
} from './cpace'

/**
 * PIN pairing for handing an account between the Frank extension and the Frank
 * web app. The side that holds the account (the sender) shows a random 6-digit
 * PIN; the user types it into the other side (the receiver). The two run CPace
 * with the PIN as the password, so whoever watches the channel learns nothing to
 * test PINs against offline. The sender encrypts the bundle only after the
 * receiver proves it derived the same key; a wrong PIN gets no ciphertext at all.
 *
 *   receiver -> sender  pair-hello
 *   sender -> receiver  { sid, Ya }                      (fresh sid and ya)
 *   receiver -> sender  pair-confirm { sid, Yb, Tb }
 *   sender -> receiver  { Ta, nonce, ciphertext }        (only when Tb checks)
 *
 * Each wrong PIN replaces the PIN, so an attacker gets one online guess per PIN,
 * and the session ends after SYNC_PAIRING_MAX_FAILURES wrong PINs.
 *
 * The sender state holds the PIN and the bundle. Keep it in memory only (page
 * memory or the extension's storage.session), never in persistent storage.
 */

export const SYNC_PAIRING_TTL_MS = 2 * 60_000
export const SYNC_PAIRING_MAX_FAILURES = 3
export const SYNC_PIN_DIGITS = 6

const PROTOCOL = 'frank-account-sync-v1'
const CI = lvCat(
  utf8ToBytes(PROTOCOL),
  utf8ToBytes('A_sender'),
  utf8ToBytes('B_receiver'),
)
const AD_SENDER = utf8ToBytes(`${PROTOCOL}:sender`)
const AD_RECEIVER = utf8ToBytes(`${PROTOCOL}:receiver`)
const SID_BYTES = 16
const POINT_BYTES = 32
const TAG_BYTES = 64
const NONCE_BYTES = 24

export type SyncPairingFailure =
  | 'pin-mismatch'
  | 'expired'
  | 'no-sender'
  | 'stale'
  | 'failed'

export type SyncHelloReply =
  | { ok: true; sid: string; Ya: string }
  | { ok: false; reason: SyncPairingFailure }

export interface SyncConfirmRequest {
  sid: string
  Yb: string
  Tb: string
}

export type SyncConfirmReply =
  | { ok: true; Ta: string; nonce: string; ciphertext: string }
  | { ok: false; reason: SyncPairingFailure }

export interface SyncSenderState {
  pin: string
  bundle: Record<string, unknown>
  createdAt: number
  failures: number
  /** The pending exchange: the latest hello's sid and ephemeral scalar. */
  attempt: { sid: string; ya: string; Ya: string } | null
}

/** What happened to the sender on a confirm, for its UI. */
export type SyncSenderOutcome =
  | 'sent'
  | 'new-pin'
  | 'ended'
  | 'expired'
  | 'stale'

/** A uniform 6-digit PIN from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function generateSyncPin(): string {
  const range = 10 ** SYNC_PIN_DIGITS
  const limit = Math.floor(0x1_0000_0000 / range) * range
  const word = new Uint32Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(word)
    if (word[0] < limit) {
      return String(word[0] % range).padStart(SYNC_PIN_DIGITS, '0')
    }
  }
}

/** Digits only, exactly SYNC_PIN_DIGITS of them, or null. */
export function normalizeSyncPin(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\s+/g, '')
  return new RegExp(`^\\d{${SYNC_PIN_DIGITS}}$`).test(digits) ? digits : null
}

export function createSyncSender(
  bundle: Record<string, unknown>,
  now = Date.now(),
): SyncSenderState {
  return {
    pin: generateSyncPin(),
    bundle,
    createdAt: now,
    failures: 0,
    attempt: null,
  }
}

export function syncSenderExpired(state: SyncSenderState, now = Date.now()) {
  return now - state.createdAt > SYNC_PAIRING_TTL_MS
}

function generator(pin: string, sid: Uint8Array) {
  return calculateGenerator(utf8ToBytes(pin), CI, sid)
}

function bundleKey(sid: Uint8Array, isk: Uint8Array): Uint8Array {
  return hkdf(sha512, isk, sid, utf8ToBytes(`${PROTOCOL}:bundle`), 32)
}

function hexBytes(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== length * 2) return null
  try {
    return hexToBytes(value)
  } catch {
    return null
  }
}

/** Starts an exchange: a fresh sid and ephemeral scalar for this attempt. */
export function syncSenderHello(
  state: SyncSenderState,
  now = Date.now(),
): { state: SyncSenderState | null; reply: SyncHelloReply } {
  if (syncSenderExpired(state, now)) {
    return { state: null, reply: { ok: false, reason: 'expired' } }
  }
  const sid = randomBytes(SID_BYTES)
  const ya = sampleScalar()
  const Ya = scalarMult(ya, generator(state.pin, sid))
  const attempt = {
    sid: bytesToHex(sid),
    ya: bytesToHex(ya),
    Ya: bytesToHex(Ya),
  }
  return {
    state: { ...state, attempt },
    reply: { ok: true, sid: attempt.sid, Ya: attempt.Ya },
  }
}

/**
 * Checks the receiver's key confirmation. Only when it holds does the sender
 * encrypt the bundle; the session then ends (the bundle goes out once).
 */
export function syncSenderConfirm(
  state: SyncSenderState,
  request: unknown,
  now = Date.now(),
): {
  state: SyncSenderState | null
  reply: SyncConfirmReply
  outcome: SyncSenderOutcome
} {
  if (syncSenderExpired(state, now)) {
    return {
      state: null,
      reply: { ok: false, reason: 'expired' },
      outcome: 'expired',
    }
  }
  const req = (request ?? {}) as Partial<SyncConfirmRequest>
  const attempt = state.attempt
  if (!attempt || req.sid !== attempt.sid) {
    return { state, reply: { ok: false, reason: 'stale' }, outcome: 'stale' }
  }

  const sid = hexToBytes(attempt.sid)
  const Ya = hexToBytes(attempt.Ya)
  const Yb = hexBytes(req.Yb, POINT_BYTES)
  const Tb = hexBytes(req.Tb, TAG_BYTES)
  const K = Yb ? scalarMultVfy(hexToBytes(attempt.ya), Yb) : null
  const isk = K && Yb ? deriveIsk(sid, K, Ya, AD_SENDER, Yb, AD_RECEIVER) : null
  const confirmed =
    isk &&
    Yb &&
    Tb &&
    bytesEqual(Tb, confirmationTag(sid, isk, Yb, AD_RECEIVER))

  if (!confirmed || !isk || !Yb) {
    const failures = state.failures + 1
    const ended = failures >= SYNC_PAIRING_MAX_FAILURES
    return {
      state: ended
        ? null
        : { ...state, pin: generateSyncPin(), failures, attempt: null },
      reply: { ok: false, reason: 'pin-mismatch' },
      outcome: ended ? 'ended' : 'new-pin',
    }
  }

  const nonce = randomBytes(NONCE_BYTES)
  const ciphertext = xchacha20poly1305(
    bundleKey(sid, isk),
    nonce,
    concatBytes(sid, Ya, Yb),
  ).encrypt(utf8ToBytes(JSON.stringify(state.bundle)))
  return {
    state: null,
    reply: {
      ok: true,
      Ta: bytesToHex(confirmationTag(sid, isk, Ya, AD_SENDER)),
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext),
    },
    outcome: 'sent',
  }
}

export type SyncPairingSend = (
  type: 'pair-hello' | 'pair-confirm',
  payload?: SyncConfirmRequest,
) => Promise<unknown>

export type SyncReceiveResult =
  | { ok: true; bundle: Record<string, unknown> }
  | { ok: false; reason: SyncPairingFailure }

function failureOf(reply: unknown): SyncPairingFailure {
  const reason = (reply as { reason?: unknown } | null)?.reason
  return reason === 'pin-mismatch' ||
    reason === 'expired' ||
    reason === 'no-sender' ||
    reason === 'stale'
    ? reason
    : 'failed'
}

/** The receiver side: runs the exchange with `pin` and returns the decrypted bundle. */
export async function receiveSyncBundle(
  pin: string,
  send: SyncPairingSend,
): Promise<SyncReceiveResult> {
  const hello = (await send('pair-hello')) as SyncHelloReply | null
  if (!hello || hello.ok !== true) {
    return { ok: false, reason: failureOf(hello) }
  }
  const sid = hexBytes(hello.sid, SID_BYTES)
  const Ya = hexBytes(hello.Ya, POINT_BYTES)
  if (!sid || !Ya) return { ok: false, reason: 'failed' }

  const yb = sampleScalar()
  const Yb = scalarMult(yb, generator(pin, sid))
  const K = scalarMultVfy(yb, Ya)
  if (!K) return { ok: false, reason: 'failed' }
  const isk = deriveIsk(sid, K, Ya, AD_SENDER, Yb, AD_RECEIVER)
  const Tb = confirmationTag(sid, isk, Yb, AD_RECEIVER)

  const reply = (await send('pair-confirm', {
    sid: bytesToHex(sid),
    Yb: bytesToHex(Yb),
    Tb: bytesToHex(Tb),
  })) as SyncConfirmReply | null
  if (!reply || reply.ok !== true) {
    return { ok: false, reason: failureOf(reply) }
  }
  const Ta = hexBytes(reply.Ta, TAG_BYTES)
  const nonce = hexBytes(reply.nonce, NONCE_BYTES)
  if (
    !Ta ||
    !nonce ||
    typeof reply.ciphertext !== 'string' ||
    !bytesEqual(Ta, confirmationTag(sid, isk, Ya, AD_SENDER))
  ) {
    return { ok: false, reason: 'failed' }
  }
  try {
    const plaintext = xchacha20poly1305(
      bundleKey(sid, isk),
      nonce,
      concatBytes(sid, Ya, Yb),
    ).decrypt(hexToBytes(reply.ciphertext))
    const bundle = JSON.parse(new TextDecoder().decode(plaintext))
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return { ok: false, reason: 'failed' }
    }
    return { ok: true, bundle }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
