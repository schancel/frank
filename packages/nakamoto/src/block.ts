// Block headers and merkle roots. BTC, BCH, and XEC use the 80-byte header
// and hash256 of those bytes. Lotus does not: lotusd serializes 160 bytes and
// hashes three single-SHA256 layers. An 80-byte buffer is not a Lotus header.
// BTC, BCH, and XEC duplicate the last hash of an odd merkle level (Core,
// BCHN, Bitcoin ABC). Lotus pads that slot with a zero hash (lotusd
// ComputeMerkleRoot and CPartialMerkleTree). Partial trees follow that rule.

import { cryptoBackend } from './backend.js'
import { concatBytes, copyBytes, encodeUnsignedLE } from './bytes.js'
import type { ChainDescriptor } from './chain/types.js'
import { internalHashFromBytes, type InternalHash } from './constructors.js'
import { EncodingException } from './encoding-error.js'
import { ByteReader, ByteWriter } from './reader.js'

export const BITCOIN_HEADER_BYTES = 80
export const LOTUS_HEADER_BYTES = 160

const ZERO32 = new Uint8Array(32)
const MAX_TRANSACTIONS = 1_048_576
const TIME48_MAX = (1n << 48n) - 1n
const SIZE56_MAX = (1n << 56n) - 1n
const UINT64_MAX = (1n << 64n) - 1n

export interface BitcoinHeader {
  readonly kind: 'bitcoin-80'
  readonly version: number
  readonly prevBlock: InternalHash
  readonly merkleRoot: InternalHash
  readonly time: number
  readonly bits: number
  readonly nonce: number
}

export interface LotusHeader {
  readonly kind: 'lotus'
  /** Wire size is 6 bytes. Values above 2^48-1 are block-range. */
  readonly time: bigint
  readonly prevBlock: InternalHash
  readonly bits: number
  readonly reserved: number
  readonly nonce: bigint
  readonly headerVersion: number
  /** Advertised block size. Wire width is 7 bytes, so this is bigint. */
  readonly size: bigint
  readonly height: number
  readonly epochBlock: InternalHash
  readonly merkleRoot: InternalHash
  readonly extendedMetadata: InternalHash
}

export type BlockHeader = BitcoinHeader | LotusHeader

export interface MerkleBlock {
  readonly header: BlockHeader
  readonly transactions: number
  readonly hashes: readonly InternalHash[]
  readonly flags: Uint8Array
  readonly matches: readonly InternalHash[]
}

export interface BlockFailure {
  readonly code:
    | 'block-truncated'
    | 'block-trailing'
    | 'block-range'
    | 'block-header-length'
    | 'block-header-shape'
    | 'merkle-proof'
    | 'merkle-root'
  readonly expected?: number
  readonly actual?: number
}

export type BlockResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BlockFailure }

export function isBlockError(value: unknown): value is BlockFailure {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return (
    code === 'block-truncated' ||
    code === 'block-trailing' ||
    code === 'block-range' ||
    code === 'block-header-length' ||
    code === 'block-header-shape' ||
    code === 'merkle-proof' ||
    code === 'merkle-root'
  )
}

function fail(
  code: BlockFailure['code'],
  extra: { expected?: number; actual?: number } = {},
): BlockResult<never> {
  return { ok: false, error: { code, ...extra } }
}

function hash256(bytes: Uint8Array) {
  return new Uint8Array(cryptoBackend.sha256d(bytes))
}

function sha256Once(bytes: Uint8Array) {
  return new Uint8Array(cryptoBackend.sha256(bytes))
}

function brand(bytes: Uint8Array): InternalHash {
  const hashed = internalHashFromBytes(bytes)
  if (!hashed.ok) throw new EncodingException(hashed.error)
  return hashed.value
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function u32ok(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
}

function i32Bits(value: number): number | null {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    return null
  }
  return value < 0 ? value + 0x100000000 : value
}

