import { PayloadConstructor } from './crypto'
import {
  stealthDepthZeroPublicNode,
  stealthParentHdPublicNode,
} from './stealth-hd-public'
import { stealthParentPublicKey } from './stealth-public'
import {
  addedPoint,
  digestSha256,
  pointKey,
  pointOf,
  reduced32,
  secretKey,
  sharedPoint,
} from '../nakamoto-oracle'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'

function reducedPoint(point: Uint8Array, digest: Uint8Array): Buffer {
  const reduced = reduced32(digest)
  if (reduced.equals(Buffer.alloc(32)))
    return pointOf(Buffer.from(DEST_SECRET, 'hex'), true)
  return addedPoint(point, reduced)
}

it('builds a depth-0 stealth public parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const destinationPublic = destination.toPublicKey()
  const shared = sharedPoint(EPHEMERAL_SECRET, destinationPublic.toBuffer())
  const digest = digestSha256(shared)
  const publicKey = reducedPoint(destinationPublic.toBuffer(), digest)
  expect(
    Buffer.from(
      stealthParentPublicKey(
        Uint8Array.from(destinationPublic.toBuffer()),
        digest,
      ),
    ),
  ).toEqual(publicKey)
  expect(
    Buffer.from(
      ctor.constructStealthPublicKey(ephemeral, destinationPublic).digest,
    ),
  ).toEqual(digest)

  const node = ctor.constructHDStealthPublicKey(ephemeral, destinationPublic)
  expect(Buffer.from(node.publicKey)).toEqual(publicKey)
  expect(Buffer.from(node.chainCode)).toEqual(digest)
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(ephemeral.toBuffer()).toString('hex')).toBe(
    EPHEMERAL_SECRET,
  )

  const compressed = pointKey(pointOf(Buffer.from(DEST_SECRET, 'hex'), true))
  expect(compressed.toBuffer().length).toBe(33)
  const compressedNode = ctor.constructHDStealthPublicKey(ephemeral, compressed)
  expect(Buffer.from(compressedNode.publicKey)).toEqual(publicKey)
  expect(Buffer.from(compressedNode.chainCode)).toEqual(digest)

  const again = Buffer.from(node.publicKey)
  expect(again.equals(Buffer.alloc(33))).toBe(false)
  node.publicKey[1] = node.publicKey[1] ^ 0xff
  expect(Buffer.from(compressedNode.publicKey)).toEqual(publicKey)
  expect(again[1]).not.toBe(node.publicKey[1])

  const callerSecret = Uint8Array.from(ephemeral.toBuffer())
  const callerPoint = Uint8Array.from(destinationPublic.toBuffer())
  const held = stealthParentHdPublicNode(callerSecret, callerPoint)
  expect(Buffer.from(callerSecret).toString('hex')).toBe(EPHEMERAL_SECRET)
  expect(Buffer.from(callerPoint)).toEqual(destinationPublic.toBuffer())
  expect(Buffer.from(held.publicKey)).toEqual(publicKey)
  expect(Buffer.from(held.chainCode)).toEqual(digest)

  const wide = pointKey(pointOf(Buffer.from(DEST_SECRET, 'hex'), false))
  expect(wide.toBuffer().length).toBe(65)
  const wideNode = ctor.constructHDStealthPublicKey(ephemeral, wide)
  expect(Buffer.from(wideNode.publicKey)).toEqual(publicKey)
  expect(Buffer.from(wideNode.chainCode)).toEqual(digest)
})

it('stores a chain code >= n without reducing it', () => {
  const compressed = pointKey(pointOf(Buffer.from(DEST_SECRET, 'hex'), true))
  expect(compressed.toBuffer().length).toBe(33)
  const point = Uint8Array.from(compressed.toBuffer())
  const order = Uint8Array.from(Buffer.from(N_HEX, 'hex'))
  const node = stealthDepthZeroPublicNode(point, order)
  expect(Buffer.from(node.chainCode)).toEqual(Buffer.from(order))
  expect(Buffer.from(node.publicKey)).toEqual(compressed.toBuffer())
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)

  const above = Uint8Array.from(Buffer.from(N_PLUS_ONE, 'hex'))
  const stored = stealthDepthZeroPublicNode(point, above)
  expect(Buffer.from(stored.chainCode)).toEqual(Buffer.from(above))
  expect(Buffer.from(stored.publicKey)).toEqual(compressed.toBuffer())

  expect(() => stealthDepthZeroPublicNode(point, new Uint8Array(31))).toThrow(
    'stealth-hd-public:chain-code',
  )
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
  const badPrefix = Uint8Array.from(point)
  badPrefix[0] = 0x01
  expect(() => stealthDepthZeroPublicNode(badPrefix, order)).toThrow(
    'stealth-hd-public:bad-prefix',
  )
  expect(() => stealthDepthZeroPublicNode(point.slice(0, 32), order)).toThrow(
    'stealth-hd-public:wrong-length',
  )
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)
  expect(Buffer.from(point)).toEqual(compressed.toBuffer())
})

it('rejects the same parent inputs as stealthSharedPoint', () => {
  const destination = secretKey(DEST_SECRET, false)
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  expect(() => stealthParentHdPublicNode(new Uint8Array(), point)).toThrow(
    'stealth-shared:wrong-length',
  )
  expect(() => stealthParentHdPublicNode(Buffer.alloc(32), point)).toThrow(
    'stealth-shared:scalar-out-of-range',
  )
  expect(() =>
    stealthParentHdPublicNode(Buffer.from(N_HEX, 'hex'), point),
  ).toThrow('stealth-shared:scalar-out-of-range')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
  expect(() =>
    stealthParentHdPublicNode(
      Uint8Array.from(destination.toBuffer()),
      new Uint8Array(),
    ),
  ).toThrow('stealth-shared:public-key')
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() =>
    stealthParentHdPublicNode(Uint8Array.from(destination.toBuffer()), invalid),
  ).toThrow('stealth-shared:point-invalid')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(point)).toEqual(destination.toPublicKey().toBuffer())
})
