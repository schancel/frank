/** @jest-environment node */
import {
  discoverWellKnown,
  WellKnownDiscoveryError,
} from './frank-wellknown-discovery'
import { createFrankDomainDiscovery } from './frank-domain-discovery'

const document = {
  version: 1,
  relays: [{ endpoint: 'https://relay.example.com', priority: 10 }],
}
const json = (value: unknown, cache = 'public, max-age=60') =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', 'cache-control': cache },
  })
function absentDns(url: string): Response {
  const request = Uint8Array.from(
    Buffer.from(new URL(url).searchParams.get('dns')!, 'base64url'),
  )
  request[2] = 0x81
  request[3] = 0x83
  return new Response(request, {
    headers: { 'content-type': 'application/dns-message' },
  })
}

it('accepts bounded version-one documents over HTTPS with no credentials or redirects', async () => {
  const request = jest.fn(async () => json(document))
  expect(await discoverWellKnown('example.com', request)).toEqual({
    relays: [
      { endpoint: 'https://relay.example.com', priority: 10, weight: 0 },
    ],
    ttl: 60,
  })
  expect(request).toHaveBeenCalledWith(
    'https://example.com/.well-known/frank-relay',
    expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
  )
})
it.each([
  { version: 2, relays: document.relays },
  { version: 1, relays: [] },
  { version: 1, relays: Array(9).fill(document.relays[0]) },
  ...[
    'http://relay.example.com',
    'https://relay.example.com/path',
    'https://relay.example.com:8443',
    'https://user:pw@relay.example.com',
    'https://127.0.0.1',
    'javascript:alert(1)',
  ].map(endpoint => ({ version: 1, relays: [{ endpoint, priority: 0 }] })),
])('rejects malformed or unsafe positive advertisements: %j', async value => {
  try {
    await discoverWellKnown(
      'example.com',
      jest.fn(async () => json(value)),
    )
    throw new Error('Expected rejection')
  } catch (error) {
    expect(error).toBeInstanceOf(WellKnownDiscoveryError)
    expect((error as WellKnownDiscoveryError).advertised).toBe(true)
  }
})
it('enforces body bounds and distinguishes HTTP absence from malformed positive documents', async () => {
  expect(
    await discoverWellKnown(
      'example.com',
      jest.fn(async () => new Response('', { status: 404 })),
    ),
  ).toBeNull()
  await expect(
    discoverWellKnown(
      'example.com',
      jest.fn(
        async () =>
          new Response(' '.repeat(4097), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ),
  ).rejects.toMatchObject({ advertised: true })
  await expect(
    discoverWellKnown(
      'example.com',
      jest.fn(async () => {
        throw new Error('CORS')
      }),
    ),
  ).rejects.toMatchObject({ advertised: false })
})
it('honors no-store and caps cache age', async () => {
  expect(
    (
      await discoverWellKnown(
        'example.com',
        jest.fn(async () => json(document, 'max-age=999999')),
      )
    )?.ttl,
  ).toBe(300)
  expect(
    (
      await discoverWellKnown(
        'example.com',
        jest.fn(async () => json(document, 'no-store, max-age=300')),
      )
    )?.ttl,
  ).toBe(0)
})
it('recovers failed DNS through authenticated well-known and caches the successful document', async () => {
  const request = jest.fn(async (url: string) => {
    if (!url.includes('/.well-known/')) throw new Error('SRV unusable')
    return json(document)
  })
  const discover = createFrankDomainDiscovery({ fetch: request })
  expect(await discover('example.com')).toEqual([
    { endpoint: 'https://relay.example.com', priority: 10, weight: 0 },
  ])
  await discover('example.com')
  expect(request).toHaveBeenCalledTimes(3)
})
it('prefers valid well-known native discovery over an absent SRV email suggestion', async () => {
  const request = jest.fn(async (url: string) =>
    url.includes('/.well-known/') ? json(document) : absentDns(url),
  )
  expect(
    await createFrankDomainDiscovery({ fetch: request })('example.com'),
  ).toEqual([
    { endpoint: 'https://relay.example.com', priority: 10, weight: 0 },
  ])
})
it('retains the explicit email option for ordinary email domains with absent SRV and unavailable CORS', async () => {
  const request = jest.fn(async (url: string) => {
    if (url.includes('/.well-known/')) throw new Error('CORS unavailable')
    return absentDns(url)
  })
  expect(
    await createFrankDomainDiscovery({ fetch: request })('example.com'),
  ).toEqual([])
})
it('never offers email after positive malformed well-known, even when SRV is absent', async () => {
  const request = jest.fn(async (url: string) =>
    url.includes('/.well-known/')
      ? json({
          version: 1,
          relays: [{ endpoint: 'http://insecure.example', priority: 0 }],
        })
      : absentDns(url),
  )
  await expect(
    createFrankDomainDiscovery({ fetch: request })('example.com'),
  ).rejects.toMatchObject({ advertised: true })
})
it('never offers email when DNS failed and well-known is absent', async () => {
  const request = jest.fn(async (url: string) => {
    if (url.includes('/.well-known/')) return new Response('', { status: 404 })
    throw new Error('DNS timeout')
  })
  await expect(
    createFrankDomainDiscovery({ fetch: request })('example.com'),
  ).rejects.toThrow('Domain discovery failed')
})
