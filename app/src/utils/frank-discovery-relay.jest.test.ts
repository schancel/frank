/** @jest-environment node */
import { assertDiscoveryRelay } from './frank-discovery-relay'

const originalFetch = globalThis.fetch
const endpoint = 'https://relay.example.com'
afterEach(() => {
  globalThis.fetch = originalFetch
})
it('accepts only matching canonical network and HTTPS origin', async () => {
  const request = jest.fn(
    async () =>
      new Response(JSON.stringify({ endpoint, network: 'monad-testnet' })),
  )
  globalThis.fetch = request
  await assertDiscoveryRelay(endpoint, 'monad-testnet')
  expect(request).toHaveBeenCalledWith(
    `${endpoint}/relay/v1/info`,
    expect.objectContaining({ credentials: 'omit', redirect: 'error' }),
  )
  await expect(
    assertDiscoveryRelay(endpoint, 'ethereum-sepolia'),
  ).rejects.toThrow('mismatch')
})
it.each([
  { endpoint: 'http://relay.example.com', network: 'monad-testnet' },
  { endpoint: 'https://other.example.com', network: 'monad-testnet' },
  { endpoint, network: 'monad' },
])('rejects unbound discovery information %j', async info => {
  globalThis.fetch = jest.fn(async () => new Response(JSON.stringify(info)))
  await expect(assertDiscoveryRelay(endpoint, 'monad-testnet')).rejects.toThrow(
    'mismatch',
  )
})
it('rejects non-JSON, oversized responses and HTTP failure', async () => {
  for (const response of [
    new Response('<html>'),
    new Response(' '.repeat(4097)),
    new Response('', { status: 503 }),
  ]) {
    globalThis.fetch = jest.fn(async () => response)
    await expect(
      assertDiscoveryRelay(endpoint, 'monad-testnet'),
    ).rejects.toThrow()
  }
})
