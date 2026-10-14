/**
 * Client-side mailbox notification policy and blind WebPush wakeup capabilities (#384, #1574).
 *
 * Manages reading/writing the user's mailbox notification policy on their home relay,
 * computing `min_notification_avu_micros` / `min_notification_value_wei` from the user's
 * configured AVU notification threshold, and generating/verifying blinded contact
 * `WakeupCapability` tokens (`SHA256(preimage)`) so trusted contacts can bypass the
 * stamp notification fee threshold.
 */
import { cryptoBackend } from '@frank/nakamoto'

/** 1 AVU = 1,000,000 micro-AVU. */
export const AVU_MICROS_PER_UNIT = 1_000_000

/** Default conversion factor (1e18 wei per 1.00 AVU = 1e12 wei per micro-AVU) when no oracle rate is provided. */
export const DEFAULT_WEI_PER_AVU = 1_000_000_000_000_000_000n

/** Domain prefix for domain-separated contact wakeup token blinding. */
export const WAKEUP_TOKEN_DOMAIN = 'frank-wakeup-v1'

/** WebPush RFC 8291 subscription credentials for content-free blind wakeup delivery. */
export interface BlindPushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/** Per-mailbox notification policy stored on the home relay. */
export interface MailboxNotificationPolicy {
  min_notification_value_wei: string
  min_notification_avu_micros: number
  allow_contact_bypass: boolean
  contact_wakeup_tokens: string[]
  push_subscriptions: BlindPushSubscription[]
  coalesce_window_seconds?: number
  updated_at_ms?: number
}

/** Pre-shared contact wakeup capability (#1574). */
export interface WakeupCapability {
  /** Secret 32-byte preimage (64-char lowercase hex) shared with a trusted contact. */
  preimageHex: string
  /** Blinded SHA-256 digest of the preimage (64-char lowercase hex) registered on the home relay. */
  tokenHashHex: string
  /** Optional contact address this capability was issued to. */
  contactAddress?: string
  /** Creation timestamp in milliseconds. */
  createdAtMs: number
}

/** Authentication material for reading/writing a mailbox notification policy. */
export interface NotificationPolicyAuthContext {
  /** Mailbox owner's Ethereum/Monad address (`0x`-prefixed 40-char hex). */
  address: string
  /** Compressed (33-byte) or uncompressed (65-byte) secp256k1 public key in hex. */
  publicKeyHex: string
  /**
   * Signs a 32-byte SHA-256 digest and returns a 64-byte compact or DER ECDSA signature
   * as `Uint8Array` or hex string.
   */
  signDigest: (
    digest32: Uint8Array,
  ) => Promise<Uint8Array | string> | Uint8Array | string
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '')
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Invalid hex string')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function normalizePreimageBytes(preimage: Uint8Array | string): Uint8Array {
  if (preimage instanceof Uint8Array) {
    return Uint8Array.from(preimage)
  }
  const trimmed = preimage.trim()
  const clean = trimmed.replace(/^0x/i, '')
  if (clean.length === 64 && /^[0-9a-fA-F]{64}$/.test(clean)) {
    return hexToBytes(clean)
  }
  return utf8ToBytes(trimmed)
}

/**
 * Convert an AVU threshold (e.g. `0.25` AVU) into integer micro-AVU (`250_000`).
 * Negative or non-finite inputs clamp to `0`.
 */
export function avuToMicros(avu: number | string): number {
  const numeric = typeof avu === 'string' ? Number(avu.trim()) : avu
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0
  }
  return Math.round(numeric * AVU_MICROS_PER_UNIT)
}

/**
 * Convert integer micro-AVU (`250_000`) back into decimal AVU (`0.25`).
 */
export function microsToAvu(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) {
    return 0
  }
  return micros / AVU_MICROS_PER_UNIT
}

/**
 * Compute `min_notification_value_wei` (decimal string) from an AVU threshold.
 */
export function avuThresholdToMinWei(
  avu: number | string,
  weiPerAvu: bigint = DEFAULT_WEI_PER_AVU,
): string {
  const micros = BigInt(avuToMicros(avu))
  if (micros <= 0n || weiPerAvu <= 0n) {
    return '0'
  }
  const wei = (micros * weiPerAvu) / BigInt(AVU_MICROS_PER_UNIT)
  return wei.toString(10)
}

/**
 * Compute the blinded token hash `SHA256(preimage)` as a 64-character lowercase hex string.
 */
