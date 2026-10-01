import { readFileSync } from 'fs'
import { join } from 'path'

import {
  PrivateKey,
  PublicKey,
  crypto as bitcoreCrypto,
} from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stampParentPublicKey } from './stamp-public'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function bitcoreStampPublic(digest: Buffer, destination: PublicKey): Buffer {
  const digestPoint = PrivateKey.fromBuffer(digest).toPublicKey().point
  return PublicKey.fromPoint(digestPoint.add(destination.point)).toBuffer()
}

it('matches bitcore stamp public keys for digests in (0, n)', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const uncompressed = destination.toPublicKey()
  const compressed = new PublicKey(
    Buffer.from(
      bitcoreCrypto.Point.pointToCompressed(uncompressed.point),
    ),
  )
  expect(uncompressed.toBuffer().length).toBe(65)
  expect(compressed.toBuffer().length).toBe(33)
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const key = ctor.constructStampPublicKey(digest, uncompressed)
  const described = key.toObject() as { compressed: boolean }
  const expected = bitcoreStampPublic(digest, uncompressed)
  expect(key.toBuffer()).toEqual(expected)
  expect(key.toBuffer()).toEqual(bitcoreStampPublic(digest, compressed))
  expect(
    ctor.constructStampPublicKey(digest, compressed).toBuffer(),
  ).toEqual(expected)
  expect(described.compressed).toBe(true)
  expect(key.network.name).toBe('livenet')
  expect(key.toBuffer().length).toBe(33)

  const almost = new PrivateKey(N_MINUS_1)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampPublicKey(cross, almost.toPublicKey())
  expect(crossed.toBuffer()).toEqual(
    bitcoreStampPublic(cross, almost.toPublicKey()),
  )
  expect(crossed.toBuffer()).toEqual(
    new PrivateKey(ONE).toPublicKey().toBuffer(),
  )

  const hd = ctor.constructStampHDPublicKey(digest, uncompressed)
  const hdDescribed = hd.toObject() as { chainCode: string }
  expect(hd.publicKey.toBuffer()).toEqual(key.toBuffer())
  expect(Buffer.from(hdDescribed.chainCode, 'hex')).toEqual(digest)

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(
    source,
    'constructStampPublicKey(',
    'constructStampHDPublicKey(',
  )
  expect(body).toContain('stampParentPublicKey(')
  expect(body).not.toContain('point.add')
  expect(body).not.toContain('PrivateKey.fromBuffer')
  expect(body).not.toContain('point.mul')
  const stealth = methodBody(
    source,
    'constructStealthPublicKey(',
    'constructHDStealthPublicKey(',
  )
  expect(stealth).toContain('point.mul')
  expect(stealth).toContain('point.add')
  const address = methodBody(source, 'constructStampAddress(', 'encrypt(')
  expect(address).toContain('crypto.BN')
  expect(address).toContain('.toAddress(')
  const helper = readFileSync(join(__dirname, 'stamp-public.ts'), 'utf8')
  expect(helper).toContain('tweakAddPublicKey(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects digests outside (0, n), a bad point, and infinity', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  const zero = Buffer.alloc(32)
  expect(() => stampParentPublicKey(point, zero)).toThrow(
    'stamp-public:scalar-out-of-range',
  )
  expect(() =>
    stampParentPublicKey(point, Buffer.from(N_HEX, 'hex')),
  ).toThrow('stamp-public:scalar-out-of-range')
  expect(() =>
    stampParentPublicKey(point, Buffer.from('33'.repeat(31), 'hex')),
  ).toThrow('stamp-public:digest')
  expect(() =>
    stampParentPublicKey(
      point.slice(0, 32),
      Buffer.from('33'.repeat(32), 'hex'),
    ),
  ).toThrow('stamp-public:point')
  const badPrefix = Uint8Array.from(point)
  badPrefix[0] = 0x01
  expect(() =>
    stampParentPublicKey(badPrefix, Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-public:point-invalid')

  const order = BigInt(`0x${N_HEX}`)
  const inverse = Buffer.from(
    (order - BigInt(`0x${DEST_SECRET}`)).toString(16).padStart(64, '0'),
    'hex',
  )
  expect(() => stampParentPublicKey(point, inverse)).toThrow(
    'stamp-public:point-at-infinity',
  )
  expect(() =>
    PublicKey.fromPoint(
      PrivateKey.fromBuffer(inverse)
        .toPublicKey()
        .point.add(destination.toPublicKey().point),
    ),
  ).toThrow()
})
