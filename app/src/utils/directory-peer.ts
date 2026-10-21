/**
 * Contact lookup through the open directory.
 *
 * For a typed account, a contact's identity and key come only from that contact's own signed
 * directory entry: the entry is fetched for the address, and it is used only if the key that
 * signed it hashes to that address. A relay-served display profile, when one exists, contributes
 * its name, bio and avatar and nothing else. Any address with a published entry can be added.
 */
import { activeChain } from '@frank/wallet/chain'
import { fromHex } from '@frank/codec'

type ChainAddress = Parameters<typeof activeChain.fetchProfile>[0]
type ProfileInfo = NonNullable<
  Awaited<ReturnType<typeof activeChain.fetchProfile>>
>
export type DirectoryLookup = (address: string) => Promise<{ subject: string }>

/**
 * `null`: no typed account in this session, the chain's own profile lookup applies.
 * `'pending'`: a typed account exists but its entry is not published yet; nothing is looked up.
 */
let lookup: DirectoryLookup | 'pending' | null = null
let pendingWaiters: Array<() => void> = []

/** Set by the messaging session. */
export function setDirectoryLookup(
  value: DirectoryLookup | 'pending' | null,
): void {
  lookup = value
  if (lookup !== 'pending' && pendingWaiters.length > 0) {
    const waiters = pendingWaiters
    pendingWaiters = []
    for (const w of waiters) w()
  }
}

/** Wake up any pending lookup waiters when messaging initialization has failed or cancelled. */
export function cancelDirectoryLookupWaiters(): void {
  if (pendingWaiters.length > 0) {
    const waiters = pendingWaiters
    pendingWaiters = []
    for (const w of waiters) w()
  }
}

/** Resolves once directory lookup transitions away from 'pending', or after timeout. */
export async function waitForDirectoryLookup(
  timeoutMs = 3000,
): Promise<DirectoryLookup | 'pending' | null> {
  if (lookup !== 'pending') return lookup
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(lookup)
      }
    }, timeoutMs)
    pendingWaiters.push(() => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(lookup)
      }
    })
  })
}

/** Why the last directory lookup of an address found nothing, for a plain message to the user. */
export type ContactLookupFailure =
  | 'not-published'
  | 'unreachable'
  | 'refused'
  | 'clock'
  | 'messaging-off'
let lastFailure: { address: string; reason: ContactLookupFailure } | null = null
export function contactLookupFailure(
  address: ChainAddress,
): ContactLookupFailure | null {
  return lastFailure?.address === address.raw.toLowerCase()
    ? lastFailure.reason
    : null
}

export interface ContactProfileResult {
  profile: (ProfileInfo & { displayLookupFailed?: true }) | undefined
  /** Request-local reason: concurrent lookups cannot overwrite a refresh retry decision. */
  failure: ContactLookupFailure | null
}

/** Convenience API for existing profile consumers and their last-lookup diagnostics. */
export async function fetchContactProfile(
  address: ChainAddress,
  options?: { relayBaseUrl?: string },
): Promise<ContactProfileResult['profile']> {
  const result = await fetchContactProfileResult(address, options)
  const key = address.raw.toLowerCase()
  if (result.failure) lastFailure = { address: key, reason: result.failure }
  else if (lastFailure?.address === key) lastFailure = null
  return result.profile
}

/** Profile used to create or refresh a contact. `undefined` when the address cannot be used.
 * A failed optional display read preserves authenticated identity but must not make an empty
 * display profile fresh: callers can still use the key and retry display enrichment later. */
export async function fetchContactProfileResult(
  address: ChainAddress,
  options?: { relayBaseUrl?: string },
): Promise<ContactProfileResult> {
  if (lookup === 'pending') {
    await waitForDirectoryLookup(3000)
  }
  if (lookup === null) {
    const profile = await (options
      ? activeChain.fetchProfile(address, options)
      : activeChain.fetchProfile(address))
    return { profile, failure: null }
  }
  if (lookup === 'pending') {
    return { profile: undefined, failure: 'messaging-off' }
  }
  let pubKey: Uint8Array
  try {
    pubKey = fromHex((await lookup(address.raw)).subject)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    return {
      profile: undefined,
      failure:
        code === 'not-published'
          ? 'not-published'
          : code === 'clock'
          ? 'clock'
          : code === 'unreachable' ||
            code === 'storage' ||
            code === 'history-too-long'
          ? 'unreachable'
          : 'refused',
    }
  }
  let display: ProfileInfo | undefined
  let displayLookupFailed: true | undefined
  try {
    display = await (options
      ? activeChain.fetchProfile(address, options)
      : activeChain.fetchProfile(address))
  } catch {
    displayLookupFailed = true
    display = undefined
  }
  // The key is the directory's, whatever a display profile claims.
  return {
    failure: null,
    profile: {
      ...(display ?? {}),
      address,
      pubKey,
      ...(displayLookupFailed ? { displayLookupFailed } : {}),
    },
  }
}

/** Capture only authenticated directory identity; display profiles never authorize negotiations. */
export async function captureDirectoryPeer(
  address: string,
): Promise<{ publicKey: Uint8Array; assertCurrent(): void }> {
  const captured = lookup
  if (typeof captured !== 'function')
    throw new Error('Authenticated directory unavailable')
  const entry = await captured(address)
  if (lookup !== captured) throw new Error('Directory session changed')
  const publicKey = fromHex(entry.subject)
  return {
    publicKey,
    assertCurrent() {
      if (lookup !== captured) throw new Error('Directory session changed')
    },
  }
}
