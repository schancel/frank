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
    get: jest.fn(async () => ({ ...reference })),
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
