import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import { BTC_MAINNET, BTC_TESTNET } from '../src/chain/index.js'
import { EncodingException } from '../src/encoding-error.js'
import {
  deriveBip44Account,
  deriveHdPath,
  deriveHdPublic,
  deriveHdPublicPath,
  hdChildScalar,
  hdPrivateFromSeed,
  hdPublicFromPrivate,
  parseHdPrivate,
  serializeHdPrivate,
  serializeHdPublic,
} from '../src/hd.js'
import { SECP256K1_N } from '../src/secp256k1.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  Networks: { livenet: object; testnet: object }
  HDPrivateKey: {
    fromSeed(
      seed: Buffer,
      network: object,
    ): {
      xprivkey: string
      xpubkey: string
      deriveChild(path: string): {
        xprivkey: string
        xpubkey: string
      }
    }
  }
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function must<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

const VECTOR_1 = '000102030405060708090a0b0c0d0e0f'
const VECTOR_2 =
  'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542'

const VECTOR_1_PATHS: readonly (readonly [string, string, string])[] = [
  [
    'm',
    'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
  ],
  [
    "m/0'",
    'xprv9uHRZZhk6KAJC1avXpDAp4MDc3sQKNxDiPvvkX8Br5ngLNv1TxvUxt4cV1rGL5hj6KCesnDYUhd7oWgT11eZG7XnxHrnYeSvkzY7d2bhkJ7',
    'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw',
  ],
  [
    "m/0'/1",
    'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs',
    'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ',
  ],
  [
    "m/0'/1/2'",
    'xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM',
    'xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJrZwQY4VUNgqFJPMM3No2dFDFGTsxxpG5uJh7n7epu4trkrX7x7DogT5Uv6fcLW5',
  ],
  [
    "m/0'/1/2'/2",
    'xprvA2JDeKCSNNZky6uBCviVfJSKyQ1mDYahRjijr5idH2WwLsEd4Hsb2Tyh8RfQMuPh7f7RtyzTtdrbdqqsunu5Mm3wDvUAKRHSC34sJ7in334',
    'xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV',
  ],
  [
    "m/0'/1/2'/2/1000000000",
    'xprvA41z7zogVVwxVSgdKUHDy1SKmdb533PjDz7J6N6mV6uS3ze1ai8FHa8kmHScGpWmj4WggLyQjgPie1rFSruoUihUZREPSL39UNdE3BBDu76',
    'xpub6H1LXWLaKsWFhvm6RVpEL9P4KfRZSW7abD2ttkWP3SSQvnyA8FSVqNTEcYFgJS2UaFcxupHiYkro49S8yGasTvXEYBVPamhGW6cFJodrTHy',
  ],
]

