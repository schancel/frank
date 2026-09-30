// Per-chain transaction bytes and sighash preimages. No keys and no signatures.
// Legacy matches Bitcoin Core SignatureHash, including the SIGHASH_SINGLE bug.
// BIP143 and BIP341 are BTC only. BCH and XEC share the fork-id preimage;
// BCH inserts the Upgrade9 UTXO hash only when commitUtxos is set.
// XPI uses SignatureHashLotus (lotusd interpreter.cpp). Fork id 0 is not that path.

import { cryptoBackend } from './backend.js'
import { concatBytes, copyBytes, encodeUnsignedLE } from './bytes.js'
import type { ChainDescriptor } from './chain/types.js'
import { internalHashFromBytes, type InternalHash } from './constructors.js'
import { ByteReader, ByteWriter } from './reader.js'

export const SIGHASH_DEFAULT = 0x00
export const SIGHASH_ALL = 0x01
export const SIGHASH_NONE = 0x02
export const SIGHASH_SINGLE = 0x03
export const SIGHASH_UTXOS = 0x20
export const SIGHASH_FORKID = 0x40
export const SIGHASH_LOTUS = 0x60
export const SIGHASH_ANYONECANPAY = 0x80

const OP_CODESEPARATOR = 0xab
const ZERO32 = new Uint8Array(32)
const SINGLE_BUG = new Uint8Array(32)
SINGLE_BUG[0] = 0x01
const NEGATIVE_ONE = Uint8Array.of(
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
)
const TAP_TAG = Uint8Array.of(84, 97, 112, 83, 105, 103, 104, 97, 115, 104)
const TAP_TAG_HASH = new Uint8Array(cryptoBackend.sha256(TAP_TAG))
const INT64_MAX = (1n << 63n) - 1n
const UINT64_MAX = (1n << 64n) - 1n
const CODESEP_NONE = 0xffffffff

export type SighashAlgorithm =
  | 'legacy'
  | 'bip143'
  | 'bip341'
  | 'forkid'
  | 'lotus'

export interface OutPoint {
  readonly txid: InternalHash
  readonly vout: number
}

export interface TxInput {
  readonly prevout: OutPoint
  readonly scriptSig: Uint8Array
  readonly sequence: number
  /** Present only on a BIP144 witness transaction. Omitted for legacy bytes. */
  readonly witness?: readonly Uint8Array[]
}

export interface TxOutput {
  readonly value: bigint
  readonly scriptPubKey: Uint8Array
}

export interface Transaction {
  readonly version: number
  readonly inputs: readonly TxInput[]
  readonly outputs: readonly TxOutput[]
  readonly locktime: number
}

export interface SpentOutput {
  readonly value: bigint
  readonly scriptPubKey: Uint8Array
}

export interface SighashOptions {
  readonly algorithm: SighashAlgorithm
  /** Legacy, BIP143, and fork-id subscript. Not the BIP341 scriptPubKey. */
  readonly scriptCode?: Uint8Array
  /** Satoshis committed by BIP143 and fork id. Required for those algorithms. */
  readonly amount?: bigint
  /** Prevouts in input order. Required by BIP341, Lotus, and BCH UTXOS. */
  readonly spent?: readonly SpentOutput[]
  /**
   * Bitcoin Cash Node inserts the spent-output hash only when this is set,
   * matching SCRIPT_ENABLE_TOKENS. XEC has no such insertion.
   */
  readonly commitUtxos?: boolean
  /** Full annex item, including the 0x50 prefix. BIP341 only. */
  readonly annex?: Uint8Array
  /** Presence selects BIP341 ext_flag 1 and appends the BIP342 extension. */
  readonly tapleafHash?: Uint8Array
  readonly keyVersion?: number
  readonly codeSeparatorPosition?: number
  /**
   * Lotus script commitment. Presence sets ext_flag. Raw SHA256 bytes,
   * the same order lotusd stores in uint256.
   */
  readonly executedScriptHash?: Uint8Array
}

