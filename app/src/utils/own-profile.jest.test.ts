/** @jest-environment node */

/**
 * Two frontends of one account agree on the account's profile, and neither can wipe it.
 *
 * Each "device" is its own profile store. The same cases run twice:
 *
 * - always, with the relay narrowed to the two calls the rule makes (read the account's entry,
 *   publish one), held in a variable: this checks the rule;
 * - against a REAL relay (the cashwebd binary) when `FRANK_LIVE_RELAY_URL` names a running one,
 *   through the app's own `syncOwnProfileWithRelay`, with a new account each run:
 *     FRANK_LIVE_RELAY_URL=http://127.0.0.1:<port> \
 *       yarn --cwd app jest src/utils/own-profile.jest.test.ts
 *   Nothing is paid: a profile is a signed directory statement, not a message.
 */
import { randomBytes } from 'crypto'
import { createPinia, setActivePinia, type Pinia } from 'pinia'

import type { ProfileInfo } from '@frank/wallet/chain'
import {
  MonadIdentity,
  fetchMonadProfile,
  type MonadProfileFields,
} from '@frank/wallet/monad-identity'

import { useProfileStore } from '../stores/my-profile'
import {
  claimProfileStore,
  syncOwnProfile,
  syncOwnProfileWithRelay,
  type OwnProfileOutcome,
} from './own-profile'

jest.mock('./avatar-resize', () => ({
  isAvatarTooLarge: () => false,
  compressAvatarDataUrl: async (avatar: string) => avatar,
}))

const LIVE = process.env.FRANK_LIVE_RELAY_URL
const NETWORK = 'monad-testnet'

interface Relay {
  name: string
  /** What the relay holds for the account now. */
  published(identity: MonadIdentity): Promise<MonadProfileFields | undefined>
  /** One run of the rule for `store`, as the app runs it at messaging start. */
  sync(
    store: ReturnType<typeof useProfileStore>,
    identity: MonadIdentity,
    pinia: Pinia,
  ): Promise<OwnProfileOutcome | undefined>
  /** The same, with the relay out of reach. */
  syncUnreachable(
    store: ReturnType<typeof useProfileStore>,
    identity: MonadIdentity,
    pinia: Pinia,
  ): Promise<OwnProfileOutcome | undefined>
  /** How many profiles were published since the last call. */
  takePublishes(): number
}

function seamRelay(): Relay {
  const held = new Map<string, MonadProfileFields>()
  let publishes = 0
  return {
    name: 'the rule, relay narrowed to read and publish',
    published: async identity => held.get(identity.address.raw),
    sync: (store, identity) =>
      syncOwnProfile({
        store,
        address: identity.address.raw,
        fetchPublished: async () => {
          const profile = held.get(identity.address.raw)
          return profile === undefined
            ? undefined
            : ({
                address: identity.address,
                pubKey: new Uint8Array(33),
                // What a relay entry always says, whatever was published.
                accountType: 0,
                ...profile,
              } as ProfileInfo)
        },
        publish: async profile => {
          publishes += 1
          held.set(identity.address.raw, JSON.parse(JSON.stringify(profile)))
        },
      }),
    syncUnreachable: (store, identity) =>
      syncOwnProfile({
        store,
        address: identity.address.raw,
        fetchPublished: async () => {
          throw new Error('connect ECONNREFUSED')
        },
        publish: async () => {
          publishes += 1
        },
      }),
    takePublishes: () => {
      const count = publishes
      publishes = 0
      return count
    },
  }
}

function liveRelay(relayBaseUrl: string): Relay {
  let puts = 0
  // The app publishes with axios; count the PUTs it makes to the relay's metadata route.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const axios = require('axios')
  axios.interceptors.request.use((config: { method?: string }) => {
    if (config.method?.toLowerCase() === 'put') puts += 1
    return config
  })
  return {
    name: `the real relay at ${relayBaseUrl}`,
    published: identity =>
      fetchMonadProfile({ relayBaseUrl, address: identity.address }),
    sync: async (_store, identity, pinia) => {
      setActivePinia(pinia)
      return syncOwnProfileWithRelay({
        relayBaseUrl,
        identity,
        network: NETWORK,
      })
    },
    syncUnreachable: async (_store, identity, pinia) => {
      setActivePinia(pinia)
      return syncOwnProfileWithRelay({
        // A port nothing listens on.
        relayBaseUrl: 'http://127.0.0.1:9',
        identity,
        network: NETWORK,
      })
    },
    takePublishes: () => {
      const count = puts
      puts = 0
      return count
    },
  }
}

