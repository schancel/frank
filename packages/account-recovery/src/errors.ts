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
  /** More shares of one backup set were supplied than restore examines; see `maxShares`. */
  | 'too-many-shares'

/**
 * What one supplied share turned out to be. `supports`: it lies on the split of each account
 * listed in `candidates`. `inconsistent`: right header, but on no reconstructed account.
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
  /** Candidate numbers this share supports. A share can lie on more than one split. */
  readonly candidates: readonly number[]
  readonly code: Codex32ErrorCode | null
}

export class AccountRecoveryError extends Error {
  readonly code: AccountRecoveryErrorCode

  /** Per-share findings when the failure came from examining a set of shares. */
  readonly shares?: readonly ShareVerdict[]

  /** With `too-many-shares`: the most shares of one backup set that may be entered. */
  readonly maxShares?: number

  constructor(
    code: AccountRecoveryErrorCode,
    shares?: readonly ShareVerdict[],
    maxShares?: number,
  ) {
    super(`Frank account recovery failed: ${code}`)
    this.name = 'AccountRecoveryError'
    this.code = code
    if (shares) this.shares = shares
    if (maxShares !== undefined) this.maxShares = maxShares
  }
}
