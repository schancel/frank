import { accountSession, accountStatus } from '../accounts/session'
import { createAccountCeremony } from '../accounts/ceremony'
import { usePersistentStorageStore } from '../stores/persistent-storage'
import { nameOwnProfile } from './identity-session'
import { setCustomRelayBaseUrl } from '@frank/wallet/chain'
import { shallowRef } from 'vue'
import {
  FRANK_PWA_EXTENSION_SYNC_CHANNEL,
  isBrowserExtensionRuntime,
  isFrankWebAppOrigin,
  sendRuntimeMessage,
} from '../../src-bex/runtime-adapter'
import {
  createSyncSender,
  receiveSyncBundle,
  syncSenderConfirm,
  syncSenderHello,
  SYNC_PAIRING_TTL_MS,
  type SyncConfirmRequest,
  type SyncReceiveResult,
  type SyncSenderState,
} from './sync-pairing'

/** Asks only for navigation in an existing ready web account; never sends account data. */
export async function requestWebAccountSyncSender(): Promise<boolean> {
  if (!isBrowserExtensionRuntime()) return false
  try {
    const response = await sendRuntimeMessage<
      unknown,
      { ok?: boolean; result?: { ok?: boolean } }
    >({
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      type: 'request-sync-sender',
    })
    return response?.ok === true && response.result?.ok === true
  } catch {
    return false
  }
}

/** A content-bridge navigation hint, with no export or account mutation authority. */
export async function handlePageSyncNavigationRequest(
  event: MessageEvent,
  navigate: () => boolean | Promise<boolean>,
  win: Window = window,
): Promise<boolean> {
  const data = event.data
  if (
    event.source !== win ||
    event.origin !== win.location.origin ||
    !isFrankWebAppOrigin(win.location.origin) ||
    win.top !== win ||
    data?.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
    data.direction !== 'to-pwa' ||
    data.type !== 'open-sync-sender' ||
    typeof data.id !== 'string' ||
    !data.id ||
    data.id.length > 128
  )
    return false
  let ok = false
  if (accountStatus.status === 'ready') {
    try {
      const revision = accountStatus.revision
      const account = accountStatus.account
      ok =
        (await navigate()) === true &&
        accountStatus.status === 'ready' &&
        accountStatus.revision === revision &&
        accountStatus.account === account
    } catch {
      /* The sender page did not open. */
    }
  }
  win.postMessage(
    {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-extension',
      type: 'sync-navigation-reply',
      id: data.id,
      result: { ok },
    },
    win.location.origin,
  )
  return true
}

/**
 * What the sending side shows while it waits for the PIN: the PIN itself, and
 * whether the last PIN was wrong, the account went out, or the session ended.
 */
export type SyncSenderStatus =
  | 'waiting'
  | 'new-pin'
  | 'sent'
  | 'ended'
  | 'expired'

export interface SyncSenderView {
  pin: string
  status: SyncSenderStatus
}

/** The web app's own sending session (web app -> extension). Memory only. */
export const pageSyncSender = shallowRef<SyncSenderView | null>(null)
let pageSenderState: SyncSenderState | null = null
let pageSenderTimer: ReturnType<typeof setTimeout> | null = null
let restoreInFlight: Promise<boolean> | null = null

function endPageSyncSender(status: SyncSenderStatus): void {
  pageSenderState = null
  if (pageSenderTimer) clearTimeout(pageSenderTimer)
  pageSenderTimer = null
  pageSyncSender.value = { pin: '', status }
}

/**
 * Starts handing this web app's account to the extension: makes a PIN for the
 * user to type there and tells the extension this tab is offering an account.
 * The bundle stays in this page until the extension proves it has the PIN.
 */
export function startPageSyncSender(
  bundle: Record<string, unknown>,
  win: Window = window,
): SyncSenderView {
  if (pageSenderTimer) clearTimeout(pageSenderTimer)
  pageSenderState = createSyncSender(bundle)
  pageSenderTimer = setTimeout(
    () => endPageSyncSender('expired'),
    SYNC_PAIRING_TTL_MS,
  )
  const view: SyncSenderView = { pin: pageSenderState.pin, status: 'waiting' }
  pageSyncSender.value = view
  win.postMessage(
    {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-extension',
      type: 'pwa-sync-offer',
      id: `sync-offer-${Date.now()}`,
    },
    win.location.origin,
  )
  return view
}

/**
 * Ends the web app's sending session now: wipes the bundle and PIN from this
 * page and withdraws the offer from the extension.
 */
export function cancelPageSyncSender(win: Window = window): void {
  const hadSession = pageSenderState !== null
  endPageSyncSender('ended')
  pageSyncSender.value = null
  if (!hadSession) return
  win.postMessage(
    {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-extension',
      type: 'pwa-sync-cancel',
      id: `sync-cancel-${Date.now()}`,
    },
    win.location.origin,
  )
}

