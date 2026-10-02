import { addedPoint, pointOf, secretKey } from '../nakamoto-oracle'
import { PayloadConstructor } from './crypto'
import { stampParentPublicKey } from './stamp-public'

const DEST_SECRET = '11'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

it('adds the stamp digest with tweakAddPublicKey', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const uncompressed = destination.toPublicKey()
  const compressed = secretKey(DEST_SECRET, true).toPublicKey()
  expect(uncompressed.toBuffer().length).toBe(65)
  expect(compressed.toBuffer().length).toBe(33)
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const key = ctor.constructStampPublicKey(digest, uncompressed)
  const expected = addedPoint(uncompressed.toBuffer(), digest)
  expect(key.toBuffer()).toEqual(expected)
  expect(key.toBuffer()).toEqual(addedPoint(compressed.toBuffer(), digest))
  expect(ctor.constructStampPublicKey(digest, compressed).toBuffer()).toEqual(
    expected,
  )
  expect(key.toBuffer().length).toBe(33)
  expect(key.toBuffer()[0] === 0x02 || key.toBuffer()[0] === 0x03).toBe(true)

  const almost = secretKey(N_MINUS_1, true)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampPublicKey(cross, almost.toPublicKey())
  expect(crossed.toBuffer()).toEqual(
    addedPoint(almost.toPublicKey().toBuffer(), cross),
  )
  expect(crossed.toBuffer()).toEqual(pointOf(Buffer.from(ONE, 'hex'), true))

  const hd = ctor.constructStampHDPublicKey(digest, uncompressed)
  expect(Buffer.from(hd.publicKey)).toEqual(key.toBuffer())
  expect(Buffer.from(hd.chainCode)).toEqual(digest)
})

it('rejects digests outside (0, n), a bad point, and infinity', () => {
  const destination = secretKey(DEST_SECRET, false)
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  const zero = Buffer.alloc(32)
  expect(() => stampParentPublicKey(point, zero)).toThrow(
    'stamp-public:scalar-out-of-range',
  )
  expect(() => stampParentPublicKey(point, Buffer.from(N_HEX, 'hex'))).toThrow(
    'stamp-public:scalar-out-of-range',
  )
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
  expect(() => addedPoint(point, inverse)).toThrow()
})
