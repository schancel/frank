/** @jest-environment node */
import {
  createFrankDomainDiscovery,
  splitDomainHandle,
} from './frank-domain-discovery'

const name = (value: string): number[] => [
  ...value
    .split('.')
    .filter(Boolean)
    .flatMap(label => [label.length, ...Buffer.from(label)]),
  0,
]
const word = (value: number): number[] => [value >> 8, value & 255]
function answer(
  options: {
    code?: number
    port?: number
    target?: string
    ttl?: number
    malformed?: boolean
  } = {},
): Uint8Array {
  const absent = options.code !== undefined
  const target = options.target ?? 'relay.example.com'
  const data = [
    ...word(10),
    ...word(0),
    ...word(options.port ?? 443),
    ...name(target),
  ]
  return Uint8Array.from([
    0,
    0,
    0x81,
    0x80 | (options.code ?? 0),
    0,
    1,
    0,
    absent ? 0 : 1,
    0,
    0,
    0,
    0,
    ...name('_frank._tcp.example.com'),
    0,
    33,
    0,
    1,
    ...(absent
      ? []
      : [
          0xc0,
          options.malformed ? 255 : 12,
          0,
          33,
          0,
          1,
          0,
          0,
          0,
          options.ttl ?? 60,
          ...word(data.length),
          ...data,
        ]),
  ])
}
function response(body: Uint8Array): Response {
  return new Response(Uint8Array.from(body), {
    headers: { 'content-type': 'application/dns-message' },
  })
}

describe('browser Frank SRV discovery', () => {
  it('uses wire-format DoH and canonicalizes domains; caches only within the SRV TTL', async () => {
    let now = 0
    const request = jest
      .fn()
      .mockImplementation(async () => response(answer({ ttl: 2 })))
    const discover = createFrankDomainDiscovery({
      fetch: request,
      now: () => now,
    })
    expect(await discover('EXAMPLE.com.')).toEqual([
      { endpoint: 'https://relay.example.com', priority: 10, weight: 0 },
    ])
    const [url, init] = request.mock.calls[0]
    expect(new URL(url).origin).toBe('https://cloudflare-dns.com')
    expect(
      Buffer.from(
        new URL(url).searchParams.get('dns')!,
        'base64url',
      ).readUInt16BE(4),
    ).toBe(1)
    expect(init).toMatchObject({
      headers: { Accept: 'application/dns-message' },
      credentials: 'omit',
      redirect: 'error',
    })
    now = 1999
    await discover('example.com')
    expect(request).toHaveBeenCalledTimes(1)
    now = 2000
    await discover('example.com')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('falls back to Google on transport failure', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error('CORS'))
      .mockResolvedValueOnce(response(answer()))
    await createFrankDomainDiscovery({ fetch: request })('example.com')
    expect(new URL(request.mock.calls[1][0]).origin).toBe('https://dns.google')
  })
  it.each([0, 3])(
    'accepts explicit empty DNS answers (rcode %s) without negative caching guesses',
    async code => {
      const request = jest
        .fn()
        .mockImplementation(async (url: string) =>
          url.includes('/.well-known/')
            ? new Response('', { status: 404 })
            : response(answer({ code })),
        )
      const discover = createFrankDomainDiscovery({ fetch: request })
      expect(await discover('example.com')).toEqual([])
      await discover('example.com')
      expect(request).toHaveBeenCalledTimes(4)
    },
  )
  it.each([
    { malformed: true },
    { port: 80 },
    { target: '127.0.0.1' },
    { target: 'evil/route.example' },
    { target: '_dc-srv._tcp.example.com' },
    { code: 2 },
  ])(
    'rejects malformed or unusable replies without email fallback: %j',
    async options => {
      const request = jest
        .fn()
        .mockImplementation(async () => response(answer(options)))
      await expect(
        createFrankDomainDiscovery({ fetch: request })('example.com'),
      ).rejects.toThrow()
    },
  )
  it('rejects truncated and oversized bodies', async () => {
    for (const bytes of [answer().slice(0, -1), new Uint8Array(17000)]) {
      const request = jest.fn().mockImplementation(async () => response(bytes))
      await expect(
        createFrankDomainDiscovery({ fetch: request })('example.com'),
      ).rejects.toThrow()
    }
  })
  it('bounds stalled requests, tries both resolvers, and never caches failure', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
    try {
      const request = jest.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) =>
            init.signal.addEventListener('abort', () =>
              reject(new Error('timeout')),
            ),
          ),
      )
      const discover = createFrankDomainDiscovery({ fetch: request })
      const pending = expect(discover('example.com')).rejects.toThrow()
      await jest.advanceTimersByTimeAsync(5000)
      await new Promise(resolve => setImmediate(resolve))
      await jest.advanceTimersByTimeAsync(5000)
      await new Promise(resolve => setImmediate(resolve))
      await jest.advanceTimersByTimeAsync(5000)
      await pending
      expect(request).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })
  it('rejects non-hostname input and unsafe resolver configuration before fetching', () => {
    expect(splitDomainHandle('Alice@NATIVE.example.')).toEqual({
      username: 'alice',
      domain: 'native.example',
    })
    expect(() => splitDomainHandle('alice@evil.test/path')).toThrow()
    expect(() =>
      createFrankDomainDiscovery({ endpoints: ['http://dns.example'] }),
    ).toThrow()
    expect(() =>
      createFrankDomainDiscovery({
        endpoints: ['https://user:secret@dns.example'],
      }),
    ).toThrow()
  })
})
