import {
  createNativeOnlyEvmChain,
  activeChain,
  DirectMessageAlreadyAttemptedError,
  getChainRegistryEntry,
  type EvmChainWalletHandle,
  type EvmChainConfig,
} from '@frank/wallet/chain'
import {
  openEvmWallet,
  peekOpenedEvmWallets,
  closeOpenedEvmWallets,
  recoverSecondaryEvmWallets,
} from './evm-wallets'
import { createNativeTransferContext } from './native-transfer'
import {
  RelayOperatorCheckpointUnavailableError,
  requireRelayOperatorCheckpoint,
} from './relay-wallet-route'
const mockState = {
  status: 'ready',
  account: { receipt: { context: { accountId: 'a' } } },
  revision: 1,
}
const mockCreate = jest.fn()
const mockEnabledPeerNetworks = new Set<string>()
const mockPrimaryClose = jest.fn(async () => undefined)
const mockPrimaryBlock = jest.fn(async () => {
  const probe = getChainRegistryEntry('monad-testnet')!.identityProbes.find(
    probe => probe.kind === 'block-hash',
  )!
  if (probe.kind !== 'block-hash') throw new Error('missing checkpoint')
  return { number: probe.height, hash: probe.expected }
})
let mockPrimary: {
  family: string
  relayBaseUrl: string
  chainIdentifier: string
  close: () => Promise<void>
  provider: {
    getNetwork: () => Promise<{ chainId: bigint }>
    getBlock: typeof mockPrimaryBlock
  }
} = {
  family: 'evm',
  relayBaseUrl: 'https://relay.invalid',
  chainIdentifier: 'monad-testnet',
  close: mockPrimaryClose,
  provider: {
    getNetwork: async () => ({ chainId: 10143n }),
    getBlock: mockPrimaryBlock,
  },
}
const mockGetWallet = jest.fn(async () => mockPrimary)
let mockRelay = 'https://relay.invalid'
let mockSessionOverride:
  | ReturnType<typeof import('./session').createAccountSession>
  | undefined
jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockSessionOverride?.state ?? mockState
    },
    createEvmWallet: (...args: unknown[]) => mockCreate(...args),
    getWallet: () => mockSessionOverride?.getWallet() ?? mockGetWallet(),
    peekWallet: () =>
      mockSessionOverride
        ? mockSessionOverride.peekWallet()
        : mockState.status === 'ready'
        ? mockPrimary
        : undefined,
  },
}))
jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  get PROTOCOL_CHAINS() {
    const entries = jest.requireActual('@frank/wallet/chain').PROTOCOL_CHAINS
    return Object.fromEntries(
      Object.entries(entries).map(([id, entry]) => {
        const e = entry as { family?: string; kind?: string; wallet?: unknown }
        if (e.family === 'evm' && e.kind !== 'monad') {
          return [
            id,
            {
              ...e,
              wallet: mockEnabledPeerNetworks.has(id)
                ? e.wallet ?? true
                : undefined,
            },
          ]
        }
        return [
          id,
          mockEnabledPeerNetworks.has(id) ? { ...e, wallet: true } : entry,
        ]
      }),
    )
  },
  getChainRegistryEntry: (id: string) => {
    const entry = jest
      .requireActual('@frank/wallet/chain')
      .getChainRegistryEntry(id)
    if (!entry) return entry
    if (entry.family === 'evm' && entry.kind !== 'monad') {
      return {
        ...entry,
        wallet: mockEnabledPeerNetworks.has(id)
          ? entry.wallet ?? true
          : undefined,
      }
    }
    return mockEnabledPeerNetworks.has(id) ? { ...entry, wallet: true } : entry
  },
  createNativeOnlyEvmChain: jest.fn(config => ({
    chainIdentifier: config.chainIdentifier,
    family: 'evm',
    config,
  })),
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: mockRelay,
    walletStorageLocation: 'configured-host-store',
    subAccountPoolSize: 8,
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultTopicVoteValueWei: 1n,
  }),
}))
beforeEach(async () => {
  await closeOpenedEvmWallets()
  jest.clearAllMocks()
  mockEnabledPeerNetworks.clear()
  mockSessionOverride = undefined
  mockState.status = 'ready'
  mockState.revision++
  mockState.account = { receipt: { context: { accountId: 'a' } } }
  mockRelay = 'https://relay.invalid'
  mockPrimary = {
    family: 'evm',
    relayBaseUrl: 'https://relay.invalid',
    chainIdentifier: 'monad-testnet',
    close: mockPrimaryClose,
    provider: {
      getNetwork: async () => ({ chainId: 10143n }),
      getBlock: mockPrimaryBlock,
    },
  }
  mockCreate.mockImplementation(async ({ config }) => ({
    family: 'evm',
    chainIdentifier: config.chainIdentifier,
    close: jest.fn(async () => undefined),
  }))
})
afterEach(async () => {
  await closeOpenedEvmWallets()
})
it('opens once per configured canonical peer and keeps independent stores without selecting the UI network', async () => {
  expect(peekOpenedEvmWallets()).toEqual([])
  expect(mockCreate).not.toHaveBeenCalled()
  const [main, again, test] = await Promise.all([
    openEvmWallet('monad-mainnet'),
    openEvmWallet('monad-mainnet'),
    openEvmWallet('monad-testnet'),
  ])
  expect(main).toBe(again)
  expect(test.wallet).not.toBe(main.wallet)
  expect(test.wallet).toBe(mockPrimary)
  expect(mockPrimaryClose).not.toHaveBeenCalled()
  expect(mockCreate).toHaveBeenCalledTimes(1)
  const mainConfig = mockCreate.mock.calls[0][0].config
  const testConfig = jest.mocked(createNativeOnlyEvmChain).mock.calls[1]![0]
  expect(mainConfig).toMatchObject({
    chainIdentifier: 'monad-mainnet',
    networkId: 'monad-mainnet',
    rpcChain: 'monad-mainnet',
    chainId: 143n,
    networkTag: 'MON1',
    walletStorageLocation: 'configured-host-store-monad-mainnet',
  })
  expect(testConfig).toMatchObject({
    chainIdentifier: 'monad-testnet',
    chainId: 10143n,
    networkTag: 'MONT',
    walletStorageLocation: 'configured-host-store-monad-testnet',
  })
  expect(peekOpenedEvmWallets()).toEqual([main, test])
  expect(createNativeOnlyEvmChain).toHaveBeenCalledTimes(2)
  await main.wallet.close()
  expect(peekOpenedEvmWallets()).toEqual([test])
})
it.each([
  'monad',
  'evm',
  'ethereum-sepolia',
  'ethereum-mainnet',
  'hyperliquid-mainnet',
  'tempo-mainnet',
  'btc-testnet',
])('refuses unconfigured wallet capability %s', chain => {
  expect(() => openEvmWallet(chain)).toThrow(/unavailable/)
  expect(mockCreate).not.toHaveBeenCalled()
})