export interface TxFailure {
  readonly code:
    | 'tx-truncated'
    | 'tx-trailing'
    | 'tx-witness-flag'
    | 'tx-witness-rejected'
    | 'tx-range'
    | 'sighash-algorithm'
    | 'sighash-index'
    | 'sighash-type'
    | 'sighash-amount'
    | 'sighash-script'
    | 'sighash-spent'
    | 'sighash-single'
    | 'sighash-utxos'
    | 'sighash-tapleaf'
    | 'sighash-extension'
}

export type TxResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TxFailure }

export function isTxError(value: unknown): value is TxFailure {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return (
    code === 'tx-truncated' ||
    code === 'tx-trailing' ||
    code === 'tx-witness-flag' ||
    code === 'tx-witness-rejected' ||
    code === 'tx-range' ||
    code === 'sighash-algorithm' ||
    code === 'sighash-index' ||
    code === 'sighash-type' ||
    code === 'sighash-amount' ||
    code === 'sighash-script' ||
    code === 'sighash-spent' ||
    code === 'sighash-single' ||
    code === 'sighash-utxos' ||
    code === 'sighash-tapleaf' ||
    code === 'sighash-extension'
  )
}

function fail(code: TxFailure['code']): TxResult<never> {
  return { ok: false, error: { code } }
}

function hash256(bytes: Uint8Array) {
  return new Uint8Array(cryptoBackend.sha256d(bytes))
}

function u32Bits(value: number): number | null {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null
  return value
}

function i32Bits(value: number): number | null {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    return null
  }
  return value < 0 ? value + 0x100000000 : value
}

function writeI32(writer: ByteWriter, value: number): boolean {
  const bits = i32Bits(value)
  if (bits === null) return false
  writer.writeUInt32LE(bits)
  return true
}

function writeU32(writer: ByteWriter, value: number): boolean {
  if (u32Bits(value) === null) return false
  writer.writeUInt32LE(value)
  return true
}

function writeU64(writer: ByteWriter, value: bigint): boolean {
  if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX)
    return false
  writer.writeUInt64LE(value)
  return true
}

function writeScript(writer: ByteWriter, script: Uint8Array): void {
  writer.writeVarint(BigInt(script.length))
  if (script.length > 0) writer.write(script)
}

function outPointBytes(prevout: OutPoint): Uint8Array | null {
  if (prevout.txid.length !== 32 || u32Bits(prevout.vout) === null) return null
  const writer = new ByteWriter()
  writer.write(prevout.txid)
  writer.writeUInt32LE(prevout.vout)
  return writer.finish()
}

function outputBytes(output: TxOutput | SpentOutput): Uint8Array | null {
  if (!writeU64(new ByteWriter(), output.value)) return null
  const script = copyBytes(output.scriptPubKey)
  const writer = new ByteWriter()
  writer.writeUInt64LE(output.value)
  writeScript(writer, script)
  return writer.finish()
}

function hasWitness(tx: Transaction): boolean {
  return tx.inputs.some(input => input.witness !== undefined)
}

function fitsCount(count: bigint, byteLength: number): boolean {
  return count >= 0n && count <= BigInt(byteLength)
}

export function serializeTransaction(
  tx: Transaction,
  chain: ChainDescriptor,
): TxResult<Uint8Array> {
  const witness = hasWitness(tx)
  if (witness && chain.family !== 'btc') return fail('tx-witness-rejected')
  if (i32Bits(tx.version) === null || u32Bits(tx.locktime) === null) {
    return fail('tx-range')
  }
  const writer = new ByteWriter()
  if (!writeI32(writer, tx.version)) return fail('tx-range')
  if (witness) {
    writer.writeUInt8(0)
    writer.writeUInt8(1)
  }
  writer.writeVarint(BigInt(tx.inputs.length))
  for (const input of tx.inputs) {
    const prevout = outPointBytes(input.prevout)
    if (prevout === null || u32Bits(input.sequence) === null) {
      return fail('tx-range')
    }
    const script = copyBytes(input.scriptSig)
    writer.write(prevout)
    writeScript(writer, script)
    writer.writeUInt32LE(input.sequence)
  }
  writer.writeVarint(BigInt(tx.outputs.length))
  for (const output of tx.outputs) {
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    writer.write(encoded)
  }
  if (witness) {
    for (const input of tx.inputs) {
      const stack = input.witness ?? []
      writer.writeVarint(BigInt(stack.length))
      for (const item of stack) {
        const bytes = copyBytes(item)
        writeScript(writer, bytes)
      }
    }
  }
  writer.writeUInt32LE(tx.locktime)
  return { ok: true, value: writer.finish() }
}

