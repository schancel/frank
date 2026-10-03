import { createHash } from 'crypto'

import type { Message } from './relay_pb'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { messageMixin } from './extension'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// NIST SHA-256("abc")
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

it('hashes relay cipher payloads with one SHA-256', () => {
  const empty = Buffer.from(relayCipherPayloadDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(relayCipherPayloadDigest(abc))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )

  const sample = Uint8Array.from([1, 2, 3, 4, 5])
  const digest = Buffer.from(relayCipherPayloadDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)
})

it('checks opened message payloads against that digest', () => {
  const payload = Uint8Array.from([9, 8, 7, 6])
  const open = messageMixin('livenet', {
    getPayloadDigest: () => new Uint8Array(),
    getPayload: () => payload,
  } as unknown as Message)
  const expected = createHash('sha256').update(payload).digest()
  expect(Buffer.from(open.digest() as Uint8Array)).toEqual(expected)
  const matched = messageMixin('livenet', {
    getPayloadDigest: () => expected,
    getPayload: () => payload,
  } as unknown as Message)
  expect(Buffer.from(matched.digest() as Uint8Array)).toEqual(expected)

  const fraudulent = messageMixin('livenet', {
    getPayloadDigest: () => Buffer.alloc(32, 1),
    getPayload: () => payload,
  } as unknown as Message)
  expect(() => fraudulent.digest()).toThrow(/Fraudulent payload digest/)
})