function device() {
  const pinia = createPinia()
  setActivePinia(pinia)
  return { pinia, store: useProfileStore(pinia) }
}

/** What Setup does with the name typed there. */
function nameAtSetup(
  store: ReturnType<typeof useProfileStore>,
  identity: MonadIdentity,
  name: string,
): void {
  claimProfileStore(store, identity.address.raw)
  if (!store.profile.name) store.profile = { ...store.profile, name }
}

/** What the profile form does on Save, up to the point the relay is told. */
function editInForm(
  store: ReturnType<typeof useProfileStore>,
  profile: MonadProfileFields,
): void {
  store.setRelayData({ profile: { ...profile }, inbox: {} })
}

const relays: Relay[] = [seamRelay(), ...(LIVE ? [liveRelay(LIVE)] : [])]

describe.each(relays)('the account profile on two devices: $name', relay => {
  let identity: MonadIdentity
  beforeEach(() => {
    identity = MonadIdentity.fromPrivateKeyHex(randomBytes(32).toString('hex'))
    relay.takePublishes()
  })

  it('a new account publishes the name typed at setup, once', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('published')
    expect((await relay.published(identity))?.name).toBe('Ada')
    expect(relay.takePublishes()).toBe(1)

    // Every later start reads the same profile back and publishes nothing.
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('unchanged')
    expect(relay.takePublishes()).toBe(0)
    expect(one.store.profile.name).toBe('Ada')
  })

  it('a device restored from the seed adopts the published profile and publishes nothing', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    await relay.sync(one.store, identity, one.pinia)
    editInForm(one.store, {
      name: 'Ada Lovelace',
      bio: 'Analytical engines',
      location: 'London',
      links: [{ type: 'web', url: 'https://example.org/ada' }],
    })
    expect(one.store.unpublished).toBe(true)
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('published')
    expect(one.store.unpublished).toBe(false)
    relay.takePublishes()

    // The restored device: an empty store, and a different name typed at setup.
    const two = device()
    nameAtSetup(two.store, identity, 'My phone')
    expect(await relay.sync(two.store, identity, two.pinia)).toBe('adopted')
    expect(relay.takePublishes()).toBe(0)
    expect(two.store.profile).toMatchObject({
      name: 'Ada Lovelace',
      bio: 'Analytical engines',
      location: 'London',
      links: [{ type: 'web', url: 'https://example.org/ada' }],
    })
    // The account's profile is what it was.
    expect(await relay.published(identity)).toMatchObject({
      name: 'Ada Lovelace',
      bio: 'Analytical engines',
      location: 'London',
    })
    // Both devices hold the same profile.
    expect(two.store.profile).toEqual(one.store.profile)
  })

  it('a restored device with nothing stored at all does not publish an empty profile', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    await relay.sync(one.store, identity, one.pinia)
    relay.takePublishes()

    const two = device()
    expect(two.store.profile).toEqual({})
    expect(await relay.sync(two.store, identity, two.pinia)).toBe('adopted')
    expect(relay.takePublishes()).toBe(0)
    expect((await relay.published(identity))?.name).toBe('Ada')
    expect(two.store.profile.name).toBe('Ada')
    expect(two.store.owner).toBe(identity.address.raw.toLowerCase())
  })

  it('an edit on one device reaches the other, in both directions, and repeating changes nothing', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    await relay.sync(one.store, identity, one.pinia)
    const two = device()
    await relay.sync(two.store, identity, two.pinia)

    editInForm(two.store, { name: 'Ada', bio: 'From the second device' })
    expect(await relay.sync(two.store, identity, two.pinia)).toBe('published')
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('adopted')
    expect(one.store.profile.bio).toBe('From the second device')

    editInForm(one.store, { name: 'Ada L.', bio: 'From the first device' })
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('published')
    expect(await relay.sync(two.store, identity, two.pinia)).toBe('adopted')
    expect(two.store.profile).toEqual(one.store.profile)

    relay.takePublishes()
    for (const each of [one, two, two, one])
      expect(await relay.sync(each.store, identity, each.pinia)).toBe(
        'unchanged',
      )
    expect(relay.takePublishes()).toBe(0)
    expect(two.store.profile).toEqual(one.store.profile)
  })

  it('a relay that cannot be asked is not published to, and the stored copy stays', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    await relay.sync(one.store, identity, one.pinia)
    relay.takePublishes()

    const two = device()
    nameAtSetup(two.store, identity, 'My phone')
    expect(await relay.syncUnreachable(two.store, identity, two.pinia)).toBe(
      'unreachable',
    )
    expect(relay.takePublishes()).toBe(0)
    expect(two.store.profile.name).toBe('My phone')
    // Once it can be asked, the account's profile replaces the placeholder.
    expect(await relay.sync(two.store, identity, two.pinia)).toBe('adopted')
    expect(two.store.profile.name).toBe('Ada')
    expect((await relay.published(identity))?.name).toBe('Ada')
  })

  it('the stored profile of one account is never shown or published for another', async () => {
    const one = device()
    nameAtSetup(one.store, identity, 'Ada')
    editInForm(one.store, { name: 'Ada', bio: 'First account' })
    one.store.inbox = { acceptancePrice: 5 }
    await relay.sync(one.store, identity, one.pinia)
    relay.takePublishes()

    // Another account becomes active on the same device (the same store).
    const other = MonadIdentity.fromPrivateKeyHex(
      randomBytes(32).toString('hex'),
    )
    await relay.sync(one.store, other, one.pinia)
    expect(one.store.owner).toBe(other.address.raw.toLowerCase())
    expect(one.store.profile.name).toBeUndefined()
    expect(one.store.profile.bio).toBeUndefined()
    expect(one.store.inbox).toEqual({})
    const publishedForOther = await relay.published(other)
    expect(publishedForOther?.name).toBeUndefined()
    expect(publishedForOther?.bio).toBeUndefined()
    // The first account's profile is still the relay's, and comes back with the account.
    expect(await relay.sync(one.store, identity, one.pinia)).toBe('adopted')
    expect(one.store.profile).toMatchObject({
      name: 'Ada',
      bio: 'First account',
    })
  })
})

