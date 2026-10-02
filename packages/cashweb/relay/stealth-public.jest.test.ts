import { PrivateKey, PublicKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stealthParentScalar } from './stealth-parent'
import { stealthParentPublicKey } from './stealth-public'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const ONE = `${'00'.repeat(31)}01`

function bitcoreReducedPublic(digest: Buffer, destination: PublicKey): Buffer {
  const reduced = bitcoreCrypto.BN.fromBuffer(digest).mod(
    bitcoreCrypto.Point.getN(),
  )
  if (reduced.cmp(new bitcoreCrypto.BN(0)) === 0) {
    return PublicKey.fromPoint(destination.point).toBuffer()
  }
  return PublicKey.fromPoint(
    new PrivateKey(reduced).toPublicKey().point.add(destination.point),
  ).toBuffer()
}

function publicOfPrivateScalar(secret: Buffer, digest: Buffer): Buffer {
  const scalar = stealthParentScalar(Uint8Array.from(secret), digest)
  try {
    return new PrivateKey(Buffer.from(scalar).toString('hex'))
      .toPublicKey()
      .toBuffer()
  } finally {
    scalar.fill(0)
  }
}

it('matches bitcore and the stealth parent scalar for the reduced digest', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const uncompressed = destination.toPublicKey()
  const compressed = new PublicKey(
    Buffer.from(bitcoreCrypto.Point.pointToCompressed(uncompressed.point)),
  )
  expect(uncompressed.toBuffer().length).toBe(65)
  expect(compressed.toBuffer().length).toBe(33)
  const digests = [
    Buffer.alloc(32),
    Buffer.from(ONE, 'hex'),
    Buffer.from(N_MINUS_1, 'hex'),
    Buffer.from(N_HEX, 'hex'),
    Buffer.from(N_PLUS_ONE, 'hex'),
    Buffer.alloc(32, 0xff),
    Buffer.from('33'.repeat(32), 'hex'),
  ]
  for (const digest of digests) {
    const fromUncompressed = stealthParentPublicKey(
      Uint8Array.from(uncompressed.toBuffer()),
      digest,
    )
    const fromCompressed = stealthParentPublicKey(
      Uint8Array.from(compressed.toBuffer()),
      digest,
    )
    const expected = bitcoreReducedPublic(digest, uncompressed)
    expect(Buffer.from(fromUncompressed)).toEqual(expected)
    expect(Buffer.from(fromCompressed)).toEqual(expected)
    expect(Buffer.from(fromCompressed)).toEqual(
      publicOfPrivateScalar(Buffer.from(destination.toBuffer()), digest),
    )
    expect(fromCompressed.length).toBe(33)
  }

  const almost = new PrivateKey(N_MINUS_1)
  const two = Buffer.alloc(32)
  two[31] = 2
  const crossed = stealthParentPublicKey(
    Uint8Array.from(almost.toPublicKey().toBuffer()),
    two,
  )
  expect(Buffer.from(crossed)).toEqual(
    bitcoreReducedPublic(two, almost.toPublicKey()),
  )
  expect(Buffer.from(crossed)).toEqual(
    new PrivateKey(ONE).toPublicKey().toBuffer(),
  )
  expect(Buffer.from(crossed)).toEqual(
    publicOfPrivateScalar(Buffer.from(almost.toBuffer()), two),
  )

  const zeroDigest = Buffer.alloc(32)
  expect(
    Buffer.from(
      stealthParentPublicKey(
        Uint8Array.from(uncompressed.toBuffer()),
        zeroDigest,
      ),
    ),
  ).toEqual(PublicKey.fromPoint(uncompressed.point).toBuffer())
  expect(
    Buffer.from(
      stealthParentPublicKey(
        Uint8Array.from(compressed.toBuffer()),
        Buffer.from(N_HEX, 'hex'),
      ),
    ),
  ).toEqual(compressed.toBuffer())

  const ephemeral = PrivateKey.fromBuffer(
    Buffer.from(EPHEMERAL_SECRET, 'hex'),
    NETWORK,
  )
  const derived = ctor.constructStealthPublicKey(ephemeral, uncompressed)
  const raw = bitcoreCrypto.Point.pointToCompressed(
    uncompressed.point.mul(ephemeral.bn),
  )
  const expectedDigest = bitcoreCrypto.Hash.sha256(raw)
  const expectedPublic = bitcoreReducedPublic(expectedDigest, uncompressed)
  expect(Buffer.from(derived.digest)).toEqual(expectedDigest)
  expect(derived.stealthPublicKey.toBuffer()).toEqual(expectedPublic)
  expect(derived.stealthPublicKey.toBuffer()).toEqual(
    new PublicKey(Buffer.from(expectedPublic)).toBuffer(),
  )
  expect(derived.stealthPublicKey.toBuffer()).toEqual(
    ctor
      .constructStealthPrivateKey(ephemeral.toPublicKey(), destination)
      .stealthPrivateKey.toPublicKey()
      .toBuffer(),
  )
  expect(derived.stealthPublicKey.toBuffer().length).toBe(33)
  expect(
    ctor
      .constructStealthPublicKey(ephemeral, compressed)
      .stealthPublicKey.toBuffer(),
  ).toEqual(derived.stealthPublicKey.toBuffer())

  const hd = ctor.constructHDStealthPublicKey(ephemeral, uncompressed)
  expect(Buffer.from(hd.publicKey)).toEqual(derived.stealthPublicKey.toBuffer())
  expect(Buffer.from(hd.chainCode)).toEqual(Buffer.from(derived.digest))

  const leadingZeroSecret = `${'00'.repeat(31)}6d`
  const leadingZeroKey = new PrivateKey(leadingZeroSecret)
  const leadingPublic = ctor.constructStealthPublicKey(
    leadingZeroKey,
    uncompressed,
  )
  const leadingRaw = bitcoreCrypto.Point.pointToCompressed(
    uncompressed.point.mul(leadingZeroKey.bn),
  )
  expect(leadingRaw.length).toBe(33)
  expect(leadingRaw[1]).toBe(0)
  expect(Buffer.from(leadingPublic.digest)).toEqual(
    bitcoreCrypto.Hash.sha256(leadingRaw),
  )
  expect(leadingPublic.stealthPublicKey.toBuffer()).toEqual(
    ctor
      .constructStealthPrivateKey(leadingZeroKey.toPublicKey(), destination)
      .stealthPrivateKey.toPublicKey()
      .toBuffer(),
  )

  const callerPoint = Uint8Array.from(uncompressed.toBuffer())
  const callerDigest = Uint8Array.from(Buffer.from('33'.repeat(32), 'hex'))
  stealthParentPublicKey(callerPoint, callerDigest)
  expect(Buffer.from(callerPoint)).toEqual(uncompressed.toBuffer())
  expect(Buffer.from(callerDigest).toString('hex')).toBe('33'.repeat(32))
})

