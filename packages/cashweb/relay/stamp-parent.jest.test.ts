import { privateKeyFromHex, tweakAddPrivateKey } from '@frank/nakamoto'

import { addedSecret, must, secretKey } from '../nakamoto-oracle'
import { PayloadConstructor } from './crypto'
import { stampParentSecret } from './stamp-parent'

const DEST_SECRET = '11'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ZERO_SUM_DIGEST =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeda99dcbd59e378f2aaec14d7bbf253030'
const ONE = `${'00'.repeat(31)}01`

it('adds the stamp digest with tweakAddPrivateKey', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const key = ctor.constructStampPrivateKey(digest, destination)
  const oracle = addedSecret(Buffer.from(DEST_SECRET, 'hex'), digest)
  expect(key.toBuffer()).toEqual(oracle)
  expect(key.toPublicKey().toBuffer()).toEqual(
    secretKey(oracle.toString('hex'), true).toPublicKey().toBuffer(),
  )
  const pub = ctor.constructStampPublicKey(digest, destination.toPublicKey())
  expect(key.toPublicKey().toBuffer()).toEqual(pub.toBuffer())

  const almost = secretKey(N_MINUS_1, true)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampPrivateKey(cross, almost)
  expect(crossed.toBuffer()).toEqual(
    addedSecret(Buffer.from(N_MINUS_1, 'hex'), cross),
  )
  expect(Buffer.from(crossed.toBuffer()).toString('hex')).toBe(ONE)

  const hd = ctor.constructStampHDPrivateKey(digest, destination)
  expect(Buffer.from(hd.privateKey.bytes)).toEqual(key.toBuffer())
  expect(Buffer.from(hd.chainCode)).toEqual(digest)
  expect(
    Buffer.from(
      stampParentSecret(Uint8Array.from(destination.toBuffer()), digest),
    ),
  ).toEqual(Buffer.from(hd.privateKey.bytes))
  expect(Buffer.from(destination.toBuffer()).toString('hex')).toBe(DEST_SECRET)

  const crossedHd = ctor.constructStampHDPrivateKey(cross, almost)
  expect(Buffer.from(crossedHd.privateKey.bytes)).toEqual(crossed.toBuffer())
  expect(
    Buffer.from(stampParentSecret(Uint8Array.from(almost.toBuffer()), cross)),
  ).toEqual(Buffer.from(crossedHd.privateKey.bytes))
  expect(Buffer.from(almost.toBuffer()).toString('hex')).toBe(N_MINUS_1)
})

it('rejects a zero sum and digests outside (0, n)', () => {
  const destination = secretKey(DEST_SECRET, false)
  const secret = Uint8Array.from(destination.toBuffer())
  const zeroSum = Buffer.from(ZERO_SUM_DIGEST, 'hex')
  expect(() => stampParentSecret(secret, zeroSum)).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  const parsed = must(privateKeyFromHex(DEST_SECRET, true))
  try {
    const added = tweakAddPrivateKey(parsed, Uint8Array.from(zeroSum))
    expect(added.ok).toBe(false)
    if (added.ok) added.value.bytes.fill(0)
  } finally {
    parsed.bytes.fill(0)
  }
  expect(() => stampParentSecret(secret, Buffer.alloc(32))).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() => stampParentSecret(secret, Buffer.from(N_HEX, 'hex'))).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
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
