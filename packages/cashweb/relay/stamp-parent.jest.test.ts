import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stampParentSecret } from './stamp-parent'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ZERO_SUM_DIGEST =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeda99dcbd59e378f2aaec14d7bbf253030'

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function bitcoreStampParent(digest: Buffer, destination: PrivateKey): Buffer {
  const sum = bitcoreCrypto.BN.fromBuffer(digest)
    .add(destination.toBigNumber())
    .mod(bitcoreCrypto.Point.getN())
  return new PrivateKey(sum).toBuffer()
}

it('matches bitcore stamp parent secrets for digests in (0, n)', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const key = ctor.constructStampPrivateKey(digest, destination)
  const described = key.toObject() as { compressed: boolean; network: string }
  expect(key.toBuffer()).toEqual(bitcoreStampParent(digest, destination))
  expect(described.compressed).toBe(true)
  expect(described.network).toBe('livenet')
  expect(key.network.name).toBe('livenet')
  const pub = ctor.constructStampPublicKey(digest, destination.toPublicKey())
  expect(
    bitcoreCrypto.Point.pointToCompressed(key.toPublicKey().point),
  ).toEqual(pub.toBuffer())

  const almost = new PrivateKey(N_MINUS_1)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampPrivateKey(cross, almost)
  expect(crossed.toBuffer()).toEqual(bitcoreStampParent(cross, almost))
  expect(crossed.toBuffer().toString('hex')).toBe(`${'00'.repeat(31)}01`)

  const hd = ctor.constructStampHDPrivateKey(digest, destination)
  const hdDescribed = hd.toObject() as { chainCode: string }
  expect(hd.privateKey.toBuffer()).toEqual(key.toBuffer())
  expect(Buffer.from(hdDescribed.chainCode, 'hex')).toEqual(digest)
  expect(
    Buffer.from(
      stampParentSecret(Uint8Array.from(destination.toBuffer()), digest),
    ),
  ).toEqual(hd.privateKey.toBuffer())
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)

  const crossedHd = ctor.constructStampHDPrivateKey(cross, almost)
  expect(crossedHd.privateKey.toBuffer()).toEqual(crossed.toBuffer())
  expect(
    Buffer.from(stampParentSecret(Uint8Array.from(almost.toBuffer()), cross)),
  ).toEqual(crossedHd.privateKey.toBuffer())
  expect(almost.toBuffer().toString('hex')).toBe(N_MINUS_1)

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(
    source,
    'constructStampPrivateKey(',
    'constructStampHDPrivateKey(',
  )
  expect(body).toContain('stampParentSecret(')
  expect(body).not.toContain('crypto.BN')
  expect(body).not.toContain('Point.getN')
  const stealth = methodBody(
    source,
    'constructStealthPrivateKey(',
    'constructHDStealthPrivateKey(',
  )
  expect(stealth).toContain('point.mul')
  expect(stealth).toContain('crypto.BN')
  const address = methodBody(source, 'constructStampAddress(', 'encrypt(')
  expect(address).toContain('crypto.BN')
  expect(address).toContain('.toAddress(')
  const helper = readFileSync(join(__dirname, 'stamp-parent.ts'), 'utf8')
  expect(helper).toContain('tweakAddPrivateKey(')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a zero sum and digests outside (0, n)', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const secret = Uint8Array.from(destination.toBuffer())
  const zeroSum = Buffer.from(ZERO_SUM_DIGEST, 'hex')
  expect(() => stampParentSecret(secret, zeroSum)).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() =>
    new PrivateKey(
      bitcoreCrypto.BN.fromBuffer(zeroSum)
        .add(destination.toBigNumber())
        .mod(bitcoreCrypto.Point.getN()),
    ),
  ).toThrow('Number can not be equal to zero')
  expect(() => stampParentSecret(secret, Buffer.alloc(32))).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() =>
    stampParentSecret(secret, Buffer.from(N_HEX, 'hex')),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    stampParentSecret(secret, Buffer.from('33'.repeat(31), 'hex')),
  ).toThrow('stamp-parent:digest')
  expect(() =>
    stampParentSecret(Buffer.alloc(31), Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-parent:wrong-length')
  expect(() =>
    stampParentSecret(Buffer.alloc(32), Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stamp-parent:scalar-out-of-range')
})
