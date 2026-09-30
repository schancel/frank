// Explicit signing. The caller names the input, the sighash type, and the
// algorithm. There is no default hash type. signAll refuses a partial
// assignment and does not return a transaction (decision 328). Script-path,
// annex, and lotus extension witnesses are unsupported, not silently dropped.

import { ripemd160 } from '@noble/hashes/ripemd160.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { copyBytes, isPlainBytes } from './bytes.js'
import type { ChainDescriptor } from './chain/types.js'
import {
  ecdsaSignatureFromBytes,
  schnorrSignatureFromBytes,
} from './constructors.js'
import {
  SIGHASH_DEFAULT,
  isTxError,
  sighash,
  type SighashAlgorithm,
  type SighashOptions,
  type SpentOutput,
  type Transaction,
  type TxFailure,
  type TxInput,
} from './transaction.js'

export type SignCode =
  | 'sign-sighash-required'
  | 'sign-algorithm-required'
  | 'sign-spent'
  | 'sign-index'
  | 'sign-assignment'
  | 'sign-pubkey-mismatch'
  | 'sign-script-unsupported'
  | 'sign-algorithm'
  | 'sign-signature'
  | 'sign-bytes'
  | 'sign-partial'

export interface InputStatus {
  readonly index: number
  readonly status: 'matched' | 'unassigned' | 'mismatch' | 'unsupported'
}

export type SignFailure =
  | {
      readonly code: SignCode
      readonly missing?: readonly number[]
      readonly inputs?: readonly InputStatus[]
    }
  | TxFailure

export type SignResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SignFailure }

export interface InputSigner {
  readonly publicKey: Uint8Array
  sign(digest: Uint8Array): Uint8Array
}

export interface SignOptions {
  readonly chain: ChainDescriptor
  readonly algorithm: SighashAlgorithm
  readonly sighashType: number
  readonly spent: readonly SpentOutput[]
  readonly commitUtxos?: boolean
  readonly annex?: Uint8Array
  readonly tapleafHash?: Uint8Array
  readonly keyVersion?: number
  readonly codeSeparatorPosition?: number
  readonly executedScriptHash?: Uint8Array
}

export interface SignAssignment {
  readonly inputIndex: number
  readonly signer: InputSigner
}

/** One named input. `unsigned` is every other index. This is not signAll. */
export interface SignedInput {
  readonly transaction: Transaction
  readonly inputIndex: number
  readonly scriptSig: Uint8Array
  readonly witness: readonly Uint8Array[] | null
  readonly unsigned: readonly number[]
}

export interface SignedOutput {
  readonly index: number
  readonly scriptSig: Uint8Array
  readonly witness: readonly Uint8Array[] | null
}

export interface SignedTransaction {
  readonly transaction: Transaction
  readonly inputs: readonly SignedOutput[]
}

const SIGN_CODES: readonly SignCode[] = [
  'sign-sighash-required',
  'sign-algorithm-required',
  'sign-spent',
  'sign-index',
  'sign-assignment',
  'sign-pubkey-mismatch',
  'sign-script-unsupported',
  'sign-algorithm',
  'sign-signature',
  'sign-bytes',
  'sign-partial',
]

const OP_DUP = 0x76
const OP_HASH160 = 0xa9
const OP_EQUALVERIFY = 0x88
const OP_CHECKSIG = 0xac
const OP_0 = 0x00
const OP_1 = 0x51

type Template =
  | {
      readonly kind: 'p2pkh'
      readonly hash: Uint8Array
      readonly scriptCode: Uint8Array
    }
  | {
      readonly kind: 'p2pk'
      readonly publicKey: Uint8Array
      readonly scriptCode: Uint8Array
    }
  | {
      readonly kind: 'p2wpkh'
      readonly hash: Uint8Array
      readonly scriptCode: Uint8Array
    }
  | { readonly kind: 'p2tr'; readonly outputKey: Uint8Array }

interface Prepared {
  readonly template: Template
  readonly sighashType: number
}

export function isSignError(value: unknown): value is SignFailure {
  if (isTxError(value)) return true
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && SIGN_CODES.some(item => item === code)
}

function fail(code: SignCode): SignResult<never> {
  return { ok: false, error: { code } }
}

