import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  BCH_MAINNET,
  BTC_MAINNET,
  XEC_MAINNET,
  XPI_MAINNET,
} from '../src/chain/index.js'
import { privateKeyFromBytes } from '../src/constructors.js'
import {
  ecdh,
  ecdhWithHash,
  generateDleqProof,
  messageDigest,
  pointAdd,
  pointMultiply,
  signEcdsa,
  signMessage,
  signSchnorr,
  tweakAddPrivateKey,
  tweakAddPublicKey,
  verifyDleqProof,
  verifyEcdsa,
  verifyMessage,
  verifySchnorr,
} from '../src/curve.js'
import { bigintToBytes } from '../src/integer.js'
import { SECP256K1_N } from '../src/secp256k1.js'
import { publicFromPrivate, privateKeyFromSecretBytes } from '../src/keys.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  PrivateKey: new (data: string) => {
    toPublicKey(): { toBuffer(): Buffer }
  }
  crypto: {
    ECDSA: new () => {
      hashbuf: Buffer
      privkey: InstanceType<typeof old.PrivateKey>
      pubkey: { toBuffer(): Buffer }
      sign(): unknown
      sig: { toDER(): Buffer }
    }
  }
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function scalar(value: bigint): Uint8Array {
  const encoded = bigintToBytes(value, 32)
  if (!encoded.ok) throw new Error('scalar')
  return encoded.value
}

