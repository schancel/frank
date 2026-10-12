import type { StealthPaymentReceiptClaim } from '@frank/wallet/stealth-payment'
import {
  cachedRecipientAssetOptions,
  cachedRecipientObservationHost,
  createRecipientAssetObservationContext,
  recipientAssetOutboundState,
  type RecipientObservationHost,
} from './observation-context'
import { accountSession } from '../accounts/session'
import { peekOpenedUtxoWallets, openUtxoWallet } from '../accounts/utxo-wallets'

jest.mock('../accounts/session', () => ({
  accountSession: {
    state: {
      status: 'ready',
      revision: 1,
      account: { receipt: { context: { accountId: 'alice' } } },
    },
    peekWallet: jest.fn(),
    getCachedCurvePublicKey: jest.fn(),
    getWallet: jest.fn(() => {
      throw new Error('Forbidden custody activation')
    }),
    getCurvePublicKey: jest.fn(() => {
      throw new Error('Forbidden derivation')
    }),
  },
}))
jest.mock('../accounts/utxo-wallets', () => ({
  peekOpenedUtxoWallets: jest.fn(() => []),
  openUtxoWallet: jest.fn(() => {
    throw new Error('Forbidden wallet activation')
  }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    chainIdentifier: 'monad-testnet',
    name: 'Monad',
    unit: 'MON',
    fromDisplayAmount: () => 10n ** 18n,
  },
}))

const digest = 'ab'.repeat(32)
const key = Uint8Array.from([2, ...Array(32).fill(17)])
const claim: StealthPaymentReceiptClaim = {
  chainIdentifier: 'xec-testnet',
  asset: { kind: 'native' },
  recipientDestination: new Uint8Array([1]),
  ephemeralPublicKey: key,
  amountAtomic: 100n,
  rawTransactions: ['0102'],
  payloadDigest: digest,
}
function fixture() {
  const state = { ready: true, accountId: 'alice', revision: 1 }
  const observe = jest.fn(async () => ({
    status: 'pending' as const,
    intendedAmountAtomic: 100n,
    spendability: 'pending' as const,
  }))
  const wallet = {
    chainIdentifier: 'xec-testnet',
    stealthReceipts: { observe, record: jest.fn(), submit: jest.fn() },
  }
  let owners = [
    {
      wallet,
      chain: {
        chainIdentifier: 'xec-testnet',
        name: 'eCash Testnet',
        unit: 'tXEC',
        fromDisplayAmount: () => 100n,
      },
    },
  ]
  const host: RecipientObservationHost = {
    snapshot: () => state,
    peekWallet: () => undefined,
    getCachedSpendPublicKey: () => key,
    getOpenedOwners: () => owners,
  }
  return {
    state,
    host,
    wallet,
    observe,
    replaceOwner: () => {
      owners = [{ ...owners[0]!, wallet: { ...wallet } }]
    },
  }
}

test('default composition reads only ready cached public keys and existing primary/UTXO owners', async () => {
  const f = fixture()
  const primary = { chainIdentifier: 'monad-testnet' }
  jest.mocked(accountSession.peekWallet).mockReturnValue(primary as never)
  jest.mocked(accountSession.getCachedCurvePublicKey).mockReturnValue(key)
  jest
    .mocked(peekOpenedUtxoWallets)
    .mockReturnValue([
      { wallet: f.wallet, chain: f.host.getOpenedOwners()[0]!.chain } as never,
    ])
  const ctx = createRecipientAssetObservationContext(digest)!
  await ctx.receipts('xec-testnet')!.observe(claim)
  expect(f.observe).toHaveBeenCalledWith(claim)
  expect(ctx.receipts('bitcoin-testnet')).toBeUndefined()
  expect(Object.keys(ctx.receipts('xec-testnet')!)).toEqual(['observe'])
  expect(cachedRecipientAssetOptions().map(o => [o.unit, o.decimals])).toEqual([
    ['MON', 18],
    ['tXEC', 2],
  ])
  expect(accountSession.getWallet).not.toHaveBeenCalled()
  expect(accountSession.getCurvePublicKey).not.toHaveBeenCalled()
  expect(openUtxoWallet).not.toHaveBeenCalled()
  expect(f.wallet.stealthReceipts.record).not.toHaveBeenCalled()
  expect(f.wallet.stealthReceipts.submit).not.toHaveBeenCalled()
  const extra = { wallet: { chainIdentifier: 'ethereum-sepolia' } }
  expect(
    cachedRecipientObservationHost(() => [extra]).getOpenedOwners(),
  ).toContain(extra)
})

test('missing keys, nonready sessions and nonfinal payload digests remain unavailable', () => {
  const f = fixture()
  expect(
    createRecipientAssetObservationContext('pending:1', f.host),
  ).toBeUndefined()
  expect(
    createRecipientAssetObservationContext(digest, {
      ...f.host,
      getCachedSpendPublicKey: () => undefined,
    }),
  ).toBeUndefined()
  f.state.ready = false
  expect(createRecipientAssetObservationContext(digest, f.host)).toBeUndefined()
  expect(cachedRecipientAssetOptions(f.host)).toEqual([])
})

test.each(['account', 'revision', 'owner', 'key'] as const)(
  'late %s replacement invalidates a completed chain observation',
  async replacement => {
    const f = fixture()
    let complete!: (value: Awaited<ReturnType<typeof f.observe>>) => void
    f.observe.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve
        }),
    )
    const ctx = createRecipientAssetObservationContext(digest, f.host)!
    const observing = ctx.receipts('xec-testnet')!.observe(claim)
    if (replacement === 'account') f.state.accountId = 'bob'
    if (replacement === 'revision') f.state.revision++
    if (replacement === 'owner') f.replaceOwner()
    if (replacement === 'key')
      f.host.getCachedSpendPublicKey = () => new Uint8Array(33)
    complete({
      status: 'pending',
      intendedAmountAtomic: 100n,
      spendability: 'pending',
    })
    await expect(observing).rejects.toThrow('expired')
  },
)

test('chain and payload affinity reject before any owner call; public key mutation cannot change captured binding', async () => {
  const f = fixture()
  const ctx = createRecipientAssetObservationContext(digest, f.host)!
  ctx.spendPublicKey.fill(0)
  ctx.assertCurrent()
  const receipts = ctx.receipts('xec-testnet')!
  await expect(
    receipts.observe({ ...claim, payloadDigest: 'cd'.repeat(32) }),
  ).rejects.toThrow('affinity')
  await expect(
    receipts.observe({ ...claim, chainIdentifier: 'xec-mainnet' }),
  ).rejects.toThrow('affinity')
  expect(f.observe).not.toHaveBeenCalled()
})

test('outgoing labels reflect only actual message delivery status', () => {
  expect(
    [
      'confirmed',
      'error',
      'pending',
      'sending',
      'payment-pending',
      'submitted',
    ].map(recipientAssetOutboundState),
  ).toEqual(['delivered', 'failed', 'pending', 'sending', 'unknown', 'unknown'])
})

test('final batch check invalidates evidence from an owner replaced after its own observation finished', async () => {
  const f = fixture()
  const ctx = createRecipientAssetObservationContext(digest, f.host)!
  await ctx.receipts('xec-testnet')!.observe(claim)
  f.replaceOwner()
  expect(() => ctx.assertCurrent()).toThrow('owner expired')
})
