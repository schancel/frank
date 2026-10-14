import {
  requireRelayWalletRoute,
  RelayWalletRouteUnavailableError,
} from './relay-wallet-route'
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'

let sequence = 0
function fixture(chains: unknown[], schema_version = 1) {
  const request = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ schema_version, chains }),
  })
  global.fetch = request
  return { request, relay: `https://relay-${++sequence}.example` }
}
function route(id: string, capabilities?: string[]) {
  const entry = getChainRegistryEntry(id)
  if (!entry?.wallet) throw new Error(`Missing wallet fixture ${id}`)
  return {
    id,
    family: entry.family,
    network: entry.network,
    caip2: entry.caip2,
    native_chain_id: entry.nativeChainId ?? null,
    capabilities: capabilities ?? [entry.wallet.indexer],
  }
}
const originalFetch = global.fetch
afterAll(() => {
  global.fetch = originalFetch
})

it('coalesces discovery across canonical EVM, UTXO and Solana wallet routes', async () => {
  const ids = ['base-sepolia', 'btc-testnet', 'xec-testnet', 'solana-devnet']
  const { request, relay } = fixture(ids.map(id => route(id)))
  await Promise.all(ids.map(id => requireRelayWalletRoute(relay, id)))
  expect(request).toHaveBeenCalledTimes(1)
})

it.each([
  'bnb-testnet',
  'polygon-amoy',
  'base-sepolia',
  'arbitrum-sepolia',
  'doge-testnet',
  'litecoin-testnet',
])('distinguishes absent %s from a failed balance read', async id => {
  const { relay } = fixture([route('monad-testnet')])
  await expect(requireRelayWalletRoute(relay, id)).rejects.toBeInstanceOf(
    RelayWalletRouteUnavailableError,
  )
})
it('requires the wallet indexer, not just a permitted capability', async () => {
  const { relay } = fixture([route('btc-testnet', ['chronik'])])
  await expect(
    requireRelayWalletRoute(relay, 'btc-testnet'),
  ).rejects.toBeInstanceOf(RelayWalletRouteUnavailableError)
})
it.each([
  { ...route('base-sepolia'), native_chain_id: '8453' },
  { ...route('base-sepolia'), family: 'bitcoin' },
  { ...route('base-sepolia'), capabilities: ['chronik'] },
])(
  'rejects inconsistent network facts instead of reporting an absent network',
  async value => {
    const { relay } = fixture([value])
    await expect(
      requireRelayWalletRoute(relay, 'base-sepolia'),
    ).rejects.toThrow('Invalid relay wallet route')
  },
)
it('does not cache failed discovery as an absent route', async () => {
  const { request, relay } = fixture([route('base-sepolia')])
  request.mockRejectedValueOnce(new Error('offline'))
  await expect(requireRelayWalletRoute(relay, 'base-sepolia')).rejects.toThrow(
    'offline',
  )
  await expect(
    requireRelayWalletRoute(relay, 'base-sepolia'),
  ).resolves.toBeUndefined()
  expect(request).toHaveBeenCalledTimes(2)
})
it('rejects malformed discovery', async () => {
  const { relay } = fixture([], 2)
  await expect(requireRelayWalletRoute(relay, 'btc-testnet')).rejects.toThrow(
    'Invalid relay wallet discovery',
  )
})
