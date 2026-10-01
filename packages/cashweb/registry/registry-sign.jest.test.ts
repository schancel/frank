import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { verifyEcdsa } from '@frank/nakamoto'
import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { compactRsFromDer, signRegistryDigest } from './index'

// lotusd src/test/key_tests.cpp. strSecret1 is WIF
// 5HxWvvfubhXpYYpS3tJkw6fq9jE9j18THftkZjHHfmFiWtmAbrj (compressed address
// 1NoJrossxPBKfCHuJXT4HadJrXRE9Fxiqs). Hash("Very deterministic message")
// is SHA-256d. libsecp256k1 mixes the 16-byte tag "ECDSA+DER       " into
// RFC6979, so its DER differs from @frank/nakamoto signEcdsa, which matches
// the bitcore signer this call replaces (decision #489). Registry metadata
// keeps the 64-byte r||s form, not DER. Both DERs verify.
const SECRET =
  '12b004fff7f4b69ef8650e767f18f11ede158148b425660723b9f9a66e61f747'
const BITCORE_DER =
  '304402205dbbddda71772d95ce91cd2d14b592cfbc1dd0aabd6a394b6c2d377bbe59d31d022014ddda21494a4e221f0824f0b8b924c43fa43c0ad57dccdaa11f81a6bd4582f6'
const LOTUSD_DER =
  '304402200c648ad9936cae4006f0b0d7bcbacdcdf5a14260eb550c31ddb1eb1a13b1b58602201b868673bb5926d1610a07cd03692dfdcb98ed059314f66b457a794f2c4b8e79'

function sha256d(text: string): Buffer {
  const first = createHash('sha256').update(text).digest()
  return createHash('sha256').update(first).digest()
}

it('signs registry digests as the bitcore compact r||s bytes', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  expect(source).not.toContain('ECDSA.sign')

  const privKey = new PrivateKey(SECRET)
  const digest = sha256d('Very deterministic message')
  const signature = signRegistryDigest(digest, privKey)
  const live = bitcoreCrypto.ECDSA.sign(digest, privKey)
    .toCompact(1, true)
    .slice(1)
  expect(signature.toString('hex')).toBe(live.toString('hex'))
  expect(live.toString('hex')).toBe(
    '5dbbddda71772d95ce91cd2d14b592cfbc1dd0aabd6a394b6c2d377bbe59d31d14ddda21494a4e221f0824f0b8b924c43fa43c0ad57dccdaa11f81a6bd4582f6',
  )
  expect(signature).toHaveLength(64)

  const pubkey = Uint8Array.from(privKey.toPublicKey().toBuffer())
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

it('keeps a short r unpadded, matching the compact slice', () => {
  // sha256("d104"). r's high bit is set, so DER is 0x00 plus 31 bytes.
  // The replaced compact slice is 63 bytes, not a left-padded 64.
  const digest = createHash('sha256').update('d104').digest()
  const privKey = new PrivateKey(SECRET)
  const pinned =
    'b1fc53d9ed112d8594c95448f0f1033e9d4e7347c4a5925c2668c4ac2dc95e06cca8ed8b1a5f1d45928b298b7cef197d481fea61921cc452c1ff180a53704d'
  const live = bitcoreCrypto.ECDSA.sign(digest, privKey)
    .toCompact(1, true)
    .slice(1)
  expect(live.toString('hex')).toBe(pinned)
  expect(live).toHaveLength(63)
  expect(signRegistryDigest(digest, privKey).toString('hex')).toBe(pinned)
  const der = Buffer.from(
    '3044022000b1fc53d9ed112d8594c95448f0f1033e9d4e7347c4a5925c2668c4ac2dc95e022006cca8ed8b1a5f1d45928b298b7cef197d481fea61921cc452c1ff180a53704d',
    'hex',
  )
  expect(compactRsFromDer(der).toString('hex')).toBe(pinned)
})

it('does not pad a 64-byte DER that bitcore fromDER rejects', () => {
  const r = Buffer.alloc(29, 0x11)
  const s = Buffer.alloc(29, 0x22)
  const der = Buffer.concat([
    Buffer.from([0x30, 0x3e, 0x02, 0x1d]),
    r,
    Buffer.from([0x02, 0x1d]),
    s,
  ])
  expect(der).toHaveLength(64)
  expect(typeof bitcoreCrypto.Signature.fromDER(der)).toBe('string')
  const compact = compactRsFromDer(der)
  expect(compact.subarray(0, 29)).toEqual(r)
  expect(compact.subarray(29)).toEqual(Buffer.concat([Buffer.alloc(3), s]))
  expect(compact).toHaveLength(61)
})

it('drops the DER sign byte the same way as bitcore compact encoding', () => {
  const r = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x01)])
  const s = Buffer.concat([Buffer.from([0x7f]), Buffer.alloc(31, 0x02)])
  const der = Buffer.concat([
    Buffer.from([0x30, 0x45, 0x02, 0x21, 0x00]),
    r,
    Buffer.from([0x02, 0x20]),
    s,
  ])
  const parsed = bitcoreCrypto.Signature.fromDER(der)
  if (typeof parsed === 'string') throw new Error('signature-invalid')
  expect(compactRsFromDer(der).toString('hex')).toBe(
    parsed.toCompact(1, true).slice(1).toString('hex'),
  )
  expect(() => compactRsFromDer(Buffer.from([0x30, 0x00]))).toThrow(
    'signature-invalid',
  )
})