it('keeps Hyperliquid custody closed until the relay advertises its exact route', async () => {
  mockEnabledPeerNetworks.add('hyperliquid-testnet')
  const originalFetch = globalThis.fetch
  const request = jest.fn(async () => ({
    ok: true,
    json: async () => ({ schema_version: 1, chains: [] }),
  })) as unknown as typeof fetch
  globalThis.fetch = request
  try {
    await expect(openEvmWallet('hyperliquid-testnet')).rejects.toThrow(
      'EVM relay route unavailable for hyperliquid-testnet',
    )
    expect(mockCreate).not.toHaveBeenCalled()
    expect(peekOpenedEvmWallets()).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
  }
})

it('opens Hyperliquid custody only after the relay advertises the canonical RPC route', async () => {
  mockEnabledPeerNetworks.add('hyperliquid-testnet')
  mockPrimary = { ...mockPrimary, chainIdentifier: 'monad-regtest' }
  const originalFetch = globalThis.fetch
  const request = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      schema_version: 1,
      chains: [
        {
          id: 'hyperliquid-testnet',
          family: 'evm',
          network: 'testnet',
          caip2: 'eip155:998',
          native_chain_id: '998',
          capabilities: ['json-rpc'],
        },
      ],
    }),
  })) as unknown as typeof fetch
  globalThis.fetch = request
  try {
    const open = await openEvmWallet('hyperliquid-testnet')
    expect(request).toHaveBeenCalledTimes(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(mockCreate.mock.calls[0][0].config).toMatchObject({
      chainIdentifier: 'hyperliquid-testnet',
      chainId: 998n,
      networkTag: 'HYPT',
      relayAuthNetworkTag: 'MONR',
    })
    expect(open.wallet.chainIdentifier).toBe('hyperliquid-testnet')
  } finally {
    globalThis.fetch = originalFetch
  }
})

it('refuses a new primary wallet after capturing the directory auth network, even at the same revision', async () => {
  mockEnabledPeerNetworks.add('hyperliquid-testnet')
  const originalFetch = globalThis.fetch
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => {
      mockPrimary = { ...mockPrimary }
      return {
        schema_version: 1,
        chains: [
          {
            id: 'hyperliquid-testnet',
            family: 'evm',
            network: 'testnet',
            caip2: 'eip155:998',
            native_chain_id: '998',
            capabilities: ['json-rpc'],
          },
        ],
      }
    },
  })) as unknown as typeof fetch
  try {
    await expect(openEvmWallet('hyperliquid-testnet')).rejects.toThrow(
      'Account changed',
    )
    expect(mockCreate).not.toHaveBeenCalled()
    expect(peekOpenedEvmWallets()).toEqual([])
  } finally {
    globalThis.fetch = originalFetch
  }
})

