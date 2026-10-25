/**
 * The account's own profile, kept in line with the relay.
 *
 * The published profile (name, username, bio, avatar, links) is a fact of the ACCOUNT, and the
 * relay holds it. What this device stores is a copy of it, tagged with the account it belongs
 * to. So every frontend of an account, and one restored later from the seed, shows the same
 * profile, and none of them publishes over another's edit:
 *
 * - The stored copy belongs to one account. When another account is active the copy is dropped
 *   before anything is read from it.
 * - At messaging start the relay is asked for the account's profile. What it holds is adopted
 *   here. A device publishes only what its user typed: an edit made in the profile form that has
 *   not reached the relay yet (the form marks it `unpublished`), or, when the relay holds no
 *   profile for the account at all, the first one (a new account's name, typed at setup; also
 *   what restores the profile on a relay with a fresh database).
 * - If the relay cannot be asked, nothing is published. A device that does not know what the
 *   account's profile is must not replace it.
 * - The profile is presentation, not required restoration: an account opens whether or not the
 *   relay answers. Until it does, {@link ownProfileCheck} names the account, the lookup keeps
 *   being retried, and the profile form does not save (an edit made over an unknown profile
 *   would replace the published one).
 *
 * Two devices that edit: the newer edit wins, by the time each was made (the relay's copy is
 * timed by the signature it was published with). An edit older than what the relay holds is
 * dropped for the relay's; a newer one is published, but only the fields its user changed, over
 * whatever the relay holds now, so it never undoes another device's later change to another
 * field. The other device adopts the result on its next mailbox poll.
 */
import { reactive } from 'vue'
import type { ProfileInfo } from '@frank/wallet/chain'
import {
  fetchMonadProfile,
  registerMonadIdentityCbor,
  type MonadIdentity,
  type MonadProfileFields,
} from '@frank/wallet/evm-identity'
import {
  useProfileStore,
  type State as ProfileState,
} from '../stores/my-profile'
import { compressAvatarDataUrl, isAvatarTooLarge } from './avatar-resize'

type StoredProfile = ProfileState['profile']

/** The part of the profile store this needs: its state, written in place. */
export type OwnProfileStore = ProfileState

export type OwnProfileOutcome =
  /** The relay could not be asked; nothing was read or published. */
  | 'unreachable'
  /** No published profile and no locally entered profile to publish. */
  | 'missing'
  /** The relay's profile is now this device's copy. */
  | 'adopted'
  /** This device's profile was published: an unpublished edit, or the account's first. */
  | 'published'
  /** The relay already holds exactly this device's copy. */
  | 'unchanged'

const sameAddress = (a: string | undefined, b: string): boolean =>
  a !== undefined && a.toLowerCase() === b.toLowerCase()

/** The profile fields a relay entry carries, in the shape the store keeps them. */
function storedProfileOf(published: ProfileInfo): StoredProfile {
  const profile: StoredProfile = {}
  if (published.name) profile.name = published.name
  if (published.username) profile.username = published.username
  if (published.bio) profile.bio = published.bio
  if (published.location) profile.location = published.location
  if (published.avatar) profile.avatar = published.avatar
  if (published.links && published.links.length > 0)
    profile.links = published.links.map(link => ({ ...link }))
  // A relay entry always names an account type; a person (0) is what an unset one means.
  if (published.accountType) profile.accountType = published.accountType
  if (published.botRole !== undefined) profile.botRole = published.botRole
  return profile
}

/** Whether a profile says anything a user typed. */
function hasContent(profile: StoredProfile): boolean {
  return Boolean(
    profile.name ||
      profile.username ||
      profile.bio ||
      profile.location ||
      profile.avatar ||
      (profile.links && profile.links.length > 0),
  )
}

const PROFILE_FIELDS = [
  'name',
  'username',
  'bio',
  'location',
  'avatar',
  'links',
  'accountType',
  'botRole',
] as const

