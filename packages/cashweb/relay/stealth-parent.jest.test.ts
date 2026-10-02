import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, PublicKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import {
  stealthDigestModN,
  stealthParentScalar,
  stealthParentSecret,
} from './stealth-parent'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const ONE = `${'00'.repeat(31)}01`

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function bitcoreMod(digest: Buffer): Buffer {
  return bitcoreCrypto.BN.fromBuffer(digest)
    .mod(bitcoreCrypto.Point.getN())
    .toBuffer({ size: 32 })
}

function bitcoreSum(digest: Buffer, destination: PrivateKey): Buffer {
  return new PrivateKey(
    bitcoreCrypto.BN.fromBuffer(digest)
      .add(destination.toBigNumber())
      .mod(bitcoreCrypto.Point.getN()),
  ).toBuffer()
}

function bitcoreParent(
  ephemeralPublic: PublicKey,
  destination: PrivateKey,
): { secret: Buffer; digest: Buffer; point: Buffer } {
  const point = bitcoreCrypto.Point.pointToCompressed(
    ephemeralPublic.point.mul(destination.bn),
  )
  const digest = bitcoreCrypto.Hash.sha256(point)
  return { secret: bitcoreSum(digest, destination), digest, point }
}

it('reduces a stealth digest mod n the way bitcore does', () => {
  const samples = [
    Buffer.alloc(32),
    Buffer.from(ONE, 'hex'),
    Buffer.from(N_MINUS_1, 'hex'),
    Buffer.from(N_HEX, 'hex'),
    Buffer.from(N_PLUS_ONE, 'hex'),
    Buffer.alloc(32, 0xff),
    Buffer.from(DEST_SECRET, 'hex'),
  ]
  for (const digest of samples) {
    expect(Buffer.from(stealthDigestModN(digest))).toEqual(bitcoreMod(digest))
  }
  expect(Buffer.from(stealthDigestModN(Buffer.from(N_HEX, 'hex'))).toString('hex')).toBe(
    '00'.repeat(32),
  )
  expect(Buffer.from(stealthDigestModN(Buffer.from(N_PLUS_ONE, 'hex'))).toString('hex')).toBe(
    ONE,
  )
  expect(() => stealthDigestModN(Buffer.alloc(31))).toThrow('stealth-parent:digest')
  expect(() => stealthDigestModN(Buffer.alloc(33))).toThrow('stealth-parent:digest')
})

it('adds the stealth digest to the destination the way bitcore does', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const almost = new PrivateKey(N_MINUS_1)
  const one = new PrivateKey(ONE)
  const digests = [
    Buffer.alloc(32),
    Buffer.from(N_HEX, 'hex'),
    Buffer.alloc(32, 0xff),
    Buffer.from('33'.repeat(32), 'hex'),
    Buffer.from(N_MINUS_1, 'hex'),
  ]
  for (const digest of digests) {
    expect(
      Buffer.from(
        stealthParentScalar(Uint8Array.from(destination.toBuffer()), digest),
      ),
    ).toEqual(bitcoreSum(digest, destination))
    expect(
      Buffer.from(
        stealthParentScalar(Uint8Array.from(almost.toBuffer()), digest),
      ),
    ).toEqual(bitcoreSum(digest, almost))
  }
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(destination.toBuffer()),
        Buffer.from(ONE, 'hex'),
      ),
    ),
  ).toEqual(bitcoreSum(Buffer.from(ONE, 'hex'), destination))
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(destination.toBuffer()),
        Buffer.from(N_PLUS_ONE, 'hex'),
      ),
    ),
  ).toEqual(bitcoreSum(Buffer.from(N_PLUS_ONE, 'hex'), destination))
  expect(Buffer.from(stealthParentScalar(Uint8Array.from(destination.toBuffer()), Buffer.alloc(32))).toString('hex')).toBe(
    DEST_SECRET,
  )
  expect(Buffer.from(stealthParentScalar(Uint8Array.from(one.toBuffer()), Buffer.from('33'.repeat(32), 'hex'))).toString('hex')).toBe(
    bitcoreSum(Buffer.from('33'.repeat(32), 'hex'), one).toString('hex'),
  )
  const caller = Uint8Array.from(destination.toBuffer())
  stealthParentScalar(caller, Buffer.from('33'.repeat(32), 'hex'))
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)

  expect(() =>
    stealthParentScalar(Uint8Array.from(one.toBuffer()), Buffer.from(N_MINUS_1, 'hex')),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() =>
    new PrivateKey(
      bitcoreCrypto.BN.fromBuffer(Buffer.from(N_MINUS_1, 'hex'))
        .add(one.toBigNumber())
        .mod(bitcoreCrypto.Point.getN()),
    ),
  ).toThrow('Number can not be equal to zero')
  expect(() => stealthParentScalar(Buffer.alloc(32), Buffer.from(ONE, 'hex'))).toThrow(
    'stealth-parent:scalar-out-of-range',
  )
  expect(() =>
    stealthParentScalar(Buffer.from(N_HEX, 'hex'), Buffer.from(ONE, 'hex')),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() =>
    stealthParentScalar(Buffer.alloc(31), Buffer.from(ONE, 'hex')),
  ).toThrow('stealth-parent:wrong-length')
  expect(() =>
    stealthParentScalar(Uint8Array.from(destination.toBuffer()), Buffer.alloc(31)),
  ).toThrow('stealth-parent:digest')
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)
})