const hyperLiveRoots = [
  process.env.FRANK_HYPER_SYNTHETIC_ROOT_A_FILE,
  process.env.FRANK_HYPER_SYNTHETIC_ROOT_B_FILE,
]
const hyperLive = hyperLiveRoots.every(Boolean) ? it : it.skip
hyperLive(
  'opens, switches, and reopens real Hyperliquid owners through the authenticated relay without sending',
  async () => {
    const { readFileSync } = await import('node:fs')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { deriveDomainRoot } = jest.requireActual('@frank/domain-roots')
    const actual = jest.requireActual('@frank/wallet/chain')
    const { verifyEvmWalletRpcIdentity } = await import(
      './evm-wallet-verification'
    )
    const stateDir = await mkdtemp(join(tmpdir(), 'frank-hyper-owner-live-'))
    const checkpoint = getChainRegistryEntry(
      'hyperliquid-testnet',
    )!.identityProbes.find(probe => probe.kind === 'block-hash')!
    if (checkpoint.kind !== 'block-hash') throw new Error('missing checkpoint')
    mockEnabledPeerNetworks.add('hyperliquid-testnet')
    mockRelay = 'https://relay.signet.mx'
    const roots = hyperLiveRoots.map(path => {
      const root = Uint8Array.from(
        Buffer.from(readFileSync(path!, 'utf8').trim(), 'hex'),
      )
      if (root.length !== 32) throw new Error('invalid synthetic test root')
      try {
        return {
          evm: deriveDomainRoot(root, 'evm-wallet'),
          authentication: deriveDomainRoot(root, 'identity-authentication'),
          messaging: deriveDomainRoot(root, 'messaging-encryption'),
        }
      } finally {
        root.fill(0)
      }
    })
    let selected = 0
    mockCreate.mockImplementation(async ({ config }) => {
      expect(config.relayAuthNetworkTag).toBe('MONT')
      expect(config.networkTag).toBe('HYPT')
      const wallet = await actual
        .createNativeOnlyEvmChain({
          ...config,
          walletStorageLocation: join(stateDir, 'hyperliquid-testnet'),
          subAccountPoolSize: 1,
        })
        .createWallet(roots[selected])
      await verifyEvmWalletRpcIdentity(
        config,
        wallet.provider,
        { blockNumber: checkpoint.height, blockHash: checkpoint.expected },
        () => undefined,
      )
      return wallet
    })
    try {
      const open = async (index: number) => {
        selected = index
        mockState.account = {
          receipt: { context: { accountId: `synthetic-${index}` } },
        }
        mockState.revision++
        mockPrimary = { ...mockPrimary }
        const result = await openEvmWallet('hyperliquid-testnet')
        const address = (await result.wallet.getReceiveAddress()).raw
        const balance = await result.wallet.getBalance()
        expect(result.wallet.chainIdentifier).toBe('hyperliquid-testnet')
        expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(balance).toBe(0n)
        return address
      }
      const a1 = await open(0)
      const b = await open(1)
      expect(b.toLowerCase()).not.toBe(a1.toLowerCase())
      const a2 = await open(0)
      expect(a2.toLowerCase()).toBe(a1.toLowerCase())
    } finally {
      await closeOpenedEvmWallets()
      await rm(stateDir, { recursive: true, force: true })
    }
  },
  90_000,
)
it('does not reuse another account or relay context and cancels an in-flight open on teardown', async () => {
  const first = await openEvmWallet('monad-mainnet')
  const close = jest.spyOn(first.wallet, 'close')
  mockState.account = { receipt: { context: { accountId: 'b' } } }
  const second = await openEvmWallet('monad-mainnet')
  expect(second.wallet).not.toBe(first.wallet)
  expect(close).toHaveBeenCalledTimes(1)
  mockRelay = 'https://other-relay.invalid'
  expect(peekOpenedEvmWallets()).toEqual([])
  const third = await openEvmWallet('monad-mainnet')
  expect(third.wallet).not.toBe(second.wallet)
  let resolve!: (wallet: unknown) => void
  let signal!: AbortSignal
  mockCreate.mockImplementationOnce(input => {
    signal = input.signal
    return new Promise(done => {
      resolve = done
    })
  })
  const pending = openEvmWallet('monad-regtest', {
    blockNumber: 7,
    blockHash: '0x' + 'ab'.repeat(32),
  })
  await new Promise(done => setTimeout(done, 0))
  const failure = expect(pending).rejects.toThrow(/changed/)
  const closing = closeOpenedEvmWallets()
  expect(signal.aborted).toBe(true)
  const late = {
    family: 'evm',
    chainIdentifier: 'monad-regtest',
    close: jest.fn(async () => undefined),
  }
  const lateClose = late.close
  resolve(late)
  await failure
  await closing
  expect(lateClose).toHaveBeenCalledTimes(1)
  expect(peekOpenedEvmWallets()).toEqual([])
})

