import { sha256 } from '@noble/hashes/sha256.js'
import { crypto as oldCrypto } from 'bitcore-lib-xpi'

import {
  BCH_MAINNET,
  BTC_MAINNET,
  XEC_MAINNET,
  XPI_MAINNET,
} from '../src/chain/index.js'
import { concatBytes, reverseBytes } from '../src/bytes.js'
import {
  internalHashFromBytes,
  type InternalHash,
} from '../src/constructors.js'
import {
  BITCOIN_HEADER_BYTES,
  LOTUS_HEADER_BYTES,
  headerHash,
  merkleRoot,
  parseHeader,
  parseMerkleBlock,
  partialMerkleRoot,
  serializeHeader,
  serializeMerkleBlock,
  type BitcoinHeader,
  type LotusHeader,
} from '../src/block.js'

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function display(bytes: Uint8Array): string {
  return toHex(reverseBytes(bytes))
}

function hashOf(hex: string): InternalHash {
  const branded = internalHashFromBytes(fromHex(hex))
  if (!branded.ok) throw new Error(branded.error.code)
  return branded.value
}

function hash256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(sha256(bytes)))
}

// bitcoin/bitcoin src/kernel/chainparams.cpp genesis (and the same header in
// Bitcoin Cash Node and Bitcoin ABC). version 1, time 1231006505,
// bits 0x1d00ffff, nonce 2083236893.
const BTC_GENESIS_HEADER =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c'
const BTC_GENESIS_ID =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const BTC_GENESIS_MERKLE =
  '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const BTC_GENESIS_COINBASE =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'

// LotusiaStewardship/lotusd src/chainparams.cpp CreateGenesisBlock and the
// asserts on hash, merkle root, extended metadata, and size 379.
// src/primitives/block.h is the 160-byte order. GetHash is block.cpp.
const XPI_GENESIS_HEADER =
  '00000000000000000000000000000000000000000000000000000000000000000000101cf407d06000000000ab78287d559f2c63017b0100000000000000000000000000000000000000000000000000000000000000000000000000000000004cf30ab9dc2797f3a4fe5f6b2dbf11670bf97e5aa266d3a6adcd708fd892f3371406e05881e299367766d313e26c05564ec91bf721d31726bd6e46e60689539a'
const XPI_GENESIS_ID =
  '000000000abc0cde58ee7e919d3d4de183e6844add1fd5d14b4eac89d958f470'
const XPI_MERKLE =
  '37f392d88f70cdada6d366a25a7ef90b6711bf2d6b5ffea4f39727dcb90af34c'
const XPI_EXTENDED =
  '9a538906e6466ebd2617d321f71bc94e56056ce213d366773699e28158e00614'

// packages/bitcore-lib-xpi/test/data/merkleblocks.js mainnet block 15290.
// The header is the Lotus layout, so this fixture is not a bitcoin-80 block.
const XPI_MERKLE_BLOCK_15290 =
  '4f0bfafc3e3ab70f3e8741c7b74d068298f0ed33c86d9b7dd0b039000000000020223e1b2218dc6000000000183422810c648bcb01a5030000000000ba3b000063a3214bb079b14a6a30e47febaa0ecbe4ee557aa8992980ee370100000000007bc0e12a069b62f53acc37c9b911dddfb0860cf8af11fe0aa7c859e1fd05d88f1406e05881e299367766d313e26c05564ec91bf721d31726bd6e46e60689539a0400000003b155767806e59532bee1ae8fb9adb75111fdcec65fb53dfcd8483e338b519df3677eeabc444b75903ec8660097e4b17d3020a9ac6c9915192a565da41f102f0d9d45b8c1e16f2afad449ce0ad3bbf36c04e0eec9ecfb8d9d788fcc5f8c95ac8e010b'

function lotusGenesis(): LotusHeader {
  return {
    kind: 'lotus',
    prevBlock: hashOf('00'.repeat(32)),
    bits: 0x1c100000,
    time: 1624246260n,
    reserved: 0,
    nonce: 7146261898250975403n,
    headerVersion: 1,
    size: 379n,
    height: 0,
    epochBlock: hashOf('00'.repeat(32)),
    merkleRoot: hashOf(display(fromHex(XPI_MERKLE))),
    extendedMetadata: hashOf(display(fromHex(XPI_EXTENDED))),
  }
}

function bitcoinGenesis(): BitcoinHeader {
  return {
    kind: 'bitcoin-80',
    version: 1,
    prevBlock: hashOf('00'.repeat(32)),
    merkleRoot: hashOf(display(fromHex(BTC_GENESIS_MERKLE))),
    time: 1231006505,
    bits: 0x1d00ffff,
    nonce: 2083236893,
  }
}

