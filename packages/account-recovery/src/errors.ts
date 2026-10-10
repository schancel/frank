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

export class AccountRecoveryError extends Error {
  readonly code: AccountRecoveryErrorCode

  constructor(code: AccountRecoveryErrorCode) {
    super(`Frank account recovery failed: ${code}`)
    this.name = 'AccountRecoveryError'
    this.code = code
  }
}
