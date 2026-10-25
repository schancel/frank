/** @jest-environment node */
import { createPinia, setActivePinia } from 'pinia'
import * as identityApi from '@frank/wallet/evm-identity'
import { useProfileStore } from '../stores/my-profile'
import {
  keepRestoringOwnProfile,
  ownProfileCheck,
  restoreOwnProfileAtStartup,
  restoreOwnProfileWithRelay,
  syncOwnProfile,
} from './own-profile'

const identity = identityApi.MonadIdentity.fromPrivateKeyHex(
  '0x' + '01'.repeat(32),
)

beforeEach(() => {
  setActivePinia(createPinia())
  ownProfileCheck.unchecked = null
})
afterEach(() => jest.restoreAllMocks())

test.each(['existing', 'missing', 'unreachable'] as const)(
  'recovery reads an %s profile without publishing over it',
  async situation => {
    const fetch = jest.spyOn(identityApi, 'fetchMonadProfile')
    const publish = jest
      .spyOn(identityApi, 'registerMonadIdentityCbor')
      .mockResolvedValue(undefined)
    if (situation === 'existing')
      fetch.mockResolvedValue({
        address: identity.address,
        pubKey: identity.compressedPubKey,
        name: 'Published name',
        bio: 'Published bio',
      })
    else if (situation === 'missing') fetch.mockResolvedValue(undefined)
    else fetch.mockRejectedValue(new Error('Relay unavailable'))
    const store = useProfileStore()
    store.owner = identity.address.raw.toLowerCase()
    store.profile = { name: 'Stale local edit' }
    store.unpublished = true
    const result = await restoreOwnProfileWithRelay({
      relayBaseUrl: 'https://relay.example',
      identity,
    })
    expect(result).toBe(situation === 'existing' ? 'adopted' : situation)
    expect(publish).not.toHaveBeenCalled()
    if (situation === 'existing') {
      expect(store.profile).toEqual({
        name: 'Published name',
        bio: 'Published bio',
      })
      expect(store.unpublished).toBe(false)
    } else if (situation === 'missing') {
      expect(store.profile).toEqual({})
      expect(store.unpublished).toBe(false)
    } else {
      expect(store.profile.name).toBe('Stale local edit')
      expect(store.unpublished).toBe(true)
    }
  },
)

test('messaging cannot publish an empty profile before recovered-account profile setup', async () => {
  const store = useProfileStore()
  const publish = jest.fn()
  expect(
    await syncOwnProfile({
      store,
      address: identity.address.raw,
      fetchPublished: async () => undefined,
      publish,
    }),
  ).toBe('missing')
  expect(publish).not.toHaveBeenCalled()
})

test('late profile recovery cannot replace another account copy', async () => {
  let finish!: (profile: undefined) => void
  jest.spyOn(identityApi, 'fetchMonadProfile').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  const recovering = restoreOwnProfileWithRelay({
    relayBaseUrl: 'https://relay.example',
    identity,
  })
  await Promise.resolve()
  const store = useProfileStore()
  store.owner = 'another-account'
  store.profile = { name: 'Another account' }
  finish(undefined)
  expect(await recovering).toBe('unreachable')
  expect(store.profile.name).toBe('Another account')
})

test('claimProfileStore preserves restoredAccountId for the same owner and clears it on owner switch', async () => {
  const { claimProfileStore } = await import('./own-profile')
  const store = useProfileStore()
  store.owner = identity.address.raw.toLowerCase()
  store.restoredAccountId = 'account-1'
  claimProfileStore(store, identity.address.raw)
  expect(store.restoredAccountId).toBe('account-1')

  claimProfileStore(store, '0x' + '22'.repeat(20))
  expect(store.restoredAccountId).toBeUndefined()
})

const published = (name: string) => ({
  address: identity.address,
  pubKey: identity.compressedPubKey,
  name,
})
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++)
    await new Promise(resolve => setTimeout(resolve, 1))
  expect(condition()).toBe(true)
}

