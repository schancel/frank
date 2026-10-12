import { discoverEmailGateway } from './email-gateway-discovery'

const relayInfo = {
  network: 'monad-testnet',
  endpoint: 'https://relay.example.test',
  emailGateway: {
    chainIdentifier: 'monad-testnet',
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
        chainIdentifier: 'ethereum-sepolia',
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
