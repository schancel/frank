import { createHash, createHmac } from 'crypto'

import { crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { hmacSha256, randomBytes, sha256 } from '../src/primitives'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

it('hashes and authenticates with SHA-256', () => {
  const empty = Buffer.from(sha256(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty).toEqual(bitcoreCrypto.Hash.sha256(Buffer.alloc(0)))

  const abc = Buffer.from('abc')
  const digest = Buffer.from(sha256(abc))
  expect(digest.toString('hex')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  expect(digest).toEqual(createHash('sha256').update(abc).digest())
  expect(digest).toEqual(bitcoreCrypto.Hash.sha256(abc))

  const data = Buffer.from('payload')
  const key = Buffer.from('secret')
  const mac = Buffer.from(hmacSha256(data, key))
  expect(mac).toEqual(createHmac('sha256', key).update(data).digest())
  expect(mac).toEqual(bitcoreCrypto.Hash.sha256hmac(data, key))

  const longKey = Buffer.alloc(80, 7)
  const longMac = Buffer.from(hmacSha256(data, longKey))
  expect(longMac).toEqual(createHmac('sha256', longKey).update(data).digest())
  expect(longMac).toEqual(bitcoreCrypto.Hash.sha256hmac(data, longKey))

  const caller = Uint8Array.from([1, 2, 3])
  const first = sha256(caller)
  caller[0] = 0
  expect(Buffer.from(first).toString('hex')).toBe(
    Buffer.from(sha256(Uint8Array.from([1, 2, 3]))).toString('hex'),
  )

  const drawn = randomBytes(32)
  expect(drawn.length).toBe(32)
  expect(randomBytes(32)).not.toEqual(drawn)
})
