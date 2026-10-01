import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import { BTC_MAINNET, BTC_TESTNET, XEC_MAINNET } from '../src/chain/index.js'
import { privateKeyFromBytes } from '../src/constructors.js'
import { EncodingException } from '../src/encoding-error.js'
import { bigintToBytes } from '../src/integer.js'
import {
  privateKeyFromHex,
  privateKeyFromSecretBytes,
  privateKeyFromWif,
  privateKeyToWif,
  publicFromPrivate,
} from '../src/keys.js'
import { SECP256K1_N } from '../src/secp256k1.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  Networks: { livenet: object; testnet: object }
  PrivateKey: new (data: unknown, network?: object) => {
    toWIF(): string
    compressed: boolean
    toPublicKey(): { toBuffer(): Buffer }
  }
}

const GENERATOR =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function scalar(value: bigint): Uint8Array {
  const encoded = bigintToBytes(value, 32)
  if (!encoded.ok) throw new Error('scalar')
  return encoded.value
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

describe('keys and WIF', () => {
  test('the source wipes secret buffers and does not name a curve package', () => {
    const keys = readFileSync(join(__dirname, '../src/keys.ts'), 'utf8')
    const curve = readFileSync(join(__dirname, '../src/secp256k1.ts'), 'utf8')
    expect(keys).toContain('.fill(0)')
    expect(keys).not.toContain('unique symbol')
    expect(curve).not.toContain('@noble/curves')
    expect(curve).not.toContain('tiny-secp256k1')
  })

  test('generator and range checks', () => {
    const one = must(privateKeyFromSecretBytes(scalar(1n), true))
    const point = must(publicFromPrivate(one))
    expect(hex(point.compressed)).toBe(GENERATOR)
    expect(point.uncompressed[0]).toBe(0x04)
    expect(point.uncompressed.length).toBe(65)
    expect(hex(point.xOnly)).toBe(GENERATOR.slice(2))
    expect(privateKeyFromSecretBytes(scalar(0n), true)).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
    expect(privateKeyFromSecretBytes(scalar(SECP256K1_N), true).ok).toBe(false)
    const below = must(
      privateKeyFromSecretBytes(scalar(SECP256K1_N - 1n), true),
    )
    const negated = must(publicFromPrivate(below))
    expect(negated.compressed[0]).toBe(0x03)
    expect(hex(negated.xOnly)).toBe(GENERATOR.slice(2))
    expect(privateKeyFromBytes(scalar(0n), true).ok).toBe(true)
  })

  test('a raw secret requires the compression flag and is not WIF', () => {
    const bytes = scalar(1n)
    expect(
      privateKeyFromSecretBytes(bytes, undefined as unknown as boolean),
    ).toEqual({ ok: false, error: { code: 'compression-required' } })
    expect(privateKeyFromHex(hex(bytes), true).ok).toBe(true)
    expect(privateKeyFromHex(hex(bytes).slice(0, 63), true)).toEqual({
      ok: false,
      error: { code: 'hex-invalid' },
    })
    expect(privateKeyFromWif(hex(bytes), BTC_MAINNET).ok).toBe(false)
    expect(() => privateKeyFromSecretBytes(Buffer.alloc(32), true)).toThrow(
      EncodingException,
    )
  })

  test('WIF matches the chain prefix and the old package when the network is explicit', () => {
    const bytes = scalar(1n)
    const compressed = must(privateKeyFromSecretBytes(bytes, true))
    const uncompressed = must(privateKeyFromSecretBytes(bytes, false))
    const main = must(privateKeyToWif(compressed, BTC_MAINNET))
    const open = must(privateKeyToWif(uncompressed, BTC_MAINNET))
    const testnet = must(privateKeyToWif(compressed, BTC_TESTNET))
    expect(main).toBe('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')
    expect(open).toBe('5HpHagT65TZzG1PH3CSu63k8DbpvD8s5ip4nEB3kEsreAnchuDf')
    expect(main).not.toBe(testnet)
    expect(must(privateKeyToWif(compressed, XEC_MAINNET))).toBe(main)

    const oldCompressed = new old.PrivateKey({
      bn: hex(bytes),
      network: old.Networks.livenet,
      compressed: true,
    })
    const oldOpen = new old.PrivateKey(Buffer.from(bytes), old.Networks.livenet)
    expect(oldOpen.compressed).toBe(false)
    expect(oldCompressed.toWIF()).toBe(main)
    expect(oldOpen.toWIF()).toBe(open)
    const oldTest = new old.PrivateKey({
      bn: hex(bytes),
      network: old.Networks.testnet,
      compressed: true,
    })
    expect(oldTest.toWIF()).toBe(testnet)

    const round = must(privateKeyFromWif(main, BTC_MAINNET))
    expect(round.compressed).toBe(true)
    expect(hex(round.bytes)).toBe(hex(bytes))
    expect(privateKeyFromWif(testnet, BTC_MAINNET)).toEqual({
      ok: false,
      error: { code: 'wif-version', expected: 128, actual: 239 },
    })
    const broken = `${main.slice(0, -1)}${main.endsWith('n') ? 'm' : 'n'}`
    expect(mustFail(privateKeyFromWif(broken, BTC_MAINNET))).toBe(
      'base58check-checksum',
    )
    expect(hex(must(publicFromPrivate(compressed)).compressed)).toBe(
      hex(oldCompressed.toPublicKey().toBuffer()),
    )
    expect(hex(must(publicFromPrivate(uncompressed)).uncompressed)).toBe(
      hex(oldOpen.toPublicKey().toBuffer()),
    )
  })
})

function mustFail(
  result: { ok: true } | { ok: false; error: { code: string } },
): string {
  if (result.ok) throw new Error('expected failure')
  return result.error.code
}
