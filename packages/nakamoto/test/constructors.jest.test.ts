import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import {
  EncodingException,
  compressedPublicKeyFromBytes,
  displayTxidFromInternal,
  ecdsaSignatureFromBytes,
  internalHashFromBytes,
  internalHashFromDisplay,
  privateKeyFromBytes,
  pubkeyHashFromBytes,
  schnorrSignatureFromBytes,
  sighashByte,
  xAddressPayloadFromBytes,
  xOnlyPublicKeyFromBytes,
} from '../src/index.js'
import * as api from '../src/index.js'

const HASH = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

describe('branded constructors', () => {
  test('the source uses a string brand, not a unique symbol', () => {
    const source = readFileSync(
      join(__dirname, '../src/constructors.ts'),
      'utf8',
    )
    expect(source).not.toContain('unique symbol')
    expect(source.toLowerCase()).not.toContain('lotus')
    expect(source).not.toContain('Buffer')
  })

  test('does not export Message or a one-argument sign', () => {
    expect('Message' in api).toBe(false)
    expect('sign' in api).toBe(false)
    expect('Transaction' in api).toBe(false)
    expect(privateKeyFromBytes.length).toBe(2)
  })

  test('hashes are 32 plain bytes, and display order is the reversal', () => {
    const internal = internalHashFromBytes(HASH)
    expect(internal.ok).toBe(true)
    if (!internal.ok) return
    const display = displayTxidFromInternal(internal.value)
    expect(Array.from(display)).toEqual(Array.from(HASH).reverse())
    expect(Array.from(internalHashFromDisplay(display))).toEqual(
      Array.from(HASH),
    )
    expect(internal.value).not.toBe(HASH)
    const short = internalHashFromBytes(HASH.slice(0, 31))
    expect(short).toEqual({
      ok: false,
      error: { code: 'wrong-length', min: 32, max: 32, actual: 31 },
    })
  })

  test('a hex string or a Buffer is not bytes', () => {
    expect(() =>
      internalHashFromBytes('11'.repeat(32) as unknown as Uint8Array),
    ).toThrow(EncodingException)
    expect(() => internalHashFromBytes(Buffer.alloc(32))).toThrow(
      EncodingException,
    )
  })

  test('private-key compression is the caller flag, not a hidden false', () => {
    const bytes = new Uint8Array(32).fill(7)
    const compressed = privateKeyFromBytes(bytes, true)
    const uncompressed = privateKeyFromBytes(bytes, false)
    expect(compressed.ok && compressed.value.compressed).toBe(true)
    expect(uncompressed.ok && uncompressed.value.compressed).toBe(false)
    expect(privateKeyFromBytes(bytes.slice(0, 31), true).ok).toBe(false)
  })

  test('compressed and x-only keys have different lengths and prefixes', () => {
    const compressed = new Uint8Array(33)
    compressed[0] = 0x02
    expect(compressedPublicKeyFromBytes(compressed).ok).toBe(true)
    compressed[0] = 0x04
    expect(compressedPublicKeyFromBytes(compressed)).toMatchObject({
      ok: false,
      error: { code: 'bad-prefix', actual: 0x04 },
    })
    expect(xOnlyPublicKeyFromBytes(HASH).ok).toBe(true)
    expect(xOnlyPublicKeyFromBytes(compressed).ok).toBe(false)
    expect(pubkeyHashFromBytes(HASH.slice(0, 20)).ok).toBe(true)
  })

  test('Schnorr is 64 bytes and does not absorb a sighash byte', () => {
    expect(schnorrSignatureFromBytes(new Uint8Array(64)).ok).toBe(true)
    expect(schnorrSignatureFromBytes(new Uint8Array(65)).ok).toBe(false)
    const der = new Uint8Array(71)
    der[0] = 0x30
    expect(ecdsaSignatureFromBytes(der).ok).toBe(true)
    expect(ecdsaSignatureFromBytes(new Uint8Array(64)).ok).toBe(false)
    expect(sighashByte(0x41).ok).toBe(true)
    expect(sighashByte(256).ok).toBe(false)
    expect(sighashByte(1.5).ok).toBe(false)
  })

  test('an XAddress payload is bytes and not an address string', () => {
    const payload = xAddressPayloadFromBytes(Uint8Array.of(1, 2, 3))
    expect(payload.ok).toBe(true)
    if (!payload.ok) return
    expect(payload.value).toBeInstanceOf(Uint8Array)
    expect(typeof payload.value).not.toBe('string')
    expect(xAddressPayloadFromBytes(new Uint8Array()).ok).toBe(false)
  })
})
