import {
  createEvmChain,
  getChainRegistryEntry,
  type EvmChainWalletHandle,
  type EvmChainConfig,
} from '@frank/wallet/chain'
import {
  openEvmWallet,
  peekOpenedEvmWallets,
  closeOpenedEvmWallets,
} from './evm-wallets'
const mockState = {
  status: 'ready',
  account: { receipt: { context: { accountId: 'a' } } },
  revision: 1,
}
const mockCreate = jest.fn()
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
  chainIdentifier: string
  close: () => Promise<void>
  provider: {
    getNetwork: () => Promise<{ chainId: bigint }>
    getBlock: typeof mockPrimaryBlock
  }
} = {
  family: 'evm',
  chainIdentifier: 'monad-testnet',
  close: mockPrimaryClose,
  provider: {
    getNetwork: async () => ({ chainId: 10143n }),
    getBlock: mockPrimaryBlock,
  },
}
const mockGetWallet = jest.fn(async () => mockPrimary)
let mockRelay = 'https://relay.invalid'
jest.mock('./session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    createEvmWallet: (...args: unknown[]) => mockCreate(...args),
    getWallet: () => mockGetWallet(),
  },
}))
jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  createEvmChain: jest.fn(config => ({
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
  mockState.status = 'ready'
  mockState.revision++
  mockState.account = { receipt: { context: { accountId: 'a' } } }
  mockRelay = 'https://relay.invalid'
  mockPrimary = {
    family: 'evm',
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
  const testConfig = jest.mocked(createEvmChain).mock.calls[1]![0]
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
  expect(createEvmChain).toHaveBeenCalledTimes(2)
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
  await Promise.resolve()
  await Promise.resolve()
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
  await Promise.resolve()
  await Promise.resolve()
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

it('requires and verifies the operator anchor even for an actual regtest primary', async () => {
  const primary = await actualEvmOwner('monad-regtest')
  mockPrimary = primary as unknown as typeof mockPrimary
  const anchor = { blockNumber: 12, blockHash: '0x' + 'ab'.repeat(32) }
  const block = jest.mocked(primary.provider.getBlock)
  const close = jest.spyOn(primary, 'close')
  try {
    expect(() => openEvmWallet('monad-regtest')).toThrow(
      /operator checkpoint is required/,
    )
    expect(block).not.toHaveBeenCalled()
    block.mockResolvedValueOnce({
      number: 12,
      hash: '0x' + 'ff'.repeat(32),
    } as never)
    await expect(openEvmWallet('monad-regtest', anchor)).rejects.toThrow(
      /checkpoint mismatch/,
    )
    expect(peekOpenedEvmWallets()).toEqual([])
    block.mockResolvedValueOnce({ number: 12, hash: anchor.blockHash } as never)
    expect((await openEvmWallet('monad-regtest', anchor)).wallet).toBe(primary)
    expect(mockCreate).not.toHaveBeenCalled()
    await closeOpenedEvmWallets()
    expect(close).not.toHaveBeenCalled()
  } finally {
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