export function blindWakeupToken(preimage: Uint8Array | string): string {
  const bytes = normalizePreimageBytes(preimage)
  const digest = cryptoBackend.sha256(bytes)
  return bytesToHex(digest)
}

/**
 * Compute the domain-separated blinded token hash `SHA256("frank-wakeup-v1" || preimage)`.
 */
export function blindWakeupTokenDomainSeparated(
  preimage: Uint8Array | string,
): string {
  const prefix = utf8ToBytes(WAKEUP_TOKEN_DOMAIN)
  const body = normalizePreimageBytes(preimage)
  const combined = new Uint8Array(prefix.length + body.length)
  combined.set(prefix, 0)
  combined.set(body, prefix.length)
  return bytesToHex(cryptoBackend.sha256(combined))
}

/**
 * Generate or wrap a contact `WakeupCapability` (`preimageHex` + `tokenHashHex = SHA256(preimage)`).
 */
export function createWakeupCapability(
  seedOrPreimage?: Uint8Array | string,
  contactAddress?: string,
  nowMs: number = Date.now(),
): WakeupCapability {
  let preimageBytes: Uint8Array
  if (seedOrPreimage !== undefined) {
    const raw = normalizePreimageBytes(seedOrPreimage)
    preimageBytes = raw.length === 32 ? raw : cryptoBackend.sha256(raw)
  } else {
    const randomBuf = new Uint8Array(32)
    if (
      typeof globalThis.crypto !== 'undefined' &&
      typeof globalThis.crypto.getRandomValues === 'function'
    ) {
      globalThis.crypto.getRandomValues(randomBuf)
    } else {
      const fallback = cryptoBackend.sha256(
        utf8ToBytes(`frank-wakeup-seed:${nowMs}:${Math.random()}`),
      )
      randomBuf.set(fallback)
    }
    preimageBytes = randomBuf
  }
  const preimageHex = bytesToHex(preimageBytes)
  const tokenHashHex = bytesToHex(cryptoBackend.sha256(preimageBytes))
  return {
    preimageHex,
    tokenHashHex,
    ...(contactAddress ? { contactAddress: contactAddress.toLowerCase() } : {}),
    createdAtMs: nowMs,
  }
}

/**
 * Verify whether a contact's wakeup token preimage hashes to any of the allowed blinded token hashes.
 */
export function verifyWakeupCapability(
  preimage: Uint8Array | string,
  allowedTokenHashes: ReadonlyArray<string | Uint8Array>,
): boolean {
  if (!allowedTokenHashes || allowedTokenHashes.length === 0) {
    return false
  }
  const directHex = blindWakeupToken(preimage)
  const domainHex = blindWakeupTokenDomainSeparated(preimage)
  const rawUtf8Hex =
    typeof preimage === 'string'
      ? bytesToHex(cryptoBackend.sha256(utf8ToBytes(preimage.trim())))
      : directHex

  for (const entry of allowedTokenHashes) {
    const candidateHex =
      typeof entry === 'string'
        ? entry.trim().replace(/^0x/i, '').toLowerCase()
        : bytesToHex(entry)
    if (
      candidateHex === directHex ||
      candidateHex === domainHex ||
      candidateHex === rawUtf8Hex
    ) {
      return true
    }
  }
  return false
}

/**
 * Client-side evaluation matching the relay's `should_trigger_wakeup` (#384, #1574).
 */
export function shouldTriggerBlindWakeup(
  policy: MailboxNotificationPolicy,
  stampValueWei: bigint | string | number,
  stampValueAvuMicros: number,
  wakeupTokenPreimage?: Uint8Array | string | null,
): boolean {
  if (
    policy.allow_contact_bypass &&
    wakeupTokenPreimage !== undefined &&
    wakeupTokenPreimage !== null &&
    verifyWakeupCapability(wakeupTokenPreimage, policy.contact_wakeup_tokens)
  ) {
    return true
  }

  const wei =
    typeof stampValueWei === 'bigint'
      ? stampValueWei
      : BigInt(String(stampValueWei || '0').trim() || '0')
  const minWei = BigInt(
    (policy.min_notification_value_wei || '0').trim() || '0',
  )
  const minAvu = Math.max(0, Math.floor(policy.min_notification_avu_micros || 0))

  if (minWei === 0n && minAvu === 0) {
    return wei > 0n || stampValueAvuMicros > 0
  }
  const meetsWei = minWei > 0n && wei >= minWei
  const meetsAvu = minAvu > 0 && stampValueAvuMicros >= minAvu
  return meetsWei || meetsAvu
}

