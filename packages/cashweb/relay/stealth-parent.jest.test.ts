import {
  addedSecretMod,
  digestSha256,
  pointOf,
  reduced32,
  secretKey,
  sharedPoint,
} from '../nakamoto-oracle'
import { PayloadConstructor } from './crypto'
import {
  stealthDigestModN,
  stealthParentScalar,
  stealthParentSecret,
} from './stealth-parent'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const ONE = `${'00'.repeat(31)}01`
const LEADING = `${'00'.repeat(31)}6d`

function parentOf(ephemeralPoint: Uint8Array, destinationHex: string) {
  const point = sharedPoint(destinationHex, ephemeralPoint)
  const digest = digestSha256(point)
  const secret = addedSecretMod(Buffer.from(destinationHex, 'hex'), digest)
  return { secret, digest, point }
}

it('reduces a stealth digest mod n', () => {
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
    expect(Buffer.from(stealthDigestModN(digest))).toEqual(reduced32(digest))
  }
  expect(
    Buffer.from(stealthDigestModN(Buffer.from(N_HEX, 'hex'))).toString('hex'),
  ).toBe('00'.repeat(32))
  expect(
    Buffer.from(stealthDigestModN(Buffer.from(N_PLUS_ONE, 'hex'))).toString(
      'hex',
    ),
  ).toBe(ONE)
  expect(() => stealthDigestModN(Buffer.alloc(31))).toThrow(
    'stealth-parent:digest',
  )
  expect(() => stealthDigestModN(Buffer.alloc(33))).toThrow(
    'stealth-parent:digest',
  )
})

it('adds the reduced stealth digest to the destination', () => {
  const destination = secretKey(DEST_SECRET, false)
  const almost = secretKey(N_MINUS_1, true)
  const one = secretKey(ONE, true)
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
    ).toEqual(addedSecretMod(Buffer.from(DEST_SECRET, 'hex'), digest))
    expect(
      Buffer.from(
        stealthParentScalar(Uint8Array.from(almost.toBuffer()), digest),
      ),
    ).toEqual(addedSecretMod(Buffer.from(N_MINUS_1, 'hex'), digest))
  }
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(destination.toBuffer()),
        Buffer.from(ONE, 'hex'),
      ),
    ),
  ).toEqual(
    addedSecretMod(Buffer.from(DEST_SECRET, 'hex'), Buffer.from(ONE, 'hex')),
  )
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(destination.toBuffer()),
        Buffer.from(N_PLUS_ONE, 'hex'),
      ),
    ),
  ).toEqual(
    addedSecretMod(
      Buffer.from(DEST_SECRET, 'hex'),
      Buffer.from(N_PLUS_ONE, 'hex'),
    ),
  )
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(destination.toBuffer()),
        Buffer.alloc(32),
      ),
    ).toString('hex'),
  ).toBe(DEST_SECRET)
  expect(
    Buffer.from(
      stealthParentScalar(
        Uint8Array.from(one.toBuffer()),
        Buffer.from('33'.repeat(32), 'hex'),
      ),
    ).toString('hex'),
  ).toBe(
    addedSecretMod(
      Buffer.from(ONE, 'hex'),
      Buffer.from('33'.repeat(32), 'hex'),
    ).toString('hex'),
  )
  const caller = Uint8Array.from(destination.toBuffer())
  stealthParentScalar(caller, Buffer.from('33'.repeat(32), 'hex'))
  expect(Buffer.from(caller).toString('hex')).toBe(DEST_SECRET)

  expect(() =>
    stealthParentScalar(
      Uint8Array.from(one.toBuffer()),
      Buffer.from(N_MINUS_1, 'hex'),
    ),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() =>
    addedSecretMod(Buffer.from(ONE, 'hex'), Buffer.from(N_MINUS_1, 'hex')),
  ).toThrow('scalar-out-of-range')
  expect(() =>
    stealthParentScalar(Buffer.alloc(32), Buffer.from(ONE, 'hex')),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() =>
    stealthParentScalar(Buffer.from(N_HEX, 'hex'), Buffer.from(ONE, 'hex')),
  ).toThrow('stealth-parent:scalar-out-of-range')
  expect(() =>
    stealthParentScalar(Buffer.alloc(31), Buffer.from(ONE, 'hex')),
  ).toThrow('stealth-parent:wrong-length')
  expect(() =>
    stealthParentScalar(
      Uint8Array.from(destination.toBuffer()),
      Buffer.alloc(31),
    ),
  ).toThrow('stealth-parent:digest')
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
})

