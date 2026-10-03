import { randomBytes } from 'crypto'

import { FrankIdentity, computeLotusAddress } from './lotus-identity'
import { sec1Point, SEC1_N_MINUS_1, SEC1_ONE, SEC1_SECRET } from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('returns the pinned public key for a known compressed secret', () => {
  for (const hex of [SEC1_SECRET, SEC1_N_MINUS_1, SEC1_ONE]) {
    const identity = FrankIdentity.fromPrivateKeyHex(hex, 'mainnet')
    expect(identity.pubKey).toEqual(sec1Point(hex, true))
    expect(identity.pubKey.length).toBe(33)
    expect(identity.toPrivateKeyHex()).toBe(hex)
    expect(identity.address).toBe(
      computeLotusAddress(identity.pubKey, 'mainnet'),
    )
    const again = FrankIdentity.fromPrivateKeyHex(
      identity.toPrivateKeyHex(),
      'regtest',
    )
    expect(again.pubKey).toEqual(identity.pubKey)
    expect(again.toPrivateKeyHex()).toBe(hex)
    expect(again.address).toBe(computeLotusAddress(again.pubKey, 'regtest'))
    expect(
      FrankIdentity.fromPrivateKeyHex(hex.toUpperCase(), 'mainnet').pubKey,
    ).toEqual(identity.pubKey)
  }

  const kept = Buffer.from(SEC1_N_MINUS_1, 'hex')
  const identity = FrankIdentity.fromPrivateKeyHex(kept.toString('hex'), 'mainnet')
  identity.toPrivateKeyHex()
  expect(kept.toString('hex')).toBe(SEC1_N_MINUS_1)

  const generated = FrankIdentity.generate('mainnet')
  const generatedHex = generated.toPrivateKeyHex()
  expect(generated.pubKey.length).toBe(33)
  expect(generated.pubKey[0] === 0x02 || generated.pubKey[0] === 0x03).toBe(
    true,
  )
  expect(
    FrankIdentity.fromPrivateKeyHex(generatedHex, 'mainnet').toPrivateKeyHex(),
  ).toBe(generatedHex)
  expect(generated.address).toBe(
    computeLotusAddress(generated.pubKey, 'mainnet'),
  )
})

it('rejects 0, n, a short hex, and a non-hex secret', () => {
  expect(() => FrankIdentity.fromPrivateKeyHex('00'.repeat(32), 'mainnet')).toThrow(
    'lotus-identity:scalar-out-of-range',
  )
  expect(() => FrankIdentity.fromPrivateKeyHex(N_HEX, 'mainnet')).toThrow(
    'lotus-identity:scalar-out-of-range',
  )
  expect(() => FrankIdentity.fromPrivateKeyHex('11'.repeat(31), 'mainnet')).toThrow(
    'lotus-identity:hex-invalid',
  )
  expect(() => FrankIdentity.fromPrivateKeyHex('zz', 'mainnet')).toThrow(
    'lotus-identity:hex-invalid',
  )
  expect(() =>
    FrankIdentity.fromPrivateKeyHex(`0x${SEC1_SECRET}`, 'mainnet'),
  ).toThrow('lotus-identity:hex-invalid')
})

it('stops after a bounded run of invalid secrets', () => {
  const spy = jest
    .spyOn(require('crypto'), 'randomBytes')
    .mockImplementation(((size: number) => Buffer.alloc(size)) as typeof randomBytes)
  try {
    expect(() => FrankIdentity.generate('mainnet')).toThrow(
      'lotus-identity:exhausted',
    )
    expect(spy).toHaveBeenCalledTimes(64)
  } finally {
    spy.mockRestore()
  }
})
