/**
 * The state-machine driver shared by key generation and signing.
 *
 * A session is a plain data object. `advance` takes the current state and one
 * incoming message and returns a NEW state plus an optional outgoing message
 * and an optional final result. The state passed in is marked used: feeding a
 * second message to it is refused, because replaying an old state against a
 * different message is exactly how a nonce gets reused.
 *
 * Rejections come in two kinds.
 *  - Frame rejections (not a message of this session or round) leave the
 *    session usable; nothing secret was touched.
 *  - Everything after the frame check aborts the session for good and wipes
 *    its secrets. `onFailure` decides whether the key is burned as well.
 */
import {
  failure,
  failureCode,
  isLocalFailure,
  success,
  type DklsErrorCode,
  type DklsResult,
} from './result.js'
import { openMessage } from './wire.js'

export type SessionStatus = 'active' | 'used' | 'finished' | 'aborted'

/** Per-session values, secret or not, as wipeable byte strings. */
export type Vars = Record<string, Uint8Array>

export interface SessionCore {
  status: SessionStatus
  readonly protocol: number
  /** Round number of the next incoming message; 0 when none is expected. */
  readonly expectedRound: number
  /** 32-byte frame binding. */
  readonly frame: Uint8Array
  readonly vars: Vars
}

export interface Step<State, Result> {
  /** The state to pass to the next call. The one passed in is consumed. */
  readonly session: State
  /** Bytes to deliver to the other party, if any. */
  readonly outgoing: Uint8Array | null
  /** The protocol's output once this party has finished, else null. */
  readonly result: Result | null
}

export function wipeVars(vars: Vars): void {
  for (const name of Object.keys(vars)) {
    vars[name]?.fill(0)
    delete vars[name]
  }
}

export interface Hooks<State> {
  /** Exact body length of the message the state expects. */
  bodyBytes(state: State): number
  /**
   * Called before the message is looked at. Returning a code refuses the
   * step and aborts the session (used for the process-wide burned set).
   */
  blocked(state: State): DklsErrorCode | null
  /**
   * Called once when a step fails after the frame check, with whether the
   * failure is attributable to the peer. Returns true if the key was burned.
   */
  onFailure(state: State, peerFault: boolean): boolean
}

export function advance<State extends SessionCore, Result>(
  state: State,
  message: unknown,
  hooks: Hooks<State>,
  handle: (state: State, body: Uint8Array) => Step<State, Result>,
): DklsResult<Step<State, Result>> {
  if (state === null || typeof state !== 'object') {
    return failure('invalid-input')
  }
  if (state.status === 'finished') return failure('session-finished')
  if (state.status === 'aborted') return failure('session-aborted')
  if (state.status === 'used') return failure('state-already-used')
  if (state.status !== 'active' || state.expectedRound === 0) {
    return failure('invalid-input')
  }
  const blocked = hooks.blocked(state)
  if (blocked !== null) {
    wipeVars(state.vars)
    state.status = 'aborted'
    return failure(blocked, true, blocked === 'key-burned', false)
  }
  const opened = openMessage(message, {
    protocol: state.protocol,
    round: state.expectedRound,
    frame: state.frame,
    bodyBytes: hooks.bodyBytes(state),
  })
  if (!opened.ok) return failure(opened.code)
  // From here on the state is consumed, whatever happens.
  state.status = 'used'
  try {
    const step = handle(state, opened.body)
    // The consumed state keeps nothing: its values moved to the new state.
    return success(step)
  } catch (error) {
    const code = failureCode(error)
    const peerFault = !isLocalFailure(code)
    const burned = hooks.onFailure(state, peerFault)
    wipeVars(state.vars)
    state.status = 'aborted'
    return failure(code, true, burned, peerFault)
  }
}

/** Reads a required per-session value. */
export function need(vars: Vars, name: string): Uint8Array {
  const value = vars[name]
  if (value === undefined) {
    throw new Error('internal-error')
  }
  return value
}