function sameField(
  field: (typeof PROFILE_FIELDS)[number],
  a: StoredProfile,
  b: StoredProfile,
): boolean {
  switch (field) {
    case 'links':
      return JSON.stringify(a.links ?? []) === JSON.stringify(b.links ?? [])
    case 'accountType':
      return (a.accountType ?? 0) === (b.accountType ?? 0)
    case 'botRole':
      return a.botRole === b.botRole
    default:
      return (a[field] ?? '') === (b[field] ?? '')
  }
}

/** `edited` made over `base`, carried onto `latest`: the fields the user changed, and the rest
 * as `latest` has them. */
export function rebaseProfileEdit(
  base: StoredProfile,
  edited: StoredProfile,
  latest: StoredProfile,
): StoredProfile {
  const result: StoredProfile = {}
  for (const field of PROFILE_FIELDS) {
    const from = sameField(field, base, edited) ? latest : edited
    const value = from[field]
    if (value !== undefined)
      (result as Record<string, unknown>)[field] = Array.isArray(value)
        ? value.map(link => ({ ...link }))
        : value
  }
  return result
}

function sameProfile(a: StoredProfile, b: StoredProfile): boolean {
  return (
    (a.name ?? '') === (b.name ?? '') &&
    (a.username ?? '') === (b.username ?? '') &&
    (a.bio ?? '') === (b.bio ?? '') &&
    (a.location ?? '') === (b.location ?? '') &&
    (a.avatar ?? '') === (b.avatar ?? '') &&
    (a.accountType ?? 0) === (b.accountType ?? 0) &&
    a.botRole === b.botRole &&
    JSON.stringify(a.links ?? []) === JSON.stringify(b.links ?? [])
  )
}

/**
 * Makes the stored profile the copy of `address`'s. A copy that belongs to another account (or
 * to none: stored before copies were tagged) is dropped, with everything else the store kept
 * for that account.
 */
export function claimProfileStore(
  store: OwnProfileStore,
  address: string,
): void {
  if (sameAddress(store.owner, address)) return
  store.profile = {}
  store.inbox = {}
  store.emailBridgeGatewayAddress = undefined
  store.unpublished = false
  store.editedAt = undefined
  store.base = undefined
  store.restoredAccountId = undefined
  store.owner = address.toLowerCase()
}

/**
 * Brings this device's copy of the account's profile and the relay's in line; see the file
 * header for the rule. `fetchPublished` resolves to `undefined` when the relay holds no entry
 * for the account and rejects when it could not be asked.
 */
export async function syncOwnProfile(options: {
  store: OwnProfileStore
  address: string
  fetchPublished: () => Promise<ProfileInfo | undefined>
  publish: (profile: StoredProfile) => Promise<void>
  isCancelled?: () => boolean
}): Promise<OwnProfileOutcome> {
  const { store, address } = options
  if (options.isCancelled?.()) return 'unreachable'
  claimProfileStore(store, address)
  let published: ProfileInfo | undefined
  try {
    published = await options.fetchPublished()
  } catch {
    return 'unreachable'
  }
  // The account changed while the relay was being asked: this answer is not for the copy that
  // is stored now.
  if (options.isCancelled?.() || !sameAddress(store.owner, address))
    return 'unreachable'
  const relayProfile = published ? storedProfileOf(published) : {}
  const relayHasProfile = hasContent(relayProfile)

  if (!relayHasProfile && !hasContent(store.profile)) return 'missing'

  const publishedAt = published?.publishedAtMs
  const adopt = (): OwnProfileOutcome => {
    store.base = { ...relayProfile }
    if (sameProfile(store.profile, relayProfile)) return 'unchanged'
    store.profile = relayProfile
    return 'adopted'
  }

  if (relayHasProfile && !store.unpublished) return adopt()

  // An edit made here before the profile the relay holds was published (on another device) is
  // the older one: the relay's replaces it.
  if (
    relayHasProfile &&
    publishedAt !== undefined &&
    store.editedAt !== undefined &&
    publishedAt > store.editedAt
  ) {
    store.unpublished = false
    store.editedAt = undefined
    return adopt()
  }

  // From here this device publishes: its user's edit, or the first profile the relay is given
  // for this account. Only what the user changed is theirs to publish; the other fields are
  // what the relay holds now.
  // (The relay holding something other than what the edit was made over means another device
  // published since.)
  if (relayHasProfile && store.base && !sameProfile(store.base, relayProfile)) {
    store.profile = rebaseProfileEdit(store.base, store.profile, relayProfile)
    store.base = { ...relayProfile }
  }
  if (published && sameProfile(store.profile, relayProfile)) {
    store.unpublished = false
    store.editedAt = undefined
    store.base = { ...relayProfile }
    return 'unchanged'
  }
  const sent = { ...store.profile }
  await options.publish(sent)
  if (options.isCancelled?.() || !sameAddress(store.owner, address))
    return 'unreachable'
  // An edit made while this one was on its way is still unpublished.
  if (sameProfile(store.profile, sent)) {
    store.unpublished = false
    store.editedAt = undefined
    store.base = { ...sent }
  }
  return 'published'
}