function readCount(reader: ByteReader, byteLength: number): TxResult<number> {
  const count = reader.readVarint()
  if (!count.ok) return fail('tx-truncated')
  if (!fitsCount(count.value, byteLength)) return fail('tx-truncated')
  return { ok: true, value: Number(count.value) }
}

function readScript(reader: ByteReader): TxResult<Uint8Array> {
  const script = reader.readBytesPrefixed()
  if (!script.ok) return fail('tx-truncated')
  return { ok: true, value: script.value }
}

function readInputs(reader: ByteReader, count: number): TxResult<TxInput[]> {
  const inputs: TxInput[] = []
  for (let index = 0; index < count; index += 1) {
    const txid = reader.read(32)
    const vout = reader.readUInt32LE()
    const script = readScript(reader)
    const sequence = reader.readUInt32LE()
    if (!txid.ok || !vout.ok || !script.ok || !sequence.ok) {
      return fail('tx-truncated')
    }
    const branded = internalHashFromBytes(txid.value)
    if (!branded.ok) return fail('tx-range')
    inputs.push({
      prevout: { txid: branded.value, vout: vout.value },
      scriptSig: script.value,
      sequence: sequence.value,
    })
  }
  return { ok: true, value: inputs }
}

function readOutputs(reader: ByteReader, count: number): TxResult<TxOutput[]> {
  const outputs: TxOutput[] = []
  for (let index = 0; index < count; index += 1) {
    const value = reader.readUInt64LE()
    const script = readScript(reader)
    if (!value.ok || !script.ok) return fail('tx-truncated')
    outputs.push({ value: value.value, scriptPubKey: script.value })
  }
  return { ok: true, value: outputs }
}

function readWitness(
  reader: ByteReader,
  inputs: readonly TxInput[],
  byteLength: number,
): TxResult<TxInput[]> {
  const withWitness: TxInput[] = []
  for (const input of inputs) {
    const count = readCount(reader, byteLength)
    if (!count.ok) return count
    const stack: Uint8Array[] = []
    for (let index = 0; index < count.value; index += 1) {
      const item = readScript(reader)
      if (!item.ok) return item
      stack.push(item.value)
    }
    withWitness.push({ ...input, witness: stack })
  }
  return { ok: true, value: withWitness }
}

/** Chain selects the witness rule. BCH, XEC, and XPI never read a marker. */
export function parseTransaction(
  bytes: Uint8Array,
  chain: ChainDescriptor,
): TxResult<Transaction> {
  const raw = copyBytes(bytes)
  const reader = new ByteReader(raw)
  const versionBits = reader.readUInt32LE()
  if (!versionBits.ok) return fail('tx-truncated')
  const version =
    versionBits.value > 0x7fffffff
      ? versionBits.value - 0x100000000
      : versionBits.value
  const vin = readCount(reader, raw.length)
  if (!vin.ok) return vin
  let witness = false
  let inputCount = vin.value
  if (chain.family === 'btc' && vin.value === 0) {
    const flag = reader.readUInt8()
    if (!flag.ok) return fail('tx-truncated')
    if (flag.value !== 1) return fail('tx-witness-flag')
    witness = true
    const real = readCount(reader, raw.length)
    if (!real.ok) return real
    inputCount = real.value
  }
  const inputs = readInputs(reader, inputCount)
  if (!inputs.ok) return inputs
  const vout = readCount(reader, raw.length)
  if (!vout.ok) return vout
  const outputs = readOutputs(reader, vout.value)
  if (!outputs.ok) return outputs
  const txInputs = witness
    ? readWitness(reader, inputs.value, raw.length)
    : inputs
  if (!txInputs.ok) return txInputs
  const locktime = reader.readUInt32LE()
  if (!locktime.ok) return fail('tx-truncated')
  if (!reader.finished()) return fail('tx-trailing')
  return {
    ok: true,
    value: {
      version,
      inputs: txInputs.value,
      outputs: outputs.value,
      locktime: locktime.value,
    },
  }
}