it('closes an opening account A result instead of publishing it to account B', async () => {
  let resolve!: (wallet: unknown) => void
  mockCreate.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const pending = openEvmWallet('monad-mainnet')
  await new Promise(done => setTimeout(done, 0))
  const rejected = expect(pending).rejects.toThrow(/changed/)
  mockState.account = { receipt: { context: { accountId: 'b' } } }
  const close = jest.fn(async () => undefined)
  resolve({ family: 'evm', chainIdentifier: 'monad-mainnet', close })
  await rejected
  expect(close).toHaveBeenCalledTimes(1)
  expect(peekOpenedEvmWallets()).toEqual([])
  expect((await openEvmWallet('monad-mainnet')).wallet.chainIdentifier).toBe(
    'monad-mainnet',
  )
})
it('binds an operator checkpoint to one opened regtest context instead of silently replacing it', async () => {
  const checkpoint = { blockNumber: 7, blockHash: '0x' + 'ab'.repeat(32) }
  await openEvmWallet('monad-regtest', checkpoint)
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      operatorCheckpoint: checkpoint,
      config: expect.objectContaining({
        chainIdentifier: 'monad-regtest',
        chainId: 20143n,
        networkTag: 'MONR',
      }),
    }),
  )
  expect(() =>
    openEvmWallet('monad-regtest', { ...checkpoint, blockNumber: 8 }),
  ).toThrow(/checkpoint changed/)
  expect(mockCreate).toHaveBeenCalledTimes(1)
})

async function actualEvmOwner(
  networkId: string,
): Promise<EvmChainWalletHandle> {
  const { DERIVATION_REGISTRY_ID } = jest.requireActual('@frank/domain-roots')
  const entry = getChainRegistryEntry(networkId)!
  const config: EvmChainConfig = {
    chainIdentifier: entry.id,
    networkId: entry.id,
    rpcChain: entry.id,
    chainId: BigInt(entry.nativeChainId!),
    networkTag: entry.networkTag!,
    relayBaseUrl: mockRelay,
    walletStorageLocation: false,
    subAccountPoolSize: 0,
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    defaultTopicVoteValueWei: 1n,
  }
  const root = (purpose: string, value: number) => ({
    registry: DERIVATION_REGISTRY_ID,
    purpose,
    bytes: new Uint8Array(32).fill(value),
  })
  const actual = jest.requireActual('@frank/wallet/chain')
  const wallet = (await actual.createEvmChain(config).createWallet({
    evm: root('evm-wallet', 51),
    authentication: root('identity-authentication', 52),
    messaging: root('messaging-encryption', 53),
  })) as EvmChainWalletHandle
  jest
    .spyOn(wallet.provider, 'getNetwork')
    .mockResolvedValue({ chainId: BigInt(entry.nativeChainId!) } as never)
  jest.spyOn(wallet.provider, 'getBlock').mockImplementation(async height => {
    const probe = entry.identityProbes.find(
      probe => probe.kind === 'block-hash',
    )
    return probe?.kind === 'block-hash'
      ? ({ number: height, hash: probe.expected } as never)
      : null
  })
  return wallet
}

it('verifies an actual reused primary checkpoint and numeric identity without closing or replacing its custody', async () => {
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  const close = jest.spyOn(primary, 'close')
  const block = jest.mocked(primary.provider.getBlock)
  const original = block.getMockImplementation()!
  try {
    block.mockResolvedValueOnce({
      number: 0,
      hash: '0x' + '00'.repeat(32),
    } as never)
    await expect(openEvmWallet('monad-testnet')).rejects.toThrow(
      /checkpoint mismatch/,
    )
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    jest
      .mocked(primary.provider.getNetwork)
      .mockResolvedValueOnce({ chainId: 143n } as never)
    await expect(openEvmWallet('monad-testnet')).rejects.toThrow(
      /chain identity mismatch/,
    )
    block.mockImplementation(original)
    expect((await openEvmWallet('monad-testnet')).wallet).toBe(primary)
    await closeOpenedEvmWallets()
    expect(close).not.toHaveBeenCalled()
  } finally {
    await primary.close()
  }
})