function readI32(bits: number): number {
  return bits > 0x7fffffff ? bits - 0x100000000 : bits
}

function u8ok(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xff
}

function u16ok(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff
}

function bigOk(value: bigint, max: bigint): boolean {
  return typeof value === 'bigint' && value >= 0n && value <= max
}

function le(value: bigint, width: number): Uint8Array | null {
  const encoded = encodeUnsignedLE(value, width)
  if (!encoded.ok) return null
  return encoded.value
}

function headerLength(chain: ChainDescriptor): 80 | 160 {
  return chain.header.kind === 'bitcoin-80'
    ? BITCOIN_HEADER_BYTES
    : LOTUS_HEADER_BYTES
}

/** Lotus odd levels hash against zero. The other chains duplicate the last. */
function oddPartner(last: Uint8Array, chain: ChainDescriptor): Uint8Array {
  return chain.family === 'xpi' ? copyBytes(ZERO32) : copyBytes(last)
}

export function merkleRoot(
  leaves: readonly InternalHash[],
  chain: ChainDescriptor,
): InternalHash {
  if (leaves.length === 0) return brand(ZERO32)
  let level = leaves.map(leaf => copyBytes(leaf))
  while (level.length > 1) {
    if (level.length % 2 === 1) {
      const last = level[level.length - 1]
      if (!last) break
      level.push(oddPartner(last, chain))
    }
    const next: Uint8Array[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]
      const right = level[index + 1]
      if (!left || !right) break
      next.push(hash256(concatBytes([left, right])))
    }
    level = next
  }
  const root = level[0]
  if (!root) return brand(ZERO32)
  return brand(root)
}

function treeWidth(transactions: number, height: number): number {
  const span = 2 ** height
  return Math.floor((transactions + span - 1) / span)
}

function treeHeight(transactions: number): number {
  let height = 0
  while (treeWidth(transactions, height) > 1) height += 1
  return height
}

interface Walk {
  bitsUsed: number
  hashesUsed: number
  matches: InternalHash[]
  bad: boolean
}

function flagBit(flags: Uint8Array, index: number): number | null {
  const byte = flags[index >> 3]
  if (byte === undefined) return null
  return (byte >>> (index & 7)) & 1
}

function walk(
  transactions: number,
  hashes: readonly InternalHash[],
  flags: Uint8Array,
  height: number,
  pos: number,
  state: Walk,
  chain: ChainDescriptor,
): Uint8Array {
  if (state.bad) return ZERO32
  const bit = flagBit(flags, state.bitsUsed)
  if (bit === null) {
    state.bad = true
    return ZERO32
  }
  state.bitsUsed += 1
  if (height === 0 || bit === 0) {
    const hash = hashes[state.hashesUsed]
    if (!hash) {
      state.bad = true
      return ZERO32
    }
    state.hashesUsed += 1
    if (height === 0 && bit === 1) state.matches.push(brand(hash))
    return copyBytes(hash)
  }
  const left = walk(
    transactions,
    hashes,
    flags,
    height - 1,
    pos * 2,
    state,
    chain,
  )
  const rightIndex = pos * 2 + 1
  let right: Uint8Array
  if (rightIndex < treeWidth(transactions, height - 1)) {
    right = walk(
      transactions,
      hashes,
      flags,
      height - 1,
      rightIndex,
      state,
      chain,
    )
    if (sameBytes(left, right)) state.bad = true
  } else {
    right = oddPartner(left, chain)
  }
  return hash256(concatBytes([left, right]))
}

