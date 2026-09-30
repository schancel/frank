import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { join } from 'path'

import { Buffer } from 'buffer'

import {
  addressesFor,
  convertAddress,
  decodeAddress,
  encodeAddress,
  isAddressError,
  lockingScript,
  sameDestination,
  type AddressListing,
  type Destination,
} from '../src/address.js'
import { decodeBech32, encodeBech32 } from '../src/bech32.js'
import { decodeCashaddr } from '../src/cashaddr.js'
import {
  BCH_MAINNET,
  BCH_REGTEST,
  BCH_TESTNET,
  BTC_MAINNET,
  BTC_REGTEST,
  BTC_TESTNET,
  XEC_MAINNET,
  XEC_TESTNET,
  XPI_MAINNET,
} from '../src/chain/index.js'
import {
  compressedPublicKeyFromBytes,
  xOnlyPublicKeyFromBytes,
  type CompressedPublicKey,
  type XOnlyPublicKey,
} from '../src/constructors.js'
import { EncodingException } from '../src/encoding-error.js'

const load = createRequire(__filename)
const old = load('bitcore-lib-xpi') as {
  Address: {
    new (text: string): {
      toLegacyAddress(): string
      toCashAddress(): string
    }
    fromPublicKey(
      key: unknown,
      network: string,
    ): {
      toLegacyAddress(): string
      toCashAddress(): string
    }
  }
  PublicKey: {
    fromBuffer(buf: Buffer): unknown
  }
  crypto: {
    Hash: {
      sha256ripemd160(buf: Buffer): { toString(encoding: 'hex'): string }
    }
  }
  encoding: {
    Base58Check: {
      encode(buf: Buffer): string
    }
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function must<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error('expected ok')
  return result.value
}

const PUB_HEX =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const PUB = compressedPublicKeyFromBytes(fromHex(PUB_HEX))
const OUTPUT_KEY = xOnlyPublicKeyFromBytes(fromHex(PUB_HEX.slice(2)))
const TWEAK = new Uint8Array(32).fill(1)

function pubkey(): CompressedPublicKey {
  if (!PUB.ok) throw new Error('pubkey')
  return PUB.value
}

function outputKey(): XOnlyPublicKey {
  if (!OUTPUT_KEY.ok) throw new Error('output key')
  return OUTPUT_KEY.value
}

function form(listing: AddressListing, encoding: string): string {
  const found = listing.forms.find(item => item.encoding === encoding)
  if (!found) throw new Error(encoding)
  return found.text
}

function kind(
  listings: readonly AddressListing[],
  name: Destination['kind'],
): AddressListing {
  const found = listings.find(item => item.destination.kind === name)
  if (!found) throw new Error(name)
  return found
}

describe('address codecs', () => {
  test('source does not build an XPI string prefix', () => {
    for (const name of ['address.ts', 'bech32.ts', 'cashaddr.ts']) {
      const source = readFileSync(join(__dirname, '../src', name), 'utf8')
      expect(source.toLowerCase()).not.toContain('lotus')
    }
  })

  test('BIP173 bech32 strings and the segwit program for the example key', () => {
    // bitcoin/bips bip-0173.mediawiki, Test vectors and Examples.
    // Public key 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798.
    expect(must(decodeBech32('A12UEL5L')).hrp).toBe('a')
    expect(must(decodeBech32('a12uel5l')).data).toEqual([])
    const missingSeparator = decodeBech32('pzry9x0s0muk')
    const emptyHrp = decodeBech32('1pzry9x0s0muk')
    const badChar = decodeBech32('x1b4n0q5v')
    expect(missingSeparator.ok).toBe(false)
    expect(emptyHrp.ok).toBe(false)
    expect(badChar.ok).toBe(false)
    if (missingSeparator.ok || emptyHrp.ok || badChar.ok) return
    expect(missingSeparator.error).toMatchObject({ code: 'separator-missing' })
    expect(emptyHrp.error).toMatchObject({ code: 'empty-hrp' })
    expect(badChar.error).toMatchObject({ code: 'base32-invalid-char' })
    const decoded = must(
      decodeAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'),
    )
    expect(decoded.chain).toBe(BTC_MAINNET)
    expect(decoded.encoding).toBe('bech32')
    expect(decoded.text).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect(hex(lockingScript(decoded.destination))).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    )
    const testnet = must(
      decodeAddress(
        'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
      ),
    )
    expect(testnet.chain).toBe(BTC_TESTNET)
    expect(testnet.destination.kind).toBe('p2wsh')
    expect(hex(lockingScript(testnet.destination))).toBe(
      '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262',
    )
    expect(
      decodeAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'),
    ).toMatchObject({ ok: false, error: { code: 'bad-checksum' } })
    expect(
      decodeAddress(
        'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7',
      ),
    ).toMatchObject({ ok: false, error: { code: 'mixed-case' } })
    expect(
      decodeAddress('tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty'),
    ).toMatchObject({
      ok: false,
      error: { code: 'wrong-prefix', prefix: 'tc' },
    })
    expect(decodeAddress('BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P')).toMatchObject(
      {
        ok: false,
        error: { code: 'witness-program-length', version: 0, actual: 16 },
      },
    )
  })

  test('BIP350 bech32m pays the supplied output key and rejects a bech32 checksum', () => {
    // bitcoin/bips bip-0350.mediawiki, valid and invalid segwit vectors.
    const decoded = must(
      decodeAddress(
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      ),
    )
    expect(decoded.encoding).toBe('bech32m')
    expect(decoded.destination.kind).toBe('p2tr')
    expect(hex(lockingScript(decoded.destination))).toBe(
      '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    )
    expect(
      decodeAddress(
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd',
      ),
    ).toMatchObject({ ok: false, error: { code: 'bad-checksum' } })
    expect(
      decodeAddress(
        'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq',
      ),
    ).toMatchObject({ ok: false, error: { code: 'mixed-case' } })
    expect(
      decodeAddress(
        'tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j',
      ),
    ).toMatchObject({ ok: false, error: { code: 'convert-bits-padding' } })
    expect(decodeAddress('BC1SW50QGDZ25J')).toMatchObject({
      ok: false,
      error: { code: 'unsupported-witness', version: 16, length: 2 },
    })
    const round = encodeBech32('bc', [0], 'bech32')
    expect(round.ok).toBe(true)
  })

  test('Bitcoin Cash cashaddr vectors, including the old package, are not XPI', () => {
    // Bitcoin-UAHF spec cashaddr.md examples, also checked by
    // bitcoin-cash-node src/cashaddr.cpp. Ported for BCH, not relabeled.
    const rows = [
      [
        '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu',
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      ],
      [
        '1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR',
        'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy',
      ],
      [
        '16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb',
        'bitcoincash:qqq3728yw0y47sqn6l2na30mcw6zm78dzqre909m2r',
      ],
      [
        '3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC',
        'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq',
      ],
      [
        '3LDsS579y7sruadqu11beEJoTjdFiFCdX4',
        'bitcoincash:pr95sy3j9xwd2ap32xkykttr4cvcu7as4yc93ky28e',
      ],
      [
        '31nwvkZwyPdgzjBJZXfDmSWsC4ZLKpYyUw',
        'bitcoincash:pqq3728yw0y47sqn6l2na30mcw6zm78dzq5ucqzc37',
      ],
    ] as const
    for (const [legacy, cash] of rows) {
      const decoded = must(decodeAddress(cash))
      expect(decoded.chain).toBe(BCH_MAINNET)
      expect(
        form(
          must(convertAddress(decoded.destination, BCH_MAINNET)),
          'base58check',
        ),
      ).toBe(legacy)
      expect(
        form(
          must(convertAddress(decoded.destination, BTC_MAINNET)),
          'base58check',
        ),
      ).toBe(legacy)
      const upper = must(decodeAddress(cash.toUpperCase()))
      expect(sameDestination(decoded.destination, upper.destination)).toBe(true)
      expect(upper.text).toBe(cash)
      const legacyDecoded = must(decodeAddress(legacy, BCH_MAINNET))
      expect(
        sameDestination(decoded.destination, legacyDecoded.destination),
      ).toBe(true)
      expect(new old.Address(cash).toLegacyAddress()).toBe(legacy)
    }
    expect(decodeAddress(rows[0][1].replace(/a$/, 'A'))).toMatchObject({
      ok: false,
      error: { code: 'mixed-case' },
    })
    const broken = `${rows[0][1].slice(0, -1)}7`
    expect(decodeAddress(broken)).toMatchObject({
      ok: false,
      error: { code: 'bad-checksum' },
    })
    expect(decodeAddress(rows[0][1].split(':')[1] ?? '')).toMatchObject({
      ok: false,
      error: { code: 'chain-required' },
    })
    const prefixless = must(
      decodeAddress(rows[0][1].split(':')[1] ?? '', BCH_MAINNET),
    )
    expect(prefixless.text).toBe(rows[0][1])
    expect(decodeAddress(rows[0][1], BCH_TESTNET)).toMatchObject({
      ok: false,
      error: {
        code: 'chain-mismatch',
        detected: { family: 'bch', network: 'mainnet' },
        supplied: { family: 'bch', network: 'testnet' },
      },
    })
    const testnetLegacy = 'mysKEM9kN86Nkcqwb4gw7RqtDyc552LQoq'
    const testnetCash = 'bchtest:qry5cr6h2qe25pzwwfrz8m653fh2tf6nusj9dl0ujc'
    expect(new old.Address(testnetLegacy).toCashAddress()).toBe(testnetCash)
    const testnet = must(decodeAddress(testnetLegacy, BCH_TESTNET))
    expect(
      form(must(convertAddress(testnet.destination, BCH_TESTNET)), 'cashaddr'),
    ).toBe(testnetCash)
    expect(decodeAddress(testnetLegacy, BTC_MAINNET)).toMatchObject({
      ok: false,
      error: { code: 'wrong-prefix' },
    })
  })

  test('Bitcoin ABC cashaddr.md eCash vectors use the ecash prefix', () => {
    // Bitcoin-ABC bitcoin-abc doc/standards/cashaddr.md (master).
    const rows = [
      [
        '1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu',
        'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2',
      ],
      [
        '1KXrWXciRDZUpQwQmuM1DbwsKDLYAYsVLR',
        'ecash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4ykdcjcn6n',
      ],
      [
        '16w1D5WRVKJuZUsSRzdLp9w3YGcgoxDXb',
        'ecash:qqq3728yw0y47sqn6l2na30mcw6zm78dzq653y7pv5',
      ],
      [
        '3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC',
        'ecash:ppm2qsznhks23z7629mms6s4cwef74vcwv2zrv3l8h',
      ],
      [
        '3LDsS579y7sruadqu11beEJoTjdFiFCdX4',
        'ecash:pr95sy3j9xwd2ap32xkykttr4cvcu7as4ypg9alspw',
      ],
      [
        '31nwvkZwyPdgzjBJZXfDmSWsC4ZLKpYyUw',
        'ecash:pqq3728yw0y47sqn6l2na30mcw6zm78dzqd3vtezhf',
      ],
    ] as const
    for (const [legacy, cash] of rows) {
      const fromLegacy = must(decodeAddress(legacy, XEC_MAINNET))
      expect(
        form(
          must(convertAddress(fromLegacy.destination, XEC_MAINNET)),
          'cashaddr',
        ),
      ).toBe(cash)
      const decoded = must(decodeAddress(cash))
      expect(decoded.chain).toBe(XEC_MAINNET)
      expect(sameDestination(decoded.destination, fromLegacy.destination)).toBe(
        true,
      )
    }
    const typed = must(
      decodeAddress('ecash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eyx54vzvwa'),
    )
    expect(typed.destination.kind).toBe('p2pkh')
    if (typed.destination.kind !== 'p2pkh') return
    expect(hex(typed.destination.hash)).toBe(
      'f5bf48b397dae70be82b3cca4793f8eb2b6cdac9',
    )
    const script = must(
      decodeAddress('ectest:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyh6krzzk3'),
    )
    expect(script.chain).toBe(XEC_TESTNET)
    expect(script.destination.kind).toBe('p2sh')
    expect(
      must(decodeCashaddr('ecash:qpzry9x8gf2tvdw0s3jn54khce6mua7llmm0t7vm'))
        .prefix,
    ).toBe('ecash')
    expect(must(decodeCashaddr('prefix:x64nx6hz')).payload.length).toBe(0)
  })

  test('addressesFor lists BTC encodings and refuses an implied taproot tweak', () => {
    expect(addressesFor(pubkey(), BTC_MAINNET)).toMatchObject({
      ok: false,
      error: { code: 'taproot-tweak-required' },
    })
    const listed = must(
      addressesFor(pubkey(), BTC_MAINNET, {
        outputKey: outputKey(),
        tweak: TWEAK,
      }),
    )
    expect(listed.map(item => item.destination.kind)).toEqual([
      'p2pkh',
      'p2sh-p2wpkh',
      'p2wpkh',
      'p2tr',
    ])
    const wpkh = kind(listed, 'p2wpkh')
    expect(form(wpkh, 'bech32')).toBe(
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    )
    expect(hex(lockingScript(wpkh.destination))).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    )
    const tap = kind(listed, 'p2tr')
    expect(form(tap, 'bech32m')).toBe(
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
    )
    const otherTweak = new Uint8Array(32).fill(2)
    const retweaked = must(
      addressesFor(pubkey(), BTC_MAINNET, {
        outputKey: outputKey(),
        tweak: otherTweak,
      }),
    )
    expect(form(kind(retweaked, 'p2tr'), 'bech32m')).toBe(form(tap, 'bech32m'))
    const retap = kind(retweaked, 'p2tr').destination
    expect(sameDestination(tap.destination, retap)).toBe(true)
    if (tap.destination.kind !== 'p2tr' || retap.kind !== 'p2tr') return
    expect(Array.from(tap.destination.tweak ?? [])).toEqual(Array.from(TWEAK))
    expect(Array.from(retap.tweak ?? [])).not.toEqual(Array.from(TWEAK))
    const decodedTap = must(
      decodeAddress(
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      ),
    )
    expect(sameDestination(tap.destination, decodedTap.destination)).toBe(true)
    expect(
      sameDestination(kind(listed, 'p2pkh').destination, wpkh.destination),
    ).toBe(false)
    const oldMain = old.Address.fromPublicKey(
      old.PublicKey.fromBuffer(Buffer.from(PUB_HEX, 'hex')),
      'livenet',
    )
    const hash = Buffer.from(
      old.crypto.Hash.sha256ripemd160(Buffer.from(PUB_HEX, 'hex')).toString(
        'hex',
      ),
      'hex',
    )
    const legacy = old.encoding.Base58Check.encode(
      Buffer.concat([Buffer.from([0]), hash]),
    )
    expect(form(kind(listed, 'p2pkh'), 'base58check')).toBe(legacy)
    expect(form(kind(listed, 'p2pkh'), 'base58check')).toBe(
      oldMain.toLegacyAddress(),
    )
    const redeem = Buffer.concat([Buffer.from([0x00, 0x14]), hash])
    const scriptHash = Buffer.from(
      old.crypto.Hash.sha256ripemd160(redeem).toString('hex'),
      'hex',
    )
    const nested = old.encoding.Base58Check.encode(
      Buffer.concat([Buffer.from([5]), scriptHash]),
    )
    expect(form(kind(listed, 'p2sh-p2wpkh'), 'base58check')).toBe(nested)
    const bch = must(addressesFor(pubkey(), BCH_MAINNET))
    expect(bch.map(item => item.destination.kind)).toEqual(['p2pkh'])
    expect(form(kind(bch, 'p2pkh'), 'cashaddr')).toBe(oldMain.toCashAddress())
    const regtest = must(
      addressesFor(pubkey(), BTC_REGTEST, {
        outputKey: outputKey(),
        tweak: TWEAK,
      }),
    )
    expect(form(kind(regtest, 'p2wpkh'), 'bech32').startsWith('bcrt1')).toBe(
      true,
    )
  })

  test('convert moves a p2pkh hash and refuses segwit on BCH, XEC, and XPI', () => {
    const listed = must(
      addressesFor(pubkey(), BTC_MAINNET, {
        outputKey: outputKey(),
        tweak: TWEAK,
      }),
    )
    const p2pkh = kind(listed, 'p2pkh').destination
    const bch = must(convertAddress(p2pkh, BCH_MAINNET))
    expect(form(bch, 'cashaddr').startsWith('bitcoincash:')).toBe(true)
    const xec = must(convertAddress(p2pkh, XEC_MAINNET))
    expect(form(xec, 'cashaddr').startsWith('ecash:')).toBe(true)
    const legacy = must(
      decodeAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', BTC_MAINNET),
    )
    expect(
      form(must(convertAddress(legacy.destination, XEC_MAINNET)), 'cashaddr'),
    ).toBe('ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2')
    expect(
      form(must(convertAddress(legacy.destination, BCH_MAINNET)), 'cashaddr'),
    ).toBe('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')
    const xpi = must(convertAddress(legacy.destination, XPI_MAINNET))
    expect(xpi.forms).toEqual([])
    expect(xpi.stringEncoding).toEqual({
      status: 'unpinned',
      code: 'address-format-not-pinned',
    })
    expect(JSON.stringify(xpi.forms)).not.toContain('lotus')
    expect(
      encodeAddress(legacy.destination, XPI_MAINNET, 'base58check'),
    ).toMatchObject({
      ok: false,
      error: { code: 'address-format-not-pinned' },
    })
    expect(
      decodeAddress('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu', XPI_MAINNET),
    ).toMatchObject({
      ok: false,
      error: { code: 'address-format-not-pinned' },
    })
    expect(
      decodeAddress(
        'lotus_16PSJLjLt4f5tQW5t3E1FKrH6WK4uzQLVvnSsdkqd',
        XPI_MAINNET,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'address-format-not-pinned' },
    })
    const regtest = must(convertAddress(legacy.destination, BCH_REGTEST))
    expect(form(regtest, 'cashaddr').startsWith('bchreg:')).toBe(true)
    for (const chain of [BCH_MAINNET, XEC_MAINNET, XPI_MAINNET]) {
      expect(
        convertAddress(kind(listed, 'p2wpkh').destination, chain),
      ).toMatchObject({
        ok: false,
        error: { code: 'not-representable', kind: 'p2wpkh' },
      })
      expect(
        convertAddress(kind(listed, 'p2tr').destination, chain),
      ).toMatchObject({
        ok: false,
        error: { code: 'not-representable', kind: 'p2tr' },
      })
      expect(
        convertAddress(kind(listed, 'p2sh-p2wpkh').destination, chain),
      ).toMatchObject({
        ok: false,
        error: { code: 'not-representable', kind: 'p2sh-p2wpkh' },
      })
    }
    expect(
      decodeAddress(
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
        XPI_MAINNET,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'chain-mismatch' },
    })
    expect(isAddressError({ code: 'address-format-not-pinned' })).toBe(true)
    expect(() =>
      addressesFor(
        Buffer.from(PUB_HEX, 'hex') as unknown as CompressedPublicKey,
        BTC_MAINNET,
        {
          outputKey: outputKey(),
          tweak: TWEAK,
        },
      ),
    ).toThrow(EncodingException)
  })
})
