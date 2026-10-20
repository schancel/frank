import { accountSession, accountStatus } from '../accounts/session'
import { createAccountCeremony } from '../accounts/ceremony'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { nameOwnProfile } from './identity-session'
import { setCustomRelayBaseUrl } from '@frank/wallet/chain'

export const PENDING_EXTENSION_SYNC_STORAGE_KEY =
  'frank:pending-extension-sync-v1'

export interface ExtensionSyncPayload {
  sasCode?: string
  deviceSyncBundle?: Record<string, any>
  syncedFromOrigin?: string
  syncedAt?: number
}

let inMemoryPendingSync: ExtensionSyncPayload | null = null
let restoreInFlight: Promise<boolean> | null = null

export function savePendingExtensionSyncPayload(
  payload: ExtensionSyncPayload | null | undefined,
): void {
  if (!payload || typeof payload !== 'object') return
  inMemoryPendingSync = payload
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(
        PENDING_EXTENSION_SYNC_STORAGE_KEY,
        JSON.stringify(payload),
      )
    }
  } catch {
    // Ignore sessionStorage errors in restricted contexts
  }
}

export function peekPendingExtensionSyncPayload(): ExtensionSyncPayload | null {
  if (inMemoryPendingSync) {
    return inMemoryPendingSync
  }
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem(PENDING_EXTENSION_SYNC_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          inMemoryPendingSync = parsed as ExtensionSyncPayload
          return inMemoryPendingSync
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return null
}

export function clearPendingExtensionSyncPayload(): void {
  inMemoryPendingSync = null
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PENDING_EXTENSION_SYNC_STORAGE_KEY)
    }
  } catch {
    // Ignore storage remove errors
  }
}

export function extractValidBackupShares(
  bundle: Record<string, any> | null | undefined,
): string[] {
  if (!bundle || typeof bundle !== 'object') return []
  if (!Array.isArray(bundle.backupShares)) return []
  return bundle.backupShares.filter(
    (s: unknown): s is string => typeof s === 'string' && Boolean(s.trim()),
  )
}

export async function restoreAccountFromExtensionBundle(
  bundle: Record<string, any> | null | undefined,
  options?: {
    preferredDisplayName?: string
    onActivated?: () => Promise<void> | void
  },
): Promise<boolean> {
  const shares = extractValidBackupShares(bundle)
  if (shares.length < 2) {
    return false
  }
  if (accountStatus.status === 'ready') {
    clearPendingExtensionSyncPayload()
    await options?.onActivated?.()
    return true
  }
  if (restoreInFlight) {
    return restoreInFlight
  }

  const ceremony = createAccountCeremony()
  if (
    typeof (ceremony as any).beginRestore !== 'function' ||
    typeof (ceremony as any).confirm !== 'function'
  ) {
    return false
  }

  restoreInFlight = (async () => {
    try {
      const chosenName =
        (
          options?.preferredDisplayName ||
          (typeof bundle?.displayName === 'string' ? bundle.displayName : '') ||
          'Frank User'
        ).trim() || 'Frank User'

      await (ceremony as any).beginRestore()
      const outcome = await (ceremony as any).confirm(shares, chosenName)
      if (outcome?.discoveredRelayUrl) {
        setCustomRelayBaseUrl(outcome.discoveredRelayUrl)
      }

      const pending = accountStatus.pending
      const operationId =
        pending?.account.receipt.operationId ??
        outcome?.attemptId ??
        'ext-sync-attempt'
      const expectedActive = pending?.expectedActive ?? {
        revision: accountStatus.revision,
        accountId: accountStatus.account?.receipt.context.accountId ?? null,
      }
      const identityAddress = accountStatus.pendingIdentityAddress

      await accountSession.activatePending(operationId, expectedActive)
      if ((accountStatus.status as string) !== 'ready') {
        return false
      }

      clearPendingExtensionSyncPayload()
      try {
        void usePersistentStorageStore().afterActivation()
      } catch {
        // Ignore in standalone test environments without Pinia
      }
      if (chosenName) {
        void nameOwnProfile(chosenName, identityAddress ?? undefined).catch(
          () => undefined,
        )
      }
      await options?.onActivated?.()
      return true
    } catch {
      try {
        ceremony.cancel()
      } catch {
        // Ignore cancel errors
      }
      return false
    } finally {
      restoreInFlight = null
    }
  })()

  return restoreInFlight
}
