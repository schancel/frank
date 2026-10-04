/**
 * Test-only helpers. Not exported from the package and excluded from the
 * production typecheck.
 */
import { sha256 } from '@noble/hashes/sha256.js'

import { deterministicStream, type RandomBytes } from './rng.js'

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error('odd hex length')
  return Uint8Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16),
  )
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}

/** A reproducible stand-in for a CSPRNG, keyed by a label. */
export function seededRandom(label: string): RandomBytes {
  return deterministicStream('test-vector-rng', sha256(ascii(label)))
}

/**
 * Copies a session state so a test can feed several different messages to
 * the same point of a protocol. Byte arrays are duplicated (an abort wipes
 * them); everything else, including the key share handle, is shared.
 */
export function cloneState<T>(state: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    out[key] = value instanceof Uint8Array ? value.slice() : value
  }
  return out as T
}

export function flip(bytes: Uint8Array, index: number): Uint8Array {
  const out = bytes.slice()
  out[index] = (out[index] ?? 0) ^ 0x01
  return out
}

export function replace(
  bytes: Uint8Array,
  offset: number,
  patch: Uint8Array,
): Uint8Array {
  const out = bytes.slice()
  out.set(patch, offset)
  return out
}

interface StepLike<S, R> {
  readonly session: S
  readonly outgoing: Uint8Array | null
  readonly result: R | null
}

type StepResult<S, R> =
  | { readonly ok: true; readonly value: StepLike<S, R> }
  | { readonly ok: false; readonly error: { readonly code: string } }

export interface Trace<S, R> {
  /** Message `i` goes to the responder when `i` is even, else the initiator. */
  readonly messages: Uint8Array[]
  /** Copy of the recipient's state just before message `i` was delivered. */
  readonly before: S[]
  readonly initiatorResult: R | null
  readonly responderResult: R | null
  readonly initiatorSession: S
  readonly responderSession: S
}

/** Runs a two-party protocol to completion, recording everything. */
export function drive<S, R>(
  initiator: StepResult<S, R>,
  responder: StepResult<S, R>,
  step: (session: S, message: Uint8Array) => StepResult<S, R>,
): Trace<S, R> {
  if (!initiator.ok) throw new Error(`initiator start: ${initiator.error.code}`)
  if (!responder.ok) throw new Error(`responder start: ${responder.error.code}`)
  const messages: Uint8Array[] = []
  const before: S[] = []
  let initiatorSession = initiator.value.session
  let responderSession = responder.value.session
  let initiatorResult = initiator.value.result
  let responderResult = responder.value.result
  let outgoing = initiator.value.outgoing
  let toResponder = true
  while (outgoing !== null) {
    messages.push(outgoing)
    const recipient = toResponder ? responderSession : initiatorSession
    before.push(cloneState(recipient))
    const stepped = step(recipient, outgoing)
    if (!stepped.ok) {
      throw new Error(`message ${messages.length}: ${stepped.error.code}`)
    }
    if (toResponder) {
      responderSession = stepped.value.session
      responderResult = stepped.value.result ?? responderResult
    } else {
      initiatorSession = stepped.value.session
      initiatorResult = stepped.value.result ?? initiatorResult
    }
    outgoing = stepped.value.outgoing
    toResponder = !toResponder
  }
  return {
    messages,
    before,
    initiatorResult,
    responderResult,
    initiatorSession,
    responderSession,
  }
}

export function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

interface RecordedShares {
  readonly keygen: {
    readonly initiatorShare: string
    readonly responderShare: string
    readonly publicKey: string
    readonly address: string
    readonly messages: string[]
  }
}

/** Parsed `test-vectors/threshold_ecdsa.json`. */
export function recordedVectors(): RecordedShares {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../test-vectors/threshold_ecdsa.json') as RecordedShares
}
