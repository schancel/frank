import { activeChain } from '@frank/wallet/chain'
import {
  reviewStealthPayment,
  sendReviewedStealthPayment,
} from './review-payment'
import type {
  StealthPaymentQuote,
  PreparedStealthPayment,
} from '@frank/wallet/stealth-payment'

const mockKey = Uint8Array.from([2, ...Array<number>(32).fill(1)])
const mockWallet = {}
const mockState = { status: 'ready', account: {}, revision: 1 }
const mockQuote = jest.fn()
const mockPrepare = jest.fn()
const mockRelease = jest.fn()
const mockStampQuote = jest.fn()
const mockBindingCheck = jest.fn(async () => undefined)
jest.mock('../accounts/session', () => ({
  accountSession: {
    get state() {
      return mockState
    },
    getWallet: async () => mockWallet,
  },
}))
jest.mock('../accounts/native-transfer', () => ({
  createNativeTransferContext: async () => ({
    captureWallet: async () => ({
      wallet: {
        stealthPayments: {
          quote: mockQuote,
          prepare: mockPrepare,
          release: mockRelease,
        },
      },
      assertCurrent: mockBindingCheck,
    }),
  }),
}))
const request = {
  address: '0x1111111111111111111111111111111111111111',
  chainIdentifier: 'monad-testnet',
  assetKey: 'monad-testnet:erc20:0x' + '34'.repeat(20),
  asset: { kind: 'erc20' as const, contractAddress: '0x' + '34'.repeat(20) },
  amountAtomic: 20000000n,
  memo: 'lunch',
}
function quote(operationId: string): StealthPaymentQuote {
  return {
    operationId,
    chainIdentifier: request.chainIdentifier,
    asset: { ...request.asset },
    amountAtomic: request.amountAtomic,
    recipientAddress: '0x' + '12'.repeat(20),
    sourceAddress: '0x' + '56'.repeat(20),
    recipientDestination: Uint8Array.from(Array<number>(20).fill(0x12)),
    recipientSpendPublicKey: mockKey.slice(),
    ephemeralPublicKey: mockKey.slice(),
    nativeBalanceAtomic: 100n,
    assetBalanceAtomic: 21000000n,
    estimatedNativeFeeAtomic: 10n,
  }
}
beforeEach(() => {
  jest.restoreAllMocks()
  mockState.status = 'ready'
  mockState.revision = 1
  mockBindingCheck.mockReset().mockResolvedValue(undefined)
  mockRelease.mockReset().mockResolvedValue(true)
  mockStampQuote.mockReset()
  mockStampQuote.mockImplementation(async params => ({
    status: 'available',
    chainIdentifier: activeChain.chainIdentifier,
    stampValueAtomic: params.stampValue,
    spendableCapacityAtomic: 100n,
    maximumNativeFeeAtomic: params.stampValue === 0n ? 0n : 2n,
  }))
  jest
    .spyOn(activeChain.directMessages, 'quoteStamp')
    .mockImplementation(mockStampQuote)
  jest
    .spyOn(activeChain, 'fetchProfile')
    .mockResolvedValue({ address: { raw: request.address }, pubKey: mockKey })
  mockQuote
    .mockReset()
    .mockImplementation(async intent => quote(intent.operationId))
  mockPrepare.mockReset().mockImplementation(async intent => {
    const observed = quote(intent.operationId)
    return {
      ...observed,
      members: [
        {
          rawTransaction: '010203',
          txHash: 'ab'.repeat(32),
          recipientAmountAtomic: request.amountAtomic,
        },
      ],
    } as PreparedStealthPayment
  })
})
test('quotes without signing and prepares the exact reviewed token intent and finite native fee', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 7n,
    isCurrent: () => true,
  })
  expect(mockPrepare).not.toHaveBeenCalled()
  await captured.prepare()
  expect(mockPrepare).toHaveBeenCalledWith(
    expect.objectContaining({
      chainIdentifier: 'monad-testnet',
      amountAtomic: 20000000n,
      asset: request.asset,
      maxNativeFeeAtomic: 10n,
      recipientSpendPublicKey: mockKey,
    }),
  )
  expect(captured.stampValue).toBe(7n)
})
test('changing the visible quote public bytes cannot redirect the captured preparation', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  captured.quote.ephemeralPublicKey.fill(9)
  captured.quote.recipientDestination.fill(9)
  await expect(captured.prepare()).resolves.toBeDefined()
})
test('account replacement and route cancellation fence signing', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  mockState.revision += 1
  await expect(captured.prepare()).rejects.toThrow('changed')
  expect(mockPrepare).not.toHaveBeenCalled()
})
test('changed prepared destination is rejected before it can become a message item', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  mockPrepare.mockImplementationOnce(async intent => ({
    ...quote(intent.operationId),
    recipientAddress: 'other',
    members: [],
  }))
  await expect(captured.prepare()).rejects.toThrow('differs')
})
test('token funds never stand in for native fees; unavailable quotes do not fabricate balances', async () => {
  mockQuote.mockImplementationOnce(async intent => ({
    ...quote(intent.operationId),
    nativeBalanceAtomic: 0n,
  }))
  await expect(
    reviewStealthPayment({ request, stampValue: 0n, isCurrent: () => true }),
  ).rejects.toThrow('available funds')
  expect(mockPrepare).not.toHaveBeenCalled()
})

