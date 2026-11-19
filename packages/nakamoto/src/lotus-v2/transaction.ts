// Lotus v2 native (version 7) transactions: the complete P01 grammar
// (Lotus repository docs/lotus-v2/decisions/encoding-and-signatures.md,
// "Complete transaction grammar", "Core and complete identities").
//
//   Tx = version:u32(7) || lock:u64 || input_count:u16 || output_count:u16
//        || Input[input_count] || Output[output_count]
//
// Encode and parse apply the framing rules the grammar fixes (flags, counts,
// shortest CompactSize, pseudo-outpoints, coinbase shape, no trailing bytes),
// with lotusd's default framing caps (src/lotus_v2/transaction.h
// DefaultTxProfile). Script execution, accounting, locks against a block and
// fees are not checked here.

import { concatBytes } from '../bytes.js'
import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { ByteReader, ByteWriter } from '../reader.js'
import {
  lengthPrefixed,
  lotusV2IndexedTreeRoot,
  lotusV2TaggedHash,
} from './hash.js'

export const LOTUS_V2_SEQUENCE_FINAL = 0xffffffff
/** C06 consensus caps; the wire's u16 counts could say more. */
export const LOTUS_V2_MAX_INPUTS = 256
export const LOTUS_V2_MAX_OUTPUTS = 256
export const LOTUS_V2_MAX_OUTPUT_BRANCHES = 16
export const LOTUS_V2_MAX_OUTPUT_PATHS = 16
export const LOTUS_V2_MAX_COINBASE_DATA = 8192
/** lotusd DefaultTxProfile framing caps. */
const MAX_SCRIPT_BYTES = 10000
const MAX_ARGUMENTS = 65535
const MAX_ARGUMENT_BYTES = 8192
const MAX_PROOF_DEPTH = 64

const FLAG_TOKEN = 0x01
const FLAG_BURN = 0x02
const FLAG_STATE = 0x04

export interface LotusV2Output {
  readonly value: bigint
  /** `HAS_TOKEN`: nonzero 32-byte token id. */
  readonly tokenId?: Uint8Array
  /** `HAS_STATE`: nonzero 32-byte state commitment. */
  readonly stateRoot?: Uint8Array
  /** `IS_BURN`: unspendable; `paths` must be empty. */
  readonly burn?: boolean
  readonly branches: readonly Uint8Array[]
  readonly paths: readonly (readonly number[])[]
}

export interface LotusV2BranchWitness {
  readonly script: Uint8Array
  /** Membership proof, bottom-up. */
  readonly siblings: readonly Uint8Array[]
  /** Argument stack, bottom first. Not in `InputCore` (TxID) or any signature message. */
  readonly arguments: readonly Uint8Array[]
}

export type LotusV2Input =
  | {
      readonly kind: 'spend'
      readonly prevTxid: Uint8Array
      readonly prevIndex: number
      readonly sequence: number
      readonly pathIndex: number
      /** One per branch index in the spent coin's `paths[pathIndex]`, in order. */
      readonly witnesses: readonly LotusV2BranchWitness[]
    }
  | {
      readonly kind: 'coinbase'
      /** The parent BlockID (zero at genesis). */
      readonly prevTxid: Uint8Array
      /** The block height. */
      readonly prevIndex: number
      readonly sequence: number
      readonly data?: Uint8Array
    }
  | {
      readonly kind: 'mint'
      readonly tokenId: Uint8Array
      readonly witness: LotusV2BranchWitness
    }

/** `lock_kind` 0 disabled (value 0), 1 height, 2 parent median time; value is 56 bits. */
export interface LotusV2Lock {
  readonly kind: 0 | 1 | 2
  readonly value: bigint
}

export interface LotusV2Transaction {
  readonly lock: LotusV2Lock
  readonly inputs: readonly LotusV2Input[]
  readonly outputs: readonly LotusV2Output[]
}

export const LOTUS_V2_NO_LOCK: LotusV2Lock = Object.freeze({
  kind: 0 as const,
  value: 0n,
})

