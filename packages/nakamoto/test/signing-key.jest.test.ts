import { privateKeyFromHex, publicFromPrivate } from '../src/keys.js'
import { signEcdsa, signSchnorr } from '../src/curve.js'
import { signingKey } from '../src/signing-key.js'
import type { PrivateKey } from '../src/constructors.js'

const HEX = '22'.repeat(32)

function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('expected ok')
  return result.value
}

function key(compressed: boolean): PrivateKey {
  return must(privateKeyFromHex(HEX, compressed))
}

const digest = new Uint8Array(32).fill(7)
const aux = new Uint8Array(32).fill(9)

it('maps an ECDSA private key, a Schnorr private key, and a 32-byte secret', () => {
  const scalar = key(true)
  const point = must(publicFromPrivate(scalar))
  const ecdsa = must(signingKey('ecdsa', scalar))
  const schnorr = must(signingKey('schnorr', { key: scalar, aux }))
  const secret = must(
    signingKey('secret', {
      toBuffer: () => Uint8Array.from(scalar.bytes),
      compressed: true,
    }),
  )

  expect(ecdsa.publicKey).toEqual(point.compressed)
  expect(ecdsa.sign(digest)).toEqual(must(signEcdsa(scalar, digest)))
  expect(schnorr.publicKey).toEqual(point.xOnly)
  expect(schnorr.sign(digest)).toEqual(must(signSchnorr(scalar, digest, aux)))
  expect(secret.publicKey).toEqual(ecdsa.publicKey)
  expect(secret.sign(digest)).toEqual(ecdsa.sign(digest))

  const open = must(signingKey('ecdsa', key(false)))
  expect(open.publicKey.length).toBe(65)
  expect(open.publicKey[0]).toBe(0x04)
  expect(open.sign(digest)).toEqual(ecdsa.sign(digest))
})

it('uses the secret point when the key provides one', () => {
  const scalar = key(true)
  const marked = new Uint8Array(33)
  marked[0] = 0x02
  const signing = must(
    signingKey('secret', {
      toBuffer: () => Uint8Array.from(scalar.bytes),
      toPublicKey: () => ({ toBuffer: () => marked }),
    }),
  )
  expect(signing.publicKey).toEqual(marked)
  expect(signing.sign(digest)).toEqual(must(signEcdsa(scalar, digest)))
  marked[1] = 0xff
  expect(signing.publicKey[1]).toBe(0)
})

it('keeps a copy of the secret and rejects a scalar outside (0, n)', () => {
  const scalar = key(true)
  const buf = Uint8Array.from(scalar.bytes)
  const signing = must(signingKey('secret', { toBuffer: () => buf }))
  buf.fill(0)
  expect(signing.sign(digest)).toEqual(must(signEcdsa(scalar, digest)))
  expect(scalar.bytes[0]).toBe(0x22)

  expect(signingKey('secret', { toBuffer: () => new Uint8Array(32) }).ok).toBe(
    false,
  )
  expect(
    signingKey('schnorr', { key: scalar, aux: new Uint8Array(31) }).ok,
  ).toBe(false)
  expect(() => signing.sign(digest.slice(0, 31))).toThrow('bad-length')
})
