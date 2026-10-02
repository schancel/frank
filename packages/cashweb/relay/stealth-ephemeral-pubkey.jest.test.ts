import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey } from 'bitcore-lib-xpi'

import { MessageConstructor } from './constructors'
import { stealthEphemeralPublicKey } from './stealth-ephemeral-pubkey'
import stealth from './stealth_pb'

const SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function bitcorePublicKey(hex: string, compressed: boolean): Buffer {
  const key = compressed
    ? new PrivateKey(hex)
    : new PrivateKey(Buffer.from(hex, 'hex'))
  const fromGetter = key.publicKey.toBuffer()
  const fromMethod = key.toPublicKey().toBuffer()
  if (!fromGetter.equals(fromMethod)) {
    throw new Error('bitcore publicKey getter diverged')
  }
  return fromGetter
}

it('matches bitcore stealth ephemeral public keys', () => {
  const secret = Buffer.from(SECRET, 'hex')
  const compressed = stealthEphemeralPublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(bitcorePublicKey(SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(stealthEphemeralPublicKey(secret, false))).toEqual(
    bitcorePublicKey(SECRET, false),
  )
  expect(stealthEphemeralPublicKey(secret, false).length).toBe(65)
  expect(stealthEphemeralPublicKey(secret, false)[0]).toBe(0x04)

  const almost = Buffer.from(N_MINUS_1, 'hex')
  expect(Buffer.from(stealthEphemeralPublicKey(almost, true))).toEqual(
    bitcorePublicKey(N_MINUS_1, true),
  )
  expect(
    Buffer.from(stealthEphemeralPublicKey(Buffer.from(ONE, 'hex'), true)),
  ).toEqual(bitcorePublicKey(ONE, true))
  expect(secret.toString('hex')).toBe(SECRET)
  expect(almost.toString('hex')).toBe(N_MINUS_1)

  const source = readFileSync(join(__dirname, 'constructors.ts'), 'utf8')
  const stealthStart = source.indexOf('constructStealthEntry(')
  const stealthBody = source.slice(
    stealthStart,
    source.indexOf('constructImageEntry(', stealthStart),
  )
  expect(stealthBody).toContain('stealthEphemeralPublicKey(')
  expect(stealthBody).not.toContain('.publicKey')
  expect(stealthBody).not.toContain('toPublicKey')
  expect(stealthBody).toContain('constructStealthTransactions(')

  const helper = readFileSync(
    join(__dirname, 'stealth-ephemeral-pubkey.ts'),
    'utf8',
  )
  expect(helper).toContain('publicFromPrivate(')
  expect(helper).toContain('privateKeyFromSecretBytes(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')

  const registry = readFileSync(join(__dirname, '../registry/index.ts'), 'utf8')
  expect(registry).toContain('privKey.toPublicKey()')
  expect(registry).toContain('idPrivKey.toPublicKey()')
})

it('sets ephemeral_pub_key from the generated private key', () => {
  const dest = new PrivateKey(ONE).toPublicKey()
  const created: PrivateKey[] = []
  const proto = PrivateKey.prototype as unknown as {
    _classifyArguments: (this: PrivateKey, ...args: unknown[]) => unknown
  }
  const original = proto._classifyArguments
  proto._classifyArguments = function (this: PrivateKey, ...args: unknown[]) {
    created.push(this)
    return original.apply(this, args)
  }
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
    expect(created).toHaveLength(1)
    const raw = stealth.StealthPaymentEntry.deserializeBinary(
      built.paymentEntry.getBody_asU8(),
    )
    const point = Buffer.from(raw.getEphemeralPubKey_asU8())
    expect(point).toEqual(created[0].publicKey.toBuffer())
    expect(point).toEqual(created[0].toPublicKey().toBuffer())
    expect(point.length).toBe(33)
    expect(created[0].toBuffer().length).toBe(32)
    const secret = created[0].toBuffer()
    expect(secret.length).toBe(32)
    expect(created[0].publicKey.toBuffer()).toEqual(point)
    expect(secret.toString('hex')).toBe(created[0].toBuffer().toString('hex'))
  } finally {
    proto._classifyArguments = original
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
  const kept = Buffer.from(SECRET, 'hex')
  expect(() =>
    stealthEphemeralPublicKey(kept, undefined as unknown as boolean),
  ).toThrow('stealth-ephemeral-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SECRET)
})