it('an edit made while the publish was on its way stays unpublished', async () => {
  const one = device()
  const identity = MonadIdentity.fromPrivateKeyHex(
    randomBytes(32).toString('hex'),
  )
  claimProfileStore(one.store, identity.address.raw)
  editInForm(one.store, { name: 'Ada' })
  await syncOwnProfile({
    store: one.store,
    address: identity.address.raw,
    fetchPublished: async () => undefined,
    publish: async () => {
      editInForm(one.store, { name: 'Ada Lovelace' })
    },
  })
  expect(one.store.unpublished).toBe(true)
  expect(one.store.profile.name).toBe('Ada Lovelace')
})

it('a stopped session cannot adopt or publish a profile after its read finishes', async () => {
  const one = device()
  const identity = MonadIdentity.generate()
  claimProfileStore(one.store, identity.address.raw)
  one.store.profile = { name: 'Local copy' }
  let stopped = false
  const publish = jest.fn(async () => undefined)
  const outcome = await syncOwnProfile({
    store: one.store,
    address: identity.address.raw,
    isCancelled: () => stopped,
    fetchPublished: async () => {
      stopped = true
      return { name: 'Other device edit', accountType: 0 } as ProfileInfo
    },
    publish,
  })
  expect(outcome).toBe('unreachable')
  expect(one.store.profile.name).toBe('Local copy')
  expect(publish).not.toHaveBeenCalled()
})

it('a queued refresh of a stopped session cannot reclaim another account profile store', async () => {
  const one = device()
  const previous = MonadIdentity.generate()
  const current = MonadIdentity.generate()
  claimProfileStore(one.store, current.address.raw)
  one.store.profile = { name: 'Current account' }
  const fetchPublished = jest.fn(async () => undefined)
  expect(
    await syncOwnProfile({
      store: one.store,
      address: previous.address.raw,
      isCancelled: () => true,
      fetchPublished,
      publish: async () => undefined,
    }),
  ).toBe('unreachable')
  expect(one.store.owner).toBe(current.address.raw.toLowerCase())
  expect(one.store.profile.name).toBe('Current account')
  expect(fetchPublished).not.toHaveBeenCalled()
})
