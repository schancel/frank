/** @jest-environment node */
import { createHash } from 'crypto'
import axios from 'axios'
import { createPinia, setActivePinia } from 'pinia'
import * as identityApi from '@frank/wallet/evm-identity'
import { useProfileStore } from '../stores/my-profile'
import { ownProfileCheck, syncOwnProfileWithRelay } from './own-profile'

jest.mock('axios', () => {
  const actual = jest.requireActual('axios')
  return {
    __esModule: true,
    default: Object.assign(jest.fn(), { isAxiosError: actual.isAxiosError }),
  }
})
jest.mock('./avatar-resize', () => ({
  isAvatarTooLarge: () => false,
  compressAvatarDataUrl: async (avatar: string) => avatar,
}))

const request = axios as unknown as jest.Mock
const identity = identityApi.MonadIdentity.fromPrivateKeyHex(
  '0x' + '01'.repeat(32),
)
const relayBaseUrl = 'https://relay.example'
const network = 'monad-testnet'
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status },
  })
const binding = {
  relayId: new Uint8Array(16).fill(1),
  endpoint: relayBaseUrl,
  identityKey: identity.compressedPubKey,
  expiry: { seconds: 4_000_000_000n, nanoseconds: 0 },
}
const info = {
  network,
  relayId: '01'.repeat(16),
  endpoint: relayBaseUrl,
  relayKey: Buffer.from(identity.compressedPubKey).toString('hex'),
  bindingExpiry: '4000000000000000000',
}
const raw = (
  profile: identityApi.MonadProfileFields,
  timestampMs = Date.now() - 1_000,
  ttlMs?: number,
) =>
  identityApi.buildSignedDirectoryStatement(identity, {
    network,
    relay: binding,
    profile,
    timestampMs,
    ttlMs,
  })
const response = (data: unknown) => ({ data, status: 200, headers: {} })
const metadataGet = (call: { method: string; url: string }) =>
  call.method === 'get' && call.url.includes('/metadata/')

beforeEach(() => {
  setActivePinia(createPinia())
  ownProfileCheck.unchecked = null
  request.mockReset()
})
afterEach(() => jest.restoreAllMocks())

function retained() {
  const store = useProfileStore()
  store.owner = identity.address.raw.toLowerCase()
  store.profile = { name: 'Retained old name', bio: 'Retained old bio' }
  store.base = { ...store.profile }
  store.unpublished = false
  return store
}

it('a later saved edit survives an older in-flight publication and its queued read', async () => {
  const store = retained()
  const firstFields = { ...store.profile }
  const laterFields = { name: 'Later saved name', bio: 'Later saved bio' }
  const startedAt = 1_800_000_000_000
  let now = startedAt
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  let announceBinding!: () => void
  let releaseBinding!: () => void
  const bindingStarted = new Promise<void>(resolve => {
    announceBinding = resolve
  })
  const bindingReleased = new Promise<void>(resolve => {
    releaseBinding = resolve
  })
  let remote: Uint8Array | undefined
  const writes: Uint8Array[] = []
  let reads = 0
  let bindings = 0
  request.mockImplementation(async call => {
    if (metadataGet(call)) {
      reads++
      if (!remote) throw httpError(404)
      if (reads === 2) {
        // The older publication completed, but only its sent copy is published.
        expect(store.profile).toEqual(laterFields)
        expect(store.unpublished).toBe(true)
        expect(store.editedAt).toBe(startedAt + 1_000)
      }
      return response(remote)
    }
    if (call.method === 'get') {
      if (++bindings === 1) {
        announceBinding()
        await bindingReleased
      }
      return response(info)
    }
    if (!remote) {
      expect(call.headers['If-None-Match']).toBe('*')
      expect(call.headers['If-Match']).toBeUndefined()
      expect(store.profile).toEqual(laterFields)
      expect(store.unpublished).toBe(true)
    } else {
      expect(call.headers['If-Match']).toBe(`"${digest(remote)}"`)
      expect(call.headers['If-None-Match']).toBeUndefined()
    }
    const bytes = new Uint8Array(call.data)
    const decoded = identityApi.decodeProfileBytes(bytes)
    expect(decoded.derivedAddress.toLowerCase()).toBe(store.owner)
    expect(decoded.network).toBe(network)
    expect(decoded.pubKey).toEqual(identity.compressedPubKey)
    writes.push(bytes)
    remote = bytes
    return response({})
  })

  const earlier = syncOwnProfileWithRelay({ relayBaseUrl, identity, network })
  await bindingStarted
  expect(ownProfileCheck.unchecked).toBeNull()
  now = startedAt + 1_000
  store.setRelayData({ profile: laterFields, inbox: store.inbox })
  expect(store.base).toEqual(firstFields)
  expect(store.editedAt).toBe(now)
  const queued = syncOwnProfileWithRelay({ relayBaseUrl, identity, network })
  now = startedAt + 2_000
  releaseBinding()
  const outcomes = await Promise.all([earlier, queued])

  // This is the visible lost-edit regression, before timestamp assertions.
  expect(store.profile).toEqual(laterFields)
  const published = identityApi.decodeProfileBytes(remote!)
  expect([published.name, published.bio]).toEqual([
    laterFields.name,
    laterFields.bio,
  ])
  expect(outcomes).toEqual(['published', 'published'])
  expect(store.unpublished).toBe(false)
  expect(store.editedAt).toBeUndefined()
  expect(store.base).toEqual(laterFields)
  expect(writes).toHaveLength(2)
  const first = identityApi.decodeProfileBytes(writes[0])
  expect([first.name, first.bio]).toEqual([firstFields.name, firstFields.bio])
  expect(first.timestampMs).toBe(startedAt)
  expect(published.timestampMs).toBe(startedAt + 2_000)
  now = startedAt + 3_000
  expect(
    await syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
  ).toBe('unchanged')
  expect(store.profile).toEqual(laterFields)
  expect(identityApi.decodeProfileBytes(remote!).name).toBe(laterFields.name)
  expect(store.unpublished).toBe(false)
  expect(ownProfileCheck.unchecked).toBeNull()
  expect([reads, writes.length, bindings]).toEqual([3, 2, 2])
})