function withoutCodeSeparators(script: Uint8Array): Uint8Array {
  const out: number[] = []
  let index = 0
  while (index < script.length) {
    const opcode = script[index] ?? 0
    if (opcode === OP_CODESEPARATOR) {
      index += 1
      continue
    }
    let data = 0
    let header = 1
    if (opcode > 0 && opcode < 0x4c) {
      data = opcode
    } else if (opcode === 0x4c || opcode === 0x4d || opcode === 0x4e) {
      header = opcode === 0x4c ? 2 : opcode === 0x4d ? 3 : 5
      if (index + header > script.length) {
        for (let rest = index; rest < script.length; rest += 1) {
          out.push(script[rest] ?? 0)
        }
        break
      }
      for (let byte = 0; byte < header - 1; byte += 1) {
        data |= (script[index + 1 + byte] ?? 0) << (8 * byte)
      }
    }
    const end = index + header + data
    const limit = end > script.length ? script.length : end
    for (let cursor = index; cursor < limit; cursor += 1) {
      out.push(script[cursor] ?? 0)
    }
    if (end > script.length) break
    index = end
  }
  return Uint8Array.from(out)
}

function baseType(hashType: number): number {
  return hashType & 0x1f
}

function anyoneCanPay(hashType: number): boolean {
  return (hashType & SIGHASH_ANYONECANPAY) !== 0
}

function requireScript(script: Uint8Array | undefined): TxResult<Uint8Array> {
  if (script === undefined) return fail('sighash-script')
  return { ok: true, value: copyBytes(script) }
}

function requireAmount(amount: bigint | undefined): TxResult<bigint> {
  if (amount === undefined || amount < 0n || amount > UINT64_MAX) {
    return fail('sighash-amount')
  }
  return { ok: true, value: amount }
}

function sighashLegacy(
  tx: Transaction,
  inputIndex: number,
  hashType: number,
  scriptCode: Uint8Array,
): TxResult<InternalHash> {
  const base = baseType(hashType)
  if (base === SIGHASH_SINGLE && inputIndex >= tx.outputs.length) {
    const bug = internalHashFromBytes(SINGLE_BUG)
    if (!bug.ok) return fail('tx-range')
    return bug
  }
  const script = withoutCodeSeparators(scriptCode)
  const anyone = anyoneCanPay(hashType)
  const writer = new ByteWriter()
  if (!writeI32(writer, tx.version)) return fail('tx-range')
  const inputCount = anyone ? 1 : tx.inputs.length
  writer.writeVarint(BigInt(inputCount))
  for (let slot = 0; slot < inputCount; slot += 1) {
    const index = anyone ? inputIndex : slot
    const input = tx.inputs[index]
    if (input === undefined) return fail('sighash-index')
    const prevout = outPointBytes(input.prevout)
    if (prevout === null) return fail('tx-range')
    writer.write(prevout)
    if (index === inputIndex) writeScript(writer, script)
    else writer.writeUInt8(0)
    const clear =
      index !== inputIndex && (base === SIGHASH_NONE || base === SIGHASH_SINGLE)
    if (!writeU32(writer, clear ? 0 : input.sequence)) return fail('tx-range')
  }
  const outputCount =
    base === SIGHASH_NONE
      ? 0
      : base === SIGHASH_SINGLE
      ? inputIndex + 1
      : tx.outputs.length
  writer.writeVarint(BigInt(outputCount))
  for (let index = 0; index < outputCount; index += 1) {
    if (base === SIGHASH_SINGLE && index !== inputIndex) {
      writer.write(NEGATIVE_ONE)
      writer.writeUInt8(0)
      continue
    }
    const output = tx.outputs[index]
    if (output === undefined) return fail('sighash-single')
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    writer.write(encoded)
  }
  if (!writeU32(writer, tx.locktime)) return fail('tx-range')
  const bits = i32Bits(hashType)
  if (bits === null) return fail('sighash-type')
  writer.writeUInt32LE(bits)
  const branded = internalHashFromBytes(hash256(writer.finish()))
  if (!branded.ok) return fail('tx-range')
  return branded
}

