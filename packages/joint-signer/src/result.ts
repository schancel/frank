/**
 * Typed results. An error is a fixed code plus flags; it never carries bytes
 * or free-form text, so nothing secret can leak through an error path.
 */
import type { JointSignerErrorCode, JointSignerResult } from './types.js'

export function success<T>(value: T): JointSignerResult<T> {
  return { ok: true, value }
}

export interface FailureFlags {
  readonly sessionAborted?: boolean
  readonly keyUnusable?: boolean
  readonly peerFault?: boolean
  readonly backendCode?: string | null
}

export function failure<T>(
  code: JointSignerErrorCode,
  flags: FailureFlags = {},
): JointSignerResult<T> {
  return {
    ok: false,
    error: {
      code,
      sessionAborted: flags.sessionAborted ?? false,
      keyUnusable: flags.keyUnusable ?? false,
      peerFault: flags.peerFault ?? false,
      backendCode: flags.backendCode ?? null,
    },
  }
}

/** Internal control-flow signal. The message is exactly the code. */
export class Failure extends Error {
  readonly code: JointSignerErrorCode
  readonly peerFault: boolean
  readonly backendCode: string | null

  constructor(
    code: JointSignerErrorCode,
    peerFault = false,
    backendCode: string | null = null,
  ) {
    super(code)
    this.code = code
    this.peerFault = peerFault
    this.backendCode = backendCode
  }
}

export function fail(
  code: JointSignerErrorCode,
  peerFault = false,
  backendCode: string | null = null,
): never {
  throw new Failure(code, peerFault, backendCode)
}
