import { openTempoPathUsdWallet } from './tempo-wallets'
import { accountSession } from './session'
import { createMonadJsonRpcProvider } from '@frank/wallet/monad-provider'
import { LevelRecordStore } from '@frank/wallet/storage/evm-coin-store'

jest.mock('./session', () => ({
  accountSession: {
    getWallet: jest.fn(),
    peekWallet: jest.fn(),
    createTempoMainAccountSigner: jest.fn(),
    getCurvePublicKey: jest.fn(),
  },
}))
jest.mock('@frank/wallet/chain', () => ({
  ...jest.requireActual('@frank/wallet/chain'),
  loadMonadChainConfigFromEnv: () => ({
    relayBaseUrl: 'https://relay.example',
    walletStorageLocation: 'tempo-test-store',
    rpcChain: 'monad-testnet',
    networkId: 'monad-testnet',
    networkTag: 'MONT',
  }),
}))
jest.mock('@frank/wallet/monad-provider', () => ({
  ...jest.requireActual('@frank/wallet/monad-provider'),
  createMonadJsonRpcProvider: jest.fn(),
}))

beforeEach(() => jest.clearAllMocks())

test('Tempo host rejects a wrong RPC chain before opening financial stores', async () => {
  const identity = {
    address: { raw: '0x1111111111111111111111111111111111111111' },
    signHash: jest.fn(),
  }
  const owner = {
    identity,
    chainIdentifier: 'monad-testnet',
    networkId: 'monad-testnet',
  }
  jest.mocked(accountSession.getWallet).mockResolvedValue(owner as never)
  jest.mocked(accountSession.peekWallet).mockReturnValue(owner as never)
  jest.mocked(accountSession.createTempoMainAccountSigner).mockResolvedValue({
    source: {
      kind: 'main',
      address: '0x2222222222222222222222222222222222222222',
    },
    signDigest: jest.fn(),
  })
  jest
    .mocked(accountSession.getCurvePublicKey)
    .mockResolvedValue(new Uint8Array(33).fill(2))
  const destroy = jest.fn()
  const send = jest.fn(async () => '0x1') // Moderato is 42431, not 1.
  jest
    .mocked(createMonadJsonRpcProvider)
    .mockReturnValue({ send, destroy } as never)
  const storage = jest.spyOn(LevelRecordStore, 'open')
  try {
    await expect(openTempoPathUsdWallet('tempo-testnet')).rejects.toThrow(
      'chain ID mismatch',
    )
    expect(createMonadJsonRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcUrl: 'https://relay.example/chain-rpc/tempo-testnet/rpc',
        chainId: 42431,
        relayAuth: expect.objectContaining({
          chain: 'tempo-testnet',
          networkTag: 'MONT',
        }),
      }),
    )
    expect(storage).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledTimes(1)
  } finally {
    storage.mockRestore()
  }
})

test('Tempo host refuses a primary account from another directory network before opening custody or RPC', async () => {
  const owner = {
    chainIdentifier: 'monad-mainnet',
    networkId: 'monad-mainnet',
  }
  jest.mocked(accountSession.getWallet).mockResolvedValue(owner as never)
  const storage = jest.spyOn(LevelRecordStore, 'open')
  try {
    await expect(openTempoPathUsdWallet('tempo-testnet')).rejects.toThrow(
      'Tempo relay identity does not match the active account',
    )
    expect(accountSession.createTempoMainAccountSigner).not.toHaveBeenCalled()
    expect(createMonadJsonRpcProvider).not.toHaveBeenCalled()
    expect(storage).not.toHaveBeenCalled()
  } finally {
    storage.mockRestore()
  }
})
