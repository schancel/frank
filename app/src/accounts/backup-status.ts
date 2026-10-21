import { ref } from 'vue'
import {
  AccountRecoveryError,
  decodeRecoveryDescriptor,
  destroyRecoveredBackup,
  parseAccountBackupShareInput,
  recoverAccountBackupShares,
  type PublicRecoveryDescriptor,
} from '@frank/account-recovery'
import { bip39Descriptor } from './custody/bip39'
import type { PublicAccount } from './custody'

/**
 * The only record of whether an account is backed up. An account is backed up once its owner has
 * shown they hold shares that reconstruct it: by verifying saved shares on the backup page, or by
 * restoring the account from shares. Showing or copying shares is not a backup.
 */
const BACKUP_STORAGE_KEY = 'frank:backed-up-accounts'

/** Bumped on every write so computed readers re-evaluate. */
const revision = ref(0)

function getBackedUpSet(): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set()
    const raw = localStorage.getItem(BACKUP_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

export function isAccountBackedUp(accountId?: string | null): boolean {
  void revision.value
  if (!accountId) return false
  return getBackedUpSet().has(accountId)
}

export function markAccountBackedUp(accountId?: string | null): void {
  if (!accountId) return
  try {
    const set = getBackedUpSet()
    set.add(accountId)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify([...set]))
    }
  } catch {
    // ignore storage quota / access issues
  } finally {
    revision.value++
  }
}

export function clearAccountBackedUp(accountId?: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (!accountId) {
      localStorage.removeItem(BACKUP_STORAGE_KEY)
    } else {
      const set = getBackedUpSet()
      set.delete(accountId)
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify([...set]))
    }
  } catch {
    // ignore
  } finally {
    revision.value++
  }
}

/**
 * Check that the shares the user saved reconstruct this exact account, then record it as backed
 * up. Throws (and records nothing) when they do not.
 */
export function verifyAccountBackup(account: PublicAccount, input: string) {
  const shards = parseAccountBackupShareInput(input)
  let expected: PublicRecoveryDescriptor | undefined
  try {
    expected = decodeRecoveryDescriptor(account.descriptor)
  } catch {
    // A historical BIP39 account: matched against its own descriptor below.
  }
  const recovery = recoverAccountBackupShares(shards, expected)
  let matches = false
  try {
    // With a Frank descriptor, recovery already dropped every other account.
    matches = recovery.candidates.some(({ account: recovered }) =>
      'seed' in recovered
        ? bip39Descriptor(recovered.seed).descriptor === account.descriptor
        : expected !== undefined,
    )
  } finally {
    recovery.candidates.forEach(c => destroyRecoveredBackup(c.account))
  }
  if (!matches) throw new AccountRecoveryError('descriptor-mismatch')
  markAccountBackedUp(account.receipt.context.accountId)
}