function sighashBip143(
  tx: Transaction,
  inputIndex: number,
  hashType: number,
  scriptCode: Uint8Array,
  amount: bigint,
  spent: readonly SpentOutput[] | undefined,
  commitUtxos: boolean,
): TxResult<InternalHash> {
  const input = tx.inputs[inputIndex]
  if (input === undefined) return fail('sighash-index')
  const base = baseType(hashType)
  const anyone = anyoneCanPay(hashType)
  let hashPrevouts = ZERO32
  let hashSequence = ZERO32
  let hashOutputs = ZERO32
  if (!anyone) {
    const prevouts = new ByteWriter()
    for (const item of tx.inputs) {
      const prevout = outPointBytes(item.prevout)
      if (prevout === null) return fail('tx-range')
      prevouts.write(prevout)
    }
    hashPrevouts = hash256(prevouts.finish())
  }
  let utxoHash: Uint8Array | null = null
  if (commitUtxos) {
    if ((hashType & SIGHASH_UTXOS) === 0) return fail('sighash-utxos')
    if (spent === undefined || spent.length !== tx.inputs.length) {
      return fail('sighash-spent')
    }
    const body = new ByteWriter()
    for (const output of spent) {
      const encoded = outputBytes(output)
      if (encoded === null) return fail('tx-range')
      body.write(encoded)
    }
    utxoHash = hash256(body.finish())
  }
  if (!anyone && base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) {
    const sequences = new ByteWriter()
    for (const item of tx.inputs) {
      if (!writeU32(sequences, item.sequence)) return fail('tx-range')
    }
    hashSequence = hash256(sequences.finish())
  }
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) {
    const outputs = new ByteWriter()
    for (const output of tx.outputs) {
      const encoded = outputBytes(output)
      if (encoded === null) return fail('tx-range')
      outputs.write(encoded)
    }
    hashOutputs = hash256(outputs.finish())
  } else if (base === SIGHASH_SINGLE && inputIndex < tx.outputs.length) {
    const output = tx.outputs[inputIndex]
    if (output === undefined) return fail('sighash-single')
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    hashOutputs = hash256(encoded)
  }
  const prevout = outPointBytes(input.prevout)
  if (prevout === null) return fail('tx-range')
  const writer = new ByteWriter()
  if (!writeI32(writer, tx.version)) return fail('tx-range')
  writer.write(hashPrevouts)
  if (utxoHash !== null) writer.write(utxoHash)
  writer.write(hashSequence)
  writer.write(prevout)
  writeScript(writer, scriptCode)
  if (!writeU64(writer, amount)) return fail('sighash-amount')
  if (!writeU32(writer, input.sequence)) return fail('tx-range')
  writer.write(hashOutputs)
  if (!writeU32(writer, tx.locktime)) return fail('tx-range')
  const bits = i32Bits(hashType)
  if (bits === null) return fail('sighash-type')
  writer.writeUInt32LE(bits)
  const branded = internalHashFromBytes(hash256(writer.finish()))
  if (!branded.ok) return fail('tx-range')
  return branded
}

const TAP_TYPES = new Set([0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83])

function shaConcat(parts: readonly Uint8Array[]) {
  return new Uint8Array(cryptoBackend.sha256(concatBytes(parts)))
}

