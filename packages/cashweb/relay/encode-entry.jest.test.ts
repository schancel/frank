import type { Wallet } from '../legacy-wallet'
import type { MessageConstructor } from './constructors'
import { encodeEntry } from './encode-entry'

it('passes the destination key object through to stealth entries', () => {
  const key = { toBuffer: () => new Uint8Array([0x02, 0x11]) }
  let seen: { toBuffer(): Uint8Array } | undefined
  const messageConstructor = {
    constructStealthEntry(args: { destPubKey: { toBuffer(): Uint8Array } }) {
      seen = args.destPubKey
      return { paymentEntry: { kind: 'stealth' }, transactionBundle: [] }
    },
  }
  const [entry, transactions, utxos, outpoints] = encodeEntry(
    { type: 'stealth', amount: 5 },
    key,
    {
      wallet: {} as Wallet,
      messageConstructor: messageConstructor as unknown as MessageConstructor,
    },
  )
  expect(seen).toBe(key)
  expect(Buffer.from(seen!.toBuffer())).toEqual(Buffer.from(key.toBuffer()))
  expect(entry).toEqual({ kind: 'stealth' })
  expect(transactions).toEqual([])
  expect(utxos).toEqual([])
  expect(outpoints).toEqual([])
})

it('builds text entries without the destination key', () => {
  const key = { toBuffer: () => new Uint8Array([1]) }
  let sawKey = false
  const messageConstructor = {
    constructTextEntry(item: { text: string }) {
      sawKey = true
      return { kind: 'text', text: item.text }
    },
  }
  const [entry, transactions] = encodeEntry({ type: 'text', text: 'hi' }, key, {
    wallet: {} as Wallet,
    messageConstructor: messageConstructor as unknown as MessageConstructor,
  })
  expect(sawKey).toBe(true)
  expect(entry).toEqual({ kind: 'text', text: 'hi' })
  expect(transactions).toEqual([])
})