it('404 then a concurrent winner then412 rereads and adopts without overwriting or unconditional fallback', async () => {
  const store = retained()
  const winner = raw({ name: 'Winner', bio: 'Winner bio' })
  let gets = 0
  let puts = 0
  request.mockImplementation(async call => {
    if (metadataGet(call)) {
      if (++gets === 1) throw httpError(404)
      return response(winner)
    }
    if (call.method === 'get') return response(info)
    puts++
    expect(call.headers['If-None-Match']).toBe('*')
    expect(call.headers['If-Match']).toBeUndefined()
    expect(identityApi.decodeProfileBytes(call.data).name).toBe(
      'Retained old name',
    )
    // Another device has published between the read and this exact conditional write.
    throw httpError(412)
  })
  expect(
    await syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
  ).toBe('adopted')
  expect(store.profile).toEqual({ name: 'Winner', bio: 'Winner bio' })
  expect(store.unpublished).toBe(false)
  expect(ownProfileCheck.unchecked).toBeNull()
  expect([gets, puts]).toEqual([2, 1])
})

it('present-row conflict rebases genuine newer local fields on the winner using its new raw digest', async () => {
  const store = retained()
  const now = Date.now()
  const first = raw({ name: 'Base', bio: 'Base bio' }, now - 3_000)
  const winner = raw(
    { name: 'Other name', bio: 'Other device bio' },
    now - 1_000,
  )
  store.profile = { name: 'My edit', bio: 'Base bio' }
  store.base = { name: 'Base', bio: 'Base bio' }
  store.unpublished = true
  store.editedAt = now
  let gets = 0
  let puts = 0
  request.mockImplementation(async call => {
    if (metadataGet(call)) return response(++gets === 1 ? first : winner)
    if (call.method === 'get') return response(info)
    puts++
    expect(call.headers['If-Match']).toBe(
      `"${digest(puts === 1 ? first : winner)}"`,
    )
    expect(call.headers['If-None-Match']).toBeUndefined()
    if (puts === 1) {
      expect(store.unpublished).toBe(true)
      throw httpError(412)
    }
    const signed = identityApi.decodeProfileBytes(call.data)
    expect([signed.name, signed.bio]).toEqual(['My edit', 'Other device bio'])
    return response({})
  })
  expect(
    await syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
  ).toBe('published')
  expect(store.profile).toEqual({ name: 'My edit', bio: 'Other device bio' })
  expect(store.unpublished).toBe(false)
  expect([gets, puts]).toEqual([2, 2])
})

it('exhausted conditional conflicts preserve edit intent and visible uncertainty within one deadline', async () => {
  const store = retained()
  store.unpublished = true
  store.editedAt = 123
  const fields = { ...store.profile }
  const signals = new Set<AbortSignal>()
  request.mockImplementation(async call => {
    signals.add(call.signal)
    if (metadataGet(call)) throw httpError(404)
    if (call.method === 'get') return response(info)
    expect(call.headers['If-None-Match']).toBe('*')
    throw httpError(412)
  })
  await expect(
    syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
  ).rejects.toThrow('412')
  expect(
    request.mock.calls.filter(([call]) => call.method === 'put'),
  ).toHaveLength(3)
  expect(request.mock.calls.filter(([call]) => metadataGet(call))).toHaveLength(
    3,
  )
  expect(signals.size).toBe(1)
  expect(store.profile).toEqual(fields)
  expect(store.unpublished).toBe(true)
  expect(store.editedAt).toBe(123)
  expect(ownProfileCheck.unchecked).toBe(store.owner)
})

