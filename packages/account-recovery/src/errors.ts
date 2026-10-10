import type { Codex32ErrorCode } from '@frank/codex32'

export type AccountRecoveryErrorCode =
  | Codex32ErrorCode
  | 'ceremony-consumed'
  | 'confirmation-mismatch'
  | 'wrong-recovery-format'
  | 'wrong-registry'
  | 'wrong-ceremony-family'
  | 'invalid-descriptor'
  | 'invalid-fingerprint'
  | 'descriptor-mismatch'
  /** The shares are valid Codex32 but do not carry a Frank account master. */
  | 'not-account-backup'
  /** The search for a valid share set was stopped at its work cap without an answer. */
  | 'too-many-inconsistent-shares'

/**
 * What one supplied share turned out to be. `supports`: it lies on the split of candidate
 * number `candidate`. `inconsistent`: right header, but on no reconstructed account.
 * `different-set`: another backup set's header. `duplicate`: a repeat of an earlier share.
 * `invalid`: it did not decode (`code` says why).
 */
export type ShareStatus =
  | 'supports'
  | 'inconsistent'
  | 'different-set'
  | 'duplicate'
  | 'invalid'

/** Public facts about one supplied share. Never its contents. */
export interface ShareVerdict {
  /** Zero-based position in the order the shares were supplied. */
  readonly position: number
  readonly identifier: string | null
  readonly index: string | null
  readonly status: ShareStatus
  readonly candidate: number | null
  readonly code: Codex32ErrorCode | null
}

export class AccountRecoveryError extends Error {
  readonly code: AccountRecoveryErrorCode

  /** Per-share findings when the failure came from examining a set of shares. */
  readonly shares?: readonly ShareVerdict[]

  constructor(
    code: AccountRecoveryErrorCode,
    shares?: readonly ShareVerdict[],
  ) {
    super(`Frank account recovery failed: ${code}`)
    this.name = 'AccountRecoveryError'
    this.code = code
    if (shares) this.shares = shares
  }
}