it('derives the stealth parent from ecdh', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const ephemeral = secretKey(EPHEMERAL_SECRET, false)
  const ephemeralPublic = ephemeral.toPublicKey()
  const expected = parentOf(ephemeralPublic.toBuffer(), DEST_SECRET)
  const derived = ctor.constructStealthPrivateKey(ephemeralPublic, destination)
  expect(derived.stealthPrivateKey.toBuffer()).toEqual(expected.secret)
  expect(Buffer.from(derived.digest)).toEqual(expected.digest)
  expect(derived.stealthPrivateKey.toPublicKey().toBuffer()).toEqual(
    pointOf(expected.secret, true),
  )

  const fromHelper = stealthParentSecret(
    Uint8Array.from(destination.toBuffer()),
    Uint8Array.from(ephemeralPublic.toBuffer()),
  )
  expect(Buffer.from(fromHelper.secret)).toEqual(expected.secret)
  expect(Buffer.from(fromHelper.digest)).toEqual(expected.digest)
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)

  const uncompressed = {
    toBuffer: () => pointOf(Buffer.from(EPHEMERAL_SECRET, 'hex'), false),
  }
  expect(uncompressed.toBuffer().length).toBe(65)
  const wide = parentOf(uncompressed.toBuffer(), DEST_SECRET)
  expect(wide.point).toEqual(expected.point)
  const wideDerived = ctor.constructStealthPrivateKey(uncompressed, destination)
  expect(wideDerived.stealthPrivateKey.toBuffer()).toEqual(expected.secret)
  expect(Buffer.from(wideDerived.digest)).toEqual(expected.digest)

  const almost = secretKey(N_MINUS_1, true)
  const almostExpected = parentOf(ephemeralPublic.toBuffer(), N_MINUS_1)
  const almostDerived = ctor.constructStealthPrivateKey(ephemeralPublic, almost)
  expect(almostDerived.stealthPrivateKey.toBuffer()).toEqual(
    almostExpected.secret,
  )
  expect(Buffer.from(almostDerived.digest)).toEqual(almostExpected.digest)

  const one = secretKey(ONE, true)
  const oneExpected = parentOf(ephemeralPublic.toBuffer(), ONE)
  expect(
    ctor
      .constructStealthPrivateKey(ephemeralPublic, one)
      .stealthPrivateKey.toBuffer(),
  ).toEqual(oneExpected.secret)

  const leadingZeroKey = secretKey(LEADING, true)
  const leadingMatch = parentOf(
    leadingZeroKey.toPublicKey().toBuffer(),
    DEST_SECRET,
  )
  expect(leadingMatch.point.length).toBe(33)
  expect(leadingMatch.point[1]).toBe(0)
  const leadingParent = ctor.constructStealthPrivateKey(
    leadingZeroKey.toPublicKey(),
    destination,
  )
  expect(leadingParent.stealthPrivateKey.toBuffer()).toEqual(
    leadingMatch.secret,
  )
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
    stealthParentSecret(
      Uint8Array.from(destination.toBuffer()),
      new Uint8Array(),
    ),
  ).toThrow('stealth-parent:public-key')
  expect(() =>
    stealthParentSecret(
      Uint8Array.from(destination.toBuffer()),
      new Uint8Array(32),
    ),
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
})