test('unadopted preparations release only through the captured financial owner proof', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  await captured.prepare()
  expect(mockRelease).not.toHaveBeenCalled()
  await expect(captured.releaseUnexposed()).resolves.toBe(true)
  expect(mockRelease).toHaveBeenCalledWith(captured.quote.operationId)
  mockRelease.mockResolvedValue(false)
  await expect(captured.releaseUnexposed()).resolves.toBe(false)
})
test('account replacement fences unexposed cleanup as well as signing', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  await captured.prepare()
  mockState.revision += 1
  await expect(captured.releaseUnexposed()).rejects.toThrow('changed')
  expect(mockRelease).not.toHaveBeenCalled()
})

test('pre-handoff preparation failures release only the captured unexposed operation', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  mockPrepare.mockRejectedValue(new Error('signing failed'))
  const send = jest.fn()
  await expect(
    sendReviewedStealthPayment(captured, undefined, send),
  ).rejects.toThrow('signing failed')
  expect(mockRelease).toHaveBeenCalledWith(captured.quote.operationId)
  expect(send).not.toHaveBeenCalled()
})
test('projection failures release before adoption; rejected outgoing adoption never releases', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  const prepare = captured.prepare.bind(captured)
  jest
    .spyOn(captured, 'prepare')
    .mockImplementationOnce(async () => ({ ...(await prepare()), members: [] }))
  const send = jest.fn().mockRejectedValue(new Error('draft save failed'))
  await expect(
    sendReviewedStealthPayment(captured, undefined, send),
  ).rejects.toThrow()
  expect(mockRelease).toHaveBeenCalledTimes(1)
  expect(send).not.toHaveBeenCalled()
  mockRelease.mockClear()
  await expect(
    sendReviewedStealthPayment(captured, 'lunch', send),
  ).rejects.toThrow('draft save failed')
  expect(send).toHaveBeenCalledTimes(1)
  expect(mockRelease).not.toHaveBeenCalled()
})
test('cleanup failure remains visible with the original pre-handoff failure', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 0n,
    isCurrent: () => true,
  })
  mockPrepare.mockRejectedValue(new Error('signing failed'))
  mockRelease.mockRejectedValue(new Error('store unavailable'))
  await expect(
    sendReviewedStealthPayment(captured, undefined, jest.fn()),
  ).rejects.toThrow(
    'signing failed. Unexposed operation cleanup failed: Error: store unavailable',
  )
})

test('a Solana recipient must publish its own Ed25519 spend key; encryption keys cannot substitute', async () => {
  await expect(
    reviewStealthPayment({
      request: {
        ...request,
        chainIdentifier: 'solana-devnet',
        asset: { kind: 'native' },
      },
      stampValue: 0n,
      isCurrent: () => true,
    }),
  ).rejects.toThrow('spend identity')
  expect(mockQuote).not.toHaveBeenCalled()
  expect(mockPrepare).not.toHaveBeenCalled()
})
test('unknown or registry-only networks cannot acquire a financial owner', async () => {
  for (const chainIdentifier of ['unknown', 'ethereum-sepolia']) {
    await expect(
      reviewStealthPayment({
        request: { ...request, chainIdentifier },
        stampValue: 0n,
        isCurrent: () => true,
      }),
    ).rejects.toThrow('Unsupported payment network')
  }
  expect(mockQuote).not.toHaveBeenCalled()
})

