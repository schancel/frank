/**
 * End-to-end WebPush VAPID subscription & relay notification policy synchronization (#384, #1574).
 *
 * Bridges the browser's `ServiceWorkerRegistration.pushManager`, the relay's
 * `/push/vapid-public-key` endpoint, deterministic per-contact `WakeupCapability` tokens,
 * and `PUT /message/monad/mailbox/:address/notification-policy`.
 */
import {
  buildMailboxNotificationPolicy,
  computeActiveContactWakeupTokenHashes,
  derivePeerWakeupCapability,
  fetchRelayVapidPublicKey,
  putMailboxNotificationPolicy,
  urlBase64ToUint8Array,
  type BlindPushSubscription,
  type MailboxNotificationPolicy,
  type NotificationPolicyAuthContext,
  type WakeupCapability,
  type WakeupPolicyContactEntry,
} from '@frank/cashweb/relay/notification-policy'
import { loadMonadChainConfigFromEnv } from '@frank/wallet/chain/evm-chain'
import type { MonadIdentity } from '@frank/wallet/evm-identity'
import { accountSession } from '../accounts/session'
import { BLIND_WAKEUP_HANDLED_TYPE } from '../../src-pwa/custom-service-worker'
import { messagingWallet } from './monad-identity-session'

const CACHED_PUSH_SUBSCRIPTION_STORAGE_KEY = 'frank-webpush-subscription-v1'

let cachedPushSubscription: BlindPushSubscription | null = null

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(binary)
      : Buffer.from(bytes).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Extract `{ endpoint, p256dh, auth }` from a browser `PushSubscription` object.
 */
export function extractBlindPushSubscription(
  sub: unknown,
): BlindPushSubscription | null {
  if (!sub || typeof sub !== 'object') {
    return null
  }
  const candidate = sub as {
    endpoint?: unknown
    keys?: { p256dh?: unknown; auth?: unknown }
    toJSON?: () => {
      endpoint?: unknown
      keys?: { p256dh?: unknown; auth?: unknown }
    }
    getKey?: (name: 'p256dh' | 'auth') => ArrayBuffer | null
  }

  const json =
    typeof candidate.toJSON === 'function' ? candidate.toJSON() : undefined
  const endpoint = String(json?.endpoint ?? candidate.endpoint ?? '').trim()
  if (!endpoint) {
    return null
  }

  let p256dh = String(json?.keys?.p256dh ?? candidate.keys?.p256dh ?? '').trim()
  let auth = String(json?.keys?.auth ?? candidate.keys?.auth ?? '').trim()

  if ((!p256dh || !auth) && typeof candidate.getKey === 'function') {
    const p256dhBuf = candidate.getKey('p256dh')
    const authBuf = candidate.getKey('auth')
    if (!p256dh && p256dhBuf) {
      p256dh = arrayBufferToBase64Url(p256dhBuf)
    }
    if (!auth && authBuf) {
      auth = arrayBufferToBase64Url(authBuf)
    }
  }

  if (!p256dh || !auth) {
    return null
  }
  return { endpoint, p256dh, auth }
}

export function getCachedBlindPushSubscription(): BlindPushSubscription | null {
  if (cachedPushSubscription) {
    return cachedPushSubscription
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const raw = window.localStorage.getItem(
        CACHED_PUSH_SUBSCRIPTION_STORAGE_KEY,
      )
      if (raw) {
        const parsed = JSON.parse(raw)
        const extracted = extractBlindPushSubscription(parsed)
        if (extracted) {
          cachedPushSubscription = extracted
          return extracted
        }
      }
    }
  } catch {
    // Ignore storage read errors
  }
  return null
}

export function setCachedBlindPushSubscription(
  sub: BlindPushSubscription | null,
): void {
  cachedPushSubscription = sub
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      if (sub) {
        window.localStorage.setItem(
          CACHED_PUSH_SUBSCRIPTION_STORAGE_KEY,
          JSON.stringify(sub),
        )
      } else {
        window.localStorage.removeItem(CACHED_PUSH_SUBSCRIPTION_STORAGE_KEY)
      }
    }
  } catch {
    // Ignore storage write errors
  }
}

function defaultRelayBaseUrl(): string {
  try {
    return loadMonadChainConfigFromEnv().relayBaseUrl
  } catch {
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin
    }
    return 'http://127.0.0.1:8098'
  }
}

