import { privateKeyFromHex, tweakAddPrivateKey } from '@frank/nakamoto'

import {
  lotusFromPrivateKey,
  lotusFromPublicKey,
} from '../legacy-wallet/lotus-address'
import { addedSecret, must, pointOf, secretKey } from '../nakamoto-oracle'
import { PayloadConstructor } from './crypto'

const DEST_SECRET = '11'.repeat(32)
const N_HEX = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const ZERO_SUM_DIGEST =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeda99dcbd59e378f2aaec14d7bbf253030'
const ONE = `${'00'.repeat(31)}01`

function lotusOfSecret(secret: Uint8Array, networkName: string): string {
  return lotusFromPublicKey(
    { toBuffer: () => pointOf(secret, true) },
    networkName,
  )
}

it('encodes the tweaked stamp key as a Lotus address', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = secretKey(DEST_SECRET, false)
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const address = ctor.constructStampAddress(digest, destination)
  const sum = addedSecret(Buffer.from(DEST_SECRET, 'hex'), digest)
  expect(address).toBe(lotusOfSecret(sum, 'testnet'))
  expect(address).not.toBe(lotusOfSecret(sum, 'livenet'))
  const fromPrivate = ctor.constructStampPrivateKey(digest, destination)
  expect(fromPrivate.toBuffer()).toEqual(sum)
  expect(fromPrivate.toPublicKey().toBuffer()).toEqual(pointOf(sum, true))
  expect(address).toBe(lotusFromPrivateKey(fromPrivate, 'testnet'))

  const almost = secretKey(N_MINUS_1, true)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampAddress(cross, almost)
  const crossedSum = addedSecret(Buffer.from(N_MINUS_1, 'hex'), cross)
  expect(crossed).toBe(lotusOfSecret(crossedSum, 'testnet'))
  expect(crossed).toBe(lotusOfSecret(Buffer.from(ONE, 'hex'), 'testnet'))

  const wide = secretKey(DEST_SECRET, false)
  expect(wide.toPublicKey().toBuffer().length).toBe(65)
  const wideAddress = ctor.constructStampAddress(digest, wide)
  expect(wideAddress).toBe(address)

  const callerSecret = Buffer.from(destination.toBuffer())
  const callerDigest = Buffer.from(digest)
  ctor.constructStampAddress(digest, destination)
  expect(destination.toBuffer()).toEqual(callerSecret)
  expect(digest).toEqual(callerDigest)
  expect(wide.toBuffer()).toEqual(callerSecret)
})

it('rejects a zero sum and digests outside (0, n)', () => {
  const ctor = new PayloadConstructor({ networkName: 'livenet' })
  const destination = secretKey(DEST_SECRET, false)
  const zeroSum = Buffer.from(ZERO_SUM_DIGEST, 'hex')
  expect(() => ctor.constructStampAddress(zeroSum, destination)).toThrow(
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
  expect(() =>
    ctor.constructStampAddress(Buffer.alloc(32), destination),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    ctor.constructStampAddress(Buffer.from(N_HEX, 'hex'), destination),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    ctor.constructStampAddress(Buffer.from(N_PLUS_ONE, 'hex'), destination),
  ).toThrow('stamp-parent:scalar-out-of-range')
  expect(() =>
    ctor.constructStampAddress(
      Buffer.from('33'.repeat(31), 'hex'),
      destination,
    ),
  ).toThrow('stamp-parent:digest')
  expect(() =>
    ctor.constructStampAddress(
      Buffer.from('33'.repeat(33), 'hex'),
      destination,
    ),
  ).toThrow('stamp-parent:digest')
})
