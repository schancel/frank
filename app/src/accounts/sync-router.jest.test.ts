import { AppMultiChainWalletResolver } from './sync-router'
import { accountSession } from './session'
import { useMonadWallet, useWallet } from '../utils/clients'

jest.mock('./session', () => ({
  accountSession: {
    getWallet: jest.fn(),
  },
}))

jest.mock('../utils/clients', () => ({
  useMonadWallet: jest.fn(),
  useWallet: jest.fn(),
}))

describe('AppMultiChainWalletResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('resolves useMonadWallet for EVM chain when available', async () => {
    const mockMonadWallet = { id: 'monad-wallet-handle' }
    ;(useMonadWallet as jest.Mock).mockReturnValue(mockMonadWallet)

    const resolver = new AppMultiChainWalletResolver()
    const wallet = await resolver.getWalletForChain('monad-testnet')

    expect(useMonadWallet).toHaveBeenCalled()
    expect(wallet).toBe(mockMonadWallet)
  })

  it('falls back to accountSession.getWallet for EVM chain when useMonadWallet throws', async () => {
    const mockSessionWallet = { id: 'session-wallet' }
    ;(useMonadWallet as jest.Mock).mockImplementation(() => {
      throw new Error('Messaging is not available yet')
    })
    ;(accountSession.getWallet as jest.Mock).mockResolvedValue(mockSessionWallet)

    const resolver = new AppMultiChainWalletResolver()
    const wallet = await resolver.getWalletForChain('monad-mainnet')

    expect(useMonadWallet).toHaveBeenCalled()
    expect(accountSession.getWallet).toHaveBeenCalled()
    expect(wallet).toBe(mockSessionWallet)
  })

  it('resolves useWallet for Bitcoin / eCash / Lotus chains', async () => {
    const mockUtxoWallet = { id: 'lotus-utxo-wallet' }
    ;(useWallet as jest.Mock).mockReturnValue(mockUtxoWallet)

    const resolver = new AppMultiChainWalletResolver()
    const xecWallet = await resolver.getWalletForChain('xec-mainnet')
    expect(xecWallet).toBe(mockUtxoWallet)

    const lotusWallet = await resolver.getWalletForChain('lotus')
    expect(lotusWallet).toBe(mockUtxoWallet)
  })

  it('returns undefined for Bitcoin chain when useWallet throws', async () => {
    ;(useWallet as jest.Mock).mockImplementation(() => {
      throw new Error('Wallet not initialized')
    })

    const resolver = new AppMultiChainWalletResolver()
    const wallet = await resolver.getWalletForChain('xec-testnet')
    expect(wallet).toBeUndefined()
  })

  it('resolves solanaWallet when set', async () => {
    const mockSolanaWallet = { id: 'solana-wallet-handle' }
    const resolver = new AppMultiChainWalletResolver({ solanaWallet: mockSolanaWallet })

    const wallet = await resolver.getWalletForChain('solana-mainnet')
    expect(wallet).toBe(mockSolanaWallet)
  })

  it('returns undefined for Solana when no solana wallet configured', async () => {
    const resolver = new AppMultiChainWalletResolver()
    const wallet = await resolver.getWalletForChain('solana-mainnet')
    expect(wallet).toBeUndefined()
  })

  it('returns undefined for unknown chain families', async () => {
    const resolver = new AppMultiChainWalletResolver()
    const wallet = await resolver.getWalletForChain('completely-unknown-chain')
    expect(wallet).toBeUndefined()
  })
})
