import { Wallet, Transaction } from 'ethers'
import {
  contactPaymentState,
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