it('derives the stealth parent from ecdh', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(Buffer.from(DEST_SECRET, 'hex'), NETWORK)
  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeralPublic = ephemeral.toPublicKey()
  const expected = bitcoreParent(ephemeralPublic, destination)
  const derived = ctor.constructStealthPrivateKey(ephemeralPublic, destination)
  const described = derived.stealthPrivateKey.toObject() as {
    compressed: boolean
    network: string
  }
  expect(derived.stealthPrivateKey.toBuffer()).toEqual(expected.secret)
  expect(Buffer.from(derived.digest)).toEqual(expected.digest)
  expect(described.compressed).toBe(true)
  expect(described.network).toBe('livenet')
  expect(derived.stealthPrivateKey.network.name).toBe('livenet')

  const fromHelper = stealthParentSecret(
    Uint8Array.from(destination.toBuffer()),
    Uint8Array.from(ephemeralPublic.toBuffer()),
  )
  expect(Buffer.from(fromHelper.secret)).toEqual(expected.secret)
  expect(Buffer.from(fromHelper.digest)).toEqual(expected.digest)
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)

  const uncompressed = PublicKey.fromPoint(ephemeralPublic.point, false)
  expect(uncompressed.toBuffer().length).toBe(65)
  const wide = bitcoreParent(uncompressed, destination)
  expect(wide.point).toEqual(expected.point)
  const wideDerived = ctor.constructStealthPrivateKey(uncompressed, destination)
  expect(wideDerived.stealthPrivateKey.toBuffer()).toEqual(expected.secret)
  expect(Buffer.from(wideDerived.digest)).toEqual(expected.digest)

  const almost = new PrivateKey(N_MINUS_1)
  const almostExpected = bitcoreParent(ephemeralPublic, almost)
  const almostDerived = ctor.constructStealthPrivateKey(ephemeralPublic, almost)
  expect(almostDerived.stealthPrivateKey.toBuffer()).toEqual(almostExpected.secret)
  expect(Buffer.from(almostDerived.digest)).toEqual(almostExpected.digest)

  const one = new PrivateKey(ONE)
  const oneExpected = bitcoreParent(ephemeralPublic, one)
  expect(ctor.constructStealthPrivateKey(ephemeralPublic, one).stealthPrivateKey.toBuffer()).toEqual(
    oneExpected.secret,
  )

  const leadingZeroSecret = `${'00'.repeat(31)}6d`
  const leadingZeroKey = new PrivateKey(leadingZeroSecret)
  const leadingMatch = bitcoreParent(leadingZeroKey.toPublicKey(), destination)
  expect(leadingMatch.point.length).toBe(33)
  expect(leadingMatch.point[1]).toBe(0)
  const leadingParent = ctor.constructStealthPrivateKey(
    leadingZeroKey.toPublicKey(),
    destination,
  )
  expect(leadingParent.stealthPrivateKey.toBuffer()).toEqual(leadingMatch.secret)
  expect(Buffer.from(leadingParent.digest)).toEqual(leadingMatch.digest)

  const hd = ctor.constructHDStealthPrivateKey(ephemeralPublic, destination)
  expect(Buffer.from(hd.privateKey.bytes)).toEqual(
    derived.stealthPrivateKey.toBuffer(),
  )
  expect(Buffer.from(hd.chainCode)).toEqual(Buffer.from(derived.digest))

  const caller = Uint8Array.from(destination.toBuffer())
  const callerPoint = Uint8Array.from(ephemeralPublic.toBuffer())
  stealthParentSecret(caller, callerPoint)
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)
  expect(Buffer.from(callerPoint)).toEqual(ephemeralPublic.toBuffer())

  expect(() =>
    stealthParentSecret(Uint8Array.from(destination.toBuffer()), new Uint8Array()),
  ).toThrow('stealth-parent:public-key')
  expect(() =>
    stealthParentSecret(Uint8Array.from(destination.toBuffer()), new Uint8Array(32)),
  ).toThrow('stealth-parent:public-key')
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() =>
    stealthParentSecret(Uint8Array.from(destination.toBuffer()), invalid),
  ).toThrow('stealth-parent:point-invalid')
  expect(() => stealthParentSecret(Buffer.alloc(32), callerPoint)).toThrow(
    'stealth-parent:scalar-out-of-range',
  )
  expect(() =>
    stealthParentSecret(Buffer.from(N_HEX, 'hex'), callerPoint),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() => stealthParentSecret(Buffer.alloc(31), callerPoint)).toThrow(
    'stealth-parent:wrong-length',
  )

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(
    source,
    'constructStealthPrivateKey(',
    'constructHDStealthPrivateKey(',
  )
  expect(body).toContain('stealthParentSecret(')
  expect(body).not.toContain('point.mul')
  expect(body).not.toContain('crypto.BN')
  expect(body).not.toContain('Point.getN')
  const publicBody = methodBody(
    source,
    'constructStealthPublicKey(',
    'constructHDStealthPublicKey(',
  )
  expect(publicBody).toContain('stealthSharedPoint(')
  expect(publicBody).not.toContain('point.mul')
  expect(publicBody).toContain('stealthParentPublicKey(')
  expect(publicBody).not.toContain('point.add')
  expect(publicBody).toContain('stealthPointDigest(')
  const merged = methodBody(source, 'constructMergedKey(', 'constructSharedPointEncodings(')
  expect(merged).toContain('point.mul')
  const helper = readFileSync(join(__dirname, 'stealth-parent.ts'), 'utf8')
  expect(helper).toContain('ecdh(')
  expect(helper).toContain('tweakAddPrivateKey(')
  expect(helper).toContain('stealthPointDigest(')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('point.add')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})
