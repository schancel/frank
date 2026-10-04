/**
 * Typed results and the internal failure signal.
 *
 * Every public function returns a `ThresholdResult`. Nothing in an error
 * carries bytes, scalars, or free-form text: an error is a fixed code plus two
 * flags, so a secret can never leak through an error path.
 */

export type ThresholdErrorCode =
  /** A caller-supplied argument has the wrong type, length or range. */
  | 'invalid-input'
  /** The caller-supplied CSPRNG threw or returned the wrong shape. */
  | 'rng-failed'
  /** The bytes are not a message of this package (magic, length, layout). */
  | 'malformed-message'
  /** A well-formed message bound to a different session transcript. */
  | 'wrong-session'
  /** A well-formed message for this session but not the expected round. */
  | 'unexpected-message'
  /** A point is not a valid non-identity secp256k1 point. */
  | 'invalid-point'
  /** A scalar or integer is outside its required range. */
  | 'out-of-range'
  /** A hash commitment did not open to the revealed value. */
  | 'invalid-commitment'
  /** A zero-knowledge proof did not verify. */
  | 'invalid-proof'
  /** A Paillier modulus or ciphertext failed validation. */
  | 'invalid-paillier'
  /** A signature or adaptor signature did not verify. */
  | 'invalid-signature'
  /** The joint nonce is unusable (r = 0 or R.x >= n). Retry with a new session. */
  | 'unusable-nonce'
  /** The session already produced its result. */
  | 'session-finished'
  /** The session aborted earlier. */
  | 'session-aborted'
  /** This state object was already advanced; use the state it returned. */
  | 'state-already-used'
  /** The key share was burned by a failed signing session or destroyed. */
  | 'key-share-burned'
  /** Stored key-share bytes failed validation. */
  | 'invalid-key-share'
  /** An invariant failed. The session is aborted. */
  | 'internal-error'

export interface ThresholdError {
  readonly code: ThresholdErrorCode
  /**
   * True when the session this call was advancing is now permanently
   * unusable. Restarting needs a new session id and fresh nonces.
   */
  readonly sessionAborted: boolean
  /**
   * True when the key share must never sign again (Lindell 2017 abort rule).
   * The caller must persist this fact; see the README.
   */
  readonly keyShareBurned: boolean
}

export type ThresholdResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ThresholdError }

export function success<T>(value: T): ThresholdResult<T> {
  return { ok: true, value }
}

export function failure<T>(
  code: ThresholdErrorCode,
  sessionAborted = false,
  keyShareBurned = false,
): ThresholdResult<T> {
  return { ok: false, error: { code, sessionAborted, keyShareBurned } }
}

/**
 * Internal control-flow signal. The message is exactly the code, so even an
 * accidentally logged stack trace contains nothing secret.
 */
export class Failure extends Error {
  readonly code: ThresholdErrorCode
  readonly burn: boolean

  constructor(code: ThresholdErrorCode, burn = false) {
    super(code)
    this.code = code
    this.burn = burn
  }
}

export function fail(code: ThresholdErrorCode, burn = false): never {
  throw new Failure(code, burn)
}

/** Maps anything thrown to a typed code. Unknown exceptions never surface. */
export function failureCode(error: unknown): ThresholdErrorCode {
  return error instanceof Failure ? error.code : 'internal-error'
}

export function failureBurns(error: unknown): boolean {
  return error instanceof Failure && error.burn
}
