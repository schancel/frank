import { reactive } from 'vue'
import { activeChain } from '@frank/wallet/chain'
import { relayHandleOf } from 'src/utils/contact-username'
import { inferCuratedBotAttributes } from 'src/utils/curated-bots'

/** Display fields only: this projection does not authenticate or normalize stored profiles. */
export interface AuthorDisplayProfile {
  name?: string
  username?: string
  accountType?: number
  botRole?: number
  isBot?: boolean
}

export function authorDisplayProfile(profile: unknown): AuthorDisplayProfile {
  const fields: AuthorDisplayProfile = {}
  if (profile === null || typeof profile !== 'object') return fields
  if ('name' in profile && typeof profile.name === 'string')
    fields.name = profile.name
  if ('username' in profile && typeof profile.username === 'string')
    fields.username = profile.username
  if ('accountType' in profile && typeof profile.accountType === 'number')
    fields.accountType = profile.accountType
  if ('botRole' in profile && typeof profile.botRole === 'number')
    fields.botRole = profile.botRole
  if ('isBot' in profile && typeof profile.isBot === 'boolean')
    fields.isBot = profile.isBot
  return fields
}

const cachedAuthorProfiles = reactive<Record<string, AuthorDisplayProfile>>({})
const inFlightLookups = new Map<
  string,
  Promise<AuthorDisplayProfile | undefined>
>()
const resolvedTimestamps = new Map<string, number>()

const HIT_TTL_MS = 5 * 60 * 1000
const MISS_TTL_MS = 60 * 1000
const CONCURRENCY_LIMIT = 6

function normalizeAuthorAddressKey(address?: string | null): string {
  if (!address || typeof address !== 'string') return ''
  const trimmed = address.trim()
  if (!trimmed) return ''
  return trimmed.toLowerCase()
}

function hasResolvedFields(profile?: AuthorDisplayProfile): boolean {
  if (!profile) return false
  return Boolean(
    (profile.name && profile.name !== 'Loading...') ||
      profile.username ||
      profile.accountType !== undefined ||
      profile.botRole !== undefined ||
      profile.isBot !== undefined,
  )
}

export function getCachedAuthorDisplayProfile(
  address?: string | null,
): AuthorDisplayProfile | undefined {
  const key = normalizeAuthorAddressKey(address)
  if (!key) return undefined
  return cachedAuthorProfiles[key]
}

export function clearAuthorDisplayProfileCache(): void {
  for (const key of Object.keys(cachedAuthorProfiles)) {
    delete cachedAuthorProfiles[key]
  }
  inFlightLookups.clear()
  resolvedTimestamps.clear()
}

export async function fetchAuthorDisplayProfile(
  address: string,
): Promise<AuthorDisplayProfile | undefined> {
  const normalizedKey = normalizeAuthorAddressKey(address)
  if (!normalizedKey) return undefined

  const existing = cachedAuthorProfiles[normalizedKey]
  const lastResolvedAt = resolvedTimestamps.get(normalizedKey)
  if (lastResolvedAt !== undefined) {
    const ttl = hasResolvedFields(existing) ? HIT_TTL_MS : MISS_TTL_MS
    if (Date.now() - lastResolvedAt < ttl) {
      return existing
    }
  }

  const inFlight = inFlightLookups.get(normalizedKey)
  if (inFlight) {
    return inFlight
  }

  const trimmedAddress = address.trim()
  const lookupPromise = (async (): Promise<
    AuthorDisplayProfile | undefined
  > => {
    try {
      let chainAddress: { raw: string; display: string } | undefined
      try {
        chainAddress =
          (
            activeChain as {
              parseAddress?: (
                addr: string,
              ) => { raw: string; display: string } | null
            }
          )?.parseAddress?.(trimmedAddress) ?? undefined
      } catch {
        chainAddress = undefined
      }
      if (
        !chainAddress &&
        typeof (activeChain as { fetchProfile?: unknown })?.fetchProfile ===
          'function'
      ) {
        chainAddress = {
          raw: normalizedKey,
          display: trimmedAddress,
        }
      }
      const displayAddress =
        typeof chainAddress?.display === 'string' && chainAddress.display.trim()
          ? chainAddress.display.trim()
          : trimmedAddress

      const fetchProfileFn = (
        activeChain as {
          fetchProfile?: (addr: unknown) => Promise<
            | {
                name?: string | null
                bot?: boolean
                accountType?: number
                botRole?: number
              }
            | undefined
          >
        }
      )?.fetchProfile

      const [profileInfo, handle] = await Promise.all([
        typeof fetchProfileFn === 'function' && chainAddress
          ? Promise.resolve(
              fetchProfileFn.call(activeChain, chainAddress),
            ).catch(() => undefined)
          : Promise.resolve(undefined),
        Promise.resolve(relayHandleOf(displayAddress)).catch(() => undefined),
      ])

      const rawName =
        typeof profileInfo?.name === 'string' ? profileInfo.name.trim() : ''
      const name = rawName && rawName !== 'Loading...' ? rawName : undefined
      const rawUsername =
        typeof handle?.username === 'string'
          ? handle.username.trim().replace(/^@/, '')
          : ''
      const username = rawUsername || undefined

      const inferred = inferCuratedBotAttributes(name ?? username ?? '')
      const isBot = profileInfo?.bot === true ? true : inferred.isBot
      const accountType =
        typeof profileInfo?.accountType === 'number'
          ? profileInfo.accountType
          : inferred.accountType
      const botRole =
        typeof profileInfo?.botRole === 'number'
          ? profileInfo.botRole
          : inferred.botRole

      const resolved: AuthorDisplayProfile = {
        ...(name ? { name } : {}),
        ...(username ? { username } : {}),
        ...(accountType !== undefined ? { accountType } : {}),
        ...(botRole !== undefined ? { botRole } : {}),
        ...(isBot !== undefined ? { isBot } : {}),
      }

      resolvedTimestamps.set(normalizedKey, Date.now())
      if (hasResolvedFields(resolved)) {
        cachedAuthorProfiles[normalizedKey] = resolved
        return resolved
      }
      return cachedAuthorProfiles[normalizedKey]
    } finally {
      inFlightLookups.delete(normalizedKey)
    }
  })()

  inFlightLookups.set(normalizedKey, lookupPromise)
  return lookupPromise
}

export async function prefetchAuthorDisplayProfiles(
  addresses: Iterable<string | undefined | null>,
): Promise<void> {
  const uniqueAddresses: string[] = []
  const seen = new Set<string>()
  for (const addr of addresses) {
    const key = normalizeAuthorAddressKey(addr)
    if (!key || seen.has(key)) continue
    seen.add(key)
    uniqueAddresses.push((addr as string).trim())
  }
  if (uniqueAddresses.length === 0) return

  for (let i = 0; i < uniqueAddresses.length; i += CONCURRENCY_LIMIT) {
    const chunk = uniqueAddresses.slice(i, i + CONCURRENCY_LIMIT)
    await Promise.all(
      chunk.map(addr => fetchAuthorDisplayProfile(addr).catch(() => undefined)),
    )
  }
}