function sighashTaproot(
  tx: Transaction,
  inputIndex: number,
  hashType: number,
  options: SighashOptions,
): TxResult<InternalHash> {
  if (hashType < 0 || hashType > 0xff || !TAP_TYPES.has(hashType)) {
    return fail('sighash-type')
  }
  const input = tx.inputs[inputIndex]
  if (input === undefined) return fail('sighash-index')
  const spent = options.spent
  if (spent === undefined || spent.length !== tx.inputs.length) {
    return fail('sighash-spent')
  }
  const low = hashType & 0x03
  const anyone = anyoneCanPay(hashType)
  if (low === SIGHASH_SINGLE && inputIndex >= tx.outputs.length) {
    return fail('sighash-single')
  }
  const extFlag = options.tapleafHash === undefined ? 0 : 1
  if (extFlag === 1 && options.tapleafHash?.length !== 32) {
    return fail('sighash-tapleaf')
  }
  const keyVersion = options.keyVersion ?? 0
  const codesep = options.codeSeparatorPosition ?? CODESEP_NONE
  if (extFlag === 1 && (u32Bits(keyVersion) === null || keyVersion > 0xff)) {
    return fail('sighash-extension')
  }
  if (extFlag === 1 && u32Bits(codesep) === null)
    return fail('sighash-extension')
  const annex = options.annex === undefined ? null : copyBytes(options.annex)
  const spendType = extFlag * 2 + (annex === null ? 0 : 1)
  const writer = new ByteWriter()
  writer.writeUInt8(0)
  writer.writeUInt8(hashType)
  if (!writeI32(writer, tx.version)) return fail('tx-range')
  if (!writeU32(writer, tx.locktime)) return fail('tx-range')
  if (!anyone) {
    const prevouts: Uint8Array[] = []
    const amounts: Uint8Array[] = []
    const scripts: Uint8Array[] = []
    const sequences: Uint8Array[] = []
    for (let index = 0; index < tx.inputs.length; index += 1) {
      const item = tx.inputs[index]
      const coin = spent[index]
      if (item === undefined || coin === undefined) return fail('sighash-spent')
      const prevout = outPointBytes(item.prevout)
      const amount = encodeUnsignedLE(coin.value, 8)
      if (prevout === null || !amount.ok || u32Bits(item.sequence) === null) {
        return fail('tx-range')
      }
      prevouts.push(prevout)
      amounts.push(amount.value)
      const script = new ByteWriter()
      writeScript(script, copyBytes(coin.scriptPubKey))
      scripts.push(script.finish())
      const sequence = new ByteWriter()
      sequence.writeUInt32LE(item.sequence)
      sequences.push(sequence.finish())
    }
    writer.write(shaConcat(prevouts))
    writer.write(shaConcat(amounts))
    writer.write(shaConcat(scripts))
    writer.write(shaConcat(sequences))
  }
  if (low !== SIGHASH_NONE && low !== SIGHASH_SINGLE) {
    const outputs: Uint8Array[] = []
    for (const output of tx.outputs) {
      const encoded = outputBytes(output)
      if (encoded === null) return fail('tx-range')
      outputs.push(encoded)
    }
    writer.write(shaConcat(outputs))
  }
  writer.writeUInt8(spendType)
  if (anyone) {
    const coin = spent[inputIndex]
    if (coin === undefined) return fail('sighash-spent')
    const prevout = outPointBytes(input.prevout)
    if (prevout === null) return fail('tx-range')
    writer.write(prevout)
    if (!writeU64(writer, coin.value)) return fail('sighash-amount')
    writeScript(writer, copyBytes(coin.scriptPubKey))
    if (!writeU32(writer, input.sequence)) return fail('tx-range')
  } else if (!writeU32(writer, inputIndex)) {
    return fail('sighash-index')
  }
  if (annex !== null) {
    const annexBytes = new ByteWriter()
    writeScript(annexBytes, annex)
    writer.write(new Uint8Array(cryptoBackend.sha256(annexBytes.finish())))
  }
  if (low === SIGHASH_SINGLE) {
    const output = tx.outputs[inputIndex]
    if (output === undefined) return fail('sighash-single')
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    writer.write(new Uint8Array(cryptoBackend.sha256(encoded)))
  }
  if (extFlag === 1 && options.tapleafHash !== undefined) {
    writer.write(copyBytes(options.tapleafHash))
    writer.writeUInt8(keyVersion)
    writer.writeUInt32LE(codesep)
  }
  const message = writer.finish()
  const digest = new Uint8Array(
    cryptoBackend.sha256(concatBytes([TAP_TAG_HASH, TAP_TAG_HASH, message])),
  )
  const branded = internalHashFromBytes(digest)
  if (!branded.ok) return fail('tx-range')
  return branded
}

