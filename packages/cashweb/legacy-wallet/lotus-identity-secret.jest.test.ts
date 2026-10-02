import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { FrankIdentity, computeLotusAddress } from './lotus-identity'

const SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcorePublicKey(hex: string): Buffer {
  return new PrivateKey(hex).toPublicKey().toBuffer()
}

it('matches bitcore public keys for a known compressed secret', () => {
  const source = readFileSync(join(__dirname, 'lotus-identity.ts'), 'utf8')
  expect(source).not.toMatch(/from ['"]bitcore-lib-xpi['"]/)
  expect(source).toContain('randomBytes(')
  expect(source).toContain('signEcdsa(')

  for (const hex of [SECRET, N_MINUS_1, ONE]) {
    const identity = FrankIdentity.fromPrivateKeyHex(hex, 'mainnet')
    expect(identity.pubKey).toEqual(bitcorePublicKey(hex))
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

  const kept = Buffer.from(N_MINUS_1, 'hex')
  const identity = FrankIdentity.fromPrivateKeyHex(kept.toString('hex'), 'mainnet')
  identity.toPrivateKeyHex()
  expect(kept.toString('hex')).toBe(N_MINUS_1)

  const generated = FrankIdentity.generate('mainnet')
  const generatedHex = generated.toPrivateKeyHex()
  expect(generated.pubKey).toEqual(bitcorePublicKey(generatedHex))
  expect(generated.pubKey.length).toBe(33)
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
    FrankIdentity.fromPrivateKeyHex(`0x${SECRET}`, 'mainnet'),
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