test('an unanswered lookup at startup opens the account and adopts the profile once the relay answers', async () => {
  const publish = jest.spyOn(identityApi, 'registerMonadIdentityCbor')
  const fetch = jest
    .spyOn(identityApi, 'fetchMonadProfile')
    .mockRejectedValueOnce(new Error('timeout'))
    .mockRejectedValueOnce(new Error('502'))
    .mockResolvedValueOnce(published('Published name'))
  const store = useProfileStore()
  // Resolves: the opening is not held back by the relay.
  await restoreOwnProfileAtStartup({
    relayBaseUrl: 'https://relay.example',
    identity,
    accountId: 'account-1',
    isCancelled: () => false,
    retryDelayMs: () => 0,
  })
  expect(ownProfileCheck.unchecked).toBe(identity.address.raw.toLowerCase())
  expect(store.restoredAccountId).toBeUndefined()
  await until(() => store.profile.name === 'Published name')
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(ownProfileCheck.unchecked).toBeNull()
  expect(store.restoredAccountId).toBe('account-1')
  expect(store.unpublished).toBe(false)
  expect(publish).not.toHaveBeenCalled()
})

test('a relay with no profile opens the account with none and asks nothing more', async () => {
  const publish = jest.spyOn(identityApi, 'registerMonadIdentityCbor')
  const fetch = jest
    .spyOn(identityApi, 'fetchMonadProfile')
    .mockResolvedValue(undefined)
  const store = useProfileStore()
  await restoreOwnProfileAtStartup({
    relayBaseUrl: 'https://relay.example',
    identity,
    accountId: 'account-1',
    isCancelled: () => false,
    retryDelayMs: () => 0,
  })
  expect(store.profile).toEqual({})
  expect(store.restoredAccountId).toBe('account-1')
  expect(ownProfileCheck.unchecked).toBeNull()
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(publish).not.toHaveBeenCalled()
})

test('an unanswered lookup never publishes the local copy, from restore or from messaging', async () => {
  const publish = jest
    .spyOn(identityApi, 'registerMonadIdentityCbor')
    .mockResolvedValue(undefined)
  jest
    .spyOn(identityApi, 'fetchMonadProfile')
    .mockRejectedValue(new Error('relay down'))
  const store = useProfileStore()
  store.owner = identity.address.raw.toLowerCase()
  store.profile = { name: 'Local copy' }
  let cancelled = false
  await restoreOwnProfileAtStartup({
    relayBaseUrl: 'https://relay.example',
    identity,
    accountId: 'account-1',
    isCancelled: () => cancelled,
    retryDelayMs: () => 0,
  })
  const syncPublish = jest.fn()
  expect(
    await syncOwnProfile({
      store,
      address: identity.address.raw,
      fetchPublished: () => Promise.reject(new Error('relay down')),
      publish: syncPublish,
    }),
  ).toBe('unreachable')
  await new Promise(resolve => setTimeout(resolve, 5))
  cancelled = true
  expect(publish).not.toHaveBeenCalled()
  expect(syncPublish).not.toHaveBeenCalled()
  expect(store.profile).toEqual({ name: 'Local copy' })
  expect(ownProfileCheck.unchecked).toBe(identity.address.raw.toLowerCase())
})

test('background retries stop when the account is switched', async () => {
  const fetch = jest
    .spyOn(identityApi, 'fetchMonadProfile')
    .mockRejectedValue(new Error('relay down'))
  let cancelled = false
  const retrying = keepRestoringOwnProfile({
    relayBaseUrl: 'https://relay.example',
    identity,
    isCancelled: () => cancelled,
    retryDelayMs: () => 1,
  })
  await until(() => fetch.mock.calls.length >= 2)
  cancelled = true
  expect(await retrying).toBeUndefined()
  const calls = fetch.mock.calls.length
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(fetch.mock.calls.length).toBe(calls)
})

test('profile retries back off to a bounded delay', async () => {
  const { profileRetryDelayMs } = await import('./own-profile')
  expect(profileRetryDelayMs(0)).toBe(2_000)
  expect(profileRetryDelayMs(1)).toBe(4_000)
  expect(profileRetryDelayMs(20)).toBe(60_000)
})
