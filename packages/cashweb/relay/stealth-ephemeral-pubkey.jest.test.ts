import * as cryptoBox from '@frank/crypto-box'

import { MessageConstructor } from './constructors'
import { stealthEphemeralPublicKey } from './stealth-ephemeral-pubkey'
import stealth from './stealth_pb'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned stealth ephemeral public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = stealthEphemeralPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(stealthEphemeralPublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(stealthEphemeralPublicKey(secret, false).length).toBe(65)
  expect(stealthEphemeralPublicKey(secret, false)[0]).toBe(0x04)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(stealthEphemeralPublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(stealthEphemeralPublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)
})

it('sets ephemeral_pub_key from the generated private key', () => {
  const dest = sec1PrivateKey(SEC1_ONE, true).toPublicKey()
  const drawn = Buffer.alloc(32, 0x22)
  const spy = jest
    .spyOn(cryptoBox, 'randomBytes')
    .mockImplementation((length: number) => Buffer.alloc(length, 0x22))
  try {
    const ctor = new MessageConstructor({ networkName: 'livenet' })
    ctor.payloadConstructor.constructStealthPublicKey = () => ({
      stealthPublicKey: dest,
      digest: Buffer.alloc(32, 9),
    })
    const built = ctor.constructStealthEntry({
      wallet: { constructTransactionSet: () => [] } as never,
      amount: 1,
      destPubKey: dest,
    })
    const raw = stealth.StealthPaymentEntry.deserializeBinary(
      built.paymentEntry.getBody_asU8(),
    )
    const point = Buffer.from(raw.getEphemeralPubKey_asU8())
    expect(point).toEqual(
      Buffer.from(stealthEphemeralPublicKey(Uint8Array.from(drawn), true)),
    )
    expect(point).toEqual(sec1Point(SEC1_SECRET, true))
    expect(point.length).toBe(33)
    expect(spy).toHaveBeenCalledWith(32)
  } finally {
    spy.mockRestore()
  }
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => stealthEphemeralPublicKey(Buffer.alloc(32), true)).toThrow(
    'stealth-ephemeral-pubkey:scalar-out-of-range',
  )
  expect(() =>
    stealthEphemeralPublicKey(Buffer.from(N_HEX, 'hex'), true),
  ).toThrow('stealth-ephemeral-pubkey:scalar-out-of-range')
  expect(() =>
    stealthEphemeralPublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('stealth-ephemeral-pubkey:secret')
  expect(() => stealthEphemeralPublicKey(Buffer.alloc(0), false)).toThrow(
    'stealth-ephemeral-pubkey:secret',
  )
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    stealthEphemeralPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('stealth-ephemeral-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})

it('serializes and deserializes multi-chain stealth payment entries', () => {
  const entry = new stealth.StealthPaymentEntry()
  entry.setEphemeralPubKey(Buffer.alloc(33, 0x02))
  entry.setChainId('monad-testnet')
  entry.addTransactions(Buffer.from('0x02signedevmtx', 'utf-8'))
  entry.addTransactions(Buffer.from('0x02secondtx', 'utf-8'))

  const serialized = entry.serializeBinary()
  const roundtripped = stealth.StealthPaymentEntry.deserializeBinary(serialized)

  expect(roundtripped.getChainId()).toBe('monad-testnet')
  expect(roundtripped.getTransactionsList().length).toBe(2)
  expect(Buffer.from(roundtripped.getTransactionsList_asU8()[0]).toString('utf-8')).toBe(
    '0x02signedevmtx',
  )
})
