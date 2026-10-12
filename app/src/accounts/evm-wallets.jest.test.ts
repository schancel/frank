import { createEvmChain } from '@frank/wallet/chain'
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
const mockPrimary = {
  family: 'evm',
  chainIdentifier: 'monad-testnet',
  close: mockPrimaryClose,
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
  const pending = openEvmWallet('monad-regtest')
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