/**
 * Answers the extension's pairing requests for the web app's sending session.
 * The extension's content script relays them; anything else is ignored.
 * Returns whether the event was such a request.
 */
export function handlePageSyncPairingRequest(
  event: MessageEvent,
  win: Window = window,
): boolean {
  if (event.source !== win || event.origin !== win.location.origin) {
    return false
  }
  const data = event.data
  if (
    !data ||
    typeof data !== 'object' ||
    data.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
    data.direction !== 'to-pwa' ||
    (data.type !== 'pair-hello' && data.type !== 'pair-confirm') ||
    typeof data.id !== 'string'
  ) {
    return false
  }
  let result: unknown = { ok: false, reason: 'no-sender' }
  if (pageSenderState && data.type === 'pair-hello') {
    const next = syncSenderHello(pageSenderState)
    pageSenderState = next.state
    if (!next.state) endPageSyncSender('expired')
    result = next.reply
  } else if (pageSenderState) {
    const next = syncSenderConfirm(pageSenderState, data.payload)
    pageSenderState = next.state
    if (next.outcome === 'new-pin' && next.state) {
      pageSyncSender.value = { pin: next.state.pin, status: 'new-pin' }
    } else if (next.outcome !== 'stale') {
      endPageSyncSender(next.outcome === 'sent' ? 'sent' : next.outcome)
    }
    result = next.reply
  }
  win.postMessage(
    {
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      direction: 'to-extension',
      type: 'pair-reply',
      id: data.id,
      result,
    },
    win.location.origin,
  )
  return true
}

/** How long the web app waits for the extension to answer a pairing message. */
export const SYNC_PAIR_REPLY_TIMEOUT_MS = 10_000
let pairRequestSeq = 0

/** Sends one pairing message to the other side and returns its reply, or null. */
async function sendSyncPairMessage(
  type: 'pair-hello' | 'pair-confirm',
  payload: SyncConfirmRequest | undefined,
  win: Window,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) return null
  if (isBrowserExtensionRuntime()) {
    // The background relays it to the web app tab that offered an account.
    const response = await sendRuntimeMessage<Record<string, unknown>, any>({
      channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
      type,
      payload,
    }).catch(() => null)
    return signal?.aborted ? null : response?.result ?? null
  }
  // The extension's content script relays it to the background, which holds
  // the extension's sending session.
  const id = `sync-pair-${Date.now()}-${++pairRequestSeq}`
  return await new Promise<unknown>(resolve => {
    const done = (value: unknown) => {
      clearTimeout(timer)
      win.removeEventListener('message', onMessage)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => done(null)
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (
        event.source !== win ||
        event.origin !== win.location.origin ||
        data?.channel !== FRANK_PWA_EXTENSION_SYNC_CHANNEL ||
        data.direction !== 'to-pwa' ||
        (data.type !== 'sync-response' && data.type !== 'sync-error') ||
        data.id !== id
      ) {
        return
      }
      done(data.result ?? null)
    }
    const timer = setTimeout(() => done(null), SYNC_PAIR_REPLY_TIMEOUT_MS)
    win.addEventListener('message', onMessage)
    signal?.addEventListener('abort', onAbort, { once: true })
    win.postMessage(
      {
        channel: FRANK_PWA_EXTENSION_SYNC_CHANNEL,
        direction: 'to-extension',
        type,
        id,
        payload,
      },
      win.location.origin,
    )
  })
}

/**
 * Whether this side may take an account from the other window: only when it
 * has none at all. A locked, pending or unavailable account still exists, and
 * restoring would replace it (or cancel the pending signup).
 */
export function canReceiveSyncedAccount(): boolean {
  return (
    accountStatus.status === 'fresh' &&
    !accountStatus.account &&
    !accountStatus.pending
  )
}

/**
 * Receives the account the other Frank window is offering, using the PIN the
 * user typed. A missing reply means nothing is offering an account. A side
 * that already has an account does not pair at all.
 */
export async function receiveAccountOverBridge(
  pin: string,
  win: Window = window,
  options: { signal?: AbortSignal } = {},
): Promise<SyncReceiveResult> {
  if (!canReceiveSyncedAccount()) return { ok: false, reason: 'has-account' }
  return receiveSyncBundle(
    pin,
    async (type, payload) =>
      (await sendSyncPairMessage(type, payload, win, options.signal)) ?? {
        ok: false,
        reason: 'no-sender',
      },
  )
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

/** Restores and activates a bundle received with the PIN the user typed. */
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
  if (!canReceiveSyncedAccount()) {
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

      // Never cancel a signup another tab may have started meanwhile.
      await (ceremony as any).beginRestore(undefined, { keepPending: true })
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