test('stamp funding uses the captured messaging owner independently of token funds and excludes the financial source', async () => {
  const captured = await reviewStealthPayment({
    request,
    stampValue: 7n,
    isCurrent: () => true,
  })
  expect(mockStampQuote).toHaveBeenCalledWith({
    wallet: mockWallet,
    stampValue: 7n,
    excludedAddresses: ['0x' + '56'.repeat(20)],
  })
  expect(captured.stampFeeAtomic).toBe(2n)
  mockStampQuote.mockResolvedValue({
    status: 'insufficient',
    chainIdentifier: activeChain.chainIdentifier,
    stampValueAtomic: 7n,
    spendableCapacityAtomic: 0n,
  })
  await expect(
    sendReviewedStealthPayment(captured, undefined, jest.fn()),
  ).rejects.toThrow('Messaging wallet cannot fund')
  expect(mockRelease).toHaveBeenCalledWith(captured.quote.operationId)
})
test('an unfunded messaging wallet prevents confirmation despite funded financial token and gas balances', async () => {
  mockStampQuote.mockResolvedValue({
    status: 'insufficient',
    chainIdentifier: activeChain.chainIdentifier,
    stampValueAtomic: 7n,
    spendableCapacityAtomic: 0n,
  })
  await expect(
    reviewStealthPayment({ request, stampValue: 7n, isCurrent: () => true }),
  ).rejects.toThrow('Messaging wallet cannot fund')
  expect(mockPrepare).not.toHaveBeenCalled()
})

test('a gathered payment excludes every frozen source from same-chain message funding', async () => {
  const addresses = ['0x' + '56'.repeat(20), '0x' + '78'.repeat(20)]
  mockQuote.mockImplementation(async intent => ({
    ...quote(intent.operationId),
    sourceAddress: undefined,
    sources: addresses.map(sourceAddress => ({
      sourceAddress,
      recipientAmountAtomic: 10000000n,
      nativeBalanceAtomic: 50n,
      assetBalanceAtomic: 10500000n,
      estimatedNativeFeeAtomic: 5n,
    })),
  }))
  const captured = await reviewStealthPayment({
    request,
    stampValue: 7n,
    isCurrent: () => true,
  })
  expect(mockStampQuote).toHaveBeenCalledWith({
    wallet: mockWallet,
    stampValue: 7n,
    excludedAddresses: addresses,
  })
  expect(captured.maxNativeFeeAtomic).toBe(10n)
  // Public display data cannot redirect the private source exclusion on confirmation.
  Object.assign(captured.quote.sources![0], { sourceAddress: request.address })
  await captured.prepare()
  expect(mockStampQuote).toHaveBeenLastCalledWith({
    wallet: mockWallet,
    stampValue: 7n,
    excludedAddresses: addresses,
  })
  expect(mockPrepare).toHaveBeenCalledWith(
    expect.objectContaining({ maxNativeFeeAtomic: 10n }),
  )
})

test('an aggregate balance cannot conceal a source without its own transaction fees', async () => {
  mockQuote.mockImplementation(async intent => ({
    ...quote(intent.operationId),
    sourceAddress: undefined,
    sources: [
      {
        sourceAddress: '0x' + '56'.repeat(20),
        recipientAmountAtomic: 10000000n,
        nativeBalanceAtomic: 0n,
        assetBalanceAtomic: 10500000n,
        estimatedNativeFeeAtomic: 5n,
      },
      {
        sourceAddress: '0x' + '78'.repeat(20),
        recipientAmountAtomic: 10000000n,
        nativeBalanceAtomic: 100n,
        assetBalanceAtomic: 10500000n,
        estimatedNativeFeeAtomic: 5n,
      },
    ],
  }))
  await expect(
    reviewStealthPayment({ request, stampValue: 7n, isCurrent: () => true }),
  ).rejects.toThrow('source allocations')
  expect(mockStampQuote).not.toHaveBeenCalled()
  expect(mockPrepare).not.toHaveBeenCalled()
})
