import { MessageConstructor } from './constructors'
import { messageSourcePublicKey } from './message-source-pubkey'
import {
  sec1Point,
  sec1PrivateKey,
  SEC1_N_MINUS_1,
  SEC1_ONE,
  SEC1_SECRET,
} from '../sec1-pins'

const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'

it('matches the pinned message source public keys', () => {
  const secret = Buffer.from(SEC1_SECRET, 'hex')
  const compressed = messageSourcePublicKey(secret, true)
  expect(Buffer.from(compressed)).toEqual(sec1Point(SEC1_SECRET, true))
  expect(compressed.length).toBe(33)
  expect(Buffer.from(messageSourcePublicKey(secret, false))).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(messageSourcePublicKey(secret, false).length).toBe(65)

  const almost = Buffer.from(SEC1_N_MINUS_1, 'hex')
  expect(Buffer.from(messageSourcePublicKey(almost, true))).toEqual(
    sec1Point(SEC1_N_MINUS_1, true),
  )
  expect(
    Buffer.from(messageSourcePublicKey(Buffer.from(SEC1_ONE, 'hex'), true)),
  ).toEqual(sec1Point(SEC1_ONE, true))
  expect(secret.toString('hex')).toBe(SEC1_SECRET)
  expect(almost.toString('hex')).toBe(SEC1_N_MINUS_1)

  const sourceKey = sec1PrivateKey(SEC1_SECRET, true)
  const destination = sec1PrivateKey(SEC1_ONE, true).toPublicKey()
  const ctor = new MessageConstructor({ networkName: 'livenet' })
  const built = ctor.constructMessage(
    {} as never,
    Uint8Array.from([1, 2, 3]),
    sourceKey,
    destination,
    0,
  )
  expect(Buffer.from(built.message.getSourcePublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, true),
  )
  expect(Buffer.from(sourceKey.toBuffer()).toString('hex')).toBe(SEC1_SECRET)

  const uncompressed = sec1PrivateKey(SEC1_SECRET, false)
  const uncompressedBuilt = ctor.constructMessage(
    {} as never,
    Uint8Array.from([1, 2, 3]),
    uncompressed,
    destination,
    0,
  )
  expect(Buffer.from(uncompressedBuilt.message.getSourcePublicKey_asU8())).toEqual(
    sec1Point(SEC1_SECRET, false),
  )
  expect(uncompressed.toPublicKey().toBuffer().length).toBe(65)
  expect(Buffer.from(uncompressed.toBuffer()).toString('hex')).toBe(SEC1_SECRET)
})

it('rejects a secret outside (0, n), a non-32-byte secret, and a missing flag', () => {
  expect(() => messageSourcePublicKey(Buffer.alloc(32), true)).toThrow(
    'message-source-pubkey:scalar-out-of-range',
  )
  expect(() => messageSourcePublicKey(Buffer.from(N_HEX, 'hex'), true)).toThrow(
    'message-source-pubkey:scalar-out-of-range',
  )
  expect(() =>
    messageSourcePublicKey(Buffer.from('22'.repeat(31), 'hex'), true),
  ).toThrow('message-source-pubkey:secret')
  expect(() => messageSourcePublicKey(Buffer.alloc(0), false)).toThrow(
    'message-source-pubkey:secret',
  )
  const kept = Buffer.from(SEC1_SECRET, 'hex')
  expect(() =>
    messageSourcePublicKey(kept, undefined as unknown as boolean),
  ).toThrow('message-source-pubkey:compressed')
  expect(kept.toString('hex')).toBe(SEC1_SECRET)
})
