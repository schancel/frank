import { accountSession, accountStatus } from '../accounts/session'
import { createAccountCeremony } from '../accounts/ceremony'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { nameOwnProfile } from './identity-session'
import { setCustomRelayBaseUrl } from '@frank/wallet/chain'
import { shallowRef } from 'vue'
import { sha256 } from '@noble/hashes/sha256.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { FRANK_PWA_EXTENSION_SYNC_CHANNEL } from '../../src-bex/runtime-adapter'

/**
 * An account bundle another Frank surface (extension or web app) offered to this
 * one. It carries backup shares, so it lives only in memory until the user
 * restores it or dismisses it, and it is never restored without that click.
 */
export interface ExtensionSyncOffer {
  deviceSyncBundle: Record<string, any>
  /** Check code to compare with the one shown on the sending device. */
  checkCode: string
}

export const pendingExtensionSyncOffer = shallowRef<ExtensionSyncOffer | null>(
  null,
)
let restoreInFlight: Promise<boolean> | null = null

/** Holds a received bundle for the user to confirm. Ignores bundles without shares. */
export function offerExtensionSyncBundle(
  bundle: Record<string, any> | null | undefined,
): ExtensionSyncOffer | null {
  const checkCode = syncTransferCheckCode(bundle)
  if (!bundle || !checkCode) return null
  const offer = { deviceSyncBundle: bundle, checkCode }
  pendingExtensionSyncOffer.value = offer
  return offer
}

export function clearExtensionSyncOffer(): void {
  pendingExtensionSyncOffer.value = null
}

/**
 * Six digits derived from the backup shares in the bundle. The sending device
 * shows the code of what it sent; the receiving device shows the code of what
 * it got. Different codes mean the bundle is not the one the user sent.
 */
export function syncTransferCheckCode(
  bundle: Record<string, any> | null | undefined,
): string {
  const shares = extractValidBackupShares(bundle)
  if (shares.length < 2) return ''
  const digest = sha256(
    utf8ToBytes(`frank-sync-check-v1\n${shares.join('\n')}`),
  )
  const value =
    ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
  return String(value % 1_000_000).padStart(6, '0')
}

/**
 * The account-sync window message a listener may act on: same window, same
 * origin, sync channel, addressed to the web app. Returns its bundle, if any.
 */
export function readExtensionSyncWindowMessage(
  event: MessageEvent,
  win: Window = window,
): Record<string, any> | null {
  if (event.source !== win || event.origin !== win.location.origin) return null
  const data = event.data
  if (
    !data ||
    typeof data !== 'object' ||
    data.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
    data.direction !== 'to-pwa' ||
    (data.type !== 'extension-sync-push' && data.type !== 'sync-response')
  ) {
    return null
  }
  const bundle = data.payload?.deviceSyncBundle ?? data.result?.deviceSyncBundle
  return bundle && typeof bundle === 'object' ? bundle : null
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

/** Restores and activates the bundle's account. Call only from the user's confirm click. */
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
    clearExtensionSyncOffer()
    return false
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

      clearExtensionSyncOffer()
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