function key(value: bigint, compressed = true) {
  const branded = privateKeyFromSecretBytes(scalar(value), compressed)
  if (!branded.ok) throw new Error(branded.error.code)
  return branded.value
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function rows(name: string): string[][] {
  const text = readFileSync(join(__dirname, 'fixtures', name), 'utf8').trim()
  return text
    .split(/\n/)
    .slice(1)
    .map(line => line.split(','))
}

function negateCompressed(point: Uint8Array): Uint8Array {
  const out = new Uint8Array(point)
  out[0] = point[0] === 0x02 ? 0x03 : 0x02
  return out
}

const GENERATOR = fromHex(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
)

describe('typed curve', () => {
  test('the module does not install a second hash or an adaptor', () => {
    const source = readFileSync(join(__dirname, '../src/curve.ts'), 'utf8')
    expect(source).toContain('@noble/curves/secp256k1.js')
    expect(source).not.toContain('@noble/ciphers')
    expect(source).not.toContain('@scure/')
    expect(source).not.toContain('tiny-secp256k1')
    expect(source).not.toContain('hash-wasm')
    expect(source).not.toContain('function adaptor')
    expect(source).not.toContain('65535')
    expect(source).not.toContain('mailbox')
    expect(source).not.toContain('AES')
  })

  test('RFC 6979 signatures match bitcore and reject another key and high-S', () => {
    const secret = key(1n)
    const digest = sha256(Buffer.from('test data'))
    const signed = must(signEcdsa(secret, digest))
    const ecdsa = new old.crypto.ECDSA()
    const reference = new old.PrivateKey(hex(scalar(1n)))
    ecdsa.hashbuf = Buffer.from(digest)
    ecdsa.privkey = reference
    ecdsa.pubkey = reference.toPublicKey()
    ecdsa.sign()
    expect(hex(signed)).toBe(Buffer.from(ecdsa.sig.toDER()).toString('hex'))
    const point = must(publicFromPrivate(secret)).compressed
    expect(must(verifyEcdsa(signed, digest, point))).toBe(true)
    const other = must(publicFromPrivate(key(2n))).compressed
    expect(must(verifyEcdsa(signed, digest, other))).toBe(false)
    const parsed = secp256k1.Signature.fromDER(signed)
    const high = new secp256k1.Signature(
      parsed.r,
      SECP256K1_N - parsed.s,
    ).toDERRawBytes()
    expect(verifyEcdsa(high, digest, point)).toEqual({
      ok: false,
      error: { code: 'high-s' },
    })
    const trailing = new Uint8Array(signed.length + 1)
    trailing.set(signed)
    expect(verifyEcdsa(trailing, digest, point).ok).toBe(false)
    const mutated = new Uint8Array(signed)
    mutated[1] = (mutated[1] ?? 0) ^ 0xff
    expect(verifyEcdsa(mutated, digest, point).ok).toBe(false)
    expect(signEcdsa(secret, digest.slice(0, 31)).ok).toBe(false)
    const zero = must(privateKeyFromBytes(scalar(0n), true))
    expect(signEcdsa(zero, digest)).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
  })

  test('BIP340 published vectors', () => {
    for (const row of rows('bip340.csv')) {
      const secret = row[1] ?? ''
      const publicKey = fromHex(row[2] ?? '')
      const aux = row[3] ?? ''
      const message = fromHex(row[4] ?? '')
      const signature = fromHex(row[5] ?? '')
      const passed = row[6] === 'TRUE'
      if (secret !== '' && aux !== '') {
        const branded = must(privateKeyFromSecretBytes(fromHex(secret), true))
        const signed = must(signSchnorr(branded, message, fromHex(aux)))
        expect(hex(signed)).toBe(hex(signature))
      }
      expect(must(verifySchnorr(signature, message, publicKey))).toBe(passed)
    }
    const first = rows('bip340.csv')[1]
    const message = fromHex(first?.[4] ?? '')
    const signature = fromHex(first?.[5] ?? '')
    const other = fromHex(rows('bip340.csv')[0]?.[2] ?? '')
    expect(must(verifySchnorr(signature, message, other))).toBe(false)
    expect(verifySchnorr(signature.slice(0, 63), message, other)).toEqual({
      ok: false,
      error: { code: 'bad-length', actual: 63 },
    })
  })

  test('ECDH returns the raw point and hashes only when asked', () => {
    const left = key(2n)
    const right = key(3n)
    const rightPoint = must(publicFromPrivate(right)).compressed
    const leftPoint = must(publicFromPrivate(left)).compressed
    const forward = must(ecdh(left, rightPoint)).point
    const back = must(ecdh(right, leftPoint)).point
    expect(hex(forward)).toBe(hex(back))
    expect(forward.length).toBe(33)
    expect(hex(forward)).not.toBe(hex(sha256(forward)))
    const hashed = must(ecdhWithHash(left, rightPoint, point => sha256(point)))
    expect(hex(hashed)).toBe(hex(sha256(forward)))
    const marked = must(
      ecdhWithHash(left, rightPoint, () => Uint8Array.of(0x11, 0x22)),
    )
    expect(hex(marked)).toBe('1122')
    expect(
      ecdhWithHash(left, rightPoint, undefined as unknown as () => Uint8Array),
    ).toEqual({
      ok: false,
      error: { code: 'hash-required' },
    })
    expect(ecdh(left, Uint8Array.of(0x02, 0x01))).toEqual({
      ok: false,
      error: { code: 'bad-length', actual: 2 },
    })
    const off = new Uint8Array(65)
    off[0] = 0x04
    off[1] = 1
    off[33] = 1
    expect(ecdh(left, off)).toEqual({
      ok: false,
      error: { code: 'point-invalid' },
    })
  })

  test('tweaks and point operations reject 0, n, off-curve, and a bad length', () => {
    const secret = key(5n)
    const point = must(publicFromPrivate(secret)).compressed
    expect(tweakAddPrivateKey(secret, scalar(0n))).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
    expect(tweakAddPublicKey(point, scalar(SECP256K1_N))).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
    expect(pointMultiply(point, scalar(0n)).ok).toBe(false)
    expect(pointMultiply(GENERATOR, scalar(SECP256K1_N - 1n)).ok).toBe(true)
    const negated = must(pointMultiply(GENERATOR, scalar(SECP256K1_N - 1n)))
    expect(negated[0]).toBe(0x03)
    expect(pointAdd(point, negateCompressed(point))).toEqual({
      ok: false,
      error: { code: 'point-at-infinity' },
    })
    expect(pointAdd(point, point.slice(0, 30))).toEqual({
      ok: false,
      error: { code: 'bad-length', actual: 30 },
    })
    const off = new Uint8Array(33)
    off[0] = 0x02
    expect(tweakAddPublicKey(off, scalar(1n))).toEqual({
      ok: false,
      error: { code: 'point-invalid' },
    })
    const tweaked = must(tweakAddPrivateKey(secret, scalar(9n)))
    const fromPoint = must(tweakAddPublicKey(point, scalar(9n)))
    expect(hex(must(publicFromPrivate(tweaked)).compressed)).toBe(
      hex(fromPoint),
    )
    expect(tweakAddPrivateKey(secret, scalar(SECP256K1_N - 5n))).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
  })

  test('BIP-374 published vectors', () => {
    for (const row of rows('bip374-generate.csv')) {
      const generator = fromHex(row[1] ?? '')
      const secret = fromHex(row[2] ?? '')
      const pointB = row[3] ?? ''
      const aux = fromHex(row[4] ?? '')
      const message = row[5] ?? ''
      const expected = row[6] ?? ''
      if (pointB === 'INFINITY') {
        expect(pointAdd(generator, negateCompressed(generator)).ok).toBe(false)
        continue
      }
      if (expected === 'INVALID') {
        expect(
          generateDleqProof({
            secret,
            pointB: fromHex(pointB),
            aux,
            generator,
            message: message === '' ? undefined : fromHex(message),
          }).ok,
        ).toBe(false)
        continue
      }
      const proof = must(
        generateDleqProof({
          secret,
          pointB: fromHex(pointB),
          aux,
          generator,
          message: message === '' ? undefined : fromHex(message),
        }),
      )
      expect(hex(proof.proof)).toBe(expected)
    }
    for (const row of rows('bip374-verify.csv')) {
      const message = row[6] ?? ''
      const verified = verifyDleqProof({
        generator: fromHex(row[1] ?? ''),
        key: fromHex(row[2] ?? ''),
        pointB: fromHex(row[3] ?? ''),
        shared: fromHex(row[4] ?? ''),
        proof: fromHex(row[5] ?? ''),
        message: message === '' ? undefined : fromHex(message),
      })
      expect(must(verified)).toBe(row[7] === 'TRUE')
    }
  })

  test('message magic follows the chain descriptor', () => {
    expect(XEC_MAINNET.messageMagic).toMatchObject({
      status: 'pinned',
      text: 'eCash Signed Message:\n',
    })
    const empty = must(messageDigest(BTC_MAINNET, new Uint8Array(0)))
    expect(hex(empty)).toBe(
      '80e795d4a4caadd7047af389d9f7f220562feb6196032e2131e10563352c4bcc',
    )
    const latin = must(messageDigest(BTC_MAINNET, bytes('Vires is Numeris')))
    expect(hex(latin)).toBe(
      'f8a5affbef4a3241b19067aa694562f64f513310817297089a8929a930f4f933',
    )
    const accented = must(messageDigest(BTC_MAINNET, bytes('Virès is Numéris')))
    expect(hex(accented)).toBe(
      'af3d51b82a6694d76af5b49401d6f824d66cfce6f96213e606e7da95fe675f25',
    )
    const secret = key(1n, true)
    const message = bytes('vires is numeris')
    const signature = must(signMessage(BTC_MAINNET, secret, message))
    expect(hex(signature)).toBe(
      '205f271ea16bdcad942986a1857deca157a85bc5b510235baf4c1f724ee5cf25e3092e50d7a124e39cf206ecb5162cbdb133ca560b2aa8eb8fbdbc9cb95492565f',
    )
    const point = must(publicFromPrivate(secret)).compressed
    expect(must(verifyMessage(BTC_MAINNET, point, message, signature))).toBe(
      true,
    )
    const other = must(publicFromPrivate(key(2n))).compressed
    expect(must(verifyMessage(BTC_MAINNET, other, message, signature))).toBe(
      false,
    )
    const uncompressed = must(publicFromPrivate(key(1n, false))).uncompressed
    expect(
      must(verifyMessage(BTC_MAINNET, uncompressed, message, signature)),
    ).toBe(false)
    const flipped = new Uint8Array(signature)
    const s = bytesToBigintHigh(flipped.subarray(33))
    const highS = scalar(SECP256K1_N - s)
    flipped.set(highS, 33)
    expect(verifyMessage(BTC_MAINNET, point, message, flipped)).toEqual({
      ok: false,
      error: { code: 'high-s' },
    })
    expect(
      verifyMessage(BTC_MAINNET, point, message, signature.slice(0, 64)),
    ).toEqual({
      ok: false,
      error: { code: 'bad-length', actual: 64 },
    })
    expect(BCH_MAINNET.messageMagic).toMatchObject({
      status: 'pinned',
      text: 'Bitcoin Signed Message:\n',
    })
    expect(hex(must(messageDigest(BCH_MAINNET, message)))).toBe(
      '88630588cd15244c180c7dee585b64278907703fd086e8f4cebec2daf3de28d3',
    )
    expect(XPI_MAINNET.messageMagic).toMatchObject({
      status: 'pinned',
      text: 'Bitcoin Signed Message:\n',
    })
    expect(hex(must(messageDigest(XPI_MAINNET, message)))).toBe(
      '88630588cd15244c180c7dee585b64278907703fd086e8f4cebec2daf3de28d3',
    )
    expect(hex(must(signMessage(XPI_MAINNET, secret, message)))).toBe(
      hex(signature),
    )
    const xecDigest = must(messageDigest(XEC_MAINNET, message))
    expect(hex(xecDigest)).toBe(
      '1ec0236c442700dca21f8a41e991776be53c19e6f2cf38a4ff1aa1ba43d93fdd',
    )
    const xec = must(signMessage(XEC_MAINNET, secret, message))
    expect(hex(xec)).not.toBe(hex(signature))
    expect(must(verifyMessage(XEC_MAINNET, point, message, xec))).toBe(true)
    expect(must(verifyMessage(BTC_MAINNET, point, message, xec))).toBe(false)
  })
})

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

function bytesToBigintHigh(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}
