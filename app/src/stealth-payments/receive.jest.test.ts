import type { RecipientAssetPaymentItem } from '@frank/cashweb/types/messages'
import {
  recordRecipientAssetPayment,
  type RecipientPaymentContext,
} from './receive'

const key = Uint8Array.from([2, ...new Array<number>(32).fill(1)])
const publicKey = Array.from(key, value =>
  value.toString(16).padStart(2, '0'),
).join('')

function item(): RecipientAssetPaymentItem {
  return {
    type: 'stealth-asset',
    transfers: [
      {
        chainIdentifier: 'monad-testnet',
        txId: 'ab'.repeat(32),
        destination: '12'.repeat(20),
        amountAtomic: ((1n << 255n) + 1n).toString(),
        asset: { kind: 'token', identifier: '34'.repeat(20) },
        stealthMetadata: { keyType: 1, ephemeralPubKey: publicKey },
        recipientSpendKey: { keyType: 1, publicKey },
        derivationScheme: 1,
        rawTx: '010203',
      },
    ],
  }
}

function context() {
  const record = jest.fn(async () => undefined)
  const openWallet = jest.fn(async (chainIdentifier: string) => ({
    chainIdentifier,
    stealthReceipts: { record, observe: jest.fn() },
  }))
  const value: RecipientPaymentContext = {
    payloadDigest: 'cd'.repeat(32),
    spendPublicKey: key.slice(),
    assertCurrent: jest.fn(),
    openWallet,
  }
  return { value, openWallet, record }
}

test('dispatches exact token amounts to their canonical financial owner without outgoing sync', async () => {
  const ctx = context()
  expect(await recordRecipientAssetPayment(item(), ctx.value)).toEqual([
    { index: 0, status: 'recorded' },
  ])
  expect(ctx.openWallet).toHaveBeenCalledWith('monad-testnet')
  expect(ctx.record).toHaveBeenCalledWith(
    expect.objectContaining({
      amountAtomic: (1n << 255n) + 1n,
      asset: { kind: 'erc20', contractAddress: '0x' + '34'.repeat(20) },
      rawTransactions: ['010203'],
      payloadDigest: ctx.value.payloadDigest,
    }),
  )
})

test('unknown schemes and allocated opaque keys never open custody', async () => {
  const payment = item()
  payment.transfers[0]!.derivationScheme = 99
  payment.transfers[0]!.recipientSpendKey.keyType = 3
  payment.transfers[0]!.stealthMetadata.keyType = 3
  const ctx = context()
  expect(await recordRecipientAssetPayment(payment, ctx.value)).toEqual([
    { index: 0, status: 'unsupported' },
  ])
  expect(ctx.openWallet).not.toHaveBeenCalled()
})

test.each(['btc-testnet', 'bch-testnet', 'xec-testnet'])(
  'routes native claims to the exact %s owner',
  async chainIdentifier => {
    const payment = item()
    payment.transfers[0]!.chainIdentifier = chainIdentifier
    payment.transfers[0]!.asset = { kind: 'native' }
    const ctx = context()
    await recordRecipientAssetPayment(payment, ctx.value)
    expect(ctx.openWallet).toHaveBeenCalledWith(chainIdentifier)
    expect(ctx.record).toHaveBeenCalledWith(
      expect.objectContaining({ chainIdentifier, asset: { kind: 'native' } }),
    )
  },
)

test('rejects a different wallet chain before receipt mutation', async () => {
  const ctx = context()
  ctx.openWallet.mockImplementation(async () => ({
    chainIdentifier: 'monad-regtest',
    stealthReceipts: { record: ctx.record, observe: jest.fn() },
  }))
  await expect(recordRecipientAssetPayment(item(), ctx.value)).rejects.toThrow(
    'different chain',
  )
  expect(ctx.record).not.toHaveBeenCalled()
})

test('rejects a different recipient identity before opening a financial owner', async () => {
  const ctx = context()
  ctx.value.spendPublicKey.fill(3)
  await expect(recordRecipientAssetPayment(item(), ctx.value)).rejects.toThrow(
    'identity',
  )
  expect(ctx.openWallet).not.toHaveBeenCalled()
})

test('checks account lifetime after an asynchronous wallet open', async () => {
  const ctx = context()
  let current = true
  ctx.value.assertCurrent = () => {
    if (!current) throw new Error('Account changed')
  }
  ctx.openWallet.mockImplementation(async chainIdentifier => {
    current = false
    return {
      chainIdentifier,
      stealthReceipts: { record: ctx.record, observe: jest.fn() },
    }
  })
  await expect(recordRecipientAssetPayment(item(), ctx.value)).rejects.toThrow(
    'Account changed',
  )
  expect(ctx.record).not.toHaveBeenCalled()
})

test('does not complete before durable receipt mutation and propagates persistence failure', async () => {
  const ctx = context()
  let reject!: (error: Error) => void
  ctx.record.mockImplementation(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      }),
  )
  let completed = false
  const pending = recordRecipientAssetPayment(item(), ctx.value).finally(() => {
    completed = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(completed).toBe(false)
  reject(new Error('Durable write failed'))
  await expect(pending).rejects.toThrow('Durable write failed')
})