export function partialMerkleRoot(
  proof: {
    readonly transactions: number
    readonly hashes: readonly InternalHash[]
    readonly flags: Uint8Array
  },
  chain: ChainDescriptor,
): BlockResult<{
  readonly root: InternalHash
  readonly matches: readonly InternalHash[]
}> {
  if (
    !Number.isInteger(proof.transactions) ||
    proof.transactions <= 0 ||
    proof.transactions > MAX_TRANSACTIONS
  ) {
    return fail('merkle-proof')
  }
  if (
    proof.hashes.length === 0 ||
    proof.hashes.length > proof.transactions ||
    proof.flags.length * 8 < proof.hashes.length
  ) {
    return fail('merkle-proof')
  }
  const state: Walk = {
    bitsUsed: 0,
    hashesUsed: 0,
    matches: [],
    bad: false,
  }
  const root = walk(
    proof.transactions,
    proof.hashes,
    proof.flags,
    treeHeight(proof.transactions),
    0,
    state,
    chain,
  )
  const usedBytes = (state.bitsUsed + 7) >> 3
  if (
    state.bad ||
    state.hashesUsed !== proof.hashes.length ||
    usedBytes !== proof.flags.length
  ) {
    return fail('merkle-proof')
  }
  return { ok: true, value: { root: brand(root), matches: state.matches } }
}

function parseBitcoin(bytes: Uint8Array): BlockResult<BitcoinHeader> {
  const reader = new ByteReader(bytes)
  const versionBits = reader.readUInt32LE()
  const prev = reader.read(32)
  const merkle = reader.read(32)
  const time = reader.readUInt32LE()
  const bits = reader.readUInt32LE()
  const nonce = reader.readUInt32LE()
  if (
    !versionBits.ok ||
    !prev.ok ||
    !merkle.ok ||
    !time.ok ||
    !bits.ok ||
    !nonce.ok
  ) {
    return fail('block-truncated')
  }
  const previous = internalHashFromBytes(prev.value)
  const merkleRoot = internalHashFromBytes(merkle.value)
  if (!previous.ok || !merkleRoot.ok) return fail('block-truncated')
  return {
    ok: true,
    value: {
      kind: 'bitcoin-80',
      version: readI32(versionBits.value),
      prevBlock: previous.value,
      merkleRoot: merkleRoot.value,
      time: time.value,
      bits: bits.value,
      nonce: nonce.value,
    },
  }
}

function parseLotus(bytes: Uint8Array): BlockResult<LotusHeader> {
  const reader = new ByteReader(bytes)
  const prev = reader.read(32)
  const bits = reader.readUInt32LE()
  const timeBytes = reader.read(6)
  const reserved = reader.readUInt16LE()
  const nonce = reader.readUInt64LE()
  const headerVersion = reader.readUInt8()
  const sizeBytes = reader.read(7)
  const heightBits = reader.readUInt32LE()
  const epoch = reader.read(32)
  const merkle = reader.read(32)
  const extended = reader.read(32)
  if (
    !prev.ok ||
    !bits.ok ||
    !timeBytes.ok ||
    !reserved.ok ||
    !nonce.ok ||
    !headerVersion.ok ||
    !sizeBytes.ok ||
    !heightBits.ok ||
    !epoch.ok ||
    !merkle.ok ||
    !extended.ok
  ) {
    return fail('block-truncated')
  }
  const prevBlock = internalHashFromBytes(prev.value)
  const epochBlock = internalHashFromBytes(epoch.value)
  const merkleRoot = internalHashFromBytes(merkle.value)
  const extendedMetadata = internalHashFromBytes(extended.value)
  if (
    !prevBlock.ok ||
    !epochBlock.ok ||
    !merkleRoot.ok ||
    !extendedMetadata.ok
  ) {
    return fail('block-truncated')
  }
  return {
    ok: true,
    value: {
      kind: 'lotus',
      prevBlock: prevBlock.value,
      bits: bits.value,
      time: decodeLe(timeBytes.value),
      reserved: reserved.value,
      nonce: nonce.value,
      headerVersion: headerVersion.value,
      size: decodeLe(sizeBytes.value),
      height: readI32(heightBits.value),
      epochBlock: epochBlock.value,
      merkleRoot: merkleRoot.value,
      extendedMetadata: extendedMetadata.value,
    },
  }
}

