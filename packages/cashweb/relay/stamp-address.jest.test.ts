import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

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

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

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
  expect(address.hashBuffer).toEqual(oracle.hashBuffer)
  expect(address.toString()).toBe(oracle.toString())
  expect(address.hashBuffer).toEqual(live.hashBuffer)
  expect(address.toString()).not.toBe(live.toString())
  expect(address.network.name).toBe('testnet')
  const fromPrivate = ctor
    .constructStampPrivateKey(digest, destination)
    .toAddress('testnet')
  expect(address.hashBuffer).toEqual(fromPrivate.hashBuffer)
  expect(address.toString()).toBe(fromPrivate.toString())

  const almost = new PrivateKey(N_MINUS_1)
  const cross = Buffer.alloc(32)
  cross[31] = 2
  const crossed = ctor.constructStampAddress(cross, almost)
  const crossedOracle = bitcoreStampAddress(cross, almost, 'testnet')
  expect(crossed.hashBuffer).toEqual(crossedOracle.hashBuffer)
  expect(crossed.toString()).toBe(crossedOracle.toString())
  expect(crossed.hashBuffer).toEqual(
    new PrivateKey(`${'00'.repeat(31)}01`).toAddress('testnet').hashBuffer,
  )

  const wide = new PrivateKey(Buffer.from(DEST_SECRET, 'hex'))
  expect(wide.toPublicKey().toBuffer().length).toBe(65)
  const wideAddress = ctor.constructStampAddress(digest, wide)
  expect(wideAddress.hashBuffer).toEqual(address.hashBuffer)
  expect(wideAddress.toString()).toBe(address.toString())

  const callerSecret = Buffer.from(destination.toBuffer())
  const callerDigest = Buffer.from(digest)
  ctor.constructStampAddress(digest, destination)
  expect(destination.toBuffer()).toEqual(callerSecret)
  expect(digest).toEqual(callerDigest)
  expect(wide.toBuffer()).toEqual(callerSecret)

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(source, 'constructStampAddress(', 'encrypt(')
  expect(body).toContain('stampParentSecret(')
  expect(body).toContain('.toAddress(')
  expect(body).toContain('secret.fill(0)')
  expect(body).not.toContain('crypto.BN')
  expect(body).not.toContain('Point.getN')
  expect(body).not.toContain('point.mul')
  const stealth = methodBody(
    source,
    'constructStealthPublicKey(',
    'constructHDStealthPublicKey(',
  )
  expect(stealth).toContain('stealthSharedPoint(')
  expect(stealth).not.toContain('point.mul')
  expect(stealth).not.toContain('constructStampAddress')
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
