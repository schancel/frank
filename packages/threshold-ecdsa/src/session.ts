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
 *    its secrets. Restarting takes a new session id.
 */
import {
  failure,
  failureBurns,
  failureCode,
  success,
  type ThresholdResult,
} from './result.js'
import { openMessage } from './wire.js'

export type SessionStatus = 'active' | 'used' | 'finished' | 'aborted'

export interface SessionCore {
  status: SessionStatus
  readonly protocol: number
  /** Round number of the next incoming message; 0 when none is expected. */
  readonly expectedRound: number
  /** 32-byte session binding. */
  readonly session: Uint8Array
}

export interface Step<State, Result> {
  /** The state to pass to the next call. */
  readonly session: State
  /** Bytes to deliver to the other party, if any. */
  readonly outgoing: Uint8Array | null
  /** The protocol's output once this party has finished, else null. */
  readonly result: Result | null
}

export interface BodyBounds {
  readonly minBody: number
  readonly maxBody: number
}

export function advance<State extends SessionCore, Result>(
  state: State,
  message: unknown,
  bounds: (state: State) => BodyBounds,
  handle: (state: State, body: Uint8Array) => Step<State, Result>,
  wipeState: (state: State) => void,
  burn: (state: State) => void,
): ThresholdResult<Step<State, Result>> {
  if (state.status === 'finished') return failure('session-finished')
  if (state.status === 'aborted') return failure('session-aborted')
  if (state.status === 'used') return failure('state-already-used')
  if (state.status !== 'active' || state.expectedRound === 0) {
    return failure('invalid-input')
  }
  const opened = openMessage(message, {
    protocol: state.protocol,
    round: state.expectedRound,
    session: state.session,
    ...bounds(state),
  })
  if (!opened.ok) return failure(opened.code)
  // From here on the state is consumed, whatever happens.
  state.status = 'used'
  try {
    return success(handle(state, opened.body))
  } catch (error) {
    const burned = failureBurns(error)
    const code = failureCode(error)
    if (burned) burn(state)
    wipeState(state)
    state.status = 'aborted'
    const local =
      code === 'internal-error' ||
      code === 'rng-failed' ||
      code === 'key-share-burned'
    return failure(code, true, burned, !local)
  }
}
