import { readFileSync } from 'fs'
import { join } from 'path'

import { PrivateKey, PublicKey, crypto as bitcoreCrypto } from 'bitcore-lib-xpi'

import { PayloadConstructor } from './crypto'
import { stealthSharedPoint } from './stealth-shared'

const NETWORK = 'livenet'
const DEST_SECRET = '11'.repeat(32)
const EPHEMERAL_SECRET = '22'.repeat(32)
const N_HEX =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const N_MINUS_1 =
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'
const ONE = `${'00'.repeat(31)}01`

function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function bitcoreShared(secret: PrivateKey, point: PublicKey): Buffer {
  return bitcoreCrypto.Point.pointToCompressed(point.point.mul(secret.bn))
}

it('matches bitcore point.mul for a secret times the destination point', () => {
  const destination = PrivateKey.fromBuffer(
    Buffer.from(DEST_SECRET, 'hex'),
    NETWORK,
  )
  const ephemeral = new PrivateKey(EPHEMERAL_SECRET)
  const uncompressed = destination.toPublicKey()
  expect(uncompressed.toBuffer().length).toBe(65)
  const compressed = new PublicKey(
    Buffer.from(bitcoreCrypto.Point.pointToCompressed(uncompressed.point)),
  )
  expect(compressed.toBuffer().length).toBe(33)

  const fromWide = stealthSharedPoint(
    Uint8Array.from(ephemeral.toBuffer()),
    Uint8Array.from(uncompressed.toBuffer()),
  )
  const fromCompressed = stealthSharedPoint(
    Uint8Array.from(ephemeral.toBuffer()),
    Uint8Array.from(compressed.toBuffer()),
  )
  const expected = bitcoreShared(ephemeral, uncompressed)
  expect(Buffer.from(fromWide)).toEqual(expected)
  expect(Buffer.from(fromCompressed)).toEqual(expected)
  expect(fromWide.length).toBe(33)

  const one = new PrivateKey(ONE)
  const almost = new PrivateKey(N_MINUS_1)
  expect(
    Buffer.from(
      stealthSharedPoint(
        Uint8Array.from(one.toBuffer()),
        Uint8Array.from(compressed.toBuffer()),
      ),
    ),
  ).toEqual(bitcoreShared(one, compressed))
  expect(
    Buffer.from(
      stealthSharedPoint(
        Uint8Array.from(almost.toBuffer()),
        Uint8Array.from(uncompressed.toBuffer()),
      ),
    ),
  ).toEqual(bitcoreShared(almost, uncompressed))

  const leadingZeroKey = new PrivateKey(`${'00'.repeat(31)}6d`)
  const leading = stealthSharedPoint(
    Uint8Array.from(leadingZeroKey.toBuffer()),
    Uint8Array.from(uncompressed.toBuffer()),
  )
  const leadingOracle = bitcoreShared(leadingZeroKey, uncompressed)
  expect(leadingOracle.length).toBe(33)
  expect(leadingOracle[1]).toBe(0)
  expect(Buffer.from(leading)).toEqual(leadingOracle)

  const ctor = new PayloadConstructor({ networkName: 'testnet' })
  const derived = ctor.constructStealthPublicKey(ephemeral, uncompressed)
  expect(Buffer.from(derived.digest)).toEqual(
    bitcoreCrypto.Hash.sha256(Buffer.from(fromWide)),
  )
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
  expect(ephemeral.toBuffer().toString('hex')).toBe(EPHEMERAL_SECRET)
  expect(destination.toBuffer().toString('hex')).toBe(DEST_SECRET)

  const source = readFileSync(join(__dirname, 'crypto.ts'), 'utf8')
  const body = methodBody(
    source,
    'constructStealthPublicKey(',
    'constructHDStealthPublicKey(',
  )
  expect(body).toContain('stealthSharedPoint(')
  expect(body).toContain('stealthPointDigest(dhKeyPointRaw)')
  expect(body).toContain('stealthParentPublicKey(')
  expect(body).not.toContain('point.mul')
  expect(body).not.toContain('pointToCompressed')
  expect(body).not.toContain('pointMultiply')
  const merged = methodBody(
    source,
    'constructMergedKey(',
    'constructSharedPointEncodings(',
  )
  expect(merged).toContain('point.mul')
  expect(source.match(/crypto\.Hash\.sha256hmac\(/g)).toHaveLength(2)
  const helper = readFileSync(join(__dirname, 'stealth-shared.ts'), 'utf8')
  expect(helper).toContain('ecdh(')
  expect(helper).not.toContain('pointMultiply')
  expect(helper).not.toContain('point.mul')
  expect(helper).not.toContain('899')
  expect(helper).not.toContain('10605')
})

it('rejects a secret outside (0, n) and a public key that is not 33 or 65 bytes', () => {
  const destination = new PrivateKey(DEST_SECRET)
  const point = Uint8Array.from(destination.toPublicKey().toBuffer())
  const secret = Uint8Array.from(
    PrivateKey.fromBuffer(Buffer.from(EPHEMERAL_SECRET, 'hex'), NETWORK).toBuffer(),
  )
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