export class LotusV2FormatError extends Error {
  constructor(readonly reason: string) {
    super(`Lotus v2 transaction: ${reason}`)
    this.name = 'LotusV2FormatError'
  }
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new LotusV2FormatError(reason)
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every(b => b === 0)
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function hash32(bytes: Uint8Array | undefined, what: string): Uint8Array {
  check(bytes instanceof Uint8Array && bytes.length === 32, `${what} length`)
  return bytes
}

function u32(value: number, what: string): number {
  check(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, what)
  return value
}

function comparePaths(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return a.length - b.length
}

/** C05/P01 output rules (lotusd output.cpp `Valid`). */
export function validateLotusV2Output(output: LotusV2Output): void {
  check(
    typeof output.value === 'bigint' &&
      output.value >= 0n &&
      output.value < 1n << 64n,
    'output value',
  )
  if (output.tokenId !== undefined)
    check(!isZero(hash32(output.tokenId, 'token id')), 'zero token')
  if (output.stateRoot !== undefined)
    check(!isZero(hash32(output.stateRoot, 'state root')), 'zero state root')
  check(!(output.burn && output.stateRoot !== undefined), 'flags')
  const branches = output.branches
  check(
    branches.length >= 1 && branches.length <= LOTUS_V2_MAX_OUTPUT_BRANCHES,
    'branch count',
  )
  branches.forEach((b, i) => {
    hash32(b, 'branch')
    for (let j = 0; j < i; j += 1)
      check(!equalBytes(b, branches[j] as Uint8Array), 'duplicate branch')
  })
  if (output.burn) check(output.paths.length === 0, 'burn paths')
  else
    check(
      output.paths.length >= 1 &&
        output.paths.length <= LOTUS_V2_MAX_OUTPUT_PATHS,
      'path count',
    )
  output.paths.forEach((path, p) => {
    check(path.length >= 1 && path.length <= branches.length, 'path length')
    path.forEach((index, i) =>
      check(
        Number.isInteger(index) &&
          index >= 0 &&
          index < branches.length &&
          (i === 0 || (path[i - 1] as number) < index),
        'path index',
      ),
    )
    if (p > 0)
      check(
        comparePaths(output.paths[p - 1] as readonly number[], path) < 0,
        'path order',
      )
  })
}

/** `Bytes(Output)` content: `flags || value || token_id? || state_root? || Vec(branch) || Vec(Vec(CS))`. */
export function encodeLotusV2Output(output: LotusV2Output): Uint8Array {
  validateLotusV2Output(output)
  const flags =
    (output.tokenId ? FLAG_TOKEN : 0) |
    (output.burn ? FLAG_BURN : 0) |
    (output.stateRoot ? FLAG_STATE : 0)
  const w = new ByteWriter().writeUInt8(flags).writeUInt64LE(output.value)
  if (output.tokenId) w.write(output.tokenId)
  if (output.stateRoot) w.write(output.stateRoot)
  w.writeVarint(BigInt(output.branches.length))
  for (const b of output.branches) w.write(b)
  w.writeVarint(BigInt(output.paths.length))
  for (const path of output.paths) {
    w.writeVarint(BigInt(path.length))
    for (const index of path) w.writeVarint(BigInt(index))
  }
  return w.finish()
}

function validateWitness(w: LotusV2BranchWitness): void {
  check(
    w.script instanceof Uint8Array && w.script.length <= MAX_SCRIPT_BYTES,
    'script bytes',
  )
  check(w.siblings.length <= MAX_PROOF_DEPTH, 'sibling count')
  w.siblings.forEach(s => hash32(s, 'sibling'))
  check(w.arguments.length <= MAX_ARGUMENTS, 'argument count')
  w.arguments.forEach(a =>
    check(
      a instanceof Uint8Array && a.length <= MAX_ARGUMENT_BYTES,
      'argument bytes',
    ),
  )
}

function writeWitness(
  w: ByteWriter,
  witness: LotusV2BranchWitness,
  core: boolean,
): void {
  validateWitness(witness)
  w.write(lengthPrefixed(witness.script))
  w.writeVarint(BigInt(witness.siblings.length))
  for (const s of witness.siblings) w.write(s)
  if (core) return
  w.writeVarint(BigInt(witness.arguments.length))
  for (const a of witness.arguments) w.write(lengthPrefixed(a))
}

function validSequence(sequence: number): boolean {
  return sequence === LOTUS_V2_SEQUENCE_FINAL || (sequence & ~0x40ffff) === 0
}

/** `Input(i)` (`core = false`) or `InputCore(i)`: every witness without its argument vector. */
export function encodeLotusV2Input(
  input: LotusV2Input,
  core = false,
): Uint8Array {
  const w = new ByteWriter()
  switch (input.kind) {
    case 'spend': {
      u32(input.prevIndex, 'prev index')
      u32(input.sequence, 'sequence')
      check(validSequence(input.sequence), 'spend authorization')
      check(
        Number.isInteger(input.pathIndex) &&
          input.pathIndex >= 0 &&
          input.pathIndex < LOTUS_V2_MAX_OUTPUT_PATHS,
        'path index',
      )
      check(
        input.witnesses.length >= 1 &&
          input.witnesses.length <= LOTUS_V2_MAX_OUTPUT_BRANCHES,
        'witness count',
      )
      w.write(hash32(input.prevTxid, 'prev txid'))
        .writeUInt32LE(input.prevIndex)
        .writeUInt32LE(input.sequence)
        .writeUInt8(1)
        .writeVarint(BigInt(input.pathIndex))
        .writeVarint(BigInt(input.witnesses.length))
      for (const witness of input.witnesses) writeWitness(w, witness, core)
      break
    }
    case 'coinbase': {
      u32(input.prevIndex, 'prev index')
      check(input.sequence === LOTUS_V2_SEQUENCE_FINAL, 'coinbase data')
      if (input.data !== undefined)
        check(
          input.data.length >= 1 &&
            input.data.length <= LOTUS_V2_MAX_COINBASE_DATA,
          'coinbase data',
        )
      w.write(hash32(input.prevTxid, 'prev txid'))
        .writeUInt32LE(input.prevIndex)
        .writeUInt32LE(input.sequence)
        .writeUInt8(2)
        .writeVarint(input.data === undefined ? 0n : 1n)
      if (input.data !== undefined) w.write(lengthPrefixed(input.data))
      break
    }
    case 'mint': {
      check(!isZero(hash32(input.tokenId, 'token id')), 'mint pseudo-outpoint')
      w.write(input.tokenId)
        .writeUInt32LE(0)
        .writeUInt32LE(LOTUS_V2_SEQUENCE_FINAL)
        .writeUInt8(3)
      writeWitness(w, input.witness, core)
      break
    }
    default: {
      const unexpected: never = input
      throw new LotusV2FormatError(`input flags ${String(unexpected)}`)
    }
  }
  return w.finish()
}

function outpointKey(input: LotusV2Input): string {
  const txid = input.kind === 'mint' ? input.tokenId : input.prevTxid
  const index = input.kind === 'mint' ? 0 : input.prevIndex
  return `${Array.from(txid, b => b.toString(16).padStart(2, '0')).join(
    '',
  )}:${index}`
}

function validateShape(tx: LotusV2Transaction): void {
  const { kind, value } = tx.lock
  check(
    (kind === 0 || kind === 1 || kind === 2) &&
      typeof value === 'bigint' &&
      value >= 0n &&
      value < 1n << 56n &&
      (kind !== 0 || value === 0n),
    'transaction header',
  )
  check(
    tx.inputs.length >= 1 && tx.inputs.length <= LOTUS_V2_MAX_INPUTS,
    'transaction header',
  )
  check(tx.outputs.length <= LOTUS_V2_MAX_OUTPUTS, 'transaction header')
  const seen = new Set<string>()
  for (const input of tx.inputs) {
    const key = outpointKey(input)
    check(!seen.has(key), 'repeated outpoint')
    seen.add(key)
  }
  if (tx.inputs.some(i => i.kind === 'coinbase')) {
    check(
      tx.inputs.length === 1 &&
        kind === 0 &&
        tx.outputs.length >= 1 &&
        tx.outputs.every(o => !o.tokenId && !o.stateRoot),
      'coinbase shape',
    )
  } else {
    check(
      tx.inputs.some(i => i.kind === 'spend'),
      'ordinary input mix',
    )
  }
}

/** `TxHeaderCore = version:u32 || lock:u64 || input_count:u16 || output_count:u16`. */
function headerCore(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
): Uint8Array {
  return new ByteWriter()
    .writeUInt32LE(chain.transactionVersion)
    .writeUInt64LE(BigInt(tx.lock.kind) | (tx.lock.value << 8n))
    .writeUInt16LE(tx.inputs.length)
    .writeUInt16LE(tx.outputs.length)
    .finish()
}

/** The complete wire bytes. */
export function encodeLotusV2Transaction(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
): Uint8Array {
  validateShape(tx)
  return concatBytes([
    headerCore(chain, tx),
    ...tx.inputs.map(i => encodeLotusV2Input(i)),
    ...tx.outputs.map(encodeLotusV2Output),
  ])
}

function need<T>(
  result: { ok: true; value: T } | { ok: false },
  reason: string,
): T {
  check(result.ok, reason)
  return (result as { value: T }).value
}

function readCount(r: ByteReader, cap: number, reason: string): number {
  const v = need(r.readVarint(), reason)
  check(v <= BigInt(cap), reason)
  return Number(v)
}

function readWitness(r: ByteReader): LotusV2BranchWitness {
  const script = need(r.readBytesPrefixed(), 'script bytes')
  check(script.length <= MAX_SCRIPT_BYTES, 'script bytes')
  const siblingCount = readCount(r, MAX_PROOF_DEPTH, 'sibling count')
  const siblings: Uint8Array[] = []
  for (let i = 0; i < siblingCount; i += 1)
    siblings.push(need(r.read(32), 'siblings'))
  const argCount = readCount(r, MAX_ARGUMENTS, 'argument count')
  const args: Uint8Array[] = []
  for (let i = 0; i < argCount; i += 1) {
    const arg = need(r.readBytesPrefixed(), 'argument bytes')
    check(arg.length <= MAX_ARGUMENT_BYTES, 'argument bytes')
    args.push(arg)
  }
  return { script, siblings, arguments: args }
}

function readInput(r: ByteReader): LotusV2Input {
  const prevTxid = need(r.read(32), 'prev txid')
  const prevIndex = need(r.readUInt32LE(), 'prev index')
  const sequence = need(r.readUInt32LE(), 'sequence')
  const flags = need(r.readUInt8(), 'input flags')
  if (flags === 1) {
    const pathIndex = readCount(r, LOTUS_V2_MAX_OUTPUT_PATHS - 1, 'path index')
    const count = readCount(r, LOTUS_V2_MAX_OUTPUT_BRANCHES, 'witness count')
    const witnesses: LotusV2BranchWitness[] = []
    for (let i = 0; i < count; i += 1) witnesses.push(readWitness(r))
    return {
      kind: 'spend',
      prevTxid,
      prevIndex,
      sequence,
      pathIndex,
      witnesses,
    }
  }
  if (flags === 2) {
    const count = readCount(r, 1, 'coinbase count')
    const data =
      count === 1 ? need(r.readBytesPrefixed(), 'coinbase bytes') : undefined
    return {
      kind: 'coinbase',
      prevTxid,
      prevIndex,
      sequence,
      ...(data === undefined ? {} : { data }),
    }
  }
  if (flags === 3) {
    check(
      prevIndex === 0 && sequence === LOTUS_V2_SEQUENCE_FINAL,
      'mint pseudo-outpoint',
    )
    return { kind: 'mint', tokenId: prevTxid, witness: readWitness(r) }
  }
  throw new LotusV2FormatError('input flags')
}

function readOutput(r: ByteReader): LotusV2Output {
  const flags = need(r.readUInt8(), 'output prefix')
  check((flags & 0xf8) === 0, 'flags')
  const value = need(r.readUInt64LE(), 'output prefix')
  const tokenId =
    flags & FLAG_TOKEN ? need(r.read(32), 'output prefix') : undefined
  const stateRoot =
    flags & FLAG_STATE ? need(r.read(32), 'output prefix') : undefined
  const branchCount = readCount(
    r,
    LOTUS_V2_MAX_OUTPUT_BRANCHES,
    'output branches',
  )
  const branches: Uint8Array[] = []
  for (let i = 0; i < branchCount; i += 1)
    branches.push(need(r.read(32), 'output branches'))
  const pathCount = readCount(r, LOTUS_V2_MAX_OUTPUT_PATHS, 'output paths')
  const paths: number[][] = []
  for (let p = 0; p < pathCount; p += 1) {
    const length = readCount(
      r,
      LOTUS_V2_MAX_OUTPUT_BRANCHES,
      'output path length',
    )
    const path: number[] = []
    for (let i = 0; i < length; i += 1)
      path.push(
        readCount(r, LOTUS_V2_MAX_OUTPUT_BRANCHES - 1, 'output path index'),
      )
    paths.push(path)
  }
  const output: LotusV2Output = {
    value,
    ...(tokenId ? { tokenId } : {}),
    ...(stateRoot ? { stateRoot } : {}),
    ...(flags & FLAG_BURN ? { burn: true } : {}),
    branches,
    paths,
  }
  validateLotusV2Output(output)
  return output
}

/** Parse `Bytes(Output)` content exactly (no trailing bytes). */
export function decodeLotusV2Output(bytes: Uint8Array): LotusV2Output {
  const r = new ByteReader(bytes)
  const output = readOutput(r)
  check(r.finished(), 'output bytes')
  return output
}

/**
 * Strict parse of a complete transaction. Throws {@link LotusV2FormatError}
 * with lotusd's reason string. The result re-encodes to the same bytes.
 */
export function decodeLotusV2Transaction(
  chain: LotusV2ChainDescriptor,
  bytes: Uint8Array,
): LotusV2Transaction {
  const r = new ByteReader(bytes)
  const version = need(r.readUInt32LE(), 'version/lock')
  check(version === chain.transactionVersion, 'version/lock')
  const lockWord = need(r.readUInt64LE(), 'version/lock')
  const inputCount = need(r.readUInt16LE(), 'transaction count')
  const outputCount = need(r.readUInt16LE(), 'transaction count')
  check(
    inputCount >= 1 &&
      inputCount <= LOTUS_V2_MAX_INPUTS &&
      outputCount <= LOTUS_V2_MAX_OUTPUTS,
    'transaction count',
  )
  const inputs: LotusV2Input[] = []
  for (let i = 0; i < inputCount; i += 1) inputs.push(readInput(r))
  const outputs: LotusV2Output[] = []
  for (let i = 0; i < outputCount; i += 1) outputs.push(readOutput(r))
  check(r.finished(), 'trailing bytes')
  const kind = Number(lockWord & 0xffn)
  check(kind <= 2, 'transaction header')
  const tx: LotusV2Transaction = {
    lock: { kind: kind as 0 | 1 | 2, value: lockWord >> 8n },
    inputs,
    outputs,
  }
  // Re-encoding applies every encoder rule (shape, sequences, coinbase data
  // lengths) and proves the parse canonical.
  const again = encodeLotusV2Transaction(chain, tx)
  check(equalBytes(again, bytes), 'noncanonical encoding')
  return tx
}

export interface LotusV2Identities {
  /** `H_txid(ChainID || TxHeaderCore || InputsRoot || OutputsRoot)`: excludes witness arguments. */
  readonly txid: Uint8Array
  /** `H_txhash(ChainID || TxHeaderCore || FullInputsRoot || OutputsRoot)`: the complete transaction. */
  readonly txhash: Uint8Array
  readonly inputsRoot: Uint8Array
  readonly outputsRoot: Uint8Array
  /** `OutputLeaf(j) = H_output(Bytes(Output[j]))`. */
  readonly outputLeaves: readonly Uint8Array[]
}

function chainIdBytes(chain: LotusV2ChainDescriptor): Uint8Array {
  check(/^[0-9a-f]{64}$/.test(chain.chainId), 'chain id')
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1)
    out[i] = parseInt(chain.chainId.slice(2 * i, 2 * i + 2), 16)
  return out
}

