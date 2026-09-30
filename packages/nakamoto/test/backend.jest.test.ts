import { createRequire } from 'module'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'

import { secp256k1 } from '@noble/curves/secp256k1.js'

import {
  CryptoBackendError,
  cryptoBackend,
  selectCryptoBackend,
} from '../src/backend.js'
import { bytesToBigint, bigintToBytes } from '../src/integer.js'
import {
  SECP256K1_N,
  addPoints,
  compressPoint,
  compressedPointFromBytes,
} from '../src/secp256k1.js'

const load = createRequire(__filename)

interface BitcorePoint {
  add(other: BitcorePoint): BitcorePoint
  neg(): BitcorePoint
  mul(scalar: unknown): BitcorePoint
  isInfinity(): boolean
  getX(): BitcoreBn
  getY(): BitcoreBn
}

interface BitcoreBn {
  toBuffer(options: { size: number }): Buffer
  toArrayLike(arrayType: typeof Buffer, endian: 'be', length: number): Buffer
}

interface BitcoreKey {
  bn: unknown
  toPublicKey(): { toBuffer(): Buffer; point: BitcorePoint }
}

interface Bitcore {
  PrivateKey: new (data: Buffer) => BitcoreKey
  PublicKey: {
    fromBuffer(data: Buffer): { point: BitcorePoint; toBuffer(): Buffer }
  }
  crypto: {
    Hash: {
      sha256(buf: Buffer): Buffer
      sha256sha256(buf: Buffer): Buffer
      ripemd160(buf: Buffer): Buffer
      sha256ripemd160(buf: Buffer): Buffer
      sha256hmac(data: Buffer, key: Buffer): Buffer
    }
    Point: {
      pointToCompressed(point: BitcorePoint): Buffer
    }
    ECDSA: new () => {
      hashbuf: Buffer
      privkey: BitcoreKey
      pubkey: ReturnType<BitcoreKey['toPublicKey']>
      sign(): unknown
      sig: { r: BitcoreBn; s: BitcoreBn }
    }
  }
}

const bitcore = load('bitcore-lib-xpi') as Bitcore
const Hash = bitcore.crypto.Hash

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, 'hex'))
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function randomInput(length: number): Uint8Array {
  return Uint8Array.from(randomBytes(length))
}

function randomScalar(): Uint8Array {
  for (;;) {
    const bytes = randomInput(32)
    const value = bytesToBigint(bytes)
    if (value > 0n && value < SECP256K1_N) return bytes
  }
}

function mustBytes(value: bigint): Uint8Array {
  const encoded = bigintToBytes(value, 32)
  if (!encoded.ok) throw new Error('scalar')
  return encoded.value
}

// PublicKey.toBuffer calls bn.toBuffer({size:32}). Elliptic's BN.toBuffer
// is (endian, length) and ignores that object, so a coordinate below 2^248
// loses its leading zero. Pad both coordinates. The short buffer is not a key.
function fixed32(value: BitcoreBn): Buffer {
  return value.toArrayLike(Buffer, 'be', 32)
}

function uncompressedPoint(key: BitcoreKey): Uint8Array {
  const point = key.toPublicKey().point
  const encoded = new Uint8Array(65)
  encoded[0] = 0x04
  encoded.set(fixed32(point.getX()), 1)
  encoded.set(fixed32(point.getY()), 33)
  return encoded
}

function compressedPoint(point: BitcorePoint): Buffer {
  const x = fixed32(point.getX())
  const y = fixed32(point.getY())
  const encoded = Buffer.alloc(33)
  encoded[0] = (y[y.length - 1] ?? 0) % 2 === 1 ? 0x03 : 0x02
  encoded.set(x, 1)
  return encoded
}

function codeOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    if (error instanceof CryptoBackendError) return error.code
    throw error
  }
  return 'ok'
}

