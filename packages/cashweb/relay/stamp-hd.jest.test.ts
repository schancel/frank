import { PayloadConstructor } from './crypto'
import { stampDepthZeroNode, stampParentHdNode } from './stamp-hd'
import { stampParentSecret } from './stamp-parent'
import { addedSecret, secretKey } from '../nakamoto-oracle'

const DEST_SECRET = '11'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ZERO_SUM_DIGEST =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeda99dcbd59e378f2aaec14d7bbf253030'
const ONE = `${'00'.repeat(31)}01`

it('builds a depth-0 stamp parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const secret = addedSecret(destination.toBuffer(), digest)
  expect(
    Buffer.from(
      stampParentSecret(Uint8Array.from(destination.toBuffer()), digest),
    ),
  ).toEqual(secret)

  const node = ctor.constructStampHDPrivateKey(digest, destination)
  expect(Buffer.from(node.privateKey.bytes)).toEqual(secret)
  expect(Buffer.from(node.chainCode)).toEqual(digest)
  expect(Buffer.from(node.chainCode)).not.toEqual(secret)
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)

  const again = Buffer.from(node.privateKey.bytes)
  expect(again.equals(Buffer.alloc(32))).toBe(false)
  expect(again).toEqual(secret)
  const other = ctor.constructStampHDPrivateKey(digest, destination)
  const kept = Buffer.from(other.privateKey.bytes)
  node.privateKey.bytes[0] = node.privateKey.bytes[0] ^ 0xff
  expect(Buffer.from(other.privateKey.bytes)).toEqual(kept)
  expect(Buffer.from(node.privateKey.bytes)).not.toEqual(kept)

  const caller = Uint8Array.from(destination.toBuffer())
  const callerDigest = Uint8Array.from(digest)
  const held = stampParentHdNode(caller, callerDigest)
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(callerDigest)).toEqual(digest)
  expect(Buffer.from(held.privateKey.bytes)).toEqual(secret)
  expect(Buffer.from(held.chainCode)).toEqual(digest)

  const almost = secretKey(N_MINUS_1, true)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampHDPrivateKey(cross, almost)
  expect(Buffer.from(crossed.privateKey.bytes)).toEqual(
    addedSecret(almost.toBuffer(), cross),
  )
  expect(Buffer.from(crossed.privateKey.bytes).toString('hex')).toBe(ONE)
  expect(Buffer.from(crossed.chainCode)).toEqual(cross)
  expect(Buffer.from(almost.toBuffer()).toString('hex')).toBe(N_MINUS_1)
})

it('stores a chain code >= n without reducing it', () => {
  const destination = secretKey(DEST_SECRET, false)
  const secret = Uint8Array.from(destination.toBuffer())
  const order = Uint8Array.from(Buffer.from(N_HEX, 'hex'))
  const node = stampDepthZeroNode(secret, order)
  expect(Buffer.from(node.chainCode)).toEqual(Buffer.from(order))
  expect(Buffer.from(node.privateKey.bytes)).toEqual(destination.toBuffer())
  expect(Buffer.from(secret).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)

  const above = Uint8Array.from(Buffer.from(N_PLUS_ONE, 'hex'))
  const stored = stampDepthZeroNode(secret, above)
  expect(Buffer.from(stored.chainCode)).toEqual(Buffer.from(above))
  expect(Buffer.from(stored.privateKey.bytes)).toEqual(destination.toBuffer())

  expect(() => stampDepthZeroNode(secret, new Uint8Array(31))).toThrow(
    'stamp-hd:chain-code',
  )
  expect(Buffer.from(secret).toString('hex')).toBe(DEST_SECRET)
  expect(() => stampDepthZeroNode(Buffer.alloc(32), order)).toThrow(
    'stamp-hd:scalar-out-of-range',
  )
  expect(() => stampDepthZeroNode(Buffer.from(N_HEX, 'hex'), order)).toThrow(
    'stamp-hd:scalar-out-of-range',
  )
  expect(() => stampDepthZeroNode(Buffer.alloc(31), order)).toThrow(
    'stamp-hd:wrong-length',
  )
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)
})

it('rejects a stamp digest >= n instead of reducing it', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const secret = Uint8Array.from(destination.toBuffer())
  expect(() => stampParentHdNode(secret, Buffer.alloc(32))).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() => stampParentHdNode(secret, Buffer.from(N_HEX, 'hex'))).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() =>
    stampParentHdNode(secret, Buffer.from(N_PLUS_ONE, 'hex')),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    ctor.constructStampHDPrivateKey(Buffer.from(N_HEX, 'hex'), destination),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    stampParentHdNode(secret, Buffer.from(ZERO_SUM_DIGEST, 'hex')),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    stampParentHdNode(secret, Buffer.from('33'.repeat(31), 'hex')),
  ).toThrow('stamp-parent:digest')
  expect(() =>
    stampParentHdNode(Buffer.alloc(31), Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-parent:wrong-length')
  expect(() =>
    stampParentHdNode(Buffer.alloc(32), Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(secret).toString('hex')).toBe(DEST_SECRET)
})