/**
 * Subscribe (or reuse an existing subscription) on the browser's ServiceWorker `PushManager`
 * using the relay's VAPID public key (`GET /push/vapid-public-key`).
 */
export async function ensureBrowserPushSubscription(options?: {
  relayBaseUrl?: string
  fetchImpl?: typeof fetch
  serviceWorkerRegistration?: {
    pushManager?: {
      getSubscription?: () => Promise<unknown>
      subscribe?: (opts: {
        userVisibleOnly: boolean
        applicationServerKey: Uint8Array<ArrayBuffer>
      }) => Promise<unknown>
    }
  } | null
}): Promise<BlindPushSubscription | null> {
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission !== 'granted'
  ) {
    return null
  }

  let registration = options?.serviceWorkerRegistration ?? null
  if (
    !registration &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator
  ) {
    try {
      registration =
        (await navigator.serviceWorker.getRegistration()) ??
        (await Promise.race([
          navigator.serviceWorker.ready,
          new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
        ]))
    } catch {
      registration = null
    }
  }

  const pushManager = registration?.pushManager
  if (!pushManager) {
    return getCachedBlindPushSubscription()
  }

  try {
    if (typeof pushManager.getSubscription === 'function') {
      const existing = await pushManager.getSubscription()
      const extracted = extractBlindPushSubscription(existing)
      if (extracted) {
        setCachedBlindPushSubscription(extracted)
        return extracted
      }
    }

    if (typeof pushManager.subscribe !== 'function') {
      return getCachedBlindPushSubscription()
    }

    const relayBaseUrl = options?.relayBaseUrl ?? defaultRelayBaseUrl()
    const vapidPublicKey = await fetchRelayVapidPublicKey(
      relayBaseUrl,
      options?.fetchImpl,
    )
    if (!vapidPublicKey) {
      return getCachedBlindPushSubscription()
    }

    // Browser BufferSource excludes shared backing buffers. Own the decoded bytes.
    const applicationServerKey = new Uint8Array(
      urlBase64ToUint8Array(vapidPublicKey),
    )
    const created = await pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    })
    const extracted = extractBlindPushSubscription(created)
    if (extracted) {
      setCachedBlindPushSubscription(extracted)
      return extracted
    }
  } catch (err) {
    console.warn('[webpush-sync] PushManager subscribe failed:', err)
  }

  return getCachedBlindPushSubscription()
}

async function resolveActiveMonadIdentity(): Promise<MonadIdentity | null> {
  const liveWallet = messagingWallet() as unknown as
    | { identity?: MonadIdentity }
    | undefined
  if (liveWallet?.identity) {
    return liveWallet.identity
  }
  try {
    if (accountSession.state.status === 'ready') {
      const wallet = await accountSession.getWallet()
      const id = (wallet as unknown as { identity?: MonadIdentity })?.identity
      if (id) {
        return id
      }
    }
  } catch {
    // Session not ready
  }
  return null
}

/**
 * Synchronously derive a deterministic per-peer `WakeupCapability` if a live `MonadIdentity` is open.
 */
export function deriveLocalPeerWakeupCapabilitySync(
  peerAddress: string,
  identityOverride?: MonadIdentity | null,
): WakeupCapability | null {
  if (!peerAddress) return null
  const identity =
    identityOverride ??
    (messagingWallet() as unknown as { identity?: MonadIdentity } | undefined)
      ?.identity
  if (!identity || typeof identity.toPrivateKeyHex !== 'function') {
    return null
  }
  try {
    return derivePeerWakeupCapability(identity.toPrivateKeyHex(), peerAddress)
  } catch {
    return null
  }
}

/**
 * Derive a deterministic per-peer `WakeupCapability` from the active wallet identity.
 */
export async function deriveLocalPeerWakeupCapability(
  peerAddress: string,
): Promise<WakeupCapability | null> {
  if (!peerAddress) return null
  const identity = await resolveActiveMonadIdentity()
  return deriveLocalPeerWakeupCapabilitySync(peerAddress, identity)
}

/**
 * Build a `NotificationPolicyAuthContext` from a `MonadIdentity`.
 */
export function authContextFromMonadIdentity(
  identity: MonadIdentity,
): NotificationPolicyAuthContext {
  return {
    address: identity.address.raw.toLowerCase(),
    publicKeyHex: Buffer.from(identity.compressedPubKey).toString('hex'),
    signDigest: digest32 =>
      new Uint8Array(identity.signHash(Buffer.from(digest32))),
  }
}