let mockRelayCount = 0
/** A relay of its own per test (discovery is cached per relay), advertising `route`. */
function relayAdvertising(route: Record<string, unknown> | undefined) {
  mockRelay = `https://relay-${++mockRelayCount}.invalid`
  const request = jest.fn(async (url: string) => {
    if (url !== `${mockRelay}/chains`) throw new Error(`unexpected ${url}`)
    return {
      ok: true,
      json: async () => ({ schema_version: 1, chains: route ? [route] : [] }),
    }
  })
  globalThis.fetch = request as unknown as typeof fetch
  return request
}
const regtestRoute = (operatorCheckpoint?: unknown) => ({
  id: 'monad-regtest',
  family: 'evm',
  network: 'regtest',
  caip2: 'eip155:20143',
  native_chain_id: '20143',
  capabilities: ['json-rpc'],
  ...(operatorCheckpoint === undefined
    ? {}
    : { operator_checkpoint: operatorCheckpoint }),
})

describe('a network whose registry row requires an operator block checkpoint', () => {
  const originalFetch = globalThis.fetch
  const anchor = { blockNumber: 12, blockHash: '0x' + 'ab'.repeat(32) }
  const advertised = { block_number: 12, block_hash: anchor.blockHash }
  let primary: EvmChainWalletHandle
  let original: string
  beforeEach(async () => {
    expect(
      getChainRegistryEntry('monad-regtest')!.identityProbes.map(p => p.kind),
    ).toContain('operator-block-checkpoint')
    relayAdvertising(regtestRoute(advertised))
    primary = await actualEvmOwner('monad-regtest')
    mockPrimary = primary as unknown as typeof mockPrimary
    original = activeChain.chainIdentifier
    Object.assign(activeChain, { chainIdentifier: 'monad-regtest' })
  })
  afterEach(async () => {
    Object.assign(activeChain, { chainIdentifier: original })
    globalThis.fetch = originalFetch
    await closeOpenedEvmWallets()
    await primary.close()
  })

  // Native Send and a stealth payment's review both open through createNativeTransferContext;
  // balance reads, foreign wallet sync items and dApp requests call openEvmWallet(chain).
  it.each([
    [
      'native send and stealth payment context',
      () => createNativeTransferContext('monad-regtest'),
    ],
    [
      'balance read, foreign sync apply and dApp request',
      () => openEvmWallet('monad-regtest'),
    ],
  ])(
    '%s open the wallet with the checkpoint the relay verified, checked on the route',
    async (_, open) => {
      const block = jest.mocked(primary.provider.getBlock)
      block.mockResolvedValue({
        number: 12,
        hash: anchor.blockHash,
      } as never)
      await expect(open()).resolves.toBeDefined()
      expect(block).toHaveBeenCalledWith(12)
      expect(peekOpenedEvmWallets()).toHaveLength(1)
      expect(peekOpenedEvmWallets()[0].wallet).toBe(primary)
      // Every path shares the one opened owner and the checkpoint it was verified with.
      expect((await openEvmWallet('monad-regtest')).wallet).toBe(primary)
      expect(peekOpenedEvmWallets()).toHaveLength(1)
    },
  )

  it('refuses a route whose chain does not have the checkpoint block', async () => {
    jest.mocked(primary.provider.getBlock).mockResolvedValueOnce({
      number: 12,
      hash: '0x' + 'ff'.repeat(32),
    } as never)
    await expect(createNativeTransferContext('monad-regtest')).rejects.toThrow(
      /checkpoint mismatch/,
    )
    expect(peekOpenedEvmWallets()).toEqual([])
  })

  it.each([
    ['names none', undefined],
    ['names a malformed one', { block_number: 12, block_hash: 'ab' }],
    ['names genesis', { block_number: 0, block_hash: anchor.blockHash }],
  ])(
    'refuses to open, without touching the chain, when the relay %s',
    async (_, checkpoint) => {
      relayAdvertising(regtestRoute(checkpoint))
      const block = jest.mocked(primary.provider.getBlock)
      await expect(
        createNativeTransferContext('monad-regtest'),
      ).rejects.toBeInstanceOf(RelayOperatorCheckpointUnavailableError)
      expect(block).not.toHaveBeenCalled()
      expect(mockCreate).not.toHaveBeenCalled()
    },
  )

  it('keeps the checkpoint an open wallet verified when the relay re-attests a newer one, and a fresh open takes the newer one', async () => {
    const renewed = { blockNumber: 7_000, blockHash: '0x' + 'cd'.repeat(32) }
    let route = regtestRoute(advertised)
    const discovery = jest.fn(async (url: string) => {
      if (url !== `${mockRelay}/chains`) throw new Error(`unexpected ${url}`)
      return {
        ok: true,
        json: async () => ({ schema_version: 1, chains: [route] }),
      }
    })
    globalThis.fetch = discovery as unknown as typeof fetch
    // A pruning regtest node: once the relay has moved on, the first block is gone.
    let pruned = false
    const block = jest.mocked(primary.provider.getBlock)
    block.mockImplementation((async (number: number) =>
      number === anchor.blockNumber && !pruned
        ? { number, hash: anchor.blockHash }
        : number === renewed.blockNumber
        ? { number, hash: renewed.blockHash }
        : null) as never)
    const first = await openEvmWallet('monad-regtest')
    expect(block).toHaveBeenCalledTimes(1)
    expect(block).toHaveBeenLastCalledWith(anchor.blockNumber)

    route = regtestRoute({
      block_number: renewed.blockNumber,
      block_hash: renewed.blockHash,
    })
    pruned = true
    // Sends, balance reads and sync items later in the session reuse the verified owner: the
    // pruned block is not asked for again and the relay is not asked for a checkpoint.
    const requestsBefore = discovery.mock.calls.length
    for (let i = 0; i < 3; i++)
      expect((await openEvmWallet('monad-regtest')).wallet).toBe(first.wallet)
    expect(block).toHaveBeenCalledTimes(1)
    expect(discovery).toHaveBeenCalledTimes(requestsBefore)

    // A fresh open, once the app's short-lived copy of GET /chains has expired, checks the
    // route against the relay's current checkpoint.
    const now = Date.now()
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 60_000)
    await closeOpenedEvmWallets()
    expect((await openEvmWallet('monad-regtest')).wallet).toBe(primary)
    expect(block).toHaveBeenCalledTimes(2)
    expect(block).toHaveBeenLastCalledWith(renewed.blockNumber)

    // And it still refuses a route that does not have the block the relay names.
    await closeOpenedEvmWallets()
    route = regtestRoute(advertised)
    clock.mockReturnValue(now + 120_000)
    await expect(openEvmWallet('monad-regtest')).rejects.toThrow(
      /checkpoint mismatch/,
    )
    clock.mockRestore()
  })

  it('keeps an explicit checkpoint and still verifies it', async () => {
    const block = jest.mocked(primary.provider.getBlock)
    block.mockResolvedValueOnce({
      number: 12,
      hash: '0x' + 'ff'.repeat(32),
    } as never)
    await expect(openEvmWallet('monad-regtest', anchor)).rejects.toThrow(
      /checkpoint mismatch/,
    )
    block.mockResolvedValueOnce({ number: 12, hash: anchor.blockHash } as never)
    expect((await openEvmWallet('monad-regtest', anchor)).wallet).toBe(primary)
  })
})

