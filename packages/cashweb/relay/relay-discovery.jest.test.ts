import { discoverRelayOrigins, relayDiscoveryOrigin } from './relay-discovery'

const request = (payload: unknown) =>
  jest.fn(
    async () => new Response(JSON.stringify(payload)),
  ) as jest.MockedFunction<typeof fetch>

test('loads bounded public origin hints from the explicit installed home without credentials or redirects', async () => {
  const fetch = request({
    relays: [
      'https://HOME.example/',
      'https://foreign.example:443',
      'https://foreign.example',
      'http://foreign.example',
      'https://user:secret@bad.example',
      'https://bad.example/path',
      'https://bad.example?q=1',
      'https://bad.example#f',
      'https://127.0.0.1',
      'https://10.0.0.1',
      'https://host.local',
    ],
  })
  await expect(
    discoverRelayOrigins({ baseUrl: 'https://home.example', fetch }),
  ).resolves.toEqual(['https://home.example', 'https://foreign.example'])
  expect(fetch).toHaveBeenCalledWith(
    'https://home.example/peers',
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'error',
      method: 'GET',
      signal: expect.any(AbortSignal),
    }),
  )
})

test('loopback HTTP requires an explicit fixture option', async () => {
  expect(() => relayDiscoveryOrigin('http://127.0.0.1:9000')).toThrow()
  const fetch = request({ relays: ['http://127.0.0.1:9001'] })
  await expect(
    discoverRelayOrigins({
      baseUrl: 'http://127.0.0.1:9000',
      fetch,
      allowLoopbackHttp: true,
    }),
  ).resolves.toEqual(['http://127.0.0.1:9001'])
})

it.each([
  { relays: 'invalid' },
  { relays: [null] },
  { relays: ['https://a.example', 'https://b.example'] },
])('rejects malformed or over-count responses %j', async payload => {
  await expect(
    discoverRelayOrigins({
      baseUrl: 'https://home.example',
      fetch: request(payload),
      maxRelays: 1,
    }),
  ).rejects.toThrow('Invalid relay discovery response')
})

test('rejects oversized streamed responses and advertised byte lengths', async () => {
  const fetch = request({ relays: ['https://a.example'] })
  await expect(
    discoverRelayOrigins({
      baseUrl: 'https://home.example',
      fetch,
      maxBytes: 10,
    }),
  ).rejects.toThrow('too large')
  const advertised = jest.fn(
    async () => new Response('{}', { headers: { 'content-length': '70000' } }),
  )
  await expect(
    discoverRelayOrigins({
      baseUrl: 'https://home.example',
      fetch: advertised,
    }),
  ).rejects.toThrow('too large')
})

test('cancels on caller abort even when the injected fetch ignores cancellation', async () => {
  const controller = new AbortController()
  const fetch = jest.fn(() => new Promise<Response>(() => undefined))
  const pending = discoverRelayOrigins({
    baseUrl: 'https://home.example',
    fetch,
    signal: controller.signal,
  })
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(fetch.mock.calls).toHaveLength(1)
})

test('times out stalled reads and rejects failed status responses', async () => {
  const fetch = jest.fn(
    async () =>
      new Response(
        new ReadableStream({
          start() {
            /* intentionally stalled */
          },
        }),
      ),
  )
  await expect(
    discoverRelayOrigins({
      baseUrl: 'https://home.example',
      fetch,
      timeoutMs: 10,
    }),
  ).rejects.toThrow('timed out')
  await expect(
    discoverRelayOrigins({
      baseUrl: 'https://home.example',
      fetch: async () => new Response('{}', { status: 503 }),
    }),
  ).rejects.toThrow('request failed')
})
