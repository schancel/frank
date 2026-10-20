import {
  requireRelayWalletRoute,
  RelayWalletRouteUnavailableError,
} from './relay-wallet-route'
import wireRegistry from '../../../docs/protocol/chains/v1.json'
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
  const facts = wireRegistry.chains.find(chain => chain.id === id)
  if (!facts) throw new Error(`Missing protocol fixture ${id}`)
  return {
    id,
    family: facts.family,
    network: facts.network,
    caip2: facts.caip2,
    native_chain_id: facts.native_chain_id,
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
  { ...route('base-sepolia'), caip2: 'eip155:8453' },
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

it.each([
  null,
  {},
  { id: 'future-testnet', capabilities: [] },
  { ...route('monad-testnet'), caip2: '' },
  { ...route('monad-testnet'), family: ['evm'] },
  { ...route('monad-testnet'), network: ['testnet'] },
])(
  'rejects malformed route members instead of treating them as absent',
  async member => {
    const { relay } = fixture([member])
    await expect(requireRelayWalletRoute(relay, 'btc-testnet')).rejects.toThrow(
      'Invalid relay wallet discovery',
    )
  },
)
it('tolerates null caip2 from a pre-upgrade relay during rolling upgrade', async () => {
  const { relay } = fixture([{ ...route('xec-testnet'), caip2: null }])
  await expect(
    requireRelayWalletRoute(relay, 'xec-testnet'),
  ).resolves.toBeUndefined()
})
it('ignores structurally valid future networks when checking the requested route', async () => {
  const { relay } = fixture([
    { ...route('base-sepolia'), id: 'future-testnet' },
    route('btc-testnet'),
  ])
  await expect(
    requireRelayWalletRoute(relay, 'btc-testnet'),
  ).resolves.toBeUndefined()
})

it('rediscovers operator routes after the short cache lifetime', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  })
  try {
    const { request, relay } = fixture([])
    await expect(
      requireRelayWalletRoute(relay, 'base-sepolia'),
    ).rejects.toBeInstanceOf(RelayWalletRouteUnavailableError)
    request.mockResolvedValue({
      ok: true,
      json: async () => ({
        schema_version: 1,
        chains: [route('base-sepolia')],
      }),
    })
    await expect(
      requireRelayWalletRoute(relay, 'base-sepolia'),
    ).rejects.toBeInstanceOf(RelayWalletRouteUnavailableError)
    jest.advanceTimersByTime(15000)
    await expect(
      requireRelayWalletRoute(relay, 'base-sepolia'),
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})
it('bounds a stalled discovery and permits a later retry', async () => {
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
  })
  try {
    const { request, relay } = fixture([route('base-sepolia')])
    request.mockImplementationOnce(
      (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    )
    const stalled = requireRelayWalletRoute(relay, 'base-sepolia')
    const rejected = expect(stalled).rejects.toThrow('aborted')
    jest.advanceTimersByTime(10000)
    await rejected
    await expect(
      requireRelayWalletRoute(relay, 'base-sepolia'),
    ).resolves.toBeUndefined()
  } finally {
    jest.useRealTimers()
  }
})
