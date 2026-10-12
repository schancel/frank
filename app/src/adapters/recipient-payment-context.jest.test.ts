import type { DirectMessageReceived, WalletHandle } from '@frank/wallet/chain'
import { recordReceivedAssetPayments } from './pinia-chain-adapter'

const mockAccount = {}
const mockWallet = {
  identity: { address: { raw: 'self' }, displayAddress: 'self' },
}
const mockState = { status: 'ready', revision: 1, account: mockAccount }
const mockKey = Uint8Array.from([2, ...Array<number>(32).fill(1)])
const mockRecord = jest.fn(async () => undefined)
const mockAssertCurrent = jest.fn(async () => undefined)
const mockCaptureWallet = jest.fn(async () => ({
  wallet: {
    chainIdentifier: 'monad-testnet',
    stealthReceipts: { record: mockRecord },
  },
  assertCurrent: mockAssertCurrent,
}))
jest.mock('../accounts/session', () => ({
  accountSession: {
    state: mockState,
    getWallet: jest.fn(async () => mockWallet),
    getCurvePublicKey: jest.fn(async () => mockKey.slice()),
  },
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: jest.fn(async () => ({
    captureWallet: mockCaptureWallet,
  })),
}))
// These modules are irrelevant to this isolated receive boundary.
jest.mock('../stores/chats', () => ({ useChatStore: jest.fn() }))
jest.mock('../utils/outgoing-payments', () => ({
  refreshOutgoingPaymentSummaries: jest.fn(),
}))
jest.mock('../utils/own-profile', () => ({
  syncOwnProfileWithRelay: jest.fn(),
}))

function payment(): DirectMessageReceived {
  const key = Buffer.from(mockKey).toString('hex')
  return {
    senderAddress: { raw: 'sender' },
    recipientAddress: { raw: 'self' },
    payloadDigest: 'cd'.repeat(32),
    stampValueWei: 0n,
    receivedTime: 200,
    items: [
      {
        type: 'stealth-asset',
        transfers: [
          {
            chainIdentifier: 'monad-testnet',
            txId: 'ab'.repeat(32),
            destination: '12'.repeat(20),
            amountAtomic: '20000000',
            asset: { kind: 'token', identifier: '34'.repeat(20) },
            stealthMetadata: { keyType: 1, ephemeralPubKey: key },
            recipientSpendKey: { keyType: 1, publicKey: key },
            derivationScheme: 1,
            rawTx: '010203',
          },
        ],
      },
    ],
  }
}
beforeEach(() => {
  jest.clearAllMocks()
  mockState.status = 'ready'
  mockState.revision = 1
  mockRecord.mockResolvedValue(undefined)
  mockAssertCurrent.mockResolvedValue(undefined)
})

test('actual receive projection durably records exact token claim before returning', async () => {
  await recordReceivedAssetPayments(
    payment(),
    mockWallet as WalletHandle,
    () => false,
  )
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      amountAtomic: 20000000n,
      asset: { kind: 'erc20', contractAddress: '0x' + '34'.repeat(20) },
      payloadDigest: 'cd'.repeat(32),
    }),
  )
})
test('does not apply own loopback or ordinary messages as recipient claims', async () => {
  await recordReceivedAssetPayments(
    { ...payment(), outbound: true },
    mockWallet,
    () => false,
  )
  await recordReceivedAssetPayments(
    { ...payment(), items: [{ type: 'text', text: 'hello' }] },
    mockWallet,
    () => false,
  )
  expect(mockCaptureWallet).not.toHaveBeenCalled()
})
test('receipt persistence failure rejects before ordinary delivery can advance', async () => {
  mockRecord.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(
    recordReceivedAssetPayments(payment(), mockWallet, () => false),
  ).rejects.toThrow('storage unavailable')
})
test('replacement during wallet capture cannot install a foreign receipt', async () => {
  mockAssertCurrent.mockImplementationOnce(async () => {
    mockState.revision += 1
  })
  await expect(
    recordReceivedAssetPayments(payment(), mockWallet, () => false),
  ).rejects.toThrow('Account changed')
  expect(mockRecord).not.toHaveBeenCalled()
})
test('stopped stream callback cannot begin recipient mutation', async () => {
  await expect(
    recordReceivedAssetPayments(payment(), mockWallet, () => true),
  ).rejects.toThrow('Account changed')
  expect(mockRecord).not.toHaveBeenCalled()
})
