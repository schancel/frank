import { createHash } from 'crypto'

import { crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { relayPlainPayloadDigest } from './plain-payload-digest'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// NIST SHA-256("abc")
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const KEY = Buffer.alloc(32, 0x22)

it('hashes relay plaintext with one SHA-256', () => {
  const empty = Buffer.from(relayPlainPayloadDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )
  expect(empty).toEqual(bitcoreCrypto.Hash.sha256(Buffer.alloc(0)))

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(relayPlainPayloadDigest(abc))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )
  expect(abcDigest).toEqual(bitcoreCrypto.Hash.sha256(abc))

  const sample = Uint8Array.from([1, 2, 3, 4, 5])
  const digest = Buffer.from(relayPlainPayloadDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  expect(digest).toEqual(bitcoreCrypto.Hash.sha256(Buffer.from(sample)))
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)

  const payload = Uint8Array.from([9, 8, 7])
  const first = relayPlainPayloadDigest(payload)
  payload[0] = 0
  expect(first[0]).toBe(relayPlainPayloadDigest(Uint8Array.from([9, 8, 7]))[0])

  expect(bitcoreCrypto.Hash.sha256hmac(digest, KEY)).toEqual(
    bitcoreCrypto.Hash.sha256hmac(bitcoreCrypto.Hash.sha256(Buffer.from(sample)), KEY),
  )
})
