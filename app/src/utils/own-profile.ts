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
 *
 * Two devices that edit at the same time: the relay keeps the later publish, and the other
 * device adopts it on its next mailbox poll.
 */
import type { ProfileInfo } from '@frank/wallet/chain'
import {
  fetchMonadProfile,
  registerMonadIdentityCbor,
  type MonadIdentity,
  type MonadProfileFields,
} from '@frank/wallet/monad-identity'
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

  if (relayHasProfile && !store.unpublished) {
    if (sameProfile(store.profile, relayProfile)) return 'unchanged'
    store.profile = relayProfile
    return 'adopted'
  }

  // From here this device publishes: its user's edit, or the first profile the relay is given
  // for this account.
  if (published && sameProfile(store.profile, relayProfile)) {
    store.unpublished = false
    return 'unchanged'
  }
  const sent = { ...store.profile }
  await options.publish(sent)
  if (options.isCancelled?.() || !sameAddress(store.owner, address))
    return 'unreachable'
  // An edit made while this one was on its way is still unpublished.
  if (sameProfile(store.profile, sent)) store.unpublished = false
  return 'published'
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