/**
 * The account whose published profile the relay has not answered for yet (lowercase address),
 * or `null`. Set when a restore lookup could not reach the relay; cleared when one is answered.
 * Shown to the user as a non-blocking notice; the profile form does not save while it names
 * the form's account.
 */
export const ownProfileCheck = reactive<{ unchecked: string | null }>({
  unchecked: null,
})

/** Recover presentation after custody activation. This read never publishes a local copy. */
export async function restoreOwnProfileWithRelay(options: {
  relayBaseUrl: string
  identity: MonadIdentity
  isCancelled?: () => boolean
}): Promise<'adopted' | 'missing' | 'unreachable'> {
  const store = useProfileStore()
  await store.restored
  if (options.isCancelled?.()) return 'unreachable'
  const address = options.identity.address.raw
  claimProfileStore(store, address)
  let published: ProfileInfo | undefined
  try {
    published = await fetchMonadProfile({
      relayBaseUrl: options.relayBaseUrl,
      address: options.identity.address,
      signal: AbortSignal.timeout(PROFILE_RELAY_TIMEOUT_MS),
    })
  } catch {
    if (!options.isCancelled?.() && sameAddress(store.owner, address))
      ownProfileCheck.unchecked = address.toLowerCase()
    return 'unreachable'
  }
  if (options.isCancelled?.() || !sameAddress(store.owner, address))
    return 'unreachable'
  if (sameAddress(ownProfileCheck.unchecked ?? undefined, address))
    ownProfileCheck.unchecked = null
  if (!published) {
    store.profile = {}
    store.unpublished = false
    store.base = undefined
    return 'missing'
  }
  store.profile = storedProfileOf(published)
  store.unpublished = false
  store.editedAt = undefined
  store.base = { ...store.profile }
  return hasContent(store.profile) ? 'adopted' : 'missing'
}

/** The wait before retry `attempt` (0-based) of an unanswered profile lookup: doubling, capped. */
export function profileRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 60_000)
}

/**
 * Retries {@link restoreOwnProfileWithRelay} until the relay answers or `isCancelled` (the
 * account was switched or closed). Resolves to the answer, or `undefined` when cancelled.
 */
export async function keepRestoringOwnProfile(options: {
  relayBaseUrl: string
  identity: MonadIdentity
  isCancelled: () => boolean
  onAnswered?: (outcome: 'adopted' | 'missing') => void
  retryDelayMs?: (attempt: number) => number
}): Promise<'adopted' | 'missing' | undefined> {
  const delay = options.retryDelayMs ?? profileRetryDelayMs
  for (let attempt = 0; ; attempt++) {
    await new Promise(resolve => setTimeout(resolve, delay(attempt)))
    if (options.isCancelled()) return undefined
    const outcome = await restoreOwnProfileWithRelay(options)
    if (options.isCancelled()) return undefined
    if (outcome !== 'unreachable') {
      options.onAnswered?.(outcome)
      return outcome
    }
  }
}

/**
 * Restores a recovered account's profile while the account opens. Never fails the opening: a
 * lookup the relay does not answer is retried in the background (and the account is named in
 * {@link ownProfileCheck} meanwhile). `background` does not wait for the first lookup.
 */
