import { Wallet, Transaction } from 'ethers'
import {
  contactPaymentState,
  stealthAssetCard,
  stealthTransactionDetails,
} from './stealth-transaction-details'
import type { ContactPaymentInfo } from '@frank/wallet/chain'

it('keeps every signed transaction and its exact value, with bare hashes explicitly unvalued', async () => {
  const wallet = Wallet.createRandom()
  const signed = await Promise.all(
    [1n, 2n].map((value, nonce) =>
      wallet.signTransaction({
        to: '0x' + '11'.repeat(20),
        value,
        nonce,
        gasLimit: 21000,
        gasPrice: 1,
        chainId: 10143,
      }),
    ),
  )
  const rows = stealthTransactionDetails([
    ...signed,
    'aa'.repeat(32),
    'malformed',
  ])
  expect(rows.map(row => row.txHash)).toEqual([
    ...signed.map(raw => Transaction.from(raw).hash),
    '0x' + 'aa'.repeat(32),
    '',
  ])
  expect(rows.map(row => row.valueWei)).toEqual([1n, 2n, undefined, undefined])
  expect(rows[3].invalid).toBe(true)
})

it('accepts only the transfer owner entry matching both ephemeral key and carried hash', () => {
  const payment: ContactPaymentInfo = {
    ephemeralPubKey: '02aa',
    messageId: 'id',
    recipientAddress: 'peer',
    valueWei: 1n,
    holdsFunds: false,
    state: 'paid',
    txHash: '0x1234',
  }
  expect(contactPaymentState([payment], '0x02AA', ['0x1234'])).toBe('paid')
  expect(contactPaymentState([payment], '02bb', ['0x1234'])).toBe('unknown')
  expect(contactPaymentState([payment], '02aa', ['0x5678'])).toBe('unknown')
  expect(contactPaymentState([], '02aa', ['0x1234'])).toBe('unknown')
  expect(contactPaymentState([payment], '02aa', ['0x1234', '0x5678'])).toBe(
    'unknown',
  )
})

describe('stealthAssetCard', () => {
  const transfer = (
    amountAtomic: string,
    rawTx: string,
    ephemeralPubKey = '02' + 'aa'.repeat(32),
  ) => ({
    chainIdentifier: 'monad-regtest',
    asset: { kind: 'native' },
    amountAtomic,
    rawTx,
    txId: 'ff'.repeat(32),
    stealthMetadata: { ephemeralPubKey },
  })

  it('shows a native payment to one one-time account as one card, with the summed amount', () => {
    expect(
      stealthAssetCard({
        transfers: [
          transfer('1500000000000000000', 'aa'),
          transfer('500000000000000000', 'bb'),
        ],
        memo: 'for you',
      }),
    ).toEqual({
      networkTag: 'monad-regtest',
      ephemeralPubKey: '02' + 'aa'.repeat(32),
      amount: 2e18,
      amountWei: '2000000000000000000',
      transactions: ['aa', 'bb'],
      memo: 'for you',
    })
  })

  it('leaves tokens and payments to several accounts to the plain preview', () => {
    expect(
      stealthAssetCard({
        transfers: [{ ...transfer('1', 'aa'), asset: { kind: 'token' } }],
      }),
    ).toBeUndefined()
    expect(
      stealthAssetCard({
        transfers: [
          transfer('1', 'aa'),
          transfer('1', 'bb', '03' + 'bb'.repeat(32)),
        ],
      }),
    ).toBeUndefined()
    expect(stealthAssetCard({ transfers: [] })).toBeUndefined()
  })
})