/**
 * Construct a default or threshold-configured `MailboxNotificationPolicy`.
 */
export function buildMailboxNotificationPolicy(options?: {
  avuThreshold?: number | string
  minNotificationValueWei?: string
  allowContactBypass?: boolean
  contactWakeupTokens?: string[]
  pushSubscriptions?: BlindPushSubscription[]
  coalesceWindowSeconds?: number
  weiPerAvu?: bigint
  updatedAtMs?: number
}): MailboxNotificationPolicy {
  const avuMicros =
    options?.avuThreshold !== undefined ? avuToMicros(options.avuThreshold) : 0
  const minWei =
    options?.minNotificationValueWei !== undefined
      ? options.minNotificationValueWei
      : options?.avuThreshold !== undefined
        ? avuThresholdToMinWei(options.avuThreshold, options.weiPerAvu)
        : '0'
  return {
    min_notification_value_wei: minWei,
    min_notification_avu_micros: avuMicros,
    allow_contact_bypass: options?.allowContactBypass ?? true,
    contact_wakeup_tokens: (options?.contactWakeupTokens ?? []).map((t) =>
      t.trim().replace(/^0x/i, '').toLowerCase(),
    ),
    push_subscriptions: options?.pushSubscriptions ?? [],
    coalesce_window_seconds: options?.coalesceWindowSeconds ?? 15,
    updated_at_ms: options?.updatedAtMs ?? Date.now(),
  }
}

/**
 * Build `X-Cashweb-Auth-*` headers signed by the mailbox owner for notification policy endpoints.
 */
export async function buildNotificationPolicyAuthHeaders(
  method: 'GET' | 'PUT',
  auth: NotificationPolicyAuthContext,
  timestampMs: number = Date.now(),
): Promise<Record<string, string>> {
  const address = auth.address.trim().toLowerCase()
  const pubkeyClean = auth.publicKeyHex.trim().replace(/^0x/i, '').toLowerCase()
  const ts = String(Math.floor(timestampMs))
  const preimage = `frank-notification-policy-auth-v1:${method}:${address}:${ts}`
  const digest = cryptoBackend.sha256(utf8ToBytes(preimage))
  const sigResult = await auth.signDigest(digest)
  const sigHex =
    typeof sigResult === 'string'
      ? sigResult.trim().replace(/^0x/i, '').toLowerCase()
      : bytesToHex(sigResult)
  return {
    'x-cashweb-auth-pubkey': pubkeyClean,
    'x-cashweb-auth-timestamp': ts,
    'x-cashweb-auth-signature': sigHex,
  }
}

function normalizeRelayUrl(relayBaseUrl: string): string {
  return relayBaseUrl.trim().replace(/\/+$/, '')
}

/**
 * Fetch the mailbox notification policy from `GET /message/monad/mailbox/:address/notification-policy`.
 */
