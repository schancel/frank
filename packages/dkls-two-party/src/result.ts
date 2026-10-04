/**
 * Typed results and the internal failure signal. An error is a fixed code
 * plus flags; it never carries bytes or free-form text, so nothing secret can
 * leak through an error path.
 */

export type DklsErrorCode =
  /** A caller-supplied argument has the wrong type, length or range. */
  | 'invalid-input'
  /** The caller-supplied CSPRNG threw or returned the wrong shape. */
  | 'rng-failed'
  /** The bytes are not a message of this package. Session still usable. */
  | 'malformed-message'
  /** A message bound to another session, key, digest or lock. Session still usable. */
  | 'wrong-session'
  /** A message of this session but not the expected round. Session still usable. */
  | 'unexpected-message'
  /** A point is not a valid non-identity secp256k1 point. */
  | 'invalid-point'
  /** A scalar is outside its required range. */
  | 'out-of-range'
  /** A hash commitment did not open to the revealed value. */
  | 'invalid-commitment'
  /** A zero-knowledge proof did not verify. */
  | 'invalid-proof'
  /** A base-OT verification step failed. */
  | 'base-ot-check-failed'
  /** The OT-extension consistency check failed. */
  | 'ot-extension-check-failed'
  /** The multiplication (VOLE) consistency check failed. */
  | 'multiplication-check-failed'
  /** The peer's multiplication inputs do not match its public nonce or key share. */
  | 'inconsistent-share'
  /** The final signature or pre-signature did not verify. */
  | 'invalid-signature'
  /** The session already produced its result. */
  | 'session-finished'
  /** The session aborted earlier. */
  | 'session-aborted'
  /** This state object was already advanced; use the state it returned. */
  | 'state-already-used'
  /** The key was burned by a failed check, or destroyed. */
  | 'key-burned'
  /** Stored key bytes failed authentication or validation. */
  | 'invalid-key-share'
  /** Stored session bytes failed authentication or do not match the key. */
  | 'invalid-state'
  /** The lock's secret opening is missing or does not open the lock. */
  | 'lock-not-owned'
  /** An invariant failed. The session is aborted. */
  | 'internal-error'

export interface DklsError {
  readonly code: DklsErrorCode
  /** The session this call was advancing is dead. Retry with a new session id. */
  readonly sessionAborted: boolean
  /** The key (share and pairwise setup) must never be used again. Record it durably. */
  readonly keyBurned: boolean
  /**
   * The content of a message that passed the frame check failed a check.
   * Over an authenticated transport that means the peer misbehaved.
   */
  readonly peerFault: boolean
}

export type DklsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DklsError }

export function success<T>(value: T): DklsResult<T> {
  return { ok: true, value }
}

export function failure<T>(
  code: DklsErrorCode,
  sessionAborted = false,
  keyBurned = false,
  peerFault = false,
): DklsResult<T> {
  return { ok: false, error: { code, sessionAborted, keyBurned, peerFault } }
}

/** Internal control-flow signal. The message is exactly the code. */
export class Failure extends Error {
  readonly code: DklsErrorCode

  constructor(code: DklsErrorCode) {
    super(code)
    this.code = code
  }
}

export function fail(code: DklsErrorCode): never {
  throw new Failure(code)
}

/** Maps anything thrown to a typed code. Unknown exceptions never surface. */
export function failureCode(error: unknown): DklsErrorCode {
  return error instanceof Failure ? error.code : 'internal-error'
}

/** Codes that are this party's own failure, not evidence against the peer. */
export function isLocalFailure(code: DklsErrorCode): boolean {
  return (
    code === 'internal-error' ||
    code === 'rng-failed' ||
    code === 'key-burned' ||
    code === 'invalid-input'
  )
}
