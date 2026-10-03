import { PayloadConstructor } from './crypto'
import {
  stampDepthZeroPublicNode,
  stampParentHdPublicNode,
} from './stamp-hd-public'
import { stampParentPublicKey } from './stamp-public'
import { addedPoint, pointOf, secretKey } from '../nakamoto-oracle'

const DEST_SECRET = '11'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

it('builds a depth-0 stamp public parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const uncompressed = destination.toPublicKey()
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const publicKey = addedPoint(uncompressed.toBuffer(), digest)
  expect(
    Buffer.from(
      stampParentPublicKey(Uint8Array.from(uncompressed.toBuffer()), digest),
    ),
  ).toEqual(publicKey)

  const node = ctor.constructStampHDPublicKey(digest, uncompressed)
  expect(Buffer.from(node.publicKey)).toEqual(publicKey)
  expect(Buffer.from(node.publicKey)).toEqual(
    ctor.constructStampPublicKey(digest, uncompressed).toBuffer(),
  )
  expect(Buffer.from(node.chainCode)).toEqual(digest)
  expect(Buffer.from(node.chainCode)).not.toEqual(publicKey)
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(uncompressed.toBuffer().length).toBe(65)
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)

  const compressedKey = secretKey(DEST_SECRET, true)
  expect(compressedKey.toPublicKey().toBuffer().length).toBe(33)
  const compressedNode = ctor.constructStampHDPublicKey(
    digest,
    compressedKey.toPublicKey(),
  )
  expect(Buffer.from(compressedNode.publicKey)).toEqual(publicKey)
  expect(Buffer.from(compressedNode.chainCode)).toEqual(digest)

  const again = Buffer.from(node.publicKey)
  expect(again.equals(Buffer.alloc(33))).toBe(false)
  const other = ctor.constructStampHDPublicKey(digest, uncompressed)
  const kept = Buffer.from(other.publicKey)
  node.publicKey[1] = node.publicKey[1] ^ 0xff
  expect(Buffer.from(other.publicKey)).toEqual(kept)
  expect(Buffer.from(compressedNode.publicKey)).toEqual(publicKey)
  expect(Buffer.from(node.publicKey)).not.toEqual(kept)
  expect(again[1]).not.toBe(node.publicKey[1])

  const callerPoint = Uint8Array.from(uncompressed.toBuffer())
  const callerDigest = Uint8Array.from(digest)
  const held = stampParentHdPublicNode(callerPoint, callerDigest)
  expect(Buffer.from(callerPoint)).toEqual(uncompressed.toBuffer())
  expect(Buffer.from(callerDigest)).toEqual(digest)
  expect(Buffer.from(held.publicKey)).toEqual(publicKey)
  expect(Buffer.from(held.chainCode)).toEqual(digest)
  callerDigest[0] = callerDigest[0] ^ 0xff
  expect(Buffer.from(held.chainCode)).toEqual(digest)
  expect(Buffer.from(callerDigest)).not.toEqual(digest)

  const almost = secretKey(N_MINUS_1, true)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampHDPublicKey(cross, almost.toPublicKey())
  expect(Buffer.from(crossed.publicKey)).toEqual(
    pointOf(Buffer.from(ONE, 'hex'), true),
  )
  expect(Buffer.from(crossed.publicKey)).toEqual(
    addedPoint(almost.toPublicKey().toBuffer(), cross),
  )
  expect(Buffer.from(crossed.chainCode)).toEqual(cross)
  expect(Buffer.from(almost.toBuffer()).toString('hex')).toBe(N_MINUS_1)
})

it('stores a chain code >= n without reducing it', () => {
  const compressed = secretKey(DEST_SECRET, true).toPublicKey()
  expect(compressed.toBuffer().length).toBe(33)
  const point = Uint8Array.from(compressed.toBuffer())
  const order = Uint8Array.from(Buffer.from(N_HEX, 'hex'))
  const node = stampDepthZeroPublicNode(point, order)
  expect(Buffer.from(node.chainCode)).toEqual(Buffer.from(order))
  expect(Buffer.from(node.publicKey)).toEqual(compressed.toBuffer())
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)

  const above = Uint8Array.from(Buffer.from(N_PLUS_ONE, 'hex'))
  const stored = stampDepthZeroPublicNode(point, above)
  expect(Buffer.from(stored.chainCode)).toEqual(Buffer.from(above))
  expect(Buffer.from(stored.publicKey)).toEqual(compressed.toBuffer())

  expect(() => stampDepthZeroPublicNode(point, new Uint8Array(31))).toThrow(
    'stamp-hd-public:chain-code',
  )
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
  const badPrefix = Uint8Array.from(point)
  badPrefix[0] = 0x01
  expect(() => stampDepthZeroPublicNode(badPrefix, order)).toThrow(
    'stamp-hd-public:bad-prefix',
  )
  expect(() => stampDepthZeroPublicNode(point.slice(0, 32), order)).toThrow(
    'stamp-hd-public:wrong-length',
  )
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
})

it('rejects a stamp digest >= n instead of reducing it', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const uncompressed = destination.toPublicKey()
  const point = Uint8Array.from(uncompressed.toBuffer())
  const before = Buffer.from(uncompressed.toBuffer())
  expect(() => stampParentHdPublicNode(point, Buffer.alloc(32))).toThrow(
    'stamp-public:scalar-out-of-range',
  )
  expect(() =>
    stampParentHdPublicNode(point, Buffer.from(N_HEX, 'hex')),
  ).toThrow('stamp-public:scalar-out-of-range')
  expect(() =>
    stampParentHdPublicNode(point, Buffer.from(N_PLUS_ONE, 'hex')),
  ).toThrow('stamp-public:scalar-out-of-range')
  expect(() =>
    ctor.constructStampHDPublicKey(Buffer.from(N_HEX, 'hex'), uncompressed),
  ).toThrow('stamp-public:scalar-out-of-range')
  expect(() =>
    stampParentHdPublicNode(point, Buffer.from('33'.repeat(31), 'hex')),
  ).toThrow('stamp-public:digest')
  expect(() =>
    stampParentHdPublicNode(
      point.slice(0, 32),
      Buffer.from('33'.repeat(32), 'hex'),
    ),
  ).toThrow('stamp-public:point')
  const badPrefix = Uint8Array.from(point)
  badPrefix[0] = 0x01
  expect(() =>
    stampParentHdPublicNode(badPrefix, Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-public:point-invalid')
  const order = BigInt(`0x${N_HEX}`)
  const inverse = Buffer.from(
    (order - BigInt(`0x${DEST_SECRET}`)).toString(16).padStart(64, '0'),
    'hex',
  )
  expect(() => stampParentHdPublicNode(point, inverse)).toThrow(
    'stamp-public:point-at-infinity',
  )
  expect(() => addedPoint(point, inverse)).toThrow('point-at-infinity')
  expect(uncompressed.toBuffer()).toEqual(before)
  expect(Buffer.from(point)).toEqual(before)
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
})
