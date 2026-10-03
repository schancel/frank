import { hmac } from '@noble/hashes/hmac.js'

import { compressedPublicKeyFromBytes } from '../src/constructors.js'
import {
  deriveHdPrivate,
  deriveHdPublic,
  hdPrivateFromSeed,
  hdPublicFromPrivate,
  type HdPrivateNode,
} from '../src/hd.js'
import { privateKeyFromSecretBytes } from '../src/keys.js'

// Only this suite replaces HMAC. Production has no injectable HD backend.
jest.mock('@noble/hashes/hmac.js', () => {
  const actual = jest.requireActual<typeof import('@noble/hashes/hmac.js')>(
    '@noble/hashes/hmac.js',
  )
  return { ...actual, hmac: Object.assign(jest.fn(actual.hmac), actual.hmac) }
})

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PRIVATE_ONE = '00'.repeat(31) + '01'
const IR = '42'.repeat(32)

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16))
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

function parent(): HdPrivateNode {
  return {
    depth: 3,
    parentFingerprint: bytes('11223344'),
    childIndex: 9,
    chainCode: bytes('a1'.repeat(32)),
    privateKey: must(privateKeyFromSecretBytes(bytes(PRIVATE_ONE), true)),
  }
}

function inject(left: bigint) {
  const mac = bytes(left.toString(16).padStart(64, '0') + IR)
  const inputs: { key: string; data: string }[] = []
  jest.mocked(hmac).mockImplementationOnce((_hash, key, data) => {
    inputs.push({ key: hex(key as Uint8Array), data: hex(data as Uint8Array) })
    return mac
  })
  return { mac, inputs }
}

afterEach(() => jest.mocked(hmac).mockClear())

describe('BIP32 exact-index HMAC boundary', () => {
  test.each([0, 0x7fffffff, 0x80000000, 0xffffffff])(
    'zero IL retains the private key but creates child metadata at %i',
    index => {
      const source = parent()
      const before = JSON.stringify(source)
      const fixture = inject(0n)
      const child = must(deriveHdPrivate(source, index))
      const publicChild = must(hdPublicFromPrivate(child))
      expect(hex(child.privateKey.bytes)).toBe(PRIVATE_ONE)
      expect(hex(publicChild.publicKey)).toBe(G)
      expect(hex(child.chainCode)).toBe(IR)
      expect(child.depth).toBe(4)
      expect(child.childIndex).toBe(index)
      expect(hex(child.parentFingerprint)).toBe('751e76e8')
      expect(fixture.inputs).toEqual([
        {
          key: 'a1'.repeat(32),
          data:
            (index >= 0x80000000 ? '00' + PRIVATE_ONE : G) +
            index.toString(16).padStart(8, '0'),
        },
      ])
      expect(hmac).toHaveBeenCalledTimes(1)
      expect(fixture.mac).toEqual(new Uint8Array(64))
      expect(JSON.stringify(source)).toBe(before)
      child.privateKey.bytes.fill(0)
      child.chainCode.fill(0)
      expect(JSON.stringify(source)).toBe(before)
    },
  )

  test.each([0, 0x7fffffff])(
    'zero IL gives identical private/public children at %i',
    index => {
      const source = parent()
      const publicSource = must(hdPublicFromPrivate(source))
      const before = JSON.stringify(publicSource)
      const fixture = inject(0n)
      const publicChild = must(deriveHdPublic(publicSource, index))
      inject(0n)
      const privateChild = must(deriveHdPrivate(source, index))
      expect(publicChild).toEqual(must(hdPublicFromPrivate(privateChild)))
      expect(hex(publicChild.publicKey)).toBe(G)
      expect(hex(publicChild.chainCode)).toBe(IR)
      expect(publicChild.depth).toBe(4)
      expect(publicChild.childIndex).toBe(index)
      expect(hex(publicChild.parentFingerprint)).toBe('751e76e8')
      expect(fixture.inputs).toEqual([
        { key: 'a1'.repeat(32), data: G + index.toString(16).padStart(8, '0') },
      ])
      expect(hmac).toHaveBeenCalledTimes(2)
      expect(fixture.mac).toEqual(new Uint8Array(64))
      publicChild.publicKey.fill(0)
      publicChild.chainCode.fill(0)
      expect(JSON.stringify(publicSource)).toBe(before)
    },
  )

  test.each([N, N - 1n, (1n << 256n) - 1n])(
    'invalid IL or zero child never advances the requested index: %s',
    left => {
      for (const index of [0, 0x7fffffff, 0x80000000, 0xffffffff]) {
        const source = parent()
        const before = JSON.stringify(source)
        const fixture = inject(left)
        expect(deriveHdPrivate(source, index)).toEqual({
          ok: false,
          error: { code: 'hd-invalid-child' },
        })
        expect(fixture.inputs).toHaveLength(1)
        expect(fixture.inputs[0]?.data.slice(-8)).toBe(
          index.toString(16).padStart(8, '0'),
        )
        expect(fixture.mac).toEqual(new Uint8Array(64))
        expect(JSON.stringify(source)).toBe(before)
        if (index < 0x80000000) {
          const publicFixture = inject(left)
          expect(
            deriveHdPublic(must(hdPublicFromPrivate(source)), index),
          ).toEqual({
            ok: false,
            error: { code: 'hd-invalid-child' },
          })
          expect(publicFixture.inputs).toHaveLength(1)
          expect(publicFixture.mac).toEqual(new Uint8Array(64))
        }
      }
      expect(hmac).toHaveBeenCalledTimes(6)
    },
  )

  test.each([0n, N])('invalid master IL remains rejected: %s', left => {
    const seed = bytes('01'.repeat(32))
    const fixture = inject(left)
    expect(hdPrivateFromSeed(seed)).toEqual({
      ok: false,
      error: { code: 'scalar-out-of-range' },
    })
    expect(hmac).toHaveBeenCalledTimes(1)
    expect(fixture.mac).toEqual(new Uint8Array(64))
    expect(hex(seed)).toBe('01'.repeat(32))
  })

  test('zero IL does not bypass parent point validation', () => {
    const source = must(hdPublicFromPrivate(parent()))
    // Structurally compressed, but x is outside the field.
    const invalid = must(
      compressedPublicKeyFromBytes(bytes('02' + 'ff'.repeat(32))),
    )
    inject(0n)
    expect(deriveHdPublic({ ...source, publicKey: invalid }, 0)).toEqual({
      ok: false,
      error: { code: 'hd-invalid-child' },
    })
    expect(hmac).toHaveBeenCalledTimes(1)
  })
})
