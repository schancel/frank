import { createHash } from 'crypto'

import { registryWrapperDigest } from './wrapper-digest'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// NIST SHA-256("abc")
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

it('hashes a wrapper payload with one SHA-256', () => {
  const empty = Buffer.from(registryWrapperDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(registryWrapperDigest(abc))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )

  const sample = Uint8Array.from([1, 2, 3, 4, 5])
  const digest = Buffer.from(registryWrapperDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)

  const payload = Uint8Array.from([9, 8, 7])
  const first = registryWrapperDigest(payload)
  payload[0] = 0
  expect(first[0]).toBe(registryWrapperDigest(Uint8Array.from([9, 8, 7]))[0])
})