it('never takes a relay checkpoint for a network whose registry pins one', async () => {
  const originalFetch = globalThis.fetch
  const request = relayAdvertising({
    ...regtestRoute(),
    id: 'monad-testnet',
    network: 'testnet',
    caip2: 'eip155:10143',
    native_chain_id: '10143',
    operator_checkpoint: {
      block_number: 5,
      block_hash: '0x' + 'cd'.repeat(32),
    },
  })
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  try {
    expect((await openEvmWallet('monad-testnet')).wallet).toBe(primary)
    expect(primary.provider.getBlock).toHaveBeenCalledWith(0)
    expect(primary.provider.getBlock).not.toHaveBeenCalledWith(5)
    expect(request).not.toHaveBeenCalled()
    await expect(
      requireRelayOperatorCheckpoint(mockRelay, 'monad-testnet'),
    ).rejects.toThrow(/protocol checkpoint/)
  } finally {
    globalThis.fetch = originalFetch
    await closeOpenedEvmWallets()
    await primary.close()
  }
})

it('waits for actual old custody retirement before same-chain relay replacement while another chain continues', async () => {
  let release!: () => void
  const closing = new Promise<void>(resolve => {
    release = resolve
  })
  const actualOwners: EvmChainWalletHandle[] = []
  mockCreate.mockImplementation(async ({ config }) => {
    const wallet = await actualEvmOwner(config.networkId)
    actualOwners.push(wallet)
    if (actualOwners.length === 1) {
      const close = wallet.close.bind(wallet)
      wallet.close = async () => {
        await closing
        await close()
      }
    }
    return wallet
  })
  try {
    const old = await openEvmWallet('monad-mainnet')
    mockRelay = 'https://replacement.invalid'
    const replacement = openEvmWallet('monad-mainnet')
    await Promise.resolve()
    await Promise.resolve()
    expect(mockCreate).toHaveBeenCalledTimes(1)
    mockPrimary.relayBaseUrl = mockRelay
    expect((await openEvmWallet('monad-testnet')).wallet).toBe(mockPrimary)
    release()
    const next = await replacement
    expect(next.wallet).not.toBe(old.wallet)
    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(peekOpenedEvmWallets()).toContain(next)
  } finally {
    release()
    await closeOpenedEvmWallets()
    await Promise.all(actualOwners.map(wallet => wallet.close()))
  }
})

