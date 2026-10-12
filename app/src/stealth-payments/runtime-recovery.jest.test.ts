import { activeChain } from '@frank/wallet/chain'
import { financialRecoveryForPolling } from './runtime-recovery'

const mockState = { status: 'ready', account: {}, revision: 1 }
const mockSubmit = jest.fn(async () => ({
  status: 'pending',
  intendedAmountAtomic: 20n,
}))
const mockReconcile = jest.fn(async () => ({
  status: 'succeeded',
  intendedAmountAtomic: 20n,
  verifiedReceivedAmountAtomic: 20n,
}))
const mockList = jest.fn(async () => [
  { operationId: 'original', payloadDigest: 'ab'.repeat(32) },
])
const mockPrimary = {
  chainIdentifier: 'monad-testnet',
  stealthPayments: {
    list: mockList,
    submit: mockSubmit,
    reconcile: mockReconcile,
  },
}
const mockUtxo = {
  chainIdentifier: 'xec-testnet',
  stealthPayments: {
    list: jest.fn(async () => []),
    submit: jest.fn(),
    reconcile: jest.fn(),
  },
}
const mockPeek = jest.fn(() => [{ wallet: mockUtxo }])
jest.mock('../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    getWallet: async () => mockPrimary,
  },
}))
jest.mock('../accounts/utxo-wallets', () => ({
  peekOpenedUtxoWallets: () => mockPeek(),
}))

beforeEach(() => {
  jest.restoreAllMocks()
  mockState.status = 'ready'
  mockState.revision = 1
  mockSubmit
    .mockReset()
    .mockResolvedValue({ status: 'pending', intendedAmountAtomic: 20n })
  mockReconcile.mockClear()
  mockList.mockClear()
  mockPeek.mockClear()
})
test('polling runtime retries the original delivered financial operation without any chat row', async () => {
  const delivery = jest.fn(async () => 'delivered' as const)
  const client = activeChain.directMessages
  const original = client.deliveryOf
  client.deliveryOf = delivery
  const errors = jest.fn()
  const recovery = financialRecoveryForPolling({
    wallet: mockPrimary as never,
    isCancelled: () => false,
    onError: errors,
  })
  mockSubmit.mockRejectedValueOnce(new Error('offline submission'))
  try {
    await recovery.tick()
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'original', stage: 'submit' }),
    )
    await recovery.tick()
    expect(mockSubmit).toHaveBeenNthCalledWith(1, 'original')
    expect(mockSubmit).toHaveBeenNthCalledWith(2, 'original')
    expect(mockReconcile).toHaveBeenCalledWith('original')
    expect(delivery).toHaveBeenCalledWith({
      wallet: mockPrimary,
      payloadDigest: 'ab'.repeat(32),
    })
    expect(mockPeek).toHaveBeenCalled()
  } finally {
    client.deliveryOf = original
  }
})
test('held delivery and replaced accounts cannot submit through the runtime driver', async () => {
  const client = activeChain.directMessages
  const original = client.deliveryOf
  client.deliveryOf = async () => 'live'
  const recovery = financialRecoveryForPolling({
    wallet: mockPrimary as never,
    isCancelled: () => false,
    onError: jest.fn(),
  })
  try {
    await recovery.tick()
    expect(mockSubmit).not.toHaveBeenCalled()
    mockState.revision += 1
    client.deliveryOf = async () => 'delivered'
    await recovery.tick()
    expect(mockSubmit).not.toHaveBeenCalled()
  } finally {
    client.deliveryOf = original
  }
})
