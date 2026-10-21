import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { accountSession, accountStatus } from '../accounts/session'
import { useProfileStore } from '../stores/my-profile'
import { getOwnCanonicalAddress } from '../utils/own-address'
import {
  cancelPageSyncSender,
  pageSyncSender,
  startPageSyncSender,
  type SyncSenderView,
} from '../utils/extension-account-sync'
import {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  FRANK_WEB_APP_ORIGIN,
  getRawExtensionApi,
  isBrowserExtensionRuntime,
  openExtensionTab,
  isFrankWebAppOrigin,
  onRuntimeMessage,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import { SYNC_PAIRING_TTL_MS } from '../utils/sync-pairing'
import { useTranslate } from './useTranslate'

/** Route-owned presentation of the existing memory-only PIN sender. */
export function useAccountSyncSender() {
  const t = useTranslate()
  const profile = useProfileStore()
  const extension = isBrowserExtensionRuntime()
  const mode =
    document.documentElement.getAttribute('data-ext-mode') ??
    new URLSearchParams(window.location.search).get('extMode')
  // Toolbar popups disappear as soon as the user focuses the receiving tab.
  // Never create a credential offer in a view whose lifetime is uncertain.
  const needsPersistentView =
    extension && !['tab', 'window', 'sidepanel', 'sidebar'].includes(mode ?? '')
  const promoting = ref(false)
  const promoted = ref(false)
  const promotionError = ref('')
  const extensionView = ref<SyncSenderView | null>(null)
  const view = computed(() =>
    extension ? extensionView.value : pageSyncSender.value,
  )
  const busy = ref(false)
  const error = ref('')
  const complete = computed(() => view.value?.status === 'sent')
  let generation = 0
  let disposed = false
  let offerId: string | null = null
  let expiry: ReturnType<typeof setTimeout> | undefined
  const accountRevision = accountStatus.revision
  const account = accountStatus.account
  const current = (token: number) =>
    !disposed &&
    token === generation &&
    accountStatus.status === 'ready' &&
    accountStatus.revision === accountRevision &&
    accountStatus.account === account

  function clearExpiry() {
    if (expiry) clearTimeout(expiry)
    expiry = undefined
  }

  async function cancel(force = false): Promise<boolean> {
    ++generation
    const cancelledOfferId = offerId
    if (
      extension &&
      cancelledOfferId &&
      !['sent', 'ended', 'expired'].includes(extensionView.value?.status ?? '')
    ) {
      busy.value = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await Promise.race([
          sendRuntimeMessage<unknown, { ok?: boolean }>({
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            type: 'extension-sync-cancel',
            payload: { offerId: cancelledOfferId },
          }),
          new Promise<null>(resolve => {
            timer = setTimeout(() => resolve(null), 2_500)
          }),
        ])
        if (!response?.ok && !force) {
          error.value = t('accountSync.cancelFailed')
          return false
        }
      } catch {
        if (!force) {
          error.value = t('accountSync.cancelFailed')
          return false
        }
      } finally {
        if (timer) clearTimeout(timer)
        busy.value = false
      }
    }
    clearExpiry()
    extensionView.value = null
    if (offerId === cancelledOfferId) offerId = null
    if (!extension) cancelPageSyncSender()
    busy.value = false
    return true
  }

  const off = onRuntimeMessage(
    (message: {
      channel?: unknown
      type?: unknown
      status?: SyncSenderView['status']
      pin?: unknown
      offerId?: unknown
    }) => {
      if (
        !message ||
        !extension ||
        !offerId ||
        message.offerId !== offerId ||
        message?.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
        message.type !== 'sync-sender-update' ||
        !message.status ||
        !['new-pin', 'sent', 'ended', 'expired'].includes(message.status)
      )
        return undefined
      extensionView.value = {
        status: message.status,
        pin: message.status === 'new-pin' ? String(message.pin ?? '') : '',
      }
      if (message.status !== 'new-pin') clearExpiry()
      return undefined
    },
  )

  async function promoteToPersistentView() {
    if (!needsPersistentView || promoting.value || promoted.value || disposed)
      return
    promoting.value = true
    promotionError.value = ''
    try {
      // Require the extension API's tab creation acknowledgment, rather than a
      // window.open fallback that a browser could silently block.
      if (typeof getRawExtensionApi()?.tabs?.create !== 'function')
        throw new Error('Tab creation unavailable')
      const result = await openExtensionTab({
        path: 'index.html?extMode=tab#/account-sync/send',
      })
      if (!result.opened) throw new Error('Tab creation failed')
      if (disposed) return
      promoted.value = true
      try {
        window.close()
      } catch {
        /* The persistent tab is open; the popup may stay visible. */
      }
    } catch {
      if (!disposed) promotionError.value = t('accountSync.promotionFailed')
    } finally {
      promoting.value = false
    }
  }
  onMounted(() => {
    if (needsPersistentView) void promoteToPersistentView()
  })

  async function showPin() {
    if (needsPersistentView) {
      await promoteToPersistentView()
      return
    }
    if (busy.value || complete.value || disposed) return
    const token = ++generation
    error.value = ''
    if (!current(token)) {
      error.value = t('accountSync.noAccount')
      return
    }
    // Reject an unsupported origin before touching custody.
    if (!extension && !isFrankWebAppOrigin(window.location.origin)) {
      error.value = t('accountSync.unsupported', {
        origin: FRANK_WEB_APP_ORIGIN,
      })
      return
    }
    const startedOfferId = extension ? crypto.randomUUID() : null
    offerId = startedOfferId
    busy.value = true
    try {
      const exported = await accountSession.backupCodex32(2, 3)
      if (!current(token)) return
      if (exported.length < 2) throw new Error('Account backup unavailable')
      const address = await getOwnCanonicalAddress()
      if (!current(token)) return
      const bundle = {
        version: 1,
        exportedAtMs: Date.now(),
        accountAddress: address ?? '',
        displayName: profile.profile?.name || 'Frank User',
        backupShares: exported.slice(0, 2),
      }
      if (!extension) {
        startPageSyncSender(bundle)
      } else {
        const response = await sendRuntimeMessage<
          Record<string, unknown>,
          {
            result?: {
              ok?: boolean
              pin?: string
              offerId?: string
              expiresAt?: number
            }
          }
        >({
          channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
          type: 'extension-sync-offer',
          payload: { deviceSyncBundle: bundle, offerId: startedOfferId },
        })
        if (!current(token)) {
          await sendRuntimeMessage({
            channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
            type: 'extension-sync-cancel',
            payload: { offerId: startedOfferId },
          }).catch(() => undefined)
          return
        }
        if (
          !response?.result?.ok ||
          response.result.offerId !== startedOfferId ||
          typeof response.result.pin !== 'string'
        )
          throw new Error('Sync offer failed')
        extensionView.value = { pin: response.result.pin, status: 'waiting' }
        clearExpiry()
        expiry = setTimeout(() => {
          extensionView.value = { pin: '', status: 'expired' }
        }, Math.max(0, (response.result.expiresAt ?? Date.now() + SYNC_PAIRING_TTL_MS) - Date.now()))
      }
    } catch {
      if (current(token)) error.value = t('accountSync.failed')
    } finally {
      if (token === generation) busy.value = false
    }
  }

  watch(
    () => [accountStatus.status, accountStatus.revision, accountStatus.account],
    () => {
      if (
        accountStatus.status !== 'ready' ||
        accountStatus.revision !== accountRevision ||
        accountStatus.account !== account
      ) {
        void cancel(true)
        error.value = t('accountSync.noAccount')
      }
    },
    { flush: 'sync' },
  )
  const onPageHide = () => {
    void cancel(true)
  }
  window.addEventListener('pagehide', onPageHide)
  onBeforeUnmount(() => {
    disposed = true
    off()
    window.removeEventListener('pagehide', onPageHide)
    void cancel(true)
  })

  return {
    view,
    busy,
    error,
    complete,
    showPin,
    cancel,
    needsPersistentView,
    promoting,
    promoted,
    promotionError,
    promoteToPersistentView,
  }
}