function merkleRoot(leaves: readonly Uint8Array[]): TxResult<{
  readonly root: Uint8Array
  readonly height: number
}> {
  if (leaves.length === 0) {
    return { ok: true, value: { root: ZERO32, height: 0 } }
  }
  let layer = leaves.map(leaf => new Uint8Array(leaf))
  let height = 1
  while (layer.length > 1) {
    height += 1
    if (height > 0xff) return fail('tx-range')
    if (layer.length % 2 === 1) layer.push(new Uint8Array(32))
    const next = []
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index] ?? ZERO32
      const right = layer[index + 1] ?? ZERO32
      next.push(hash256(concatBytes([left, right])))
    }
    layer = next
  }
  return { ok: true, value: { root: layer[0] ?? ZERO32, height } }
}

function sighashLotus(
  tx: Transaction,
  inputIndex: number,
  hashType: number,
  options: SighashOptions,
): TxResult<InternalHash> {
  const bits = i32Bits(hashType)
  if (bits === null) return fail('sighash-type')
  if ((bits & 0x60) !== SIGHASH_LOTUS) return fail('sighash-type')
  if ((bits & 0x03) === 0 || (bits & 0x1c) !== 0) return fail('sighash-type')
  const input = tx.inputs[inputIndex]
  if (input === undefined) return fail('sighash-index')
  const spent = options.spent
  if (spent === undefined || spent.length !== tx.inputs.length) {
    return fail('sighash-spent')
  }
  const base = bits & 0x1f
  const anyone = (bits & SIGHASH_ANYONECANPAY) !== 0
  if (base === SIGHASH_SINGLE && inputIndex >= tx.outputs.length) {
    return fail('sighash-single')
  }
  const executed = options.executedScriptHash
  const extFlag = executed === undefined ? 0 : 1
  if (extFlag === 1 && executed?.length !== 32) return fail('sighash-extension')
  const codesep = options.codeSeparatorPosition ?? CODESEP_NONE
  if (extFlag === 1 && u32Bits(codesep) === null)
    return fail('sighash-extension')
  const coin = spent[inputIndex]
  if (coin === undefined) return fail('sighash-spent')
  const prevout = outPointBytes(input.prevout)
  const spentBytes = outputBytes(coin)
  const sequence = encodeUnsignedLE(BigInt(input.sequence), 4)
  if (prevout === null || spentBytes === null || !sequence.ok) {
    return fail('tx-range')
  }
  const inputHash = hash256(
    concatBytes([
      Uint8Array.of(extFlag << 1),
      prevout,
      sequence.value,
      spentBytes,
    ]),
  )
  const inputLeaves: Uint8Array[] = []
  const spentLeaves: Uint8Array[] = []
  let inputSum = 0n
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const item = tx.inputs[index]
    const prev = spent[index]
    if (item === undefined || prev === undefined) return fail('sighash-spent')
    const point = outPointBytes(item.prevout)
    const encoded = outputBytes(prev)
    const sequence = encodeUnsignedLE(BigInt(item.sequence), 4)
    if (point === null || encoded === null || !sequence.ok)
      return fail('tx-range')
    inputLeaves.push(hash256(concatBytes([point, sequence.value])))
    spentLeaves.push(hash256(encoded))
    inputSum += prev.value
  }
  const outputLeaves: Uint8Array[] = []
  let outputSum = 0n
  for (const output of tx.outputs) {
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    outputLeaves.push(hash256(encoded))
    outputSum += output.value
  }
  if (inputSum > INT64_MAX || outputSum > INT64_MAX)
    return fail('sighash-amount')
  const inputsRoot = merkleRoot(inputLeaves)
  const outputsRoot = merkleRoot(outputLeaves)
  const spentRoot = merkleRoot(spentLeaves)
  if (!inputsRoot.ok) return inputsRoot
  if (!outputsRoot.ok) return outputsRoot
  if (!spentRoot.ok) return spentRoot
  const writer = new ByteWriter()
  writer.writeUInt32LE(bits)
  writer.write(inputHash)
  if (extFlag === 1 && executed !== undefined) {
    writer.writeUInt32LE(codesep)
    writer.write(copyBytes(executed))
  }
  if (!anyone) {
    writer.writeUInt32LE(inputIndex)
    writer.write(spentRoot.value.root)
    writer.writeUInt64LE(inputSum)
  }
  if (base === SIGHASH_ALL) writer.writeUInt64LE(outputSum)
  if (!writeI32(writer, tx.version)) return fail('tx-range')
  if (!anyone) {
    writer.write(inputsRoot.value.root)
    writer.writeUInt8(inputsRoot.value.height)
  }
  if (base === SIGHASH_SINGLE) {
    const output = tx.outputs[inputIndex]
    if (output === undefined) return fail('sighash-single')
    const encoded = outputBytes(output)
    if (encoded === null) return fail('tx-range')
    writer.write(hash256(encoded))
  }
  if (base === SIGHASH_ALL) {
    writer.write(outputsRoot.value.root)
    writer.writeUInt8(outputsRoot.value.height)
  }
  if (!writeU32(writer, tx.locktime)) return fail('tx-range')
  const branded = internalHashFromBytes(hash256(writer.finish()))
  if (!branded.ok) return fail('tx-range')
  return branded
}

