/** Test-only helpers. Excluded from the production typecheck. */
import { randomBytes as nodeRandomBytes } from 'crypto'

import { keygenStep, startKeygen, type KeygenSession } from './keygen.js'
import type { KeyShare } from './key-share.js'
import {
  signStep,
  startSign,
  type SignResult,
  type SignSession,
} from './sign.js'
import type { AdaptorLock, LockOpening } from './lock.js'
import type { RandomBytes } from './rng.js'
import type { DklsError, DklsResult } from './result.js'
import type { Step } from './session.js'
import type { RoleName } from './wire.js'

export const rng = (length: number): Uint8Array =>
  new Uint8Array(nodeRandomBytes(length))

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, character => character.charCodeAt(0))
}

export function must<T>(result: DklsResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

export function flip(bytes: Uint8Array, index: number, mask = 1): Uint8Array {
  const out = bytes.slice()
  out[index] = (out[index] ?? 0) ^ mask
  return out
}

export interface Party<S, R> {
  session: S
  result: R | null
  elapsed: number
}

export interface Trace<S, R> {
  /** Message `i` goes to the responder when `i` is even, else the initiator. */
  readonly messages: Uint8Array[]
  readonly initiator: Party<S, R>
  readonly responder: Party<S, R>
  readonly failure: { readonly index: number; readonly error: DklsError } | null
}

export interface DriveHooks<S> {
  /** Replaces message `index` before delivery. */
  readonly rewrite?: (index: number, message: Uint8Array) => Uint8Array
  /** Replaces the recipient's state before message `index` is delivered. */
  readonly restore?: (index: number, session: S, recipient: RoleName) => S
}

/** Runs a two-party protocol by alternating delivery, recording everything. */
export function drive<S, R>(
  start: (role: RoleName) => DklsResult<Step<S, R>>,
  step: (session: S, message: Uint8Array) => DklsResult<Step<S, R>>,
  hooks: DriveHooks<S> = {},
): Trace<S, R> {
  const timed = <T>(party: { elapsed: number }, call: () => T): T => {
    const started = performance.now()
    try {
      return call()
    } finally {
      party.elapsed += performance.now() - started
    }
  }
  const timers = { initiator: { elapsed: 0 }, responder: { elapsed: 0 } }
  const first = must(timed(timers.initiator, () => start('initiator')))
  const second = must(timed(timers.responder, () => start('responder')))
  const initiator: Party<S, R> = {
    session: first.session,
    result: first.result,
    elapsed: 0,
  }
  const responder: Party<S, R> = {
    session: second.session,
    result: second.result,
    elapsed: 0,
  }
  const messages: Uint8Array[] = []
  let failure: Trace<S, R>['failure'] = null
  let outgoing = first.outgoing
  let toResponder = true
  while (outgoing !== null) {
    const index = messages.length
    const delivered = hooks.rewrite?.(index, outgoing) ?? outgoing
    messages.push(delivered)
    const role: RoleName = toResponder ? 'responder' : 'initiator'
    const recipient = toResponder ? responder : initiator
    if (hooks.restore !== undefined) {
      recipient.session = hooks.restore(index, recipient.session, role)
    }
    const stepped = timed(timers[role], () => step(recipient.session, delivered))
    if (!stepped.ok) {
      failure = { index, error: stepped.error }
      break
    }
    recipient.session = stepped.value.session
    recipient.result = stepped.value.result ?? recipient.result
    outgoing = stepped.value.outgoing
    toResponder = !toResponder
  }
  initiator.elapsed = timers.initiator.elapsed
  responder.elapsed = timers.responder.elapsed
  return { messages, initiator, responder, failure }
}

// --- Shared fixtures ---------------------------------------------------------

export const IDS = { initiator: ascii('alice'), responder: ascii('bob') }

export interface KeyPair {
  /** The share of the key-generation initiator ("alice"). */
  readonly initiator: KeyShare
  /** The share of the key-generation responder ("bob"). */
  readonly responder: KeyShare
}

export function makeKeys(
  hooks?: DriveHooks<KeygenSession>,
  randomBytes: RandomBytes = rng,
  sessionId: Uint8Array = rng(32),
): { keys: KeyPair; trace: Trace<KeygenSession, KeyShare> } {
  const trace = drive<KeygenSession, KeyShare>(
    role =>
      startKeygen({
        role,
        sessionId,
        localId: IDS[role],
        peerId: IDS[role === 'initiator' ? 'responder' : 'initiator'],
        randomBytes,
      }),
    keygenStep,
    hooks,
  )
  const a = trace.initiator.result
  const b = trace.responder.result
  if (a === null || b === null) throw new Error('key generation failed')
  return { keys: { initiator: a, responder: b }, trace }
}

export interface SignOptions {
  readonly hooks?: DriveHooks<SignSession>
  /** The key-generation responder initiates the session. */
  readonly swapRoles?: boolean
  readonly sessionId?: Uint8Array
  readonly lock?: AdaptorLock
  readonly lockOpening?: LockOpening
  readonly randomBytes?: RandomBytes
}

/** The share that takes `role` in a session. */
export function shareFor(
  keys: KeyPair,
  role: RoleName,
  swapRoles = false,
): KeyShare {
  if (!swapRoles) return keys[role]
  return role === 'initiator' ? keys.responder : keys.initiator
}

export function runSign(
  keys: KeyPair,
  digest: Uint8Array,
  options: SignOptions = {},
): Trace<SignSession, SignResult> {
  const sessionId = options.sessionId ?? rng(32)
  return drive<SignSession, SignResult>(
    role =>
      startSign({
        keyShare: shareFor(keys, role, options.swapRoles),
        role,
        sessionId,
        digest,
        lock: options.lock,
        lockOpening: role === 'responder' ? options.lockOpening : undefined,
        randomBytes: options.randomBytes ?? rng,
      }),
    signStep,
    options.hooks,
  )
}
