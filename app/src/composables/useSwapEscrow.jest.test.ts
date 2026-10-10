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

// The EVM tests below need a GenericHTLC address for monad-testnet. Addresses come only from
// deployment records, so this file supplies one; ethereum-sepolia is left without.
jest.mock('../../../packages/contracts/deployments', () => {
  const contract = (address: string) => ({
    address,
    deployedVia: 'create2-proxy',
    transactionHash: '0x' + '00'.repeat(32),
    blockNumber: 1,
  })
  return {
    DEPLOYMENTS: {
      'monad-testnet': {
        chainIdentifier: 'monad-testnet',
        chainId: '10143',
        contracts: {
          GenericHTLC: contract('0x00000000000000000000000000000000000000A1'),
          StateChannel: contract('0x00000000000000000000000000000000000000A2'),
        },
      },
    },
  }
})

const mockSubmitRawTransaction = jest.fn().mockResolvedValue('0xmockedevmtxhash123')

jest.mock('../utils/clients', () => ({
  useMonadWallet: () => ({
    provider: mockProvider,
    identity: {
      toPrivateKeyHex: () => '0x' + '11'.repeat(32),
    },
    httpClient: {
      submitRawTransaction: mockSubmitRawTransaction,
      getTransactionReceipt: jest.fn().mockResolvedValue({ status: 1 }),
    },
  }),
}))

describe('useSwapEscrow', () => {
  beforeEach(() => {
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

  it('deposits and locks funds on EVM chain', async () => {
    const { depositLock } = useSwapEscrow()

    const res = await depositLock({
      swapId: 'swap-test-id-1',
      chain: 'monad-testnet',
      amount: '1.5',
      recipient: '0x2222222222222222222222222222222222222222',
      durationSeconds: 3600,
    })

    expect(res.txHash).toBe('0xmockedevmtxhash123')
    expect(res.hashLock).toBeDefined()
    expect(res.preimageHex).toBeDefined()
    expect(res.lockId).toBeDefined()
  })

  it('claims funds with preimage on EVM chain', async () => {
    const { claimLock } = useSwapEscrow()

    const res = await claimLock({
      swapId: 'swap-test-id-1',
      chain: 'monad-testnet',
      preimage: '0x' + '33'.repeat(32),
    })

    expect(res.txHash).toBe('0xmockedevmtxhash123')
  })

  it('refunds expired funds on EVM chain', async () => {
    const { refundLock } = useSwapEscrow()

    const res = await refundLock({
      swapId: 'swap-test-id-1',
      chain: 'monad-testnet',
    })

    expect(res.txHash).toBe('0xmockedevmtxhash123')
  })

  it('refuses to lock, claim or refund on a network where GenericHTLC is not deployed', async () => {
    const { depositLock, claimLock, refundLock } = useSwapEscrow()
    mockSubmitRawTransaction.mockClear()
    const notDeployed = 'GenericHTLC is not deployed on ethereum-sepolia'

    await expect(
      depositLock({
        swapId: 'swap-test-id-2',
        chain: 'ethereum-sepolia',
        amount: '1.5',
        recipient: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toThrow(notDeployed)
    await expect(
      claimLock({
        swapId: 'swap-test-id-2',
        chain: 'ethereum-sepolia',
        preimage: '0x' + '33'.repeat(32),
      }),
    ).rejects.toThrow(notDeployed)
    await expect(
      refundLock({ swapId: 'swap-test-id-2', chain: 'ethereum-sepolia' }),
    ).rejects.toThrow(notDeployed)
    await expect(
      depositLock({
        swapId: 'swap-test-id-2',
        chain: 'not-a-chain',
        amount: '1.5',
        recipient: '0x2222222222222222222222222222222222222222',
      }),
    ).rejects.toThrow('Unknown chain identifier "not-a-chain"')

    expect(mockSubmitRawTransaction).not.toHaveBeenCalled()
  })

  it('deposits funds on Solana chain', async () => {
    const { depositLock } = useSwapEscrow()

    const res = await depositLock({
      swapId: 'swap-solana-1',
      chain: 'solana-testnet',
      amount: '2.5',
      recipient: '11111111111111111111111111111111',
    })

    expect(res.txHash).toBeDefined()
    expect(res.hashLock).toBeDefined()
  })
})