it.each(['cbor', 'protobuf'] as const)(
  'expired %s remains a matched raw snapshot and can republish conditionally',
  async representation => {
    let bytes: Uint8Array
    if (representation === 'cbor') bytes = raw({ name: 'Expired' }, 1_000, 1)
    else {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000)
      request.mockResolvedValue(response({}))
      await identityApi.registerMonadIdentity({
        relayBaseUrl,
        identity,
        profile: { name: 'Expired' },
      })
      bytes = new Uint8Array(request.mock.calls[0][0].data)
      clock.mockRestore()
      request.mockReset()
    }
    request.mockImplementation(async call => {
      if (metadataGet(call)) return response(bytes)
      if (call.method === 'get') return response(info)
      expect(call.headers['If-Match']).toBe(`"${digest(bytes)}"`)
      expect(call.headers['If-None-Match']).toBeUndefined()
      return response({})
    })
    const snapshot = await identityApi.fetchEvmProfileSnapshot({
      relayBaseUrl,
      address: identity.address,
    })
    expect(snapshot).toEqual({
      profile: undefined,
      precondition: { kind: 'matches', digest: digest(bytes) },
    })
    expect(
      await identityApi.fetchMonadProfile({
        relayBaseUrl,
        address: identity.address,
      }),
    ).toBeUndefined()
    await identityApi.registerMonadIdentityCbor({
      relayBaseUrl,
      identity,
      network,
      profile: { name: 'Renewed' },
      precondition: snapshot.precondition,
    })
    expect(
      request.mock.calls.filter(([call]) => call.method === 'put'),
    ).toHaveLength(1)
  },
)

it('a412 transport rejection never falls back to an unconditional PUT', async () => {
  request.mockImplementation(async call => {
    if (call.method === 'get') return response(info)
    throw httpError(412)
  })
  await expect(
    identityApi.registerMonadIdentityCbor({
      relayBaseUrl,
      identity,
      network,
      profile: { name: 'Edit' },
      precondition: { kind: 'matches', digest: 'a'.repeat(64) },
    }),
  ).rejects.toThrow('412')
  expect(
    request.mock.calls.filter(([call]) => call.method === 'put'),
  ).toHaveLength(1)
  expect(request.mock.calls.some(([call]) => metadataGet(call))).toBe(false)
})

it.each([401, 403, 500, 503])(
  'a%s reread after412 remains unknown and never treats failure as absence',
  async status => {
    const store = retained()
    store.unpublished = true
    store.editedAt = 123
    let gets = 0
    request.mockImplementation(async call => {
      if (metadataGet(call)) throw httpError(++gets === 1 ? 404 : status)
      if (call.method === 'get') return response(info)
      throw httpError(412)
    })
    expect(
      await syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
    ).toBe('unreachable')
    expect(store.profile.name).toBe('Retained old name')
    expect(store.unpublished).toBe(true)
    expect(store.editedAt).toBe(123)
    expect(ownProfileCheck.unchecked).toBe(store.owner)
    expect(
      request.mock.calls.filter(([call]) => call.method === 'put'),
    ).toHaveLength(1)
  },
)

it('cancellation after412 prevents another read or publication and keeps unpublished fields', async () => {
  const store = retained()
  store.unpublished = true
  store.editedAt = 123
  const controller = new AbortController()
  request.mockImplementation(async call => {
    if (metadataGet(call)) throw httpError(404)
    if (call.method === 'get') return response(info)
    controller.abort()
    throw httpError(412)
  })
  await expect(
    syncOwnProfileWithRelay({
      relayBaseUrl,
      identity,
      network,
      signal: controller.signal,
    }),
  ).rejects.toThrow('412')
  expect(request.mock.calls.filter(([call]) => metadataGet(call))).toHaveLength(
    1,
  )
  expect(
    request.mock.calls.filter(([call]) => call.method === 'put'),
  ).toHaveLength(1)
  expect(store.profile.name).toBe('Retained old name')
  expect(store.unpublished).toBe(true)
  expect(store.editedAt).toBe(123)
})

it('a late412 never reclaims or changes the newly active account profile', async () => {
  const store = retained()
  const other = '0x' + '22'.repeat(20)
  request.mockImplementation(async call => {
    if (metadataGet(call)) throw httpError(404)
    if (call.method === 'get') return response(info)
    store.owner = other
    store.profile = { name: 'New account' }
    throw httpError(412)
  })
  expect(
    await syncOwnProfileWithRelay({ relayBaseUrl, identity, network }),
  ).toBe('unreachable')
  expect(store.owner).toBe(other)
  expect(store.profile).toEqual({ name: 'New account' })
  expect(request.mock.calls.filter(([call]) => metadataGet(call))).toHaveLength(
    1,
  )
  expect(
    request.mock.calls.filter(([call]) => call.method === 'put'),
  ).toHaveLength(1)
})