function decodeLe(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = 0; index < bytes.length; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << BigInt(index * 8)
  }
  return value
}

export function parseHeader(
  bytes: Uint8Array,
  chain: ChainDescriptor,
): BlockResult<BlockHeader> {
  const body = copyBytes(bytes)
  const expected = headerLength(chain)
  if (
    chain.header.kind !== 'bitcoin-80' &&
    body.length === BITCOIN_HEADER_BYTES
  ) {
    return fail('block-header-shape', {
      expected: LOTUS_HEADER_BYTES,
      actual: body.length,
    })
  }
  if (body.length !== expected) {
    return fail('block-header-length', { expected, actual: body.length })
  }
  return chain.header.kind === 'bitcoin-80'
    ? parseBitcoin(body)
    : parseLotus(body)
}

function writeBitcoin(header: BitcoinHeader): BlockResult<Uint8Array> {
  const version = i32Bits(header.version)
  if (
    version === null ||
    !u32ok(header.time) ||
    !u32ok(header.bits) ||
    !u32ok(header.nonce)
  ) {
    return fail('block-range')
  }
  const writer = new ByteWriter()
  writer.writeUInt32LE(version)
  writer.write(header.prevBlock)
  writer.write(header.merkleRoot)
  writer.writeUInt32LE(header.time)
  writer.writeUInt32LE(header.bits)
  writer.writeUInt32LE(header.nonce)
  const bytes = writer.finish()
  if (bytes.length !== BITCOIN_HEADER_BYTES) return fail('block-range')
  return { ok: true, value: bytes }
}

function writeLotus(header: LotusHeader): BlockResult<Uint8Array> {
  const height = i32Bits(header.height)
  if (
    height === null ||
    !u32ok(header.bits) ||
    !u16ok(header.reserved) ||
    !u8ok(header.headerVersion) ||
    !bigOk(header.time, TIME48_MAX) ||
    !bigOk(header.nonce, UINT64_MAX) ||
    !bigOk(header.size, SIZE56_MAX)
  ) {
    return fail('block-range')
  }
  const time = le(header.time, 6)
  const size = le(header.size, 7)
  if (!time || !size) return fail('block-range')
  const writer = new ByteWriter()
  writer.write(header.prevBlock)
  writer.writeUInt32LE(header.bits)
  writer.write(time)
  writer.writeUInt16LE(header.reserved)
  writer.writeUInt64LE(header.nonce)
  writer.writeUInt8(header.headerVersion)
  writer.write(size)
  writer.writeUInt32LE(height)
  writer.write(header.epochBlock)
  writer.write(header.merkleRoot)
  writer.write(header.extendedMetadata)
  const bytes = writer.finish()
  if (bytes.length !== LOTUS_HEADER_BYTES) return fail('block-range')
  return { ok: true, value: bytes }
}

export function serializeHeader(header: BlockHeader): BlockResult<Uint8Array> {
  return header.kind === 'bitcoin-80'
    ? writeBitcoin(header)
    : writeLotus(header)
}

function lotusDigest(header: LotusHeader): BlockResult<Uint8Array> {
  const height = i32Bits(header.height)
  if (
    height === null ||
    !u32ok(header.bits) ||
    !u16ok(header.reserved) ||
    !u8ok(header.headerVersion) ||
    !bigOk(header.time, TIME48_MAX) ||
    !bigOk(header.nonce, UINT64_MAX) ||
    !bigOk(header.size, SIZE56_MAX)
  ) {
    return fail('block-range')
  }
  const time = le(header.time, 6)
  const size = le(header.size, 7)
  const bits = le(BigInt(header.bits), 4)
  const reserved = le(BigInt(header.reserved), 2)
  const nonce = le(header.nonce, 8)
  const version = le(BigInt(header.headerVersion), 1)
  const heightBytes = le(BigInt(height), 4)
  if (
    !time ||
    !size ||
    !bits ||
    !reserved ||
    !nonce ||
    !version ||
    !heightBytes
  ) {
    return fail('block-range')
  }
  const layer3 = sha256Once(
    concatBytes([
      version,
      size,
      heightBytes,
      header.epochBlock,
      header.merkleRoot,
      header.extendedMetadata,
    ]),
  )
  const layer2 = sha256Once(concatBytes([bits, time, reserved, nonce, layer3]))
  return {
    ok: true,
    value: sha256Once(concatBytes([header.prevBlock, layer2])),
  }
}