/** @internal shared with the signing module. */
export function lotusV2ChainIdBytes(chain: LotusV2ChainDescriptor): Uint8Array {
  return chainIdBytes(chain)
}

/** @internal `TxHeaderCore`, shared with the signing module. */
export function lotusV2HeaderCore(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
): Uint8Array {
  return headerCore(chain, tx)
}

/** `OutputLeaf(j)`. */
export function lotusV2OutputLeaf(
  chain: LotusV2ChainDescriptor,
  output: LotusV2Output,
): Uint8Array {
  return lotusV2TaggedHash(
    chain,
    'output',
    lengthPrefixed(encodeLotusV2Output(output)),
  )
}

export function lotusV2TransactionIdentities(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
): LotusV2Identities {
  validateShape(tx)
  const chainId = chainIdBytes(chain)
  const header = headerCore(chain, tx)
  const inputsRoot = lotusV2IndexedTreeRoot(
    chain,
    tx.inputs.map(i =>
      lotusV2TaggedHash(chain, 'inputcore', encodeLotusV2Input(i, true)),
    ),
  )
  const fullInputsRoot = lotusV2IndexedTreeRoot(
    chain,
    tx.inputs.map(i =>
      lotusV2TaggedHash(chain, 'inputfull', encodeLotusV2Input(i)),
    ),
  )
  const outputLeaves = tx.outputs.map(o => lotusV2OutputLeaf(chain, o))
  const outputsRoot = lotusV2IndexedTreeRoot(chain, outputLeaves)
  return {
    txid: lotusV2TaggedHash(
      chain,
      'txid',
      concatBytes([chainId, header, inputsRoot, outputsRoot]),
    ),
    txhash: lotusV2TaggedHash(
      chain,
      'txhash',
      concatBytes([chainId, header, fullInputsRoot, outputsRoot]),
    ),
    inputsRoot,
    outputsRoot,
    outputLeaves,
  }
}