describe('crypto backend', () => {
  test('the installed backend is the noble fallback', () => {
    expect(selectCryptoBackend()).toBe(cryptoBackend)
    expect(cryptoBackend.name).toBe('noble')
    const source = readFileSync(
      join(__dirname, '../src/backend/noble.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/from ['"]hash-wasm/)
    expect(source).not.toMatch(/from ['"]tiny-secp256k1/)
    expect(source).not.toContain('crypto.subtle')
    expect(source).not.toContain('createHash')
    expect(source).not.toContain('elliptic')
    expect(source).not.toContain('bn.js')
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies).toEqual({
      '@noble/curves': '1.9.1',
      '@noble/hashes': '1.8.0',
    })
  })

  test('known hash vectors match the bitcore oracle', () => {
    const empty = new Uint8Array(0)
    const abc = Uint8Array.from(Buffer.from('abc'))
    expect(hex(cryptoBackend.sha256(empty))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(hex(cryptoBackend.sha256(abc))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(hex(cryptoBackend.ripemd160(empty))).toBe(
      '9c1185a5c5e9fc54612808977ee8f548b2258d31',
    )
    expect(hex(cryptoBackend.ripemd160(abc))).toBe(
      '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc',
    )
    expect(hex(cryptoBackend.sha256d(empty))).toBe(
      '5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456',
    )
    expect(hex(cryptoBackend.hash160(empty))).toBe(
      'b472a266d0bd89c13706a4132ccfb16f7c3b9fcb',
    )
    for (const input of [empty, abc, randomInput(64)]) {
      const bytes = Buffer.from(input)
      expect(Buffer.from(cryptoBackend.sha256(input))).toEqual(
        Hash.sha256(bytes),
      )
      expect(Buffer.from(cryptoBackend.sha256d(input))).toEqual(
        Hash.sha256sha256(bytes),
      )
      expect(Buffer.from(cryptoBackend.ripemd160(input))).toEqual(
        Hash.ripemd160(bytes),
      )
      expect(Buffer.from(cryptoBackend.hash160(input))).toEqual(
        Hash.sha256ripemd160(bytes),
      )
    }
  })

  test('noble hashes agree with bitcore on 20000 random inputs', () => {
    let mismatches = 0
    for (let index = 0; index < 20000; index += 1) {
      const input = randomInput(index % 257)
      const bytes = Buffer.from(input)
      if (!same(cryptoBackend.sha256(input), Hash.sha256(bytes)))
        mismatches += 1
      if (!same(cryptoBackend.sha256d(input), Hash.sha256sha256(bytes))) {
        mismatches += 1
      }
      if (!same(cryptoBackend.ripemd160(input), Hash.ripemd160(bytes))) {
        mismatches += 1
      }
      if (!same(cryptoBackend.hash160(input), Hash.sha256ripemd160(bytes))) {
        mismatches += 1
      }
    }
    expect(mismatches).toBe(0)
  })

  test('HMAC-SHA256 matches RFC 2202 and bitcore for block-sized keys', () => {
    const shortKey = new Uint8Array(20).fill(0x0b)
    const hiThere = Uint8Array.from(Buffer.from('Hi There'))
    const case1 = cryptoBackend.hmacSha256(shortKey, hiThere)
    expect(hex(case1)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
    const handRolled = Hash.sha256hmac(
      Buffer.from(hiThere),
      Buffer.from(shortKey),
    )
    expect(handRolled.toString('hex')).toBe(hex(case1))
    const jefe = Uint8Array.from(Buffer.from('Jefe'))
    const nothing = Uint8Array.from(Buffer.from('what do ya want for nothing?'))
    expect(hex(cryptoBackend.hmacSha256(jefe, nothing))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
    let mismatches = 0
    for (let index = 0; index < 2000; index += 1) {
      const key = randomInput(64)
      const message = randomInput(index % 96)
      const ours = cryptoBackend.hmacSha256(key, message)
      const theirs = Hash.sha256hmac(Buffer.from(message), Buffer.from(key))
      if (!same(ours, theirs)) mismatches += 1
    }
    expect(mismatches).toBe(0)
  })

  test('BIP340 vectors sign and verify', () => {
    const csv = readFileSync(join(__dirname, 'fixtures/bip340.csv'), 'utf8')
    const rows = csv.trim().split('\n').slice(1)
    expect(rows.length).toBeGreaterThan(10)
    for (const row of rows) {
      const cells = row.split(',')
      const secret = cells[1] ?? ''
      const pub = cells[2] ?? ''
      const aux = cells[3] ?? ''
      const message = cells[4] ?? ''
      const signature = cells[5] ?? ''
      const ok = (cells[6] ?? '').trim() === 'TRUE'
      if (secret !== '' && aux !== '') {
        const signed = cryptoBackend.signSchnorr(
          fromHex(secret),
          fromHex(message),
          fromHex(aux),
        )
        expect(hex(signed)).toBe(signature.toLowerCase())
      }
      expect(
        cryptoBackend.verifySchnorr(
          fromHex(signature),
          fromHex(message),
          fromHex(pub),
        ),
      ).toBe(ok)
    }
  })

  test('ECDSA matches bitcore on random keys and edge scalars', () => {
    const digest = randomInput(32)
    expect(
      codeOf(() => cryptoBackend.signEcdsa(new Uint8Array(32), digest)),
    ).toBe('scalar-out-of-range')
    expect(
      codeOf(() => cryptoBackend.signEcdsa(mustBytes(SECP256K1_N), digest)),
    ).toBe('scalar-out-of-range')
    expect(codeOf(() => cryptoBackend.signEcdsa(randomInput(31), digest))).toBe(
      'bad-length',
    )
    expect(codeOf(() => cryptoBackend.signEcdsa(randomInput(33), digest))).toBe(
      'bad-length',
    )
    expect(codeOf(() => cryptoBackend.signEcdsa(randomInput(64), digest))).toBe(
      'bad-length',
    )
    const almostN = cryptoBackend.signEcdsa(mustBytes(SECP256K1_N - 1n), digest)
    const almostKey = new bitcore.PrivateKey(
      Buffer.from(mustBytes(SECP256K1_N - 1n)),
    )
    expect(
      cryptoBackend.verifyEcdsa(almostN, digest, uncompressedPoint(almostKey)),
    ).toBe(true)

    for (let index = 0; index < 40; index += 1) {
      const secret = randomScalar()
      const hash = randomInput(32)
      const der = cryptoBackend.signEcdsa(secret, hash)
      const key = new bitcore.PrivateKey(Buffer.from(secret))
      const ecdsa = new bitcore.crypto.ECDSA()
      ecdsa.hashbuf = Buffer.from(hash)
      ecdsa.privkey = key
      ecdsa.pubkey = key.toPublicKey()
      ecdsa.sign()
      const parsed = secp256k1.Signature.fromDER(der)
      const compact = parsed.toCompactRawBytes()
      expect(Buffer.from(compact.subarray(0, 32))).toEqual(fixed32(ecdsa.sig.r))
      expect(Buffer.from(compact.subarray(32))).toEqual(fixed32(ecdsa.sig.s))
      const pub = uncompressedPoint(key)
      expect(cryptoBackend.verifyEcdsa(der, hash, pub)).toBe(true)
      expect(cryptoBackend.verifyEcdsa(der, randomInput(32), pub)).toBe(false)
      const high = new secp256k1.Signature(parsed.r, SECP256K1_N - parsed.s)
      expect(high.hasHighS()).toBe(true)
      expect(
        codeOf(() =>
          cryptoBackend.verifyEcdsa(high.toDERRawBytes(), hash, pub),
        ),
      ).toBe('high-s')
    }
  })

  test('ECDSA verifies a bitcore key that drops a leading zero', () => {
    const secret = mustBytes(0x7an)
    const digest = new Uint8Array(32).fill(0x11)
    const der = cryptoBackend.signEcdsa(secret, digest)
    const key = new bitcore.PrivateKey(Buffer.from(secret))
    const raw = Uint8Array.from(key.toPublicKey().toBuffer())
    expect(raw.length).toBe(64)
    expect(codeOf(() => cryptoBackend.verifyEcdsa(der, digest, raw))).toBe(
      'bad-length',
    )
    expect(cryptoBackend.verifyEcdsa(der, digest, uncompressedPoint(key))).toBe(
      true,
    )
  })

  test('ECDSA r matches bitcore when r drops a leading zero', () => {
    const secret = mustBytes(1n)
    const digest = mustBytes(47n)
    const der = cryptoBackend.signEcdsa(secret, digest)
    const key = new bitcore.PrivateKey(Buffer.from(secret))
    const ecdsa = new bitcore.crypto.ECDSA()
    ecdsa.hashbuf = Buffer.from(digest)
    ecdsa.privkey = key
    ecdsa.pubkey = key.toPublicKey()
    ecdsa.sign()
    const compact = secp256k1.Signature.fromDER(der).toCompactRawBytes()
    expect(ecdsa.sig.r.toBuffer({ size: 32 }).length).toBe(31)
    expect(Buffer.from(compact.subarray(0, 32))).toEqual(fixed32(ecdsa.sig.r))
    expect(Buffer.from(compact.subarray(32))).toEqual(fixed32(ecdsa.sig.s))
    expect(cryptoBackend.verifyEcdsa(der, digest, uncompressedPoint(key))).toBe(
      true,
    )
  })

  test('point addition agrees with the jacobian fallback', () => {
    for (let index = 0; index < 1000; index += 1) {
      const left = secp256k1.getPublicKey(randomScalar(), true)
      const right = secp256k1.getPublicKey(randomScalar(), true)
      const sum = cryptoBackend.pointAdd(left, right)
      const affineLeft = compressedPointFromBytes(left)
      const affineRight = compressedPointFromBytes(right)
      if (affineLeft === null || affineRight === null) throw new Error('point')
      const affine = addPoints(affineLeft, affineRight)
      if (affine === null) throw new Error('jacobian sum')
      const compressed = compressPoint(affine)
      if (compressed === null) throw new Error('compress')
      if (!same(sum, compressed)) throw new Error(`jacobian mismatch ${index}`)
    }
  })

  test('point addition and ECDH agree with bitcore', () => {
    const invalid = new Uint8Array(33)
    invalid[0] = 0x02
    invalid.fill(0xff, 1)
    expect(codeOf(() => cryptoBackend.pointAdd(invalid, invalid))).toBe(
      'point-invalid',
    )
    expect(
      codeOf(() => cryptoBackend.pointAdd(randomInput(31), randomInput(33))),
    ).toBe('bad-length')
    const secret = randomScalar()
    const pub = secp256k1.getPublicKey(secret, true)
    const negated = secp256k1.ProjectivePoint.fromHex(pub)
      .negate()
      .toRawBytes(true)
    expect(codeOf(() => cryptoBackend.pointAdd(pub, negated))).toBe(
      'point-at-infinity',
    )

    for (let index = 0; index < 20; index += 1) {
      const leftSecret = randomScalar()
      const rightSecret = randomScalar()
      const left = secp256k1.getPublicKey(leftSecret, true)
      const right = secp256k1.getPublicKey(rightSecret, true)
      const sum = cryptoBackend.pointAdd(left, right)
      const oracle = compressedPoint(
        bitcore.PublicKey.fromBuffer(Buffer.from(left)).point.add(
          bitcore.PublicKey.fromBuffer(Buffer.from(right)).point,
        ),
      )
      expect(Buffer.from(sum)).toEqual(oracle)
      const shared = cryptoBackend.ecdh(leftSecret, right)
      const theirShared = compressedPoint(
        bitcore.PublicKey.fromBuffer(Buffer.from(right)).point.mul(
          new bitcore.PrivateKey(Buffer.from(leftSecret)).bn,
        ),
      )
      expect(Buffer.from(shared)).toEqual(theirShared)
      const product = cryptoBackend.pointMultiply(right, leftSecret)
      expect(product).toEqual(shared)
    }
  })

  test('compressed points pad an x coordinate below 2^248', () => {
    const secret = mustBytes(153n)
    const point = new bitcore.PrivateKey(Buffer.from(secret)).toPublicKey()
      .point
    const raw = bitcore.crypto.Point.pointToCompressed(point)
    expect(raw.length).toBe(32)
    const padded = compressedPoint(point)
    expect(Buffer.from(secp256k1.getPublicKey(secret, true))).toEqual(padded)
  })
})