it('does not publish an actual primary after account replacement during its checkpoint RPC', async () => {
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  const close = jest.spyOn(primary, 'close')
  let resolve!: (block: never) => void
  jest.mocked(primary.provider.getBlock).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  const opening = openEvmWallet('monad-testnet')
  const failed = expect(opening).rejects.toThrow(/Account changed/)
  try {
    await new Promise(done => setTimeout(done, 0))
    mockState.revision++
    const probe = getChainRegistryEntry('monad-testnet')!.identityProbes.find(
      probe => probe.kind === 'block-hash',
    )!
    if (probe.kind !== 'block-hash') throw new Error('missing checkpoint')
    resolve({ number: probe.height, hash: probe.expected } as never)
    await failed
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(close).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  } finally {
    await primary.close()
  }
})

it.each(['public', 'direct'])(
  'retains actual custody retirement through %s cache eviction and concurrent reopen',
  async mode => {
    let release!: () => void
    const deferredClose = new Promise<void>(resolve => {
      release = resolve
    })
    const owners: EvmChainWalletHandle[] = []
    mockCreate.mockImplementation(async ({ config }) => {
      const owner = await actualEvmOwner(config.networkId)
      owners.push(owner)
      if (owners.length === 1) {
        const close = owner.close.bind(owner)
        owner.close = async () => {
          await deferredClose
          await close()
        }
      }
      return owner
    })
    try {
      const first = await openEvmWallet('monad-mainnet')
      const closing =
        mode === 'public' ? closeOpenedEvmWallets() : first.wallet.close()
      const reopen = openEvmWallet('monad-mainnet')
      await new Promise(done => setTimeout(done, 0))
      expect(mockCreate).toHaveBeenCalledTimes(1)
      mockPrimary.relayBaseUrl = mockRelay
      expect((await openEvmWallet('monad-testnet')).wallet).toBe(mockPrimary)
      release()
      await closing
      expect((await reopen).wallet).not.toBe(first.wallet)
      expect(mockCreate).toHaveBeenCalledTimes(2)
    } finally {
      release()
      await closeOpenedEvmWallets()
      await Promise.all(owners.map(owner => owner.close()))
    }
  },
)

it('rejects an active financial context with an actual primary on the wrong checkpoint', async () => {
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  try {
    expect(activeChain.chainIdentifier).toBe('monad-testnet')
    jest.mocked(primary.provider.getBlock).mockResolvedValueOnce({
      number: 0,
      hash: '0x' + '00'.repeat(32),
    } as never)
    await expect(
      createNativeTransferContext(activeChain.chainIdentifier),
    ).rejects.toThrow(/checkpoint mismatch/)
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
  } finally {
    await primary.close()
  }
})

it('normalizes the captured primary relay and rejects a new host relay before pairing chain and owner', async () => {
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  try {
    mockRelay = ' https://relay.invalid/// '
    const original = await openEvmWallet('monad-testnet')
    expect(original.wallet).toBe(primary)
    mockRelay = 'https://replacement.invalid'
    await expect(openEvmWallet('monad-testnet')).rejects.toThrow(
      /Primary EVM relay differs/,
    )
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(mockCreate).not.toHaveBeenCalled()
    expect(primary.relayBaseUrl).toBe('https://relay.invalid')
  } finally {
    await closeOpenedEvmWallets()
    await primary.close()
  }
})

it('rechecks an actual session owner after invalidation at the same persisted revision', async () => {
  const { createAccountSession } =
    jest.requireActual<typeof import('./session')>('./session')
  const { DOMAIN_PURPOSES, DERIVATION_REGISTRY_ID } = jest.requireActual<
    typeof import('@frank/domain-roots')
  >('@frank/domain-roots')
  const account = {
    displayName: 'Fixture',
    descriptor: 'public',
    receipt: { operationId: 'fixture', context: { accountId: 'a' } },
  } as import('./custody').PublicAccount
  const snapshot = { schema: 1, revision: 1, active: account, pending: null }
  let invalidate!: () => void
  const session = createAccountSession({
    listen: callback => {
      invalidate = callback
      return () => undefined
    },
    open: async () =>
      ({
        snapshot: async () => snapshot,
        reconcile: async () => 'ready',
        openActive: async () => ({
          account,
          close: () => undefined,
          takeRoots: () =>
            DOMAIN_PURPOSES.map((purpose, i) => ({
              registry: DERIVATION_REGISTRY_ID,
              purpose,
              bytes: new Uint8Array(32).fill(i + 1),
            })),
        }),
        close: () => undefined,
      } as unknown as import('./custody').AccountCustody),
    createWallet: async () =>
      (await actualEvmOwner(
        'monad-testnet',
      )) as unknown as import('./session').RuntimeWallet,
  })
  mockSessionOverride = session
  try {
    expect(session.peekWallet()).toBeUndefined()
    await session.initialize()
    const first = await openEvmWallet('monad-testnet')
    const binding = await (
      await createNativeTransferContext('monad-testnet')
    ).captureWallet()
    const primaryA = session.peekWallet()
    expect(first.wallet).toBe(primaryA)
    invalidate()
    expect(session.peekWallet()).toBeUndefined()
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(binding.isCurrent()).toBe(false)
    await session.initialize()
    const primaryB = await session.getWallet()
    expect(primaryB).not.toBe(primaryA)
    expect(session.state.revision).toBe(1)
    expect(peekOpenedEvmWallets()).toEqual([])
    expect(binding.isCurrent()).toBe(false)
    const second = await openEvmWallet('monad-testnet')
    expect(second.wallet).toBe(primaryB)
    expect(second.wallet).not.toBe(first.wallet)
    expect(peekOpenedEvmWallets()).toEqual([second])
    expect(mockCreate).not.toHaveBeenCalled()
  } finally {
    await closeOpenedEvmWallets()
    await session.close()
    expect(session.peekWallet()).toBeUndefined()
    mockSessionOverride = undefined
  }
})

