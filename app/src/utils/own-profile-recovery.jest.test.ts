/** @jest-environment node */
import { createPinia, setActivePinia } from 'pinia'
import * as identityApi from '@frank/wallet/evm-identity'
import { useProfileStore } from '../stores/my-profile'
import { restoreOwnProfileWithRelay, syncOwnProfile } from './own-profile'

const identity = identityApi.MonadIdentity.fromPrivateKeyHex(
  '0x' + '01'.repeat(32),
)

beforeEach(() => setActivePinia(createPinia()))
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