/**
 * Recompute and push the user's `MailboxNotificationPolicy` (including active unmuted
 * contact wakeup token hashes, AVU threshold, and WebPush subscription) to the home relay.
 */
export async function syncRelayNotificationPolicy(options?: {
  relayBaseUrl?: string
  avuThreshold?: number
  allowContactBypass?: boolean
  contacts?: ReadonlyArray<WakeupPolicyContactEntry>
  pushSubscription?: BlindPushSubscription | null
  subscribeIfGranted?: boolean
  identity?: MonadIdentity | null
  authContext?: NotificationPolicyAuthContext
  walletSecretHex?: string
  fetchImpl?: typeof fetch
}): Promise<MailboxNotificationPolicy | null> {
  try {
    const identity =
      options?.identity !== undefined
        ? options.identity
        : await resolveActiveMonadIdentity()
    const authContext =
      options?.authContext ??
      (identity ? authContextFromMonadIdentity(identity) : null)
    if (!authContext) {
      return null
    }

    const walletSecretHex =
      options?.walletSecretHex ??
      (identity && typeof identity.toPrivateKeyHex === 'function'
        ? identity.toPrivateKeyHex()
        : undefined)

    const relayBaseUrl = options?.relayBaseUrl ?? defaultRelayBaseUrl()

    let avuThreshold = options?.avuThreshold
    let allowContactBypass = options?.allowContactBypass
    if (avuThreshold === undefined || allowContactBypass === undefined) {
      try {
        const { useSettingsStore } = await import('../stores/settings')
        const settingsStore = useSettingsStore()
        if (avuThreshold === undefined) {
          avuThreshold = settingsStore.notificationFeeThresholdAvu ?? 0
        }
        if (allowContactBypass === undefined) {
          allowContactBypass =
            settingsStore.allowContactNotificationBypass ?? true
        }
      } catch {
        avuThreshold = avuThreshold ?? 0
        allowContactBypass = allowContactBypass ?? true
      }
    }

    let contactEntries: ReadonlyArray<WakeupPolicyContactEntry> =
      options?.contacts ?? []
    if (!options?.contacts) {
      try {
        const { useContactStore } = await import('../stores/contacts')
        const contactStore = useContactStore()
        const entries: WakeupPolicyContactEntry[] = []
        for (const [address, contact] of Object.entries(
          contactStore.contacts ?? {},
        )) {
          if (!contact) continue
          entries.push({
            address,
            notify: contact.notify,
            inboundWakeupToken: contact.inboundWakeupToken,
            outboundWakeupToken: contact.outboundWakeupToken,
          })
        }
        contactEntries = entries
      } catch {
        contactEntries = []
      }
    }

    const contactWakeupTokens = computeActiveContactWakeupTokenHashes(
      contactEntries,
      walletSecretHex,
    )

    let pushSub =
      options?.pushSubscription !== undefined
        ? options.pushSubscription
        : getCachedBlindPushSubscription()
    if (!pushSub && (options?.subscribeIfGranted ?? true)) {
      pushSub = await ensureBrowserPushSubscription({
        relayBaseUrl,
        fetchImpl: options?.fetchImpl,
      })
    }

    const policy = buildMailboxNotificationPolicy({
      avuThreshold,
      allowContactBypass,
      contactWakeupTokens,
      pushSubscriptions: pushSub ? [pushSub] : [],
    })

    return await putMailboxNotificationPolicy(
      relayBaseUrl,
      policy,
      authContext,
      options?.fetchImpl,
    )
  } catch (err) {
    console.warn(
      '[webpush-sync] Failed to sync relay notification policy:',
      err,
    )
    return null
  }
}

/**
 * Notify the active Service Worker that a backgrounded client window decrypted and handled
 * an incoming message notification so the fallback generic wakeup notification is suppressed.
 */
export function acknowledgeServiceWorkerWakeupHandled(): void {
  try {
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker
    ) {
      const msg = {
        type: BLIND_WAKEUP_HANDLED_TYPE,
        timestampMs: Date.now(),
      }
      navigator.serviceWorker.controller?.postMessage(msg)
      void navigator.serviceWorker
        .getRegistration?.()
        .then(reg => {
          reg?.active?.postMessage(msg)
        })
        .catch(() => undefined)
    }
  } catch {
    // Ignore when serviceWorker is unavailable
  }
}
