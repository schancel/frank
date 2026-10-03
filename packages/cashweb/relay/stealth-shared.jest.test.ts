import { digestSha256, secretKey, sharedPoint } from '../nakamoto-oracle'
import { PayloadConstructor } from './crypto'
import { stealthSharedPoint } from './stealth-shared'

const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`
const LEADING = `${'00'.repeat(31)}6d`

it('matches ecdh for a secret times the destination point', () => {
  const destination = secretKey(DEST_SECRET, false)
  const ephemeral = secretKey(EPHEMERAL_SECRET, true)
  const uncompressed = destination.toPublicKey()
  expect(uncompressed.toBuffer().length).toBe(65)
  const compressed = secretKey(DEST_SECRET, true).toPublicKey()
  expect(compressed.toBuffer().length).toBe(33)

  const fromWide = stealthSharedPoint(
    Uint8Array.from(ephemeral.toBuffer()),
    Uint8Array.from(uncompressed.toBuffer()),
  )
  const fromCompressed = stealthSharedPoint(
    Uint8Array.from(ephemeral.toBuffer()),
    Uint8Array.from(compressed.toBuffer()),
  )
  const expected = sharedPoint(EPHEMERAL_SECRET, uncompressed.toBuffer())
  expect(Buffer.from(fromWide)).toEqual(expected)
  expect(Buffer.from(fromCompressed)).toEqual(expected)
  expect(fromWide.length).toBe(33)

  expect(
    Buffer.from(
      stealthSharedPoint(
        Uint8Array.from(secretKey(ONE, true).toBuffer()),
        Uint8Array.from(compressed.toBuffer()),
      ),
    ),
  ).toEqual(sharedPoint(ONE, compressed.toBuffer()))
  expect(
    Buffer.from(
      stealthSharedPoint(
        Uint8Array.from(secretKey(N_MINUS_1, true).toBuffer()),
        Uint8Array.from(uncompressed.toBuffer()),
      ),
    ),
  ).toEqual(sharedPoint(N_MINUS_1, uncompressed.toBuffer()))

  const leadingZeroKey = secretKey(LEADING, true)
  const leading = stealthSharedPoint(
    Uint8Array.from(leadingZeroKey.toBuffer()),
    Uint8Array.from(uncompressed.toBuffer()),
  )
  const leadingOracle = sharedPoint(LEADING, uncompressed.toBuffer())
  expect(leadingOracle.length).toBe(33)
  expect(leadingOracle[1]).toBe(0)
  expect(Buffer.from(leading)).toEqual(leadingOracle)

  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const derived = ctor.constructStealthPublicKey(ephemeral, uncompressed)
  expect(Buffer.from(derived.digest)).toEqual(digestSha256(fromWide))
  expect(derived.stealthPublicKey.toBuffer()).toEqual(
    ctor
      .constructStealthPrivateKey(ephemeral.toPublicKey(), destination)
      .stealthPrivateKey.toPublicKey()
      .toBuffer(),
  )

  const callerSecret = Uint8Array.from(ephemeral.toBuffer())
  const callerPoint = Uint8Array.from(uncompressed.toBuffer())
  const secretCopy = Buffer.from(callerSecret)
  const pointCopy = Buffer.from(callerPoint)
  stealthSharedPoint(callerSecret, callerPoint)
  expect(Buffer.from(callerSecret)).toEqual(secretCopy)
  expect(Buffer.from(callerPoint)).toEqual(pointCopy)
  expect(Buffer.from(ephemeral.toBuffer()).toString('hex')).toBe(
    EPHEMERAL_SECRET,
  )
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)
})

it('rejects a secret outside (0, n) and a public key that is not 33 or 65 bytes', () => {
  const destination = secretKey(DEST_SECRET, true)
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  const secret = Uint8Array.from(secretKey(EPHEMERAL_SECRET, false).toBuffer())
  expect(() => stealthSharedPoint(Buffer.alloc(32), point)).toThrow(
    'stealth-shared:scalar-out-of-range',
  )
  expect(() => stealthSharedPoint(Buffer.from(N_HEX, 'hex'), point)).toThrow(
    'stealth-shared:scalar-out-of-range',
  )
  expect(() => stealthSharedPoint(Buffer.alloc(31), point)).toThrow(
    'stealth-shared:wrong-length',
  )
  expect(() => stealthSharedPoint(secret, new Uint8Array(32))).toThrow(
    'stealth-shared:public-key',
  )
  expect(() => stealthSharedPoint(secret, new Uint8Array())).toThrow(
    'stealth-shared:public-key',
  )
  const invalid = new Uint8Array(33)
  invalid[0] = 0x02
  expect(() => stealthSharedPoint(secret, invalid)).toThrow(
    'stealth-shared:point-invalid',
  )
  expect(Buffer.from(secret).toString('hex')).toBe(EPHEMERAL_SECRET)
  expect(Buffer.from(point)).toEqual(destination.toPublicKey().toBuffer())
})