export async function getMailboxNotificationPolicy(
  relayBaseUrl: string,
  auth: NotificationPolicyAuthContext,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MailboxNotificationPolicy> {
  const address = auth.address.trim().toLowerCase()
  const url = `${normalizeRelayUrl(relayBaseUrl)}/message/monad/mailbox/${address}/notification-policy`
  const headers = await buildNotificationPolicyAuthHeaders('GET', auth)
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...headers,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Failed to fetch mailbox notification policy: HTTP ${response.status}`,
    )
  }
  return (await response.json()) as MailboxNotificationPolicy
}

/**
 * Update the mailbox notification policy via `PUT /message/monad/mailbox/:address/notification-policy`.
 */
export async function putMailboxNotificationPolicy(
  relayBaseUrl: string,
  policy: MailboxNotificationPolicy,
  auth: NotificationPolicyAuthContext,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MailboxNotificationPolicy> {
  const address = auth.address.trim().toLowerCase()
  const url = `${normalizeRelayUrl(relayBaseUrl)}/message/monad/mailbox/${address}/notification-policy`
  const headers = await buildNotificationPolicyAuthHeaders('PUT', auth)
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(policy),
  })
  if (!response.ok) {
    throw new Error(
      `Failed to update mailbox notification policy: HTTP ${response.status}`,
    )
  }
  return (await response.json()) as MailboxNotificationPolicy
}

/**
 * Deterministically derive a per-contact wakeup token preimage (64-char lowercase hex)
 * issued by the local wallet to `peerAddress`.
 *
 * Because the token is uniquely bound to `peerAddress`, muting or deleting that contact
 * and re-publishing `contact_wakeup_tokens` immediately revokes that peer's ability to
 * trigger blind WebPush wakeups without affecting any other contact.
 */
export function derivePeerWakeupTokenPreimage(
  secretSeedOrPrivateKey: Uint8Array | string,
  peerAddress: string,
): string {
  const secretBytes = normalizePreimageBytes(secretSeedOrPrivateKey)
  const peerNorm = peerAddress.trim().toLowerCase()
  const prefix = utf8ToBytes('frank-contact-wakeup-v1:')
  const suffix = utf8ToBytes(`:${peerNorm}`)
  const combined = new Uint8Array(
    prefix.length + secretBytes.length + suffix.length,
  )
  combined.set(prefix, 0)
  combined.set(secretBytes, prefix.length)
  combined.set(suffix, prefix.length + secretBytes.length)
  return bytesToHex(cryptoBackend.sha256(combined))
}

/**
 * Deterministically derive a `WakeupCapability` (`preimageHex` + `tokenHashHex`)
 * granted by the local wallet to `peerAddress`.
 */
export function derivePeerWakeupCapability(
  secretSeedOrPrivateKey: Uint8Array | string,
  peerAddress: string,
  nowMs: number = Date.now(),
): WakeupCapability {
  const preimageHex = derivePeerWakeupTokenPreimage(
    secretSeedOrPrivateKey,
    peerAddress,
  )
  return createWakeupCapability(preimageHex, peerAddress, nowMs)
}

/** Minimal contact shape used to compute active `contact_wakeup_tokens` for the relay policy. */
export interface WakeupPolicyContactEntry {
  address: string
  /** When `false`, contact is muted and its wakeup token hash is excluded from the relay policy. */
  notify?: boolean
  /** Preimage issued by us to this contact (or deterministically derived if omitted). */
  inboundWakeupToken?: string
  /** Preimage issued by this contact to us (used when we send messages to them). */
  outboundWakeupToken?: string
}

/**
 * Compute the deduplicated list of blinded `SHA256(preimage)` token hashes for all
 * unmuted contacts (`notify !== false`). Muted or deleted contacts are excluded so
 * syncing the resulting list to the relay immediately revokes their wakeup capability.
 */
export function computeActiveContactWakeupTokenHashes(
  contacts: ReadonlyArray<WakeupPolicyContactEntry>,
  secretSeedOrPrivateKey?: Uint8Array | string,
): string[] {
  const seen = new Set<string>()
  for (const contact of contacts) {
    if (!contact || !contact.address || contact.notify === false) {
      continue
    }
    const explicitInbound = contact.inboundWakeupToken?.trim()
    if (explicitInbound) {
      seen.add(blindWakeupToken(explicitInbound))
    }
    if (secretSeedOrPrivateKey !== undefined) {
      const derived = derivePeerWakeupCapability(
        secretSeedOrPrivateKey,
        contact.address,
      )
      seen.add(derived.tokenHashHex)
    }
  }
  return Array.from(seen)
}

/**
 * Convert a base64url-encoded VAPID public key into a `Uint8Array` suitable for
 * `PushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const clean = base64String.trim().replace(/=+$/, '')
  const padding = '='.repeat((4 - (clean.length % 4)) % 4)
  const base64 = (clean + padding).replace(/-/g, '+').replace(/_/g, '/')
  if (typeof globalThis.atob === 'function') {
    const rawData = globalThis.atob(base64)
    const outputArray = new Uint8Array(rawData.length)
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
  }
  const buf = Buffer.from(base64, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/**
 * Fetch the relay's P-256 VAPID public key (base64url uncompressed 65-byte key)
 * from `GET /push/vapid-public-key`.
 */
export async function fetchRelayVapidPublicKey(
  relayBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
  if (typeof fetchImpl !== 'function') {
    return null
  }
  const base = normalizeRelayUrl(relayBaseUrl)
  for (const path of [
    '/push/vapid-public-key',
    '/message/push/vapid-public-key',
  ]) {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        continue
      }
      const headerKey = response.headers
        ?.get?.('x-cashweb-vapid-public-key')
        ?.trim()
      if (headerKey) {
        return headerKey
      }
      const data = (await response.json()) as {
        vapid_public_key?: string
      } | null
      const bodyKey = data?.vapid_public_key?.trim()
      if (bodyKey) {
        return bodyKey
      }
    } catch {
      // Try next fallback path
    }
  }
  return null
}