it('rejects a bad point, a bad digest, and a point at infinity', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  const keptPoint = Uint8Array.from(point)
  const keptDigest = Uint8Array.from(Buffer.from(N_MINUS_1, 'hex'))
  expect(() => stealthParentPublicKey(point.slice(0, 32), keptDigest)).toThrow(
    'stealth-public:point',
  )
  expect(() => stealthParentPublicKey(new Uint8Array(), keptDigest)).toThrow(
    'stealth-public:point',
  )
  expect(() =>
    stealthParentPublicKey(point, Buffer.from('33'.repeat(31), 'hex')),
  ).toThrow('stealth-public:digest')
  expect(() =>
    stealthParentPublicKey(point, Buffer.from('33'.repeat(33), 'hex')),
  ).toThrow('stealth-public:digest')
  const badPrefix = Uint8Array.from(point)
  badPrefix[0] = 0x01
  expect(() =>
    stealthParentPublicKey(badPrefix, Buffer.from('33'.repeat(32), 'hex')),
  ).toThrow('stealth-public:point-invalid')
  const order = BigInt(`0x${N_HEX}`)
  const inverse = Buffer.from(
    (order - BigInt(`0x${DEST_SECRET}`)).toString(16).padStart(64, '0'),
    'hex',
  )
  expect(() => stealthParentPublicKey(point, inverse)).toThrow(
    'stealth-public:point-at-infinity',
  )
  expect(() =>
    PublicKey.fromPoint(
      PrivateKey.fromBuffer(inverse)
        .toPublicKey()
        .point.add(destination.toPublicKey().point),
    ),
  ).toThrow()
  expect(() =>
    stealthParentScalar(Uint8Array.from(destination.toBuffer()), inverse),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(Buffer.from(keptPoint)).toEqual(destination.toPublicKey().toBuffer())
  expect(Buffer.from(keptDigest).toString('hex')).toBe(N_MINUS_1)
  expect(Buffer.from(point)).toEqual(destination.toPublicKey().toBuffer())
})
