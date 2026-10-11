import type { DomainPurpose, DomainRoot, DERIVATION_REGISTRY_ID, RECOVERY_FORMAT_ID } from '@frank/domain-roots'

export const BIP39_RECOVERY_FORMAT = 'bip39-pbkdf2-seed-v1' as const
export const BIP39_DERIVATION = 'frank-bip39-bip32-v1' as const

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
  readonly recoveryFormat: typeof RECOVERY_FORMAT_ID | typeof BIP39_RECOVERY_FORMAT
  readonly registry: typeof DERIVATION_REGISTRY_ID | typeof BIP39_DERIVATION
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
  /**
   * Store the secret selected by the authenticated recovery format: a 32-byte Codex32
   * account root or the exact 64-byte historical BIP39 PBKDF2 seed. They are never converted.
   */
  stage(intent: VaultWriteIntent, accountRoot: Uint8Array): Promise<VaultReceipt>
  /**
   * Caller-owned roots for every purpose in the registry today, derived in memory from the
   * stored account root. Nothing is written. A record from before account roots were kept
   * returns the roots stored in it, for the purposes in its context, and no others.
   */
  open(receipt: VaultReceipt): Promise<readonly DomainRoot[]>
  /**
   * The account root stored with this record, as a caller-owned copy, for issuing a new
   * backup. `null` means this record has no Codex32 root (historical BIP39, or a record
   * written before roots were stored). Callers must never substitute a different secret.
   */
  openAccountRoot(receipt: VaultReceipt): Promise<Uint8Array | null>
  /** Exact historical PBKDF2 seed, never an HKDF domain root; null for Codex32 accounts. */
  openBip39Seed(receipt: VaultReceipt): Promise<Uint8Array | null>
  reconcile(receipt: VaultReceipt): Promise<'committed' | 'absent' | 'superseded' | 'removed'>
  remove(receipt: VaultReceipt): Promise<void>
  /** Cancel a known pending write, even before its initial stage commits. No roots required. */
  discardIntent(intent: VaultWriteIntent): Promise<void>
  close(): void
}