function allowed(chain: ChainDescriptor, algorithm: SighashAlgorithm): boolean {
  if (algorithm === 'legacy') {
    return chain.family === 'btc' || chain.family === 'xpi'
  }
  if (algorithm === 'bip143' || algorithm === 'bip341') {
    return chain.sighash.kind === 'btc-legacy-and-segwit'
  }
  if (algorithm === 'forkid') return chain.sighash.kind === 'forkid'
  return chain.sighash.kind === 'lotus'
}

/**
 * Digest of one input. The returned bytes are the raw hash (internal order).
 * Bitcoin Core's GetHex() is the reversal of those bytes.
 */
export function sighash(
  tx: Transaction,
  inputIndex: number,
  chain: ChainDescriptor,
  hashType: number,
  options: SighashOptions,
): TxResult<InternalHash> {
  if (!Number.isInteger(hashType)) return fail('sighash-type')
  if (!allowed(chain, options.algorithm)) return fail('sighash-algorithm')
  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= tx.inputs.length
  ) {
    return fail('sighash-index')
  }
  if (options.algorithm === 'legacy') {
    const script = requireScript(options.scriptCode)
    if (!script.ok) return script
    return sighashLegacy(tx, inputIndex, hashType, script.value)
  }
  if (options.algorithm === 'bip143' || options.algorithm === 'forkid') {
    if (options.commitUtxos === true && chain.family !== 'bch') {
      return fail('sighash-utxos')
    }
    const script = requireScript(options.scriptCode)
    if (!script.ok) return script
    const amount = requireAmount(options.amount)
    if (!amount.ok) return amount
    return sighashBip143(
      tx,
      inputIndex,
      hashType,
      script.value,
      amount.value,
      options.spent,
      options.commitUtxos === true,
    )
  }
  if (options.algorithm === 'bip341')
    return sighashTaproot(tx, inputIndex, hashType, options)
  return sighashLotus(tx, inputIndex, hashType, options)
}
