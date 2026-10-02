import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import type { Message } from './relay_pb'
import { relayCipherPayloadDigest } from './cipher-payload-digest'
import { messageMixin } from './extension'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// NIST SHA-256("abc")
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

it('hashes relay cipher payloads with one SHA-256', () => {
  const empty = Buffer.from(relayCipherPayloadDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )
  expect(empty).toEqual(bitcoreCrypto.Hash.sha256(Buffer.alloc(0)))

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(relayCipherPayloadDigest(abc))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )
  expect(abcDigest).toEqual(bitcoreCrypto.Hash.sha256(abc))

  const sample = Uint8Array.from([1, 2, 3, 4, 5])
  const digest = Buffer.from(relayCipherPayloadDigest(sample))
  expect(digest.toString('hex')).toBe(
    createHash('sha256').update(sample).digest('hex'),
  )
  expect(digest).toEqual(bitcoreCrypto.Hash.sha256(Buffer.from(sample)))
  const doubled = createHash('sha256').update(digest).digest('hex')
  expect(digest.toString('hex')).not.toBe(doubled)
})

it('checks message payloads with that digest and leaves the salt HMAC', () => {
  const constructors = readFileSync(join(__dirname, 'constructors.ts'), 'utf8')
  const message = methodBody(
    constructors,
    'constructMessage(',
    'constructReplyEntry(',
  )
  expect(message).toContain(
    'const payloadDigest = Buffer.from(relayCipherPayloadDigest(payload))',
  )
  expect(message).toContain(
    'const plainPayloadDigest = crypto.Hash.sha256(Buffer.from(plainTextPayload))',
  )
  expect(message.match(/crypto\.Hash\.sha256\(/g)).toHaveLength(1)
  expect(message.match(/crypto\.Hash\.sha256hmac\(/g)).toHaveLength(1)
  expect(message).not.toContain('sha256d')
  expect(message).not.toContain('cryptoBackend.sha256')

  const extension = readFileSync(join(__dirname, 'extension.ts'), 'utf8')
  const digest = methodBody(extension, 'digest() {', 'parse() {')
  expect(
    digest.match(/relayCipherPayloadDigest\(payloadBuffer\)/g),
  ).toHaveLength(2)
  expect(digest).not.toContain('crypto.Hash')

  const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  expect(index).toContain('relayCipherPayloadDigest(rawCipherPayload)')
  expect(index).not.toContain('crypto.Hash.sha256')
  expect(index).not.toContain('crypto.Point.pointToCompressed')
  expect(index).toContain('stampOutpointPublicKey(')

  const payload = Uint8Array.from([9, 8, 7, 6])
  const open = messageMixin('livenet', {
    getPayloadDigest: () => new Uint8Array(),
    getPayload: () => payload,
  } as unknown as Message)
  expect(Buffer.from(open.digest() as Uint8Array)).toEqual(
    bitcoreCrypto.Hash.sha256(Buffer.from(payload)),
  )

  const expected = bitcoreCrypto.Hash.sha256(Buffer.from(payload))
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
