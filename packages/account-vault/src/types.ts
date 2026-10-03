import type { DomainPurpose, DomainRoot, DERIVATION_REGISTRY_ID, RECOVERY_FORMAT_ID } from '@frank/domain-roots'

export type VaultErrorCode = 'invalid-input' | 'unavailable' | 'closed' | 'locked' | 'corrupt' | 'conflict' | 'capacity' | 'storage-failed'

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode) {
    super(`Preview vault: ${code}`)
    this.name = 'VaultError'
  }
}

/** Public metadata only. Never put shares, mnemonic phrases, or root bytes here. */
export interface VaultContext {
  readonly accountId: string
  readonly creationId: string
  readonly recoveryFormat: typeof RECOVERY_FORMAT_ID
  readonly registry: typeof DERIVATION_REGISTRY_ID
  readonly purposes: readonly DomainPurpose[]
  readonly custodyEpoch: number
  readonly recoveryFingerprint: string
  readonly retirementContext: string
}

export interface VaultReceipt {
  readonly schema: 1
  readonly policy: 'browser-preview-aes-gcm-v1'
  readonly context: VaultContext
  readonly previousRevision: number
  readonly revision: number
  readonly operationId: string
}

/** Persist this public intent in the account coordinator BEFORE calling stage. */
export interface VaultWriteIntent {
  readonly expected: VaultReceipt | null
  readonly receipt: VaultReceipt
}

export interface PreviewVault {
  stage(intent: VaultWriteIntent, roots: readonly DomainRoot[]): Promise<VaultReceipt>
  open(receipt: VaultReceipt): Promise<readonly DomainRoot[]>
  reconcile(receipt: VaultReceipt): Promise<'committed' | 'absent' | 'superseded' | 'removed'>
  remove(receipt: VaultReceipt): Promise<void>
  /** Cancel a known pending write, even before its initial stage commits. No roots required. */
  discardIntent(intent: VaultWriteIntent): Promise<void>
  close(): void
}
