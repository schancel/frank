const mockGetWallet = jest.fn()
const mockCreateContext = jest.fn()
jest.mock('../accounts/session', () => ({
  accountSession: { getWallet: () => mockGetWallet() },
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: (id: string) => mockCreateContext(id),
}))
import { captureOutgoingFinancialOperations } from './outgoing'
import type { WalletHandle } from '@frank/wallet/chain'

const primary = {} as WalletHandle
const refs = [
  { chainIdentifier: 'xec-testnet', operationId: 'xec' },
  { chainIdentifier: 'monad-testnet', operationId: 'token' },
]
function owner(reference: (typeof refs)[number]) {
  const capability = {
    get: jest.fn(
      async (
        _operationId: string,
      ): Promise<{
        chainIdentifier: string
        operationId: string
        asset?: { kind: 'native' }
      }> => ({ ...reference }),
    ),
    expose: jest.fn(async () => undefined),
    submit: jest.fn(async () => undefined),
    prepare: jest.fn(),
    release: jest.fn(),
  }
  const binding = {
    wallet: { stealthPayments: capability },
    assertCurrent: jest.fn(async () => undefined),
  }
  return { capability, binding }
}
beforeEach(() => {
  jest.clearAllMocks()
  mockGetWallet.mockResolvedValue(primary)
})
test('replays a partially completed binding with the same digest and no fresh preparation or release', async () => {
  const owners = refs.map(owner)
  mockCreateContext.mockImplementation(async id => ({
    captureWallet: async () =>
      owners[refs.findIndex(ref => ref.chainIdentifier === id)].binding,
  }))
  const captured = await captureOutgoingFinancialOperations(primary, refs)
  owners[1].capability.expose.mockRejectedValueOnce(new Error('disk full'))
  await expect(captured.expose('a'.repeat(64))).rejects.toThrow('disk full')
  await captured.expose('a'.repeat(64))
  for (let i = 0; i < owners.length; i++) {
    expect(owners[i].capability.expose.mock.calls).toEqual([
      [{ operationId: refs[i].operationId, payloadDigest: 'a'.repeat(64) }],
      [{ operationId: refs[i].operationId, payloadDigest: 'a'.repeat(64) }],
    ])
    expect(owners[i].capability.prepare).not.toHaveBeenCalled()
    expect(owners[i].capability.release).not.toHaveBeenCalled()
  }
})
test('rejects a replaced messaging account before exposing any captured financial owner', async () => {
  const first = owner(refs[0])
  mockCreateContext.mockResolvedValue({
    captureWallet: async () => first.binding,
  })
  const captured = await captureOutgoingFinancialOperations(primary, [refs[0]])
  mockGetWallet.mockResolvedValue({})
  await expect(captured.expose('a'.repeat(64))).rejects.toThrow(
    'account changed',
  )
  expect(first.capability.expose).not.toHaveBeenCalled()
})
test('attempts every original submission even if one owner cannot submit', async () => {
  const owners = refs.map(owner)
  mockCreateContext.mockImplementation(async id => ({
    captureWallet: async () =>
      owners[refs.findIndex(ref => ref.chainIdentifier === id)].binding,
  }))
  const captured = await captureOutgoingFinancialOperations(primary, refs)
  owners[0].capability.submit.mockRejectedValueOnce(new Error('timeout'))
  await expect(captured.submit()).rejects.toThrow('remains pending')
  owners.forEach((value, i) =>
    expect(value.capability.submit).toHaveBeenCalledWith(refs[i].operationId),
  )
})
test('refuses a missing or foreign operation instead of preparing a replacement', async () => {
  const first = owner(refs[0])
  first.capability.get.mockResolvedValueOnce({
    ...refs[0],
    chainIdentifier: 'bch-testnet',
  })
  mockCreateContext.mockResolvedValue({
    captureWallet: async () => first.binding,
  })
  await expect(
    captureOutgoingFinancialOperations(primary, [refs[0]]),
  ).rejects.toThrow('unavailable')
  expect(first.capability.prepare).not.toHaveBeenCalled()
  expect(first.capability.expose).not.toHaveBeenCalled()
})

test('captures the original same-wallet native operation for the message stamp without preparing again', async () => {
  const reference = {
    chainIdentifier: 'monad-testnet',
    operationId: 'native-payment',
  }
  const first = owner(reference)
  const wallet = {
    chainIdentifier: reference.chainIdentifier,
    stealthPayments: { ...first.capability, supportsCombinedStamp: true },
  } as unknown as WalletHandle
  first.capability.get.mockResolvedValue({
    ...reference,
    asset: { kind: 'native' },
  })
  mockGetWallet.mockResolvedValue(wallet)
  mockCreateContext.mockResolvedValue({
    captureWallet: async () => ({ ...first.binding, wallet }),
  })
  const captured = await captureOutgoingFinancialOperations(wallet, [reference])
  expect(captured.paymentOperationId).toBe(reference.operationId)
  expect(first.capability.prepare).not.toHaveBeenCalled()
  expect(first.capability.expose).not.toHaveBeenCalled()
  await captured.expose('a'.repeat(64))
  expect(first.capability.expose).toHaveBeenCalledWith({
    operationId: reference.operationId,
    payloadDigest: 'a'.repeat(64),
  })
})

test('does not combine a native operation from another captured wallet', async () => {
  const reference = {
    chainIdentifier: 'ethereum-sepolia',
    operationId: 'native-payment',
  }
  const first = owner(reference)
  Object.assign(first.binding.wallet.stealthPayments, {
    supportsCombinedStamp: true,
  })
  first.capability.get.mockResolvedValue({
    ...reference,
    asset: { kind: 'native' },
  })
  mockCreateContext.mockResolvedValue({
    captureWallet: async () => first.binding,
  })
  const captured = await captureOutgoingFinancialOperations(primary, [
    reference,
  ])
  expect(captured.paymentOperationId).toBeUndefined()
  expect(first.capability.prepare).not.toHaveBeenCalled()
})

test('rejects multiple combined native owners before exposing any of them', async () => {
  const references = ['one', 'two'].map(operationId => ({
    chainIdentifier: 'monad-testnet',
    operationId,
  }))
  const first = owner(references[0])
  first.capability.get.mockImplementation(async operationId => ({
    chainIdentifier: 'monad-testnet',
    operationId,
    asset: { kind: 'native' },
  }))
  const wallet = {
    chainIdentifier: 'monad-testnet',
    stealthPayments: { ...first.capability, supportsCombinedStamp: true },
  } as unknown as WalletHandle
  mockGetWallet.mockResolvedValue(wallet)
  mockCreateContext.mockResolvedValue({
    captureWallet: async () => ({ ...first.binding, wallet }),
  })
  await expect(
    captureOutgoingFinancialOperations(wallet, references),
  ).rejects.toThrow('multiple native payment')
  expect(first.capability.expose).not.toHaveBeenCalled()
  expect(first.capability.prepare).not.toHaveBeenCalled()
})
