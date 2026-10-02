import { HDPrivateKey, PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stealthDepthZeroNode, stealthParentHdNode } from './stealth-hd'
import { stealthParentSecret } from './stealth-parent'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'

function bitcoreNode(secret: Buffer, chainCode: Buffer, network: string) {
  return new HDPrivateKey({
    privateKey: secret,
    depth: 0,
    network,
    childIndex: 0,
    chainCode,
    parentFingerPrint: 0,
  })
}

it('builds a depth-0 stealth parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeralPublic = ephemeral.toPublicKey()
  const derived = stealthParentSecret(
    Uint8Array.from(destination.toBuffer()),
    Uint8Array.from(ephemeralPublic.toBuffer()),
  )
  const secret = Buffer.from(derived.secret)
  const digest = Buffer.from(derived.digest)
  derived.secret.fill(0)

  const node = ctor.constructHDStealthPrivateKey(ephemeralPublic, destination)
  const described = bitcoreNode(secret, digest, 'testnet').toObject() as {
    chainCode: string
    parentFingerPrint: number
    depth: number
    childIndex: number
  }
  expect(Buffer.from(node.privateKey.bytes)).toEqual(
    bitcoreNode(secret, digest, 'testnet').privateKey.toBuffer(),
  )
  expect(Buffer.from(node.privateKey.bytes)).toEqual(
    bitcoreNode(secret, digest, NETWORK).privateKey.toBuffer(),
  )
  expect(Buffer.from(node.chainCode)).toEqual(digest)
  expect(Buffer.from(node.chainCode).toString('hex')).toBe(described.chainCode)
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(described.depth).toBe(0)
  expect(described.childIndex).toBe(0)
  expect(described.parentFingerPrint).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
  const compressed = PublicKey.fromPoint(ephemeralPublic.point, true)
  expect(compressed.toBuffer().length).toBe(33)
  const compressedNode = ctor.constructHDStealthPrivateKey(
    compressed,
    destination,
  )
  expect(Buffer.from(compressedNode.privateKey.bytes)).toEqual(secret)
  expect(Buffer.from(compressedNode.chainCode)).toEqual(digest)

  const again = Buffer.from(node.privateKey.bytes)
  expect(again.equals(Buffer.alloc(32))).toBe(false)
  expect(again).toEqual(secret)

  const caller = Uint8Array.from(destination.toBuffer())
  const callerPoint = Uint8Array.from(ephemeralPublic.toBuffer())
  const held = stealthParentHdNode(caller, callerPoint)
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(callerPoint)).toEqual(ephemeralPublic.toBuffer())
  expect(Buffer.from(held.privateKey.bytes)).toEqual(secret)
  expect(Buffer.from(held.chainCode)).toEqual(digest)

  const uncompressed = PublicKey.fromPoint(ephemeralPublic.point, false)
  expect(uncompressed.toBuffer().length).toBe(65)
  const wide = ctor.constructHDStealthPrivateKey(uncompressed, destination)
  expect(Buffer.from(wide.privateKey.bytes)).toEqual(secret)
  expect(Buffer.from(wide.chainCode)).toEqual(digest)
})

it('stores a chain code >= n without reducing it', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const secret = Uint8Array.from(destination.toBuffer())
  const order = Uint8Array.from(Buffer.from(N_HEX, 'hex'))
  const node = stealthDepthZeroNode(secret, order)
  expect(Buffer.from(node.chainCode)).toEqual(Buffer.from(order))
  expect(Buffer.from(node.privateKey.bytes)).toEqual(destination.toBuffer())
  expect(Buffer.from(secret).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)

  const above = Uint8Array.from(Buffer.from(N_PLUS_ONE, 'hex'))
  const stored = stealthDepthZeroNode(secret, above)
  expect(Buffer.from(stored.chainCode)).toEqual(Buffer.from(above))
  expect(Buffer.from(stored.privateKey.bytes)).toEqual(destination.toBuffer())

  expect(() => stealthDepthZeroNode(secret, new Uint8Array(31))).toThrow(
    'stealth-hd:chain-code',
  )
  expect(Buffer.from(secret).toString('hex')).toBe(DEST_SECRET)
  expect(() => stealthDepthZeroNode(Buffer.alloc(32), order)).toThrow(
    'stealth-hd:scalar-out-of-range',
  )
  expect(() => stealthDepthZeroNode(Buffer.from(N_HEX, 'hex'), order)).toThrow(
    'stealth-hd:scalar-out-of-range',
  )
  expect(() => stealthDepthZeroNode(Buffer.alloc(31), order)).toThrow(
    'stealth-hd:wrong-length',
  )
  expect(Buffer.from(order).toString('hex')).toBe(N_HEX)
})

it('rejects the same parent inputs as stealthParentSecret', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  expect(() =>
    stealthParentHdNode(
      Uint8Array.from(destination.toBuffer()),
      new Uint8Array(),
    ),
  ).toThrow('stealth-parent:public-key')
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() =>
    stealthParentHdNode(Uint8Array.from(destination.toBuffer()), invalid),
  ).toThrow('stealth-parent:point-invalid')
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)

})