it('surfaces retirement failure and never constructs a replacement owner', async () => {
  const first = await openEvmWallet('monad-mainnet')
  jest
    .spyOn(first.wallet, 'close')
    .mockRejectedValueOnce(new Error('close failed'))
  mockRelay = 'https://replacement.invalid'
  await expect(openEvmWallet('monad-mainnet')).rejects.toThrow('close failed')
  expect(mockCreate).toHaveBeenCalledTimes(1)
  expect(peekOpenedEvmWallets()).toEqual([])
})

it('carries a peer EVM sync event through the captured primary mailbox and refuses a changed account', async () => {
  mockEnabledPeerNetworks.add('ethereum-sepolia')
  const primary = await actualEvmOwner('monad-testnet')
  mockPrimary = primary as unknown as typeof mockPrimary
  const send = jest
    .spyOn(activeChain.directMessages, 'send')
    .mockResolvedValue({
      payloadDigest: 'delivered',
    } as never)
  const reconcile = jest.spyOn(activeChain.directMessages, 'reconcileAttempts')
  const messageId = new Uint8Array(16).fill(7)
  const item = {
    type: 'wallet-sync' as const,
    direction: 'out' as const,
    chainIdentifier: 'ethereum-sepolia',
    txHash: `0x${'ab'.repeat(32)}`,
    spentInputs: [],
    createdOutputs: [],
    timestamp: 1728000000000,
  }
  try {
    await openEvmWallet('ethereum-sepolia')
    const config = mockCreate.mock.calls[0][0].config as EvmChainConfig
    expect(config.emitWalletSync).toBeDefined()
    await config.emitWalletSync!(item, undefined, messageId)
    expect(send).toHaveBeenCalledWith({
      wallet: primary,
      recipient: primary.identity.address,
      items: [item],
      stampValue: 0n,
      messageId,
    })
    send.mockRejectedValueOnce(
      new DirectMessageAlreadyAttemptedError(
        'same-id',
        'original-digest',
        'self',
      ),
    )
    reconcile.mockResolvedValueOnce({ 'original-digest': 'delivered' })
    await config.emitWalletSync!(item, undefined, messageId)
    expect(reconcile).toHaveBeenCalledWith({
      wallet: primary,
      payloadDigests: ['original-digest'],
    })
    mockState.account = { receipt: { context: { accountId: 'changed' } } }
    await expect(
      config.emitWalletSync!(item, undefined, messageId),
    ).rejects.toThrow('owner changed')
    expect(send).toHaveBeenCalledTimes(2)
  } finally {
    reconcile.mockRestore()
    send.mockRestore()
    await closeOpenedEvmWallets()
    await primary.close()
  }
})

it('recovers an enabled secondary journal without signing another payment', async () => {
  mockEnabledPeerNetworks.add('ethereum-sepolia')
  const reobserve = jest.fn(async () => undefined)
  const flush = jest
    .fn()
    .mockResolvedValueOnce(['original-operation'])
    .mockResolvedValueOnce([])
  mockCreate.mockImplementation(async ({ config }) => ({
    family: 'evm',
    chainIdentifier: config.chainIdentifier,
    close: jest.fn(async () => undefined),
    reobserveNativeOperations: reobserve,
    flushNativeSync: flush,
  }))
  await expect(
    recoverSecondaryEvmWallets(mockPrimary as never),
  ).rejects.toThrow('original-operation')
  await expect(
    recoverSecondaryEvmWallets(mockPrimary as never),
  ).resolves.toBeUndefined()
  expect(mockCreate).toHaveBeenCalledTimes(1)
  expect(reobserve).toHaveBeenCalledTimes(2)
  expect(flush).toHaveBeenCalledTimes(2)
})