describe('block headers and merkle roots', () => {
  test('bitcoin genesis header round-trips and matches Core', () => {
    const bytes = fromHex(BTC_GENESIS_HEADER)
    expect(bytes.length).toBe(BITCOIN_HEADER_BYTES)
    for (const chain of [BTC_MAINNET, BCH_MAINNET, XEC_MAINNET]) {
      const parsed = parseHeader(bytes, chain)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.value.kind).toBe('bitcoin-80')
      const encoded = serializeHeader(parsed.value)
      expect(encoded.ok && toHex(encoded.value)).toBe(BTC_GENESIS_HEADER)
      const id = headerHash(parsed.value)
      expect(id.ok && display(id.value)).toBe(BTC_GENESIS_ID)
    }
    const fromOld = oldCrypto.Hash.sha256sha256(Buffer.from(bytes))
    expect(toHex(fromOld)).toBe(toHex(reverseBytes(fromHex(BTC_GENESIS_ID))))
  })

  test('genesis coinbase merkle root matches the header', () => {
    const txid = hash256(fromHex(BTC_GENESIS_COINBASE))
    expect(display(txid)).toBe(BTC_GENESIS_MERKLE)
    const root = merkleRoot([hashOf(toHex(txid))], BTC_MAINNET)
    expect(display(root)).toBe(BTC_GENESIS_MERKLE)
    expect(toHex(merkleRoot([], BTC_MAINNET))).toBe('00'.repeat(32))
  })

  test('an odd merkle level duplicates the last hash', () => {
    const first = hashOf('11'.repeat(32))
    const second = hashOf('22'.repeat(32))
    const third = hashOf('33'.repeat(32))
    const left = hash256(concatBytes([first, second]))
    const duplicated = hash256(concatBytes([third, third]))
    const expected = hash256(concatBytes([left, duplicated]))
    const nulled = hash256(
      concatBytes([left, hash256(concatBytes([third, new Uint8Array(32)]))]),
    )
    for (const chain of [BTC_MAINNET, BCH_MAINNET, XEC_MAINNET]) {
      expect(toHex(merkleRoot([first, second, third], chain))).toBe(
        toHex(expected),
      )
    }
    expect(toHex(expected)).not.toBe(toHex(nulled))
    const partial = partialMerkleRoot(
      {
        transactions: 3,
        hashes: [first, second, third],
        flags: Uint8Array.of(0x3f),
      },
      BTC_MAINNET,
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(toHex(partial.value.root)).toBe(toHex(expected))
    expect(partial.value.matches).toHaveLength(3)
  })

  test('an odd lotus level pads with a zero hash', () => {
    const first = hashOf('11'.repeat(32))
    const second = hashOf('22'.repeat(32))
    const third = hashOf('33'.repeat(32))
    const left = hash256(concatBytes([first, second]))
    const padded = hash256(
      concatBytes([left, hash256(concatBytes([third, new Uint8Array(32)]))]),
    )
    const duplicated = hash256(concatBytes([third, third]))
    expect(toHex(merkleRoot([first, second, third], XPI_MAINNET))).toBe(
      toHex(padded),
    )
    expect(toHex(padded)).not.toBe(
      toHex(hash256(concatBytes([left, duplicated]))),
    )
    const partial = partialMerkleRoot(
      {
        transactions: 3,
        hashes: [first, second, third],
        flags: Uint8Array.of(0x3f),
      },
      XPI_MAINNET,
    )
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(toHex(partial.value.root)).toBe(toHex(padded))
    expect(partial.value.matches).toHaveLength(3)
  })

  test('a partial tree rejects an inner duplicate', () => {
    const leaf = hashOf('ab'.repeat(32))
    const proof = partialMerkleRoot(
      {
        transactions: 2,
        hashes: [leaf, leaf],
        flags: Uint8Array.of(0x07),
      },
      BTC_MAINNET,
    )
    expect(proof.ok).toBe(false)
    if (proof.ok) return
    expect(proof.error.code).toBe('merkle-proof')
  })

  test('lotus genesis is 160 bytes and is not hash256 of the header', () => {
    const encoded = serializeHeader(lotusGenesis())
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(encoded.value.length).toBe(LOTUS_HEADER_BYTES)
    expect(toHex(encoded.value)).toBe(XPI_GENESIS_HEADER)
    const parsed = parseHeader(encoded.value, XPI_MAINNET)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const id = headerHash(parsed.value)
    expect(id.ok && display(id.value)).toBe(XPI_GENESIS_ID)
    expect(display(hash256(encoded.value))).not.toBe(XPI_GENESIS_ID)
    const built = headerHash(bitcoinGenesis())
    expect(built.ok && display(built.value)).toBe(BTC_GENESIS_ID)
  })

  test('an 80-byte buffer is not a lotus header', () => {
    const eighty = fromHex(BTC_GENESIS_HEADER)
    const parsed = parseHeader(eighty, XPI_MAINNET)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('block-header-shape')
    const block = parseMerkleBlock(eighty, XPI_MAINNET)
    expect(block.ok).toBe(false)
    if (block.ok) return
    expect(block.error.code).toBe('block-header-shape')
    const wide = parseHeader(fromHex(XPI_GENESIS_HEADER), BTC_MAINNET)
    expect(wide.ok).toBe(false)
    if (wide.ok) return
    expect(wide.error.code).toBe('block-header-length')
  })

  test('lotus size and time widths are rejected past the wire', () => {
    const header = lotusGenesis()
    const size = serializeHeader({ ...header, size: 1n << 56n })
    const time = serializeHeader({ ...header, time: 1n << 48n })
    expect(size.ok).toBe(false)
    expect(time.ok).toBe(false)
    if (size.ok || time.ok) return
    expect(size.error.code).toBe('block-range')
    expect(time.error.code).toBe('block-range')
  })

  test('ported lotus merkle block 15290 round-trips and matches its root', () => {
    const bytes = fromHex(XPI_MERKLE_BLOCK_15290)
    const parsed = parseMerkleBlock(bytes, XPI_MAINNET)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.transactions).toBe(4)
    expect(parsed.value.hashes).toHaveLength(3)
    expect(parsed.value.matches).toHaveLength(1)
    expect(display(parsed.value.header.merkleRoot)).toBe(
      '8fd805fde159c8a70afe11aff80c86b0dfdd11b9c937cc3af5629b062ae1c07b',
    )
    const encoded = serializeMerkleBlock(parsed.value)
    expect(encoded.ok && toHex(encoded.value)).toBe(XPI_MERKLE_BLOCK_15290)
    const flipped = new Uint8Array(bytes)
    flipped[96] ^= 0xff
    const mismatch = parseMerkleBlock(flipped, XPI_MAINNET)
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) return
    expect(mismatch.error.code).toBe('merkle-root')
  })

  test('ported lotus merkle block 22003 matches the header root', () => {
    const header: LotusHeader = {
      kind: 'lotus',
      prevBlock: hashOf(
        display(
          fromHex(
            '0000000000030882116ee6f5963b9ed7c028845e55ec992c2a49abac0e1a52a0',
          ),
        ),
      ),
      bits: 456014208,
      time: 1625768825n,
      reserved: 0,
      nonce: 12045594477943128845n,
      headerVersion: 1,
      size: 2152n,
      height: 22003,
      epochBlock: hashOf(
        display(
          fromHex(
            '000000000002b926066e364c16302ffe83b1b55040853ec76f45b7a4f2eca54a',
          ),
        ),
      ),
      merkleRoot: hashOf(
        display(
          fromHex(
            '3f2c344f3ec5d3e434c4772d36ee01971b575f513542cc723929105b458d7de6',
          ),
        ),
      ),
      extendedMetadata: hashOf(display(fromHex(XPI_EXTENDED))),
    }
    const id = headerHash(header)
    expect(id.ok && display(id.value)).toBe(
      '000000000019072db2834f8ed26ef6f0f2f3a4d9288f63176c5e82d9477ca397',
    )
    const encoded = serializeMerkleBlock({
      header,
      transactions: 6,
      hashes: [
        'ebe885d1d9003636a0d1dbaca45f595a7e9eb36c10ff1c0aa0cff9f698a93a43',
        '8b5c233843e7074fd8d7df86eabc719594c23774e5693874edaee0e9fb9e78c9',
        '95116d3eb89c26f16399414b9aad492d868d1255eddb05d77fdcbe2f6ec3bfb4',
        '85d80c3a2a27e2f42940c71386f76f1c757e01fe7a7199ffb3b29a192e1f22f0',
      ].map(hashOf),
      flags: Uint8Array.of(23),
      matches: [],
    })
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    const parsed = parseMerkleBlock(encoded.value, XPI_MAINNET)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.matches).toHaveLength(1)
    const asBitcoin = parseMerkleBlock(encoded.value, BTC_MAINNET)
    expect(asBitcoin.ok).toBe(false)
  })

  test('a non-minimal compact size in a merkle block is rejected', () => {
    const bytes = fromHex(XPI_MERKLE_BLOCK_15290)
    const countAt = LOTUS_HEADER_BYTES + 4
    expect(bytes[countAt]).toBe(0x03)
    const inflated = concatBytes([
      bytes.subarray(0, countAt),
      Uint8Array.of(0xfd, 0x03, 0x00),
      bytes.subarray(countAt + 1),
    ])
    const parsed = parseMerkleBlock(inflated, XPI_MAINNET)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error.code).toBe('block-truncated')
  })
})
