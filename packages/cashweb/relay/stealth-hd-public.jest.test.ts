import { readFileSync } from 'fs'
import { join } from 'path'

import { HDPublicKey, PrivateKey, PublicKey } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import {
  stealthDepthZeroPublicNode,
  stealthParentHdPublicNode,
} from './stealth-hd-public'
import { stealthParentPublicKey } from './stealth-public'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function bitcoreNode(publicKey: Buffer, chainCode: Buffer, network: string) {
  return new HDPublicKey({
    publicKey,
    depth: 0,
    network,
    childIndex: 0,
    chainCode,
    parentFingerPrint: 0,
  })
}

it('builds a depth-0 stealth public parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const destinationPublic = destination.toPublicKey()
  const point = stealthParentPublicKey(
    Uint8Array.from(destinationPublic.toBuffer()),
    Uint8Array.from(
      ctor.constructStealthPublicKey(ephemeral, destinationPublic).digest,
    ),
  )
  const digest = ctor.constructStealthPublicKey(
    ephemeral,
    destinationPublic,
  ).digest
  const publicKey = Buffer.from(point)

  const node = ctor.constructHDStealthPublicKey(ephemeral, destinationPublic)
  const described = bitcoreNode(
    publicKey,
    Buffer.from(digest),
    'testnet',
  ).toObject() as {
    chainCode: Buffer
    parentFingerPrint: number
    depth: number
    childIndex: number
  }
  expect(Buffer.from(node.publicKey)).toEqual(
    bitcoreNode(publicKey, Buffer.from(digest), 'testnet').publicKey.toBuffer(),
  )
  expect(Buffer.from(node.publicKey)).toEqual(
    bitcoreNode(publicKey, Buffer.from(digest), NETWORK).publicKey.toBuffer(),
  )
  expect(Buffer.from(node.chainCode)).toEqual(Buffer.from(digest))
  expect(Buffer.from(described.chainCode)).toEqual(Buffer.from(digest))
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(described.depth).toBe(0)
  expect(described.childIndex).toBe(0)
  expect(described.parentFingerPrint).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
  expect(ephemeral.toBuffer().toString('hex')).toBe(EPHEMERAL_SECRET)

  const compressed = PublicKey.fromPoint(destinationPublic.point, true)
  expect(compressed.toBuffer().length).toBe(33)
  const compressedNode = ctor.constructHDStealthPublicKey(ephemeral, compressed)
  expect(Buffer.from(compressedNode.publicKey)).toEqual(publicKey)
  expect(Buffer.from(compressedNode.chainCode)).toEqual(Buffer.from(digest))

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
  expect(Buffer.from(held.chainCode)).toEqual(Buffer.from(digest))

  const uncompressed = PublicKey.fromPoint(destinationPublic.point, false)
  expect(uncompressed.toBuffer().length).toBe(65)
  const wide = ctor.constructHDStealthPublicKey(ephemeral, uncompressed)
  expect(Buffer.from(wide.publicKey)).toEqual(publicKey)
  expect(Buffer.from(wide.chainCode)).toEqual(Buffer.from(digest))
})

it('stores a chain code >= n without reducing it', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const compressed = PublicKey.fromPoint(destination.toPublicKey().point, true)
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
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
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
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
  expect(() =>
    stealthParentHdPublicNode(Uint8Array.from(destination.toBuffer()), new Uint8Array()),
  ).toThrow('stealth-shared:public-key')
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() =>
    stealthParentHdPublicNode(Uint8Array.from(destination.toBuffer()), invalid),
  ).toThrow('stealth-shared:point-invalid')
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(point)).toEqual(destination.toPublicKey().toBuffer())

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(
    source,
    'constructHDStealthPublicKey(',
    'constructStealthPrivateKey(',
  )
  expect(body).toContain('stealthParentHdPublicNode(')
  expect(body).not.toContain('HDPublicKey')
  expect(body).not.toContain('fromSeed')
  expect(body).not.toContain('networkName')
  const helper = readFileSync(join(__dirname, 'stealth-hd-public.ts'), 'utf8')
  expect(helper).toContain('compressedPublicKeyFromBytes(')
  expect(helper).toContain('stealthSharedPoint(')
  expect(helper).toContain('stealthPointDigest(')
  expect(helper).toContain('stealthParentPublicKey(')
  expect(helper).not.toContain('stealthDigestModN')
  expect(helper).not.toContain('hdPrivateFromSeed')
  expect(helper).not.toContain('bitcore')
  expect(helper).not.toContain('Point.getN')
})
