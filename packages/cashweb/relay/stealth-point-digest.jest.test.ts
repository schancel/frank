import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import {
  PrivateKey,
  PublicKey,
  crypto as bitcoreCrypto,
} from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stealthPointDigest } from './stealth-point-digest'

const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// NIST SHA-256("abc")
const ABC_SHA256 =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

it('hashes a compressed stealth point with one SHA-256', () => {
  const empty = Buffer.from(stealthPointDigest(new Uint8Array()))
  expect(empty.toString('hex')).toBe(EMPTY_SHA256)
  expect(empty.toString('hex')).toBe(
    createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
  )
  expect(empty).toEqual(bitcoreCrypto.Hash.sha256(Buffer.alloc(0)))

  const abc = Buffer.from('abc')
  const abcDigest = Buffer.from(stealthPointDigest(abc))
  expect(abcDigest.toString('hex')).toBe(ABC_SHA256)
  expect(abcDigest.toString('hex')).toBe(
    createHash('sha256').update(abc).digest('hex'),
  )
  expect(abcDigest).toEqual(bitcoreCrypto.Hash.sha256(abc))

  const leadingZero = Uint8Array.from([0x02, 0x00, 0x01])
  const leadingZeroDigest = Buffer.from(stealthPointDigest(leadingZero))
  expect(leadingZeroDigest).toEqual(
    bitcoreCrypto.Hash.sha256(Buffer.from(leadingZero)),
  )
  expect(leadingZeroDigest.toString('hex')).toBe(
    createHash('sha256').update(leadingZero).digest('hex'),
  )
  const doubled = createHash('sha256').update(leadingZeroDigest).digest('hex')
  expect(leadingZeroDigest.toString('hex')).not.toBe(doubled)
})

it('derives stealth keys from that digest and leaves HMAC on bitcore', () => {
  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const publicBody = methodBody(
    source,
    'constructStealthPublicKey(',
    'constructHDStealthPublicKey(',
  )
  const privateBody = methodBody(
    source,
    'constructStealthPrivateKey(',
    'constructHDStealthPrivateKey(',
  )
  expect(publicBody).toContain('stealthPointDigest(dhKeyPointRaw)')
  expect(privateBody).toContain('stealthPointDigest(dhKeyPointRaw)')
  expect(publicBody).not.toContain('crypto.Hash.sha256')
  expect(privateBody).not.toContain('crypto.Hash.sha256')
  expect(source).not.toContain('crypto.Hash.sha256(')
  expect(source.match(/crypto\.Hash\.sha256hmac\(/g)).toHaveLength(2)
  expect(source).toContain('point.mul(')
  expect(source).not.toContain('sha256d')

  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const destinationPublic = destination.toPublicKey()
  const ephemeralPublic = ephemeral.toPublicKey()
  const raw = bitcoreCrypto.Point.pointToCompressed(
    destinationPublic.point.mul(ephemeral.bn),
  )
  const expectedDigest = bitcoreCrypto.Hash.sha256(raw)
  expect(Buffer.from(stealthPointDigest(raw))).toEqual(expectedDigest)
  expect(expectedDigest.toString('hex')).toBe(
    createHash('sha256').update(raw).digest('hex'),
  )

  const stealthPublic = ctor.constructStealthPublicKey(
    ephemeral,
    destinationPublic,
  )
  expect(Buffer.from(stealthPublic.digest)).toEqual(expectedDigest)
  const digestPublic = PrivateKey.fromBuffer(
    expectedDigest,
    NETWORK,
  ).toPublicKey()
  const expectedPublic = PublicKey.fromPoint(
    digestPublic.point.add(destinationPublic.point),
  )
  expect(stealthPublic.stealthPublicKey.toBuffer()).toEqual(
    expectedPublic.toBuffer(),
  )

  const stealthPrivate = ctor.constructStealthPrivateKey(
    ephemeralPublic,
    destination,
  )
  expect(Buffer.from(stealthPrivate.digest)).toEqual(expectedDigest)
  const digestBn = bitcoreCrypto.BN.fromBuffer(expectedDigest)
  const expectedPrivate = new PrivateKey(
    digestBn.add(destination.bn).mod(bitcoreCrypto.Point.getN()),
  )
  expect(stealthPrivate.stealthPrivateKey.toBuffer()).toEqual(
    expectedPrivate.toBuffer(),
  )
})