export function headerHash(header: BlockHeader): BlockResult<InternalHash> {
  if (header.kind === 'lotus') {
    const digest = lotusDigest(header)
    if (!digest.ok) return digest
    return { ok: true, value: brand(digest.value) }
  }
  const bytes = writeBitcoin(header)
  if (!bytes.ok) return bytes
  return { ok: true, value: brand(hash256(bytes.value)) }
}

export function parseMerkleBlock(
  bytes: Uint8Array,
  chain: ChainDescriptor,
): BlockResult<MerkleBlock> {
  const body = copyBytes(bytes)
  const expected = headerLength(chain)
  if (
    chain.header.kind !== 'bitcoin-80' &&
    body.length === BITCOIN_HEADER_BYTES
  ) {
    return fail('block-header-shape', {
      expected: LOTUS_HEADER_BYTES,
      actual: body.length,
    })
  }
  if (body.length < expected) {
    return fail('block-truncated', { expected, actual: body.length })
  }
  const header = parseHeader(body.subarray(0, expected), chain)
  if (!header.ok) return header
  const reader = new ByteReader(body.subarray(expected))
  const countBits = reader.readUInt32LE()
  if (!countBits.ok) return fail('block-truncated')
  if (countBits.value === 0 || countBits.value > MAX_TRANSACTIONS) {
    return fail('merkle-proof')
  }
  const hashCount = reader.readVarint()
  if (!hashCount.ok) return fail('block-truncated')
  if (
    hashCount.value <= 0n ||
    hashCount.value > BigInt(countBits.value) ||
    hashCount.value > BigInt(MAX_TRANSACTIONS)
  ) {
    return fail('merkle-proof')
  }
  const hashes: InternalHash[] = []
  const total = Number(hashCount.value)
  for (let index = 0; index < total; index += 1) {
    const hash = reader.read(32)
    if (!hash.ok) return fail('block-truncated')
    const branded = internalHashFromBytes(hash.value)
    if (!branded.ok) return fail('block-truncated')
    hashes.push(branded.value)
  }
  const flags = reader.readBytesPrefixed()
  if (!flags.ok) return fail('block-truncated')
  if (!reader.finished()) return fail('block-trailing')
  const proof = partialMerkleRoot(
    {
      transactions: countBits.value,
      hashes,
      flags: flags.value,
    },
    chain,
  )
  if (!proof.ok) return proof
  if (!sameBytes(proof.value.root, header.value.merkleRoot)) {
    return fail('merkle-root')
  }
  return {
    ok: true,
    value: {
      header: header.value,
      transactions: countBits.value,
      hashes,
      flags: copyBytes(flags.value),
      matches: proof.value.matches,
    },
  }
}

export function serializeMerkleBlock(
  block: MerkleBlock,
): BlockResult<Uint8Array> {
  const header = serializeHeader(block.header)
  if (!header.ok) return header
  if (
    !u32ok(block.transactions) ||
    block.transactions === 0 ||
    block.transactions > MAX_TRANSACTIONS ||
    block.hashes.length > block.transactions
  ) {
    return fail('merkle-proof')
  }
  const writer = new ByteWriter()
  writer.write(header.value)
  writer.writeUInt32LE(block.transactions)
  writer.writeVarint(BigInt(block.hashes.length))
  for (const hash of block.hashes) writer.write(hash)
  writer.writeVarint(BigInt(block.flags.length))
  writer.write(block.flags)
  return { ok: true, value: writer.finish() }
}
