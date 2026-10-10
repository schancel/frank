import type { RecoveryPublicMetadata } from '@frank/account-recovery'
import type { VaultReceipt, VaultWriteIntent } from '@frank/account-vault'
import type { DomainRoot } from '@frank/domain-roots'

export type CustodyErrorCode =
  | 'invalid-input'
  | 'unavailable'
  | 'locked'
  | 'conflict'
  | 'storage-failed'
  | 'closed'
  | 'capacity'

export class CustodyError extends Error {
  constructor(readonly code: CustodyErrorCode) {
    super(`Account custody: ${code}`)
    this.name = 'CustodyError'
  }
}

/** A caller must read and explicitly accept this precondition before replacement. */
export interface ExpectedActive {
  readonly revision: number
  readonly accountId: string | null
}

export interface PublicAccount {
  readonly displayName: string
  readonly descriptor: string
  readonly fingerprint: string
  readonly masterRetirementId: string
  readonly recoveryIdentityCommitment: string
  readonly receipt: VaultReceipt
}

export interface PendingChange {
  readonly status: 'staging' | 'discarding'
  readonly account: PublicAccount
  readonly expectedActive: ExpectedActive
}

/** Only this bounded public projection is persisted; roots never enter this shape. */
export interface CustodySnapshot {
  readonly schema: 1
  readonly revision: number
  readonly active: PublicAccount | null
  readonly pending: PendingChange | null
}

export interface StageAccount {
  readonly attemptId: string
  readonly accountId: string
  readonly expectedActive: ExpectedActive
  readonly displayName: string
  readonly custodyEpoch: number
  readonly metadata: RecoveryPublicMetadata
  readonly roots: readonly DomainRoot[]
  /**
   * The 32-byte account root the roots were derived from. Custody keeps it beside them so
   * a later backup splits the account itself; staging refuses a root that is not this
   * account's.
   */
  readonly accountRoot: Uint8Array
}

/** Roots remain outside enumerable state. takeRoots transfers ownership exactly once. */
export interface ActiveCustody {
  readonly account: PublicAccount
  takeRoots(): readonly DomainRoot[]
  close(): void
}

export interface AccountCustody {
  snapshot(): Promise<CustodySnapshot>
  stage(input: StageAccount): Promise<CustodySnapshot>
  reconcile(
    attemptId: string,
  ): Promise<'active' | 'ready' | 'incomplete' | 'discarded'>
  activate(
    attemptId: string,
    expected: ExpectedActive,
  ): Promise<CustodySnapshot>
  cancel(attemptId: string): Promise<CustodySnapshot>
  openActive(): Promise<ActiveCustody>
  /**
   * Caller-owned roots of a staged, not yet active account, so the user can be shown which
   * identity an attempt would activate before choosing to. Changes nothing.
   */
  openPending(attemptId: string): Promise<readonly DomainRoot[]>
  /**
   * The active account and a caller-owned copy of its account root, for issuing backup
   * shares. `accountRoot` is null for an account stored before roots were kept: no backup
   * can be issued for it, and callers must say so rather than split something else.
   */
  exportAccountRoot(): Promise<{
    readonly account: PublicAccount
    readonly accountRoot: Uint8Array | null
  }>
  close(): void
}

export function writeIntent(account: PublicAccount): VaultWriteIntent {
  return { expected: null, receipt: account.receipt }
}
