import { getChainRegistryEntry } from '@frank/wallet/chain'
import { verifyEvmRelayRoute } from './evm-wallet-verification'

const id = 'hyperliquid-testnet'
const entry = getChainRegistryEntry(id)
if (!entry?.networkTag) throw new Error('Hyperliquid registry entry unavailable')
const config = {
  chainIdentifier: id,
  networkId: id,
  rpcChain: id,
  chainId: 998n,
  networkTag: entry.networkTag,
  relayBaseUrl: 'https://relay.example/',
} as Parameters<typeof verifyEvmRelayRoute>[0]

function discovery(chains: unknown[]): typeof fetch {
  return jest.fn(async () => ({
    ok: true,
    json: async () => ({ schema_version: 1, chains }),
  })) as unknown as typeof fetch
}

const route = {
  id,
  family: 'evm',
  network: 'testnet',
  caip2: 'eip155:998',
  native_chain_id: '998',
  capabilities: ['json-rpc'],
}

it('requires the exact advertised Hyperliquid RPC route before opening custody', async () => {
  expect(entry.wallet).toBeUndefined()
  const request = discovery([route])
  await expect(
    verifyEvmRelayRoute(config, undefined, request),
  ).resolves.toBeUndefined()
  expect(request).toHaveBeenCalledWith('https://relay.example/chains', {
    cache: 'no-store',
    signal: undefined,
  })
})

it.each([
  { chains: [] },
  { chains: [{ ...route, id: 'hyperliquid-mainnet' }] },
  { chains: [{ ...route, native_chain_id: '999' }] },
  { chains: [{ ...route, caip2: 'eip155:999' }] },
  { chains: [{ ...route, capabilities: [] }] },
])('rejects a missing or mismatched relay route', async ({ chains }) => {
  await expect(
    verifyEvmRelayRoute(config, undefined, discovery(chains)),
  ).rejects.toThrow(`EVM relay route unavailable for ${id}`)
})

it('rejects malformed discovery and transport failure', async () => {
  const malformed = jest.fn(async () => ({
    ok: true,
    json: async () => ({ schema_version: 2, chains: [route] }),
  })) as unknown as typeof fetch
  await expect(
    verifyEvmRelayRoute(config, undefined, malformed),
  ).rejects.toThrow(`Invalid EVM relay discovery for ${id}`)
  const failed = jest.fn(async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
  await expect(verifyEvmRelayRoute(config, undefined, failed)).rejects.toThrow(
    `EVM relay route unavailable for ${id}`,
  )
})