describe('HD derivation', () => {
  test('coin type is required and invalid children are not skipped', () => {
    const source = readFileSync(join(__dirname, '../src/hd.ts'), 'utf8')
    expect(source).toContain('.fill(0)')
    expect(source).not.toContain('registeredSlip44')
    expect(source).toContain('Bitcoin seed')
    expect(deriveBip44Account.length).toBe(3)
    expect(hdChildScalar(1n, 0n)).toEqual({ ok: true, value: 1n })
    expect(hdChildScalar(1n, -1n)).toEqual({
      ok: false,
      error: { code: 'hd-invalid-child' },
    })
    expect(hdChildScalar(1n, SECP256K1_N).ok).toBe(false)
    expect(hdChildScalar(1n, SECP256K1_N - 1n).ok).toBe(false)
    expect(must(hdChildScalar(2n, 3n))).toBe(5n)
  })

  test('BIP32 vector 1 matches the published strings and the old package', () => {
    const seed = fromHex(VECTOR_1)
    const master = must(hdPrivateFromSeed(seed))
    expect(hex(master.privateKey.bytes)).toBe(
      'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35',
    )
    expect(hex(master.chainCode)).toBe(
      '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508',
    )
    const oldMaster = old.HDPrivateKey.fromSeed(
      Buffer.from(seed),
      old.Networks.livenet,
    )
    for (const [path, xprv, xpub] of VECTOR_1_PATHS) {
      const node = must(deriveHdPath(master, path))
      const pub = must(hdPublicFromPrivate(node))
      expect(must(serializeHdPrivate(node, BTC_MAINNET))).toBe(xprv)
      expect(must(serializeHdPublic(pub, BTC_MAINNET))).toBe(xpub)
      const other = path === 'm' ? oldMaster : oldMaster.deriveChild(path)
      expect(other.xprivkey).toBe(xprv)
      expect(other.xpubkey).toBe(xpub)
      const round = must(parseHdPrivate(xprv, BTC_MAINNET))
      expect(hex(round.privateKey.bytes)).toBe(hex(node.privateKey.bytes))
    }
    const testnet = must(serializeHdPrivate(master, BTC_TESTNET))
    expect(testnet).not.toBe(VECTOR_1_PATHS[0]?.[1])
    expect(
      old.HDPrivateKey.fromSeed(Buffer.from(seed), old.Networks.testnet)
        .xprivkey,
    ).toBe(testnet)
    expect(parseHdPrivate(testnet, BTC_MAINNET).ok).toBe(false)
  })

  test('BIP32 vector 2 and public derivation', () => {
    const seed = fromHex(VECTOR_2)
    const master = must(hdPrivateFromSeed(seed))
    const pub = must(hdPublicFromPrivate(master))
    const child = must(deriveHdPath(master, 'm/0'))
    const childPub = must(deriveHdPublic(pub, 0))
    expect(must(serializeHdPublic(childPub, BTC_MAINNET))).toBe(
      must(serializeHdPublic(must(hdPublicFromPrivate(child)), BTC_MAINNET)),
    )
    expect(must(serializeHdPrivate(master, BTC_MAINNET))).toBe(
      'xprv9s21ZrQH143K31xYSDQpPDxsXRTUcvj2iNHm5NUtrGiGG5e2DtALGdso3pGz6ssrdK4PFmM8NSpSBHNqPqm55Qn3LqFtT2emdEXVYsCzC2U',
    )
    expect(
      must(
        serializeHdPrivate(
          must(deriveHdPath(master, "m/0/2147483647'")),
          BTC_MAINNET,
        ),
      ),
    ).toBe(
      'xprv9wSp6B7kry3Vj9m1zSnLvN3xH8RdsPP1Mh7fAaR7aRLcQMKTR2vidYEeEg2mUCTAwCd6vnxVrcjfy2kRgVsFawNzmjuHc2YmYRmagcEPdU9',
    )
    expect(deriveHdPublic(pub, 0x80000000)).toEqual({
      ok: false,
      error: { code: 'hd-hardened-public' },
    })
    expect(deriveHdPublicPath(pub, "m/0'")).toEqual({
      ok: false,
      error: { code: 'hd-hardened-public' },
    })
  })

  test('coin types 899 and 145 differ, and a short seed is rejected', () => {
    const seed = fromHex(VECTOR_1)
    const master = must(hdPrivateFromSeed(seed))
    const registered = must(deriveBip44Account(master, 899, 0))
    const historical = must(deriveBip44Account(master, 145, 0))
    expect(hex(registered.privateKey.bytes)).not.toBe(
      hex(historical.privateKey.bytes),
    )
    const oldMaster = old.HDPrivateKey.fromSeed(
      Buffer.from(seed),
      old.Networks.livenet,
    )
    expect(must(serializeHdPrivate(registered, BTC_MAINNET))).toBe(
      oldMaster.deriveChild("m/44'/899'/0'").xprivkey,
    )
    expect(must(serializeHdPrivate(historical, BTC_MAINNET))).toBe(
      oldMaster.deriveChild("m/44'/145'/0'").xprivkey,
    )
    expect(
      deriveBip44Account(master, undefined as unknown as number, 0),
    ).toEqual({ ok: false, error: { code: 'coin-type-required' } })
    expect(hdPrivateFromSeed(new Uint8Array(15))).toEqual({
      ok: false,
      error: { code: 'hd-seed-length', actual: 15 },
    })
    expect(() => hdPrivateFromSeed(Buffer.alloc(32))).toThrow(EncodingException)
    expect(deriveHdPath(master, 'm/00')).toEqual({
      ok: false,
      error: { code: 'hd-path' },
    })
  })
})