function hash160(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(ripemd160(sha256(bytes)))
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function slice(script: Uint8Array, start: number, length: number): Uint8Array {
  return copyBytes(script.subarray(start, start + length))
}

function p2pkhScript(hash: Uint8Array): Uint8Array {
  const out = new Uint8Array(25)
  out[0] = OP_DUP
  out[1] = OP_HASH160
  out[2] = 20
  out.set(hash, 3)
  out[23] = OP_EQUALVERIFY
  out[24] = OP_CHECKSIG
  return out
}

function classify(script: Uint8Array): Template | undefined {
  if (
    script.length === 25 &&
    script[0] === OP_DUP &&
    script[1] === OP_HASH160 &&
    script[2] === 20 &&
    script[23] === OP_EQUALVERIFY &&
    script[24] === OP_CHECKSIG
  ) {
    return {
      kind: 'p2pkh',
      hash: slice(script, 3, 20),
      scriptCode: copyBytes(script),
    }
  }
  if (script.length === 35 && script[0] === 33 && script[34] === OP_CHECKSIG) {
    return {
      kind: 'p2pk',
      publicKey: slice(script, 1, 33),
      scriptCode: copyBytes(script),
    }
  }
  if (script.length === 67 && script[0] === 65 && script[66] === OP_CHECKSIG) {
    return {
      kind: 'p2pk',
      publicKey: slice(script, 1, 65),
      scriptCode: copyBytes(script),
    }
  }
  if (script.length === 22 && script[0] === OP_0 && script[1] === 20) {
    const hash = slice(script, 2, 20)
    return { kind: 'p2wpkh', hash, scriptCode: p2pkhScript(hash) }
  }
  if (script.length === 34 && script[0] === OP_1 && script[1] === 32) {
    return { kind: 'p2tr', outputKey: slice(script, 2, 32) }
  }
  return undefined
}

function keyMatches(template: Template, publicKey: Uint8Array): boolean {
  if (template.kind === 'p2pk') {
    const same = equalBytes(publicKey, template.publicKey)
    if (!same) return false
    return true
  }
  if (template.kind === 'p2tr') {
    if (publicKey.length !== 32) return false
    const same = equalBytes(publicKey, template.outputKey)
    if (!same) return false
    return true
  }
  if (template.kind === 'p2wpkh' && publicKey.length !== 33) return false
  if (
    template.kind === 'p2pkh' &&
    publicKey.length !== 33 &&
    publicKey.length !== 65
  ) {
    return false
  }
  const same = equalBytes(hash160(publicKey), template.hash)
  if (!same) return false
  return true
}

function algorithmFits(
  template: Template,
  algorithm: SighashAlgorithm,
): boolean {
  if (template.kind === 'p2wpkh') return algorithm === 'bip143'
  if (template.kind === 'p2tr') return algorithm === 'bip341'
  return (
    algorithm === 'legacy' || algorithm === 'forkid' || algorithm === 'lotus'
  )
}

function isAlgorithm(value: unknown): value is SighashAlgorithm {
  return (
    value === 'legacy' ||
    value === 'bip143' ||
    value === 'bip341' ||
    value === 'forkid' ||
    value === 'lotus'
  )
}

function requireContext(
  tx: Transaction,
  options: SignOptions,
): SignResult<{ readonly sighashType: number }> {
  if (
    options === undefined ||
    options === null ||
    typeof options !== 'object' ||
    options.chain === undefined ||
    options.chain === null ||
    typeof options.chain.family !== 'string'
  ) {
    return fail('sign-algorithm-required')
  }
  if (!isAlgorithm(options.algorithm)) return fail('sign-algorithm-required')
  const sighashType = options.sighashType
  if (
    typeof sighashType !== 'number' ||
    !Number.isInteger(sighashType) ||
    sighashType < 0 ||
    sighashType > 0xff
  ) {
    return fail('sign-sighash-required')
  }
  if (
    !Array.isArray(options.spent) ||
    options.spent.length !== tx.inputs.length
  ) {
    return fail('sign-spent')
  }
  if (
    options.annex !== undefined ||
    options.tapleafHash !== undefined ||
    options.executedScriptHash !== undefined ||
    options.keyVersion !== undefined ||
    options.codeSeparatorPosition !== undefined
  ) {
    return fail('sign-script-unsupported')
  }
  return { ok: true, value: { sighashType } }
}

function prepare(
  tx: Transaction,
  inputIndex: number,
  signer: InputSigner,
  options: SignOptions,
): SignResult<Prepared> {
  const context = requireContext(tx, options)
  if (!context.ok) return context
  if (
    !Number.isInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= tx.inputs.length
  ) {
    return fail('sign-index')
  }
  const coin = options.spent[inputIndex]
  if (
    coin === undefined ||
    typeof coin.value !== 'bigint' ||
    !isPlainBytes(coin.scriptPubKey)
  ) {
    return fail('sign-spent')
  }
  if (!isPlainBytes(signer.publicKey)) return fail('sign-bytes')
  const template = classify(coin.scriptPubKey)
  if (template === undefined) return fail('sign-script-unsupported')
  if (!algorithmFits(template, options.algorithm)) return fail('sign-algorithm')
  const publicKey = copyBytes(signer.publicKey)
  if (!keyMatches(template, publicKey)) return fail('sign-pubkey-mismatch')
  return {
    ok: true,
    value: { template, sighashType: context.value.sighashType },
  }
}

function push(data: Uint8Array): SignResult<Uint8Array> {
  if (data.length < 0x4c) {
    const out = new Uint8Array(1 + data.length)
    out[0] = data.length
    out.set(data, 1)
    return { ok: true, value: out }
  }
  if (data.length <= 0xff) {
    const out = new Uint8Array(2 + data.length)
    out[0] = 0x4c
    out[1] = data.length
    out.set(data, 2)
    return { ok: true, value: out }
  }
  return fail('sign-signature')
}

function encodePushes(parts: readonly Uint8Array[]): SignResult<Uint8Array> {
  const encoded: Uint8Array[] = []
  let length = 0
  for (const part of parts) {
    const item = push(part)
    if (!item.ok) return item
    encoded.push(item.value)
    length += item.value.length
  }
  const out = new Uint8Array(length)
  let offset = 0
  for (const item of encoded) {
    out.set(item, offset)
    offset += item.length
  }
  return { ok: true, value: out }
}

function signatureBytes(
  kind: 'ecdsa' | 'schnorr',
  raw: Uint8Array,
  sighashType: number,
): SignResult<Uint8Array> {
  if (!isPlainBytes(raw) || raw.length === 0) return fail('sign-signature')
  if (kind === 'schnorr') {
    const parsed = schnorrSignatureFromBytes(raw)
    if (!parsed.ok) return fail('sign-signature')
    if (sighashType === SIGHASH_DEFAULT)
      return { ok: true, value: parsed.value }
    const out = new Uint8Array(parsed.value.length + 1)
    out.set(parsed.value, 0)
    out[parsed.value.length] = sighashType
    return { ok: true, value: out }
  }
  const parsed = ecdsaSignatureFromBytes(raw)
  if (!parsed.ok) return fail('sign-signature')
  const out = new Uint8Array(parsed.value.length + 1)
  out.set(parsed.value, 0)
  out[parsed.value.length] = sighashType
  return { ok: true, value: out }
}

function hashOptions(
  template: Template,
  options: SignOptions,
  coin: SpentOutput,
): SighashOptions {
  const shared: SighashOptions = {
    algorithm: options.algorithm,
    spent: options.spent,
    ...(options.commitUtxos === undefined
      ? {}
      : { commitUtxos: options.commitUtxos }),
  }
  if (template.kind === 'p2tr') return shared
  return {
    ...shared,
    scriptCode: template.scriptCode,
    amount: coin.value,
  }
}

function replaceInput(
  tx: Transaction,
  index: number,
  scriptSig: Uint8Array,
  witness: readonly Uint8Array[] | null,
): Transaction {
  const inputs = tx.inputs.map((input, inputIndex) => {
    if (inputIndex !== index) return input
    return signedTxInput(input, scriptSig, witness)
  })
  return {
    version: tx.version,
    inputs,
    outputs: tx.outputs,
    locktime: tx.locktime,
  }
}

function signedTxInput(
  input: TxInput,
  scriptSig: Uint8Array,
  witness: readonly Uint8Array[] | null,
): TxInput {
  if (witness !== null) {
    return {
      prevout: input.prevout,
      sequence: input.sequence,
      scriptSig,
      witness,
    }
  }
  if (input.witness !== undefined) {
    return {
      prevout: input.prevout,
      sequence: input.sequence,
      scriptSig,
      witness: input.witness,
    }
  }
  return {
    prevout: input.prevout,
    sequence: input.sequence,
    scriptSig,
  }
}

function commit(
  tx: Transaction,
  inputIndex: number,
  signer: InputSigner,
  options: SignOptions,
  prepared: Prepared,
): SignResult<SignedInput> {
  const coin = options.spent[inputIndex]
  if (coin === undefined) return fail('sign-spent')
  const digest = sighash(
    tx,
    inputIndex,
    options.chain,
    prepared.sighashType,
    hashOptions(prepared.template, options, coin),
  )
  if (!digest.ok) return digest
  const raw = signer.sign(copyBytes(digest.value))
  const signature = signatureBytes(
    prepared.template.kind === 'p2tr' ? 'schnorr' : 'ecdsa',
    raw,
    prepared.sighashType,
  )
  if (!signature.ok) return signature
  const pubkey = copyBytes(signer.publicKey)
  let scriptSig: Uint8Array = new Uint8Array()
  let witness: readonly Uint8Array[] | null = null
  if (prepared.template.kind === 'p2pkh' || prepared.template.kind === 'p2pk') {
    const parts =
      prepared.template.kind === 'p2pkh'
        ? [signature.value, pubkey]
        : [signature.value]
    const encoded = encodePushes(parts)
    if (!encoded.ok) return encoded
    scriptSig = encoded.value
  } else if (prepared.template.kind === 'p2wpkh') {
    witness = [signature.value, pubkey]
  } else {
    witness = [signature.value]
  }
  const unsigned: number[] = []
  for (let index = 0; index < tx.inputs.length; index += 1) {
    if (index !== inputIndex) unsigned.push(index)
  }
  return {
    ok: true,
    value: {
      transaction: replaceInput(tx, inputIndex, scriptSig, witness),
      inputIndex,
      scriptSig,
      witness,
      unsigned,
    },
  }
}

export function signInput(
  tx: Transaction,
  inputIndex: number,
  signer: InputSigner,
  options: SignOptions,
): SignResult<SignedInput> {
  const ready = prepare(tx, inputIndex, signer, options)
  if (!ready.ok) return ready
  return commit(tx, inputIndex, signer, options, ready.value)
}

function statuses(
  count: number,
  matched: ReadonlySet<number>,
  mismatched: ReadonlySet<number>,
  unsupported: ReadonlySet<number>,
): { readonly missing: number[]; readonly inputs: InputStatus[] } {
  const missing: number[] = []
  const inputs: InputStatus[] = []
  for (let index = 0; index < count; index += 1) {
    if (matched.has(index)) {
      inputs.push({ index, status: 'matched' })
      continue
    }
    if (mismatched.has(index)) {
      inputs.push({ index, status: 'mismatch' })
      continue
    }
    if (unsupported.has(index)) {
      inputs.push({ index, status: 'unsupported' })
      continue
    }
    missing.push(index)
    inputs.push({ index, status: 'unassigned' })
  }
  return { missing, inputs }
}

export function signAll(
  tx: Transaction,
  assignments: readonly SignAssignment[],
  options: SignOptions,
): SignResult<SignedTransaction> {
  if (!Array.isArray(assignments)) return fail('sign-assignment')
  const seen = new Set<number>()
  for (const assignment of assignments) {
    if (
      assignment === null ||
      typeof assignment !== 'object' ||
      assignment.signer === undefined ||
      assignment.signer === null
    ) {
      return fail('sign-assignment')
    }
    const index = assignment.inputIndex
    if (!Number.isInteger(index) || index < 0 || index >= tx.inputs.length) {
      return fail('sign-index')
    }
    if (seen.has(index)) return fail('sign-assignment')
    seen.add(index)
  }
  const matched = new Map<number, SignAssignment>()
  const mismatched = new Set<number>()
  const unsupported = new Set<number>()
  for (const assignment of assignments) {
    const ready = prepare(tx, assignment.inputIndex, assignment.signer, options)
    if (!ready.ok) {
      if (ready.error.code === 'sign-pubkey-mismatch') {
        mismatched.add(assignment.inputIndex)
        continue
      }
      if (ready.error.code === 'sign-script-unsupported') {
        unsupported.add(assignment.inputIndex)
        continue
      }
      return ready
    }
    matched.set(assignment.inputIndex, assignment)
  }
  const coverage = statuses(
    tx.inputs.length,
    new Set(matched.keys()),
    mismatched,
    unsupported,
  )
  if (mismatched.size > 0) {
    return {
      ok: false,
      error: {
        code: 'sign-pubkey-mismatch',
        missing: coverage.missing,
        inputs: coverage.inputs,
      },
    }
  }
  if (unsupported.size > 0) {
    return {
      ok: false,
      error: {
        code: 'sign-script-unsupported',
        missing: coverage.missing,
        inputs: coverage.inputs,
      },
    }
  }
  if (coverage.missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'sign-partial',
        missing: coverage.missing,
        inputs: coverage.inputs,
      },
    }
  }
  let next = tx
  const inputs: SignedOutput[] = []
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const assignment = matched.get(index)
    if (assignment === undefined) return fail('sign-partial')
    const ready = prepare(next, index, assignment.signer, options)
    if (!ready.ok) return ready
    const signed = commit(next, index, assignment.signer, options, ready.value)
    if (!signed.ok) return signed
    next = signed.value.transaction
    inputs.push({
      index,
      scriptSig: signed.value.scriptSig,
      witness: signed.value.witness,
    })
  }
  return { ok: true, value: { transaction: next, inputs } }
}
