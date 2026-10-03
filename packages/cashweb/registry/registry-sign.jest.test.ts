import { createHash } from 'crypto'

import { verifyEcdsa } from '@frank/nakamoto'

import { compactRsFromDer, signRegistryDigest } from './index'
import { sec1Point, sec1PrivateKey, SEC1_IDENTITY } from '../sec1-pins'

// lotusd src/test/key_tests.cpp. strSecret1 is WIF
// 5HxWvvfubhXpYYpS3tJkw6fq9jE9j18THftkZjHHfmFiWtmAbrj (compressed address
// 1NoJrossxPBKfCHuJXT4HadJrXRE9Fxiqs). Hash("Very deterministic message")
// is SHA-256d. libsecp256k1 mixes the 16-byte tag "ECDSA+DER       " into
// RFC6979, so its DER differs from @frank/nakamoto signEcdsa, which matches
// the signer this call replaces (decision #489). Registry metadata
// keeps the 64-byte r||s form, not DER. Both DERs verify.
const BITCORE_DER =
  '304402205dbbddda71772d95ce91cd2d14b592cfbc1dd0aabd6a394b6c2d377bbe59d31d022014ddda21494a4e221f0824f0b8b924c43fa43c0ad57dccdaa11f81a6bd4582f6'
const LOTUSD_DER =
  '304402200c648ad9936cae4006f0b0d7bcbacdcdf5a14260eb550c31ddb1eb1a13b1b58602201b868673bb5926d1610a07cd03692dfdcb98ed059314f66b457a794f2c4b8e79'
const COMPACT =
  '5dbbddda71772d95ce91cd2d14b592cfbc1dd0aabd6a394b6c2d377bbe59d31d14ddda21494a4e221f0824f0b8b924c43fa43c0ad57dccdaa11f81a6bd4582f6'

function sha256d(text: string): Buffer {
  const first = createHash('sha256').update(text).digest()
  return createHash('sha256').update(first).digest()
}

it('signs registry digests as compact r||s bytes', () => {
  const privKey = sec1PrivateKey(SEC1_IDENTITY, true)
  const digest = sha256d('Very deterministic message')
  const signature = signRegistryDigest(digest, privKey)
  expect(signature.toString('hex')).toBe(COMPACT)
  expect(signature).toHaveLength(64)

  const pubkey = Uint8Array.from(sec1Point(SEC1_IDENTITY, true))
  const message = Uint8Array.from(digest)
  expect(
    verifyEcdsa(
      Uint8Array.from(Buffer.from(BITCORE_DER, 'hex')),
      message,
      pubkey,
    ),
  ).toEqual({ ok: true, value: true })
  expect(
    verifyEcdsa(
      Uint8Array.from(Buffer.from(LOTUSD_DER, 'hex')),
      message,
      pubkey,
    ),
  ).toEqual({ ok: true, value: true })

  expect(() => signRegistryDigest(Buffer.alloc(31), privKey)).toThrow(
    'sign-digest',
  )
  expect(() => signRegistryDigest(Buffer.alloc(33), privKey)).toThrow(
    'sign-digest',
  )
})

it('keeps a short r unpadded in the compact slice', () => {
  // sha256("d104"). r's high bit is set, so DER is 0x00 plus 31 bytes.
  // The compact slice is 63 bytes, not a left-padded 64.
  const digest = createHash('sha256').update('d104').digest()
  const privKey = sec1PrivateKey(SEC1_IDENTITY, true)
  const pinned =
    'b1fc53d9ed112d8594c95448f0f1033e9d4e7347c4a5925c2668c4ac2dc95e06cca8ed8b1a5f1d45928b298b7cef197d481fea61921cc452c1ff180a53704d'
  expect(signRegistryDigest(digest, privKey).toString('hex')).toBe(pinned)
  expect(signRegistryDigest(digest, privKey)).toHaveLength(63)
  const der = Buffer.from(
    '3044022000b1fc53d9ed112d8594c95448f0f1033e9d4e7347c4a5925c2668c4ac2dc95e022006cca8ed8b1a5f1d45928b298b7cef197d481fea61921cc452c1ff180a53704d',
    'hex',
  )
  expect(compactRsFromDer(der).toString('hex')).toBe(pinned)
})

it('does not pad a short DER integer up to 32 bytes', () => {
  const r = Buffer.alloc(29, 0x11)
  const s = Buffer.alloc(29, 0x22)
  const der = Buffer.concat([
    Buffer.from([0x30, 0x3e, 0x02, 0x1d]),
    r,
    Buffer.from([0x02, 0x1d]),
    s,
  ])
  expect(der).toHaveLength(64)
  const compact = compactRsFromDer(der)
  expect(compact.subarray(0, 29)).toEqual(r)
  expect(compact.subarray(29)).toEqual(Buffer.concat([Buffer.alloc(3), s]))
  expect(compact).toHaveLength(61)
})

it('drops the DER sign byte from a high-bit r', () => {
  const r = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x01)])
  const s = Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(31, 0x02)])
  const der = Buffer.concat([
    Buffer.from([0x30, 0x45, 0x02, 0x21, 0x00]),
    r,
    Buffer.from([0x02, 0x20]),
    s,
  ])
  expect(compactRsFromDer(der)).toEqual(Buffer.concat([r, s]))
  expect(() => compactRsFromDer(Buffer.from([0x30, 0x00]))).toThrow(
    'signature-invalid',
  )
})
