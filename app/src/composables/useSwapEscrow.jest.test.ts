/** @jest-environment jsdom */

import { setActivePinia, createPinia } from 'pinia'
import { useSwapEscrow } from './useSwapEscrow'
import nodeCrypto from 'crypto'

// Ensure jsdom has Node's native webcrypto and is treated as secure context
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: nodeCrypto.webcrypto,
    configurable: true,
    writable: true,
  })
}
Object.defineProperty(globalThis, 'isSecureContext', {
  value: true,
  configurable: true,
  writable: true,
})

const mockProvider = {
  call: jest.fn().mockResolvedValue('0x'),
  getTransactionCount: jest.fn().mockResolvedValue(0),
  estimateGas: jest.fn().mockResolvedValue(21000n),
  getFeeData: jest.fn().mockResolvedValue({
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    gasPrice: null,
  }),
  getNetwork: jest.fn().mockResolvedValue({ chainId: 10143n }),
}

// A wallet that could sign and submit, so the tests can show that nothing asks it to.
const mockSubmitRawTransaction = jest
  .fn()
  .mockResolvedValue('0xmockedevmtxhash123')
const mockToPrivateKeyHex = jest.fn(() => '0x' + '11'.repeat(32))
const mockBuildAndSignCall = jest.fn()

jest.mock('@frank/wallet/monad-account-tx', () => ({
  MonadAccountTxSigner: jest.fn().mockImplementation(() => ({
    buildAndSignCall: mockBuildAndSignCall,
  })),
}))

jest.mock('../utils/clients', () => ({
  useMonadWallet: () => ({
    provider: mockProvider,
    identity: { toPrivateKeyHex: mockToPrivateKeyHex },
    httpClient: {
      submitRawTransaction: mockSubmitRawTransaction,
      getTransactionReceipt: jest.fn().mockResolvedValue({ status: 1 }),
    },
  }),
}))

describe('useSwapEscrow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('evaluates swap phases correctly', () => {
    const { evaluatePhase } = useSwapEscrow()

    const makerPhase = evaluatePhase({
      isMaker: true,
      offerStatus: 'pending',
      legALock: null,
      legBLock: null,
    })

    expect(makerPhase.phase).toBe('maker_lock_needed')
    expect(makerPhase.canLock).toBe(true)
    expect(makerPhase.canClaim).toBe(false)
  })

  // Atomic swaps are being rebuilt. Until then these refuse on every chain, with a wallet
  // that could sign, and never hand back a transaction hash (they used to return a random
  // one for Solana and when no submitter was present).
  it.each([
    'monad-testnet',
    'ethereum-sepolia',
    'solana-testnet',
    'not-a-chain',
  ])(
    'refuses to lock, claim or refund on %s, and signs and submits nothing',
    async chain => {
      const { depositLock, claimLock, refundLock, error } = useSwapEscrow()
      const refused = 'Atomic swaps are not available yet'

      await expect(
        depositLock({
          swapId: 'swap-test-id-1',
          chain,
          amount: '1.5',
          recipient: '0x2222222222222222222222222222222222222222',
          refundAddress: '0x3333333333333333333333333333333333333333',
          hashLock: '0x' + '44'.repeat(32),
          durationSeconds: 3600,
        }),
      ).rejects.toThrow(refused)
      await expect(
        claimLock({
          swapId: 'swap-test-id-1',
          chain,
          preimage: '0x' + '33'.repeat(32),
        }),
      ).rejects.toThrow(refused)
      await expect(
        refundLock({ swapId: 'swap-test-id-1', chain }),
      ).rejects.toThrow(refused)

      expect(error.value).toBe(refused)
      expect(mockToPrivateKeyHex).not.toHaveBeenCalled()
      expect(mockBuildAndSignCall).not.toHaveBeenCalled()
      expect(mockSubmitRawTransaction).not.toHaveBeenCalled()
      expect(mockProvider.estimateGas).not.toHaveBeenCalled()
      expect(mockProvider.getTransactionCount).not.toHaveBeenCalled()
    },
  )
})
