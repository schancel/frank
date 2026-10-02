import { PayloadConstructor } from './crypto'
import { stealthDepthZeroNode, stealthParentHdNode } from './stealth-hd'
import { stealthParentSecret } from './stealth-parent'
import {
  addedSecretMod,
  digestSha256,
  pointKey,
  pointOf,
  secretKey,
  sharedPoint,
} from '../nakamoto-oracle'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'

function parentOf(
  destHex: string,
  ephemeralPoint: Uint8Array,
): {
  secret: Buffer
  digest: Buffer
} {
  const shared = sharedPoint(destHex, ephemeralPoint)
  const digest = digestSha256(shared)
  return {
    secret: addedSecretMod(Buffer.from(destHex, 'hex'), digest),
    digest,
  }
}

it('builds a depth-0 stealth parent whose chain code is the raw digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const ephemeralPublic = ephemeral.toPublicKey()
  const expected = parentOf(DEST_SECRET, ephemeralPublic.toBuffer())
  const derived = stealthParentSecret(
    Uint8Array.from(destination.toBuffer()),
    Uint8Array.from(ephemeralPublic.toBuffer()),
  )
  expect(Buffer.from(derived.secret)).toEqual(expected.secret)
  expect(Buffer.from(derived.digest)).toEqual(expected.digest)
  derived.secret.fill(0)

  const node = ctor.constructHDStealthPrivateKey(ephemeralPublic, destination)
  expect(Buffer.from(node.privateKey.bytes)).toEqual(expected.secret)
  expect(Buffer.from(node.chainCode)).toEqual(expected.digest)
  expect(node.depth).toBe(0)
  expect(node.childIndex).toBe(0)
  expect(Buffer.from(node.parentFingerprint)).toEqual(Buffer.alloc(4))
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)

  const compressed = pointKey(
    pointOf(Buffer.from(EPHEMERAL_SECRET, 'hex'), true),
  )
  expect(compressed.toBuffer().length).toBe(33)
  const compressedNode = ctor.constructHDStealthPrivateKey(
    compressed,
    destination,
  )
  expect(Buffer.from(compressedNode.privateKey.bytes)).toEqual(expected.secret)
  expect(Buffer.from(compressedNode.chainCode)).toEqual(expected.digest)

  const again = Buffer.from(node.privateKey.bytes)
  expect(again.equals(Buffer.alloc(32))).toBe(false)
  expect(again).toEqual(expected.secret)

  const caller = Uint8Array.from(destination.toBuffer())
  const callerPoint = Uint8Array.from(ephemeralPublic.toBuffer())
  const held = stealthParentHdNode(caller, callerPoint)
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(callerPoint)).toEqual(ephemeralPublic.toBuffer())
  expect(Buffer.from(held.privateKey.bytes)).toEqual(expected.secret)
  expect(Buffer.from(held.chainCode)).toEqual(expected.digest)

  const wide = pointKey(pointOf(Buffer.from(EPHEMERAL_SECRET, 'hex'), false))
  expect(wide.toBuffer().length).toBe(65)
  const wideNode = ctor.constructHDStealthPrivateKey(wide, destination)
  expect(Buffer.from(wideNode.privateKey.bytes)).toEqual(expected.secret)
  expect(Buffer.from(wideNode.chainCode)).toEqual(expected.digest)
})

it('stores a chain code >= n without reducing it', () => {
  const destination = secretKey(DEST_SECRET, false)
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
  const destination = secretKey(DEST_SECRET, false)
  expect(() =>
    stealthParentHdNode(
      Uint8Array.from(destination.toBuffer()),
      new Uint8Array(),
    ),
  ).toThrow('stealth-parent:public-key')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() =>
    stealthParentHdNode(Uint8Array.from(destination.toBuffer()), invalid),
  ).toThrow('stealth-parent:point-invalid')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
})
