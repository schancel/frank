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
  | 'profile-unreachable'
  /** A staged attempt saved before account roots were kept: it can only be cancelled and redone. */
  | 'outdated-attempt'

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
  /** Local presentation only; may be empty for a recovered account. */
  readonly displayName: string
  readonly descriptor: string
  readonly fingerprint: string
  /** Codex32 recovery metadata only; absent for historical BIP39 accounts. */
  readonly masterRetirementId?: string
  readonly recoveryIdentityCommitment?: string
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

export interface RetentionIncarnation {
  readonly accountRevision: number
  readonly accountReceipt: VaultReceipt
}

/** Public reference only. The financial owner decides when it may be released. */
export interface RetentionReceipt extends RetentionIncarnation {
  readonly operationId: string
  readonly generation: number
}

export interface RetentionIntent extends RetentionIncarnation {
  readonly operationId: string
  readonly expectedGeneration: number
}

export interface RetentionSnapshot {
  readonly active: RetentionIncarnation | null
  readonly nextGeneration: number
  readonly holds: readonly RetentionReceipt[]
}

export interface StageAccount {
  readonly attemptId: string
  readonly accountId: string
  readonly expectedActive: ExpectedActive
  readonly displayName: string
  readonly custodyEpoch: number
  readonly metadata: RecoveryPublicMetadata
  /**
   * The 32-byte account root. It is the only secret custody stores for an account: every
   * purpose root is derived from it each time the account is opened. Staging refuses a
   * root that does not reproduce the account's public fingerprint.
   */
  readonly accountRoot: Uint8Array
}

export interface StageBip39Account {
  readonly attemptId: string
  readonly accountId: string
  readonly expectedActive: ExpectedActive
  readonly displayName: string
  readonly custodyEpoch: number
  /** Exact BIP39 PBKDF2 seed. This is not a Codex32 account root. */
  readonly bip39Seed: Uint8Array
}

/** Roots remain outside enumerable state. takeRoots transfers ownership exactly once. */
export interface ActiveCustody {
  readonly account: PublicAccount
  takeRoots(): readonly DomainRoot[]
  takeBip39Seed(): Uint8Array
  close(): void
}

export interface AccountCustody {
  snapshot(): Promise<CustodySnapshot>
  retentionSnapshot(): Promise<RetentionSnapshot>
  acquireRetention(intent: RetentionIntent): Promise<RetentionReceipt>
  releaseRetention(receipt: RetentionReceipt): Promise<'released' | 'absent'>
  stage(input: StageAccount | StageBip39Account): Promise<CustodySnapshot>
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
  openPendingBip39Seed(attemptId: string): Promise<Uint8Array>
  /**
   * The active account and a caller-owned copy of its account root, for issuing backup
   * shares. `accountRoot` is null for an account stored before roots were kept: no backup
   * can be issued for it, and callers must say so rather than split something else.
   */
  exportAccountRoot(): Promise<{
    readonly account: PublicAccount
    readonly accountRoot: Uint8Array | null
  }>
  reset(cleanup?: () => Promise<void>): Promise<CustodySnapshot>
  close(): void
}

export function writeIntent(account: PublicAccount): VaultWriteIntent {
  return { expected: null, receipt: account.receipt }
}
