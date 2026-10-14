import { discoverEmailGateway } from './email-gateway-discovery'

const relayInfo = {
  network: 'monad-testnet',
  endpoint: 'https://relay.example.test',
  emailGateway: {
    address: '0x2222222222222222222222222222222222222222',
    domain: 'mail.example.test',
  },
}
const fetcher = (body: unknown): typeof fetch =>
  jest.fn(async () => ({
    ok: true,
    json: async () => body,
  })) as unknown as typeof fetch

describe('email gateway discovery', () => {
  const args = {
    relayBaseUrl: 'https://relay.example.test/path',
    chainIdentifier: 'monad-testnet',
  }
  it('reads only the selected relay and network', async () => {
    const fetch = fetcher(relayInfo)
    await expect(
      discoverEmailGateway({ ...args, fetcher: fetch }),
    ).resolves.toEqual(relayInfo.emailGateway)
    expect(fetch).toHaveBeenCalledWith(
      'https://relay.example.test/relay/v1/info',
      {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      },
    )
  })
  it('returns no gateway if the operator advertises none', async () => {
    await expect(
      discoverEmailGateway({
        ...args,
        fetcher: fetcher({ ...relayInfo, emailGateway: undefined }),
      }),
    ).resolves.toBeNull()
  })
  it.each([
    { ...relayInfo, network: 'ethereum-sepolia' },
    { ...relayInfo, endpoint: 'https://other.example.test' },
    {
      ...relayInfo,
      emailGateway: {
        ...relayInfo.emailGateway,
        chainIdentifier: 'monad-testnet',
      },
    },
    {
      ...relayInfo,
      emailGateway: { ...relayInfo.emailGateway, address: '0x123' },
    },
    {
      ...relayInfo,
      emailGateway: { ...relayInfo.emailGateway, domain: 'BAD host' },
    },
  ])('rejects a mismatched or malformed advertisement', async info => {
    await expect(
      discoverEmailGateway({ ...args, fetcher: fetcher(info) }),
    ).rejects.toThrow()
  })
})

describe('transport validation equivalence', () => {
  const args = {
    relayBaseUrl: 'https://relay.example.test/path',
    chainIdentifier: 'monad-testnet',
  }
  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://[::1]:8080',
    'https://remote.test',
  ])('accepts URL policy %s', async relayBaseUrl => {
    const endpoint = new URL(relayBaseUrl).origin
    await expect(
      discoverEmailGateway({
        ...args,
        relayBaseUrl,
        fetcher: fetcher({ ...relayInfo, endpoint }),
      }),
    ).resolves.toEqual(relayInfo.emailGateway)
  })
  it.each(['http://remote.test', 'ftp://localhost', 'file:///tmp/info'])(
    'rejects URL policy %s before fetch',
    async relayBaseUrl => {
      const fetch = fetcher(relayInfo)
      await expect(
        discoverEmailGateway({ ...args, relayBaseUrl, fetcher: fetch }),
      ).rejects.toThrow('Email gateway relay must use HTTPS or local loopback')
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it.each([null, false, 1, 'text'])(
    'rejects malformed information %s',
    async body => {
      await expect(
        discoverEmailGateway({ ...args, fetcher: fetcher(body) }),
      ).rejects.toThrow('Invalid relay information')
    },
  )
  it.each([
    false,
    1,
    'gateway',
    {},
    { address: relayInfo.emailGateway.address, domain: 'UPPER.test' },
    { address: relayInfo.emailGateway.address, domain: '-bad.test' },
  ])('rejects malformed gateway %s', async emailGateway => {
    await expect(
      discoverEmailGateway({
        ...args,
        fetcher: fetcher({ ...relayInfo, emailGateway }),
      }),
    ).rejects.toThrow('Invalid email gateway advertisement')
  })
  it('preserves address casing and accepts null gateway', async () => {
    const gateway = {
      ...relayInfo.emailGateway,
      address: '0xAb22222222222222222222222222222222222222',
    }
    await expect(
      discoverEmailGateway({
        ...args,
        fetcher: fetcher({ ...relayInfo, emailGateway: gateway }),
      }),
    ).resolves.toEqual(gateway)
    await expect(
      discoverEmailGateway({
        ...args,
        fetcher: fetcher({ ...relayInfo, emailGateway: null }),
      }),
    ).resolves.toBeNull()
  })
  it('surfaces HTTP, JSON and fetch failures', async () => {
    const http = jest.fn(async () => ({ ok: false })) as unknown as typeof fetch
    await expect(
      discoverEmailGateway({ ...args, fetcher: http }),
    ).rejects.toThrow('Relay information is unavailable')
    const json = jest.fn(async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad JSON')
      },
    })) as unknown as typeof fetch
    await expect(
      discoverEmailGateway({ ...args, fetcher: json }),
    ).rejects.toThrow('bad JSON')
    const network = jest.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(
      discoverEmailGateway({ ...args, fetcher: network }),
    ).rejects.toThrow('offline')
  })
})