export async function restoreOwnProfileAtStartup(options: {
  relayBaseUrl: string
  identity: MonadIdentity
  accountId: string
  isCancelled: () => boolean
  background?: boolean
  retryDelayMs?: (attempt: number) => number
}): Promise<void> {
  let store: ReturnType<typeof useProfileStore>
  try {
    store = useProfileStore()
    await store.restored
  } catch {
    // A host without the profile store has no profile to restore.
    return
  }
  const address = options.identity.address.raw
  if (
    store.restoredAccountId === options.accountId &&
    sameAddress(store.owner, address)
  )
    return
  const markRestored = () => {
    if (sameAddress(store.owner, address))
      store.restoredAccountId = options.accountId
  }
  const keepTrying = () =>
    void keepRestoringOwnProfile({
      ...options,
      onAnswered: options.background ? undefined : markRestored,
    }).catch(() => undefined)
  if (options.background) {
    claimProfileStore(store, address)
    markRestored()
    void restoreOwnProfileWithRelay(options).then(
      outcome => {
        if (outcome === 'unreachable' && !options.isCancelled()) keepTrying()
      },
      () => undefined,
    )
    return
  }
  const outcome = await restoreOwnProfileWithRelay(options)
  if (options.isCancelled()) return
  if (outcome === 'unreachable') keepTrying()
  else markRestored()
}

// Serialise publishes for one account only. A stalled old account must not hold up the new
// account's messaging activation. Entries are removed as soon as the account's last run ends.
const relaySyncs = new Map<string, Promise<OwnProfileOutcome | undefined>>()
export const PROFILE_RELAY_TIMEOUT_MS = 10_000

/**
 * {@link syncOwnProfile} for the app's profile store and the account's relay. One run per account at a time:
 * a second run reads what the first one stored. Rejects only when publishing was refused or
 * failed; resolves to `undefined` where there is no profile store (a non-Vue host).
 */
export async function syncOwnProfileWithRelay(options: {
  relayBaseUrl: string
  identity: MonadIdentity
  network?: string
  isCancelled?: () => boolean
  signal?: AbortSignal
}): Promise<OwnProfileOutcome | undefined> {
  const { relayBaseUrl, identity, network } = options
  let store: ReturnType<typeof useProfileStore>
  try {
    store = useProfileStore()
  } catch {
    return undefined
  }
  await store.restored
  if (options.isCancelled?.() || options.signal?.aborted) return undefined
  // Claim before waiting for this account's queue or asking the relay: an old account's
  // profile must never be presented as the active account's while the network is unavailable.
  claimProfileStore(store, identity.address.raw)
  const owner = identity.address.raw.toLowerCase()
  const run = async (): Promise<OwnProfileOutcome | undefined> => {
    if (
      options.isCancelled?.() ||
      options.signal?.aborted ||
      store.owner !== owner
    )
      return undefined
    const deadline = AbortSignal.timeout(PROFILE_RELAY_TIMEOUT_MS)
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline
    return syncOwnProfile({
      store,
      isCancelled: () => options.isCancelled?.() === true || signal.aborted,
      address: identity.address.raw,
      fetchPublished: () =>
        fetchMonadProfile({ relayBaseUrl, address: identity.address, signal }),
      publish: async profile => {
        // The relay refuses an avatar over its size limit: a smaller one, or none, is sent.
        let avatar = profile.avatar
        if (avatar && isAvatarTooLarge(avatar)) {
          try {
            const compressed = await compressAvatarDataUrl(avatar)
            avatar =
              compressed && !isAvatarTooLarge(compressed)
                ? compressed
                : undefined
          } catch {
            avatar = undefined
          }
        }
        if (signal.aborted || options.isCancelled?.() || store.owner !== owner)
          return
        await registerMonadIdentityCbor({
          relayBaseUrl,
          signal,
          identity,
          profile: { ...profile, avatar } as MonadProfileFields,
          network,
        })
      },
    })
  }
  const previous = relaySyncs.get(owner)
  const next = (previous ?? Promise.resolve()).then(run, run)
  relaySyncs.set(owner, next)
  try {
    return await next
  } finally {
    if (relaySyncs.get(owner) === next) relaySyncs.delete(owner)
  }
}
