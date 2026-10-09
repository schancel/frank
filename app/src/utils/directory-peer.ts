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

/** Profile used to create or refresh a contact. `undefined` when the address cannot be used. */
export async function fetchContactProfile(
  address: ChainAddress,
): Promise<ProfileInfo | undefined> {
  if (lookup === 'pending') {
    await waitForDirectoryLookup(3000)
  }
  if (lookup === null) return activeChain.fetchProfile(address)
  const key = address.raw.toLowerCase()
  if (lookup === 'pending') {
    lastFailure = { address: key, reason: 'messaging-off' }
    return undefined
  }
  let pubKey: Uint8Array
  try {
    pubKey = fromHex((await lookup(address.raw)).subject)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code
    lastFailure = {
      address: key,
      reason:
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
    return undefined
  }
  if (lastFailure?.address === key) lastFailure = null
  let display: ProfileInfo | undefined
  try {
    display = await activeChain.fetchProfile(address)
  } catch {
    display = undefined
  }
  // The key is the directory's, whatever a display profile claims.
  return { ...(display ?? {}), address, pubKey }
}
