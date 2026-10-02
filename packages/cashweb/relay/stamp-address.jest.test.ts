import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { lotusFromAddress } from '../legacy-wallet/lotus-address'
import { PayloadConstructor } from './crypto'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const N_PLUS_ONE =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364142'
const ZERO_SUM_DIGEST =
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeda99dcbd59e378f2aaec14d7bbf253030'

function bitcoreStampAddress(
  digest: Buffer,
  destination: PrivateKey,
  network: string,
) {
  const sum = bitcoreCrypto.BN.fromBuffer(digest)
    .add(destination.toBigNumber())
    .mod(bitcoreCrypto.Point.getN())
  return new PrivateKey(sum).toAddress(network)
}

it('matches bitcore stamp addresses for digests in (0, n)', () => {
  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const digest = Buffer.from('33'.repeat(32), 'hex')
  const address = ctor.constructStampAddress(digest, destination)
  const oracle = bitcoreStampAddress(digest, destination, 'testnet')
  const live = bitcoreStampAddress(digest, destination, NETWORK)
  expect(address).toBe(lotusFromAddress(oracle, 'testnet'))
  expect(address).not.toBe(lotusFromAddress(live, NETWORK))
  const fromPrivate = ctor
    .constructStampPrivateKey(digest, destination)
    .toAddress('testnet')
  expect(address).toBe(lotusFromAddress(fromPrivate, 'testnet'))

  const almost = new PrivateKey(N_MINUS_1)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampAddress(cross, almost)
  const crossedOracle = bitcoreStampAddress(cross, almost, 'testnet')
  expect(crossed).toBe(lotusFromAddress(crossedOracle, 'testnet'))
  expect(crossed).toBe(
    lotusFromAddress(
      new PrivateKey(`${'00'.repeat(31)}01`).toAddress('testnet'),
      'testnet',
    ),
  )

  const wide = new PrivateKey(Buffer.from(DEST_SECRET, 'hex'))
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
  const ctor = new PayloadConstructor({ networkName: NETWORK })
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const zeroSum = Buffer.from(ZERO_SUM_DIGEST, 'hex')
  expect(() => ctor.constructStampAddress(zeroSum, destination)).toThrow(
    'stamp-parent:scalar-out-of-range',
  )
  expect(() =>
    new PrivateKey(
      bitcoreCrypto.BN.fromBuffer(zeroSum)
        .add(destination.toBigNumber())
        .mod(bitcoreCrypto.Point.getN()),
    ),
  ).toThrow('Number can not be equal to zero')
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
