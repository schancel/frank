// Per-chain script. Rules come from the descriptor's named era, not from a
// default flag word of zero. Witness v0 is script-witness. Witness v1 (32
// bytes) is script-tapscript. Neither is a legacy success. Schnorr and
// CashToken codepoints fail closed. ECDSA digest checks use the in-tree
// curve; typed Schnorr stays on issue 249.

import { ripemd160 } from '@noble/hashes/ripemd160.js'
import { sha1 } from '@noble/hashes/sha1.js'
import { sha256 } from '@noble/hashes/sha256.js'

import { isPlainBytes } from './bytes.js'
import type { ChainDescriptor, ChainFamily } from './chain/types.js'
import { bytesToBigint } from './integer.js'
import { decodeScriptNum, encodeScriptNum } from './script-num.js'
import {
  SECP256K1_N,
  addPoints,
  multiplyGenerator,
  multiplyPoint,
  pointFromPublicKey,
  type AffinePoint,
} from './secp256k1.js'
import {
  sighash,
  type SighashAlgorithm,
  type SpentOutput,
  type Transaction,
} from './transaction.js'

export type ScriptCode =
  | 'script-false'
  | 'script-cleanstack'
  | 'script-push-size'
  | 'script-op-count'
  | 'script-stack-size'
  | 'script-invalid-stack'
  | 'script-disabled'
  | 'script-bad-opcode'
  | 'script-unbalanced'
  | 'script-minimal-data'
  | 'script-minimal-if'
  | 'script-verify'
  | 'script-return'
  | 'script-signature'
  | 'script-nullfail'
  | 'script-nulldummy'
  | 'script-locktime'
  | 'script-size'
  | 'script-split'
  | 'script-operand'
  | 'script-number'
  | 'script-div'
  | 'script-encoding'
  | 'script-tapscript'
  | 'script-witness'
  | 'script-schnorr'
  | 'script-token'
  | 'script-spent'
  | 'script-index'
  | 'script-push-only'
  | 'script-bytes'
  | 'script-discouraged'

export interface ScriptFailure {
  readonly code: ScriptCode
  readonly opcode?: number
}

export type ScriptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ScriptFailure }

export interface ScriptContext {
  readonly chain: ChainDescriptor
  readonly transaction?: Transaction
  readonly inputIndex?: number
  readonly spent?: readonly SpentOutput[]
}

const SCRIPT_CODES: readonly ScriptCode[] = [
  'script-false',
  'script-cleanstack',
  'script-push-size',
  'script-op-count',
  'script-stack-size',
  'script-invalid-stack',
  'script-disabled',
  'script-bad-opcode',
  'script-unbalanced',
  'script-minimal-data',
  'script-minimal-if',
  'script-verify',
  'script-return',
  'script-signature',
  'script-nullfail',
  'script-nulldummy',
  'script-locktime',
  'script-size',
  'script-split',
  'script-operand',
  'script-number',
  'script-div',
  'script-encoding',
  'script-tapscript',
  'script-witness',
  'script-schnorr',
  'script-token',
  'script-spent',
  'script-index',
  'script-push-only',
  'script-bytes',
  'script-discouraged',
]

const OP_PUSHDATA1 = 0x4c
const OP_PUSHDATA2 = 0x4d
const OP_PUSHDATA4 = 0x4e
const OP_1NEGATE = 0x4f
const OP_1 = 0x51
const OP_16 = 0x60
const OP_NOP = 0x61
const OP_IF = 0x63
const OP_NOTIF = 0x64
const OP_ELSE = 0x67
const OP_ENDIF = 0x68
const OP_VERIFY = 0x69
const OP_RETURN = 0x6a
const OP_TOALTSTACK = 0x6b
const OP_FROMALTSTACK = 0x6c
const OP_2DROP = 0x6d
const OP_2DUP = 0x6e
const OP_3DUP = 0x6f
const OP_2OVER = 0x70
const OP_2ROT = 0x71
const OP_2SWAP = 0x72
const OP_IFDUP = 0x73
const OP_DEPTH = 0x74
const OP_DROP = 0x75
const OP_DUP = 0x76
const OP_NIP = 0x77
const OP_OVER = 0x78
const OP_PICK = 0x79
const OP_ROLL = 0x7a
const OP_ROT = 0x7b
const OP_SWAP = 0x7c
const OP_TUCK = 0x7d
const OP_CAT = 0x7e
const OP_SPLIT = 0x7f
const OP_NUM2BIN = 0x80
const OP_BIN2NUM = 0x81
const OP_SIZE = 0x82
const OP_INVERT = 0x83
const OP_AND = 0x84
const OP_OR = 0x85
const OP_XOR = 0x86
const OP_EQUAL = 0x87
const OP_EQUALVERIFY = 0x88
const OP_1ADD = 0x8b
const OP_1SUB = 0x8c
const OP_2MUL = 0x8d
const OP_2DIV = 0x8e
const OP_NEGATE = 0x8f
const OP_ABS = 0x90
const OP_NOT = 0x91
const OP_0NOTEQUAL = 0x92
const OP_ADD = 0x93
const OP_SUB = 0x94
const OP_MUL = 0x95
const OP_DIV = 0x96
const OP_MOD = 0x97
const OP_LSHIFT = 0x98
const OP_RSHIFT = 0x99
const OP_BOOLAND = 0x9a
const OP_BOOLOR = 0x9b
const OP_NUMEQUAL = 0x9c
const OP_NUMEQUALVERIFY = 0x9d
const OP_NUMNOTEQUAL = 0x9e
const OP_LESSTHAN = 0x9f
const OP_GREATERTHAN = 0xa0
const OP_LESSTHANOREQUAL = 0xa1
const OP_GREATERTHANOREQUAL = 0xa2
const OP_MIN = 0xa3
const OP_MAX = 0xa4
const OP_WITHIN = 0xa5
const OP_RIPEMD160 = 0xa6
const OP_SHA1 = 0xa7
const OP_SHA256 = 0xa8
const OP_HASH160 = 0xa9
const OP_HASH256 = 0xaa
const OP_CODESEPARATOR = 0xab
const OP_CHECKSIG = 0xac
const OP_CHECKSIGVERIFY = 0xad
const OP_CHECKMULTISIG = 0xae
const OP_CHECKMULTISIGVERIFY = 0xaf
const OP_NOP1 = 0xb0
const OP_CHECKLOCKTIMEVERIFY = 0xb1
const OP_CHECKSEQUENCEVERIFY = 0xb2
const OP_NOP4 = 0xb3
const OP_NOP5 = 0xb4
const OP_NOP6 = 0xb5
const OP_NOP7 = 0xb6
const OP_NOP8 = 0xb7
const OP_NOP9 = 0xb8
const OP_NOP10 = 0xb9
const OP_CHECKDATASIG = 0xba
const OP_CHECKDATASIGVERIFY = 0xbb
const OP_REVERSEBYTES = 0xbc
const OP_INPUTINDEX = 0xc0
const OP_ACTIVEBYTECODE = 0xc1
const OP_TXVERSION = 0xc2
const OP_TXINPUTCOUNT = 0xc3
const OP_TXOUTPUTCOUNT = 0xc4
const OP_TXLOCKTIME = 0xc5
const OP_UTXOVALUE = 0xc6
const OP_UTXOBYTECODE = 0xc7
const OP_OUTPOINTTXHASH = 0xc8
const OP_OUTPOINTINDEX = 0xc9
const OP_INPUTBYTECODE = 0xca
const OP_INPUTSEQUENCENUMBER = 0xcb
const OP_OUTPUTVALUE = 0xcc
const OP_OUTPUTBYTECODE = 0xcd

const LOCKTIME_THRESHOLD = 500_000_000n
const SEQUENCE_DISABLE = 1n << 31n
const SEQUENCE_TYPE = 1n << 22n
const SEQUENCE_MASK = 0xffffn
interface Op {
  readonly opcode: number
  readonly data: Uint8Array | null
  readonly next: number
}

interface Machine {
  readonly script: Uint8Array
  readonly context: ScriptContext
  readonly stack: Uint8Array[]
  readonly alt: Uint8Array[]
  readonly cond: boolean[]
  codeSep: number
  separated: boolean
  opCount: number
  pc: number
}

export function isScriptError(value: unknown): value is ScriptFailure {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && SCRIPT_CODES.includes(code as ScriptCode)
}

export function evaluateScript(
  script: Uint8Array,
  context: ScriptContext,
  initial?: readonly Uint8Array[],
): ScriptResult<Uint8Array[]> {
  if (!isPlainBytes(script)) return reject('script-bytes')
  const rules = context.chain.script
  if (script.length > rules.maxScriptBytes) return reject('script-size')
  const stack: Uint8Array[] = []
  if (initial !== undefined) {
    for (const item of initial) {
      if (!isPlainBytes(item)) return reject('script-bytes')
      stack.push(item.slice())
    }
  }
  const machine: Machine = {
    script,
    context,
    stack,
    alt: [],
    cond: [],
    codeSep: 0,
    separated: false,
    opCount: 0,
    pc: 0,
  }
  if (stack.length > rules.maxStackItems) return reject('script-stack-size')
  let pc = 0
  while (pc < script.length) {
    const op = readOp(script, pc)
    if (op === null) return reject('script-encoding')
    pc = op.next
    machine.pc = pc
    if (op.data !== null && op.data.length > rules.maxElementBytes) {
      return reject('script-push-size', op.opcode)
    }
    if (op.opcode > OP_16) {
      machine.opCount += 1
      if (machine.opCount > rules.maxOps) {
        return reject('script-op-count', op.opcode)
      }
    }
    if (isDisabled(op.opcode, rules)) {
      return reject('script-disabled', op.opcode)
    }
    const exec = machine.cond.every(Boolean)
    if (exec && op.opcode <= OP_PUSHDATA4) {
      if (rules.minimalData && !isMinimalPush(op)) {
        return reject('script-minimal-data', op.opcode)
      }
      stack.push(op.data === null ? new Uint8Array(0) : op.data.slice())
    } else if (exec || (op.opcode >= OP_IF && op.opcode <= OP_ENDIF)) {
      const error = apply(machine, op.opcode, exec)
      if (error) return { ok: false, error }
    }
    if (stack.length + machine.alt.length > rules.maxStackItems) {
      return reject('script-stack-size', op.opcode)
    }
  }
  if (machine.cond.length !== 0) return reject('script-unbalanced')
  return { ok: true, value: stack }
}

export function verifyScript(
  unlocking: Uint8Array,
  locking: Uint8Array,
  context: ScriptContext,
): ScriptResult<true> {
  if (!isPlainBytes(unlocking) || !isPlainBytes(locking)) {
    return reject('script-bytes')
  }
  const rules = context.chain.script
  const witness = witnessKind(locking)
  if (witness) return reject(witness)
  if (rules.sigPushOnly && !isPushOnly(unlocking)) {
    return reject('script-push-only')
  }
  const unlocked = evaluateScript(unlocking, context)
  if (!unlocked.ok) return unlocked
  const locked = evaluateScript(locking, context, unlocked.value)
  if (!locked.ok) return locked
  if (!topTrue(locked.value)) return reject('script-false')
  let finalStack = locked.value
  if (rules.p2sh && isP2sh(locking)) {
    if (!isPushOnly(unlocking)) return reject('script-push-only')
    const saved = unlocked.value.map(item => item.slice())
    const redeem = saved.pop()
    if (redeem === undefined) return reject('script-invalid-stack')
    const nested = witnessKind(redeem)
    if (nested) return reject(nested)
    const redeemed = evaluateScript(redeem, context, saved)
    if (!redeemed.ok) return redeemed
    if (!topTrue(redeemed.value)) return reject('script-false')
    finalStack = redeemed.value
  }
  if (rules.cleanStack) {
    if (!rules.p2sh || finalStack.length !== 1)
      return reject('script-cleanstack')
  }
  return { ok: true, value: true }
}

function reject(code: ScriptCode, opcode?: number): ScriptResult<never> {
  return {
    ok: false,
    error: opcode === undefined ? { code } : { code, opcode },
  }
}

function failure(code: ScriptCode, opcode?: number): ScriptFailure {
  return opcode === undefined ? { code } : { code, opcode }
}

function isDisabled(opcode: number, rules: ChainDescriptor['script']): boolean {
  switch (opcode) {
    case OP_CAT:
    case OP_SPLIT:
      return !rules.cat
    case OP_NUM2BIN:
    case OP_BIN2NUM:
      return !rules.num2bin
    case OP_AND:
    case OP_OR:
    case OP_XOR:
      return !rules.bitwise
    case OP_DIV:
    case OP_MOD:
      return !rules.divMod
    case OP_INVERT:
    case OP_2MUL:
    case OP_2DIV:
    case OP_MUL:
    case OP_LSHIFT:
    case OP_RSHIFT:
      return true
    default:
      return false
  }
}

function readOp(script: Uint8Array, pc: number): Op | null {
  if (pc >= script.length) return null
  const opcode = script[pc] ?? 0
  if (opcode === 0) return { opcode, data: new Uint8Array(0), next: pc + 1 }
  if (opcode < OP_PUSHDATA1) {
    if (pc + 1 + opcode > script.length) return null
    return {
      opcode,
      data: script.slice(pc + 1, pc + 1 + opcode),
      next: pc + 1 + opcode,
    }
  }
  if (
    opcode === OP_PUSHDATA1 ||
    opcode === OP_PUSHDATA2 ||
    opcode === OP_PUSHDATA4
  ) {
    const width = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : 4
    if (pc + 1 + width > script.length) return null
    let length = 0
    let scale = 1
    for (let byte = 0; byte < width; byte += 1) {
      length += (script[pc + 1 + byte] ?? 0) * scale
      scale *= 256
    }
    const start = pc + 1 + width
    if (start + length > script.length) return null
    return {
      opcode,
      data: script.slice(start, start + length),
      next: start + length,
    }
  }
  return { opcode, data: null, next: pc + 1 }
}

function isMinimalPush(op: Op): boolean {
  const data = op.data ?? new Uint8Array(0)
  if (op.opcode === 0) return true
  if (op.opcode < OP_PUSHDATA1) {
    if (data.length === 1) {
      const byte = data[0] ?? 0
      if (byte === 0x81 || (byte >= 1 && byte <= 16)) return false
    }
    return true
  }
  if (op.opcode === OP_PUSHDATA1) return data.length >= 76
  if (op.opcode === OP_PUSHDATA2) return data.length > 255
  return data.length > 65535
}

function isPushOnly(script: Uint8Array): boolean {
  let pc = 0
  while (pc < script.length) {
    const op = readOp(script, pc)
    if (op === null || op.opcode > OP_16) return false
    pc = op.next
  }
  return true
}

function isP2sh(script: Uint8Array): boolean {
  return (
    script.length === 23 &&
    script[0] === OP_HASH160 &&
    script[1] === 20 &&
    script[22] === OP_EQUAL
  )
}

function witnessKind(script: Uint8Array): ScriptCode | null {
  if (script.length < 4 || script.length > 42) return null
  const versionByte = script[0] ?? 0xff
  let version = -1
  if (versionByte === 0) version = 0
  else if (versionByte >= OP_1 && versionByte <= OP_16) {
    version = versionByte - (OP_1 - 1)
  } else return null
  const program = script[1] ?? 0
  if (program !== script.length - 2 || program < 2 || program > 40) return null
  if (version === 1 && program === 32) return 'script-tapscript'
  return 'script-witness'
}

function castToBool(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0
    if (byte !== 0) {
      if (index === bytes.length - 1 && byte === 0x80) return false
      return true
    }
  }
  return false
}

function topTrue(stack: readonly Uint8Array[]): boolean {
  const top = stack[stack.length - 1]
  return top !== undefined && castToBool(top)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function pushBool(stack: Uint8Array[], value: boolean): void {
  stack.push(value ? Uint8Array.of(1) : new Uint8Array(0))
}

function readNum(
  bytes: Uint8Array,
  rules: ChainDescriptor['script'],
  opcode: number,
  maxBytes?: number,
): { ok: true; value: bigint } | { ok: false; error: ScriptFailure } {
  const decoded = decodeScriptNum(bytes, {
    requireMinimal: rules.minimalData,
    maxBytes: maxBytes ?? rules.maxScriptNumBytes,
  })
  if (!decoded.ok) return { ok: false, error: failure('script-number', opcode) }
  return decoded
}

function finishNum(
  value: bigint,
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | Uint8Array {
  const encoded = encodeScriptNum(value)
  if (encoded.length > rules.maxScriptNumBytes) {
    return failure('script-number', opcode)
  }
  return encoded
}

function pushInt(
  stack: Uint8Array[],
  value: bigint,
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const encoded = encodeScriptNum(value)
  if (encoded.length > rules.maxElementBytes) {
    return failure('script-push-size', opcode)
  }
  stack.push(encoded)
  return null
}

function need(
  stack: readonly Uint8Array[],
  count: number,
  opcode: number,
): ScriptFailure | null {
  if (stack.length < count) return failure('script-invalid-stack', opcode)
  return null
}

function apply(
  machine: Machine,
  opcode: number,
  exec: boolean,
): ScriptFailure | null {
  const { stack, alt, cond } = machine
  const rules = machine.context.chain.script
  switch (opcode) {
    case OP_1NEGATE:
      stack.push(encodeScriptNum(-1n))
      return null
    case OP_1:
    case 0x52:
    case 0x53:
    case 0x54:
    case 0x55:
    case 0x56:
    case 0x57:
    case 0x58:
    case 0x59:
    case 0x5a:
    case 0x5b:
    case 0x5c:
    case 0x5d:
    case 0x5e:
    case 0x5f:
    case OP_16:
      stack.push(encodeScriptNum(BigInt(opcode - (OP_1 - 1))))
      return null
    case OP_NOP:
      return null
    case OP_IF:
    case OP_NOTIF: {
      let flag = false
      if (exec) {
        const top = stack.pop()
        if (top === undefined) return failure('script-unbalanced', opcode)
        if (rules.minimalIf) {
          if (top.length > 1) return failure('script-minimal-if', opcode)
          if (top.length === 1 && top[0] !== 1) {
            return failure('script-minimal-if', opcode)
          }
        }
        flag = castToBool(top)
        if (opcode === OP_NOTIF) flag = !flag
      }
      cond.push(flag)
      return null
    }
    case OP_ELSE: {
      if (cond.length === 0) return failure('script-unbalanced', opcode)
      const last = cond.length - 1
      cond[last] = !cond[last]
      return null
    }
    case OP_ENDIF:
      if (cond.length === 0) return failure('script-unbalanced', opcode)
      cond.pop()
      return null
    case OP_VERIFY: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      const top = stack[stack.length - 1] ?? new Uint8Array(0)
      if (!castToBool(top)) return failure('script-verify', opcode)
      stack.pop()
      return null
    }
    case OP_RETURN:
      return failure('script-return', opcode)
    case OP_TOALTSTACK: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      const top = stack.pop()
      if (top) alt.push(top)
      return null
    }
    case OP_FROMALTSTACK: {
      const top = alt.pop()
      if (top === undefined) return failure('script-invalid-stack', opcode)
      stack.push(top)
      return null
    }
    case OP_2DROP: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      stack.pop()
      stack.pop()
      return null
    }
    case OP_2DUP: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      const first = stack[stack.length - 2]
      const second = stack[stack.length - 1]
      if (first === undefined || second === undefined) {
        return failure('script-invalid-stack', opcode)
      }
      stack.push(first.slice(), second.slice())
      return null
    }
    case OP_3DUP: {
      const missing = need(stack, 3, opcode)
      if (missing) return missing
      const first = stack[stack.length - 3]
      const second = stack[stack.length - 2]
      const third = stack[stack.length - 1]
      if (first === undefined || second === undefined || third === undefined) {
        return failure('script-invalid-stack', opcode)
      }
      stack.push(first.slice(), second.slice(), third.slice())
      return null
    }
    case OP_2OVER: {
      const missing = need(stack, 4, opcode)
      if (missing) return missing
      const first = stack[stack.length - 4]
      const second = stack[stack.length - 3]
      if (first === undefined || second === undefined) {
        return failure('script-invalid-stack', opcode)
      }
      stack.push(first.slice(), second.slice())
      return null
    }
    case OP_2ROT: {
      const missing = need(stack, 6, opcode)
      if (missing) return missing
      const pair = stack.splice(stack.length - 6, 2)
      stack.push(...pair)
      return null
    }
    case OP_2SWAP: {
      const missing = need(stack, 4, opcode)
      if (missing) return missing
      const pair = stack.splice(stack.length - 4, 2)
      stack.push(...pair)
      return null
    }
    case OP_IFDUP: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      const top = stack[stack.length - 1]
      if (top && castToBool(top)) stack.push(top.slice())
      return null
    }
    case OP_DEPTH:
      return pushInt(stack, BigInt(stack.length), rules, opcode)
    case OP_DROP: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      stack.pop()
      return null
    }
    case OP_DUP: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      const top = stack[stack.length - 1]
      if (top) stack.push(top.slice())
      return null
    }
    case OP_NIP: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      stack.splice(stack.length - 2, 1)
      return null
    }
    case OP_OVER: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      const item = stack[stack.length - 2]
      if (item) stack.push(item.slice())
      return null
    }
    case OP_PICK:
    case OP_ROLL:
      return pick(stack, rules, opcode, opcode === OP_ROLL)
    case OP_ROT: {
      const missing = need(stack, 3, opcode)
      if (missing) return missing
      const third = stack[stack.length - 3]
      const second = stack[stack.length - 2]
      const first = stack[stack.length - 1]
      if (third === undefined || second === undefined || first === undefined) {
        return failure('script-invalid-stack', opcode)
      }
      stack[stack.length - 3] = second
      stack[stack.length - 2] = first
      stack[stack.length - 1] = third
      return null
    }
    case OP_SWAP: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      const second = stack[stack.length - 2]
      const first = stack[stack.length - 1]
      if (second === undefined || first === undefined) {
        return failure('script-invalid-stack', opcode)
      }
      stack[stack.length - 2] = first
      stack[stack.length - 1] = second
      return null
    }
    case OP_TUCK: {
      const missing = need(stack, 2, opcode)
      if (missing) return missing
      const top = stack[stack.length - 1]
      if (top) stack.splice(stack.length - 2, 0, top.slice())
      return null
    }
    case OP_SIZE: {
      const missing = need(stack, 1, opcode)
      if (missing) return missing
      const top = stack[stack.length - 1]
      return pushInt(stack, BigInt(top?.length ?? 0), rules, opcode)
    }
    case OP_AND:
    case OP_OR:
    case OP_XOR:
      return bitwise(stack, opcode)
    case OP_EQUAL:
    case OP_EQUALVERIFY:
      return equal(stack, opcode, opcode === OP_EQUALVERIFY)
    case OP_1ADD:
    case OP_1SUB:
    case OP_NEGATE:
    case OP_ABS:
    case OP_NOT:
    case OP_0NOTEQUAL:
      return unary(stack, rules, opcode)
    case OP_ADD:
    case OP_SUB:
    case OP_DIV:
    case OP_MOD:
    case OP_BOOLAND:
    case OP_BOOLOR:
    case OP_NUMEQUAL:
    case OP_NUMEQUALVERIFY:
    case OP_NUMNOTEQUAL:
    case OP_LESSTHAN:
    case OP_GREATERTHAN:
    case OP_LESSTHANOREQUAL:
    case OP_GREATERTHANOREQUAL:
    case OP_MIN:
    case OP_MAX:
      return binary(stack, rules, opcode)
    case OP_WITHIN:
      return within(stack, rules, opcode)
    case OP_RIPEMD160:
    case OP_SHA1:
    case OP_SHA256:
    case OP_HASH160:
    case OP_HASH256:
      return hashOp(stack, opcode)
    case OP_CODESEPARATOR:
      machine.separated = true
      machine.codeSep = machine.pc
      return null
    case OP_CHECKSIG:
    case OP_CHECKSIGVERIFY:
      return checkSig(machine, opcode, opcode === OP_CHECKSIGVERIFY)
    case OP_CHECKMULTISIG:
    case OP_CHECKMULTISIGVERIFY:
      return checkMultisig(machine, opcode, opcode === OP_CHECKMULTISIGVERIFY)
    case OP_NOP1:
    case OP_NOP4:
    case OP_NOP5:
    case OP_NOP6:
    case OP_NOP7:
    case OP_NOP8:
    case OP_NOP9:
    case OP_NOP10:
      if (rules.discourageNops) return failure('script-discouraged', opcode)
      return null
    case OP_CHECKLOCKTIMEVERIFY:
      return lockTime(machine, opcode)
    case OP_CHECKSEQUENCEVERIFY:
      return sequenceTime(machine, opcode)
    case OP_CAT:
      return cat(stack, rules, opcode)
    case OP_SPLIT:
      return split(stack, rules, opcode)
    case OP_NUM2BIN:
      return num2bin(stack, rules, opcode)
    case OP_BIN2NUM:
      return bin2num(stack, rules, opcode)
    case OP_CHECKDATASIG:
      if (!rules.checkDataSig) return failure('script-tapscript', opcode)
      return checkDataSig(machine, opcode, false)
    case OP_CHECKDATASIGVERIFY:
      if (!rules.checkDataSig) return failure('script-bad-opcode', opcode)
      return checkDataSig(machine, opcode, true)
    case OP_REVERSEBYTES:
      if (!rules.reverseBytes) return failure('script-bad-opcode', opcode)
      return reverse(stack, opcode)
    case OP_INPUTINDEX:
    case OP_ACTIVEBYTECODE:
    case OP_TXVERSION:
    case OP_TXINPUTCOUNT:
    case OP_TXOUTPUTCOUNT:
    case OP_TXLOCKTIME:
    case OP_UTXOVALUE:
    case OP_UTXOBYTECODE:
    case OP_OUTPOINTTXHASH:
    case OP_OUTPOINTINDEX:
    case OP_INPUTBYTECODE:
    case OP_INPUTSEQUENCENUMBER:
    case OP_OUTPUTVALUE:
    case OP_OUTPUTBYTECODE:
      if (!rules.introspection) return failure('script-bad-opcode', opcode)
      return introspect(machine, opcode)
    default:
      // OP_VERIF and OP_VERNOTIF sit in the IF window, so this runs even in a
      // dead branch. OP_VER and OP_RESERVED reach here only when executed.
      if (opcode >= 0xce && opcode <= 0xd3) {
        if (rules.introspection) return failure('script-token', opcode)
        return failure('script-disabled', opcode)
      }
      return failure('script-bad-opcode', opcode)
  }
}

function pick(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
  roll: boolean,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const top = stack.pop()
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const index = readNum(top, rules, opcode)
  if (!index.ok) return index.error
  if (index.value < 0n || index.value >= BigInt(stack.length)) {
    return failure('script-invalid-stack', opcode)
  }
  const at = stack.length - 1 - Number(index.value)
  const item = stack[at]
  if (item === undefined) return failure('script-invalid-stack', opcode)
  if (roll) stack.splice(at, 1)
  stack.push(roll ? item : item.slice())
  return null
}

function bitwise(stack: Uint8Array[], opcode: number): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const right = stack.pop()
  const left = stack[stack.length - 1]
  if (right === undefined || left === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  if (left.length !== right.length) return failure('script-operand', opcode)
  const out = new Uint8Array(left.length)
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (opcode === OP_AND) out[index] = a & b
    else if (opcode === OP_OR) out[index] = a | b
    else out[index] = a ^ b
  }
  stack[stack.length - 1] = out
  return null
}

function equal(
  stack: Uint8Array[],
  opcode: number,
  verify: boolean,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const right = stack.pop()
  const left = stack.pop()
  if (right === undefined || left === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  const matched = sameBytes(left, right)
  pushBool(stack, matched)
  if (verify) {
    if (!matched) return failure('script-verify', opcode)
    stack.pop()
  }
  return null
}

function unary(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 1, opcode)
  if (missing) return missing
  const top = stack.pop()
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const decoded = readNum(top, rules, opcode)
  if (!decoded.ok) return decoded.error
  let value = decoded.value
  if (opcode === OP_1ADD) value += 1n
  else if (opcode === OP_1SUB) value -= 1n
  else if (opcode === OP_NEGATE) value = -value
  else if (opcode === OP_ABS) value = value < 0n ? -value : value
  else if (opcode === OP_NOT) value = value === 0n ? 1n : 0n
  else value = value === 0n ? 0n : 1n
  const encoded = finishNum(value, rules, opcode)
  if (!(encoded instanceof Uint8Array)) return encoded
  stack.push(encoded)
  return null
}

function binary(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const rightBytes = stack.pop()
  const leftBytes = stack.pop()
  if (rightBytes === undefined || leftBytes === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  const left = readNum(leftBytes, rules, opcode)
  if (!left.ok) return left.error
  const right = readNum(rightBytes, rules, opcode)
  if (!right.ok) return right.error
  let value = 0n
  if (opcode === OP_ADD) value = left.value + right.value
  else if (opcode === OP_SUB) value = left.value - right.value
  else if (opcode === OP_DIV || opcode === OP_MOD) {
    if (right.value === 0n) return failure('script-div', opcode)
    value =
      opcode === OP_DIV ? left.value / right.value : left.value % right.value
  } else if (opcode === OP_BOOLAND) {
    value = left.value !== 0n && right.value !== 0n ? 1n : 0n
  } else if (opcode === OP_BOOLOR) {
    value = left.value !== 0n || right.value !== 0n ? 1n : 0n
  } else if (opcode === OP_NUMEQUAL || opcode === OP_NUMEQUALVERIFY) {
    value = left.value === right.value ? 1n : 0n
  } else if (opcode === OP_NUMNOTEQUAL) {
    value = left.value !== right.value ? 1n : 0n
  } else if (opcode === OP_LESSTHAN) value = left.value < right.value ? 1n : 0n
  else if (opcode === OP_GREATERTHAN) {
    value = left.value > right.value ? 1n : 0n
  } else if (opcode === OP_LESSTHANOREQUAL) {
    value = left.value <= right.value ? 1n : 0n
  } else if (opcode === OP_GREATERTHANOREQUAL) {
    value = left.value >= right.value ? 1n : 0n
  } else if (opcode === OP_MIN) {
    value = left.value < right.value ? left.value : right.value
  } else value = left.value > right.value ? left.value : right.value
  const encoded = finishNum(value, rules, opcode)
  if (!(encoded instanceof Uint8Array)) return encoded
  stack.push(encoded)
  if (opcode === OP_NUMEQUALVERIFY) {
    if (value === 0n) return failure('script-verify', opcode)
    stack.pop()
  }
  return null
}

function within(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 3, opcode)
  if (missing) return missing
  const maxBytes = stack.pop()
  const minBytes = stack.pop()
  const valueBytes = stack.pop()
  if (
    maxBytes === undefined ||
    minBytes === undefined ||
    valueBytes === undefined
  ) {
    return failure('script-invalid-stack', opcode)
  }
  const value = readNum(valueBytes, rules, opcode)
  if (!value.ok) return value.error
  const min = readNum(minBytes, rules, opcode)
  if (!min.ok) return min.error
  const max = readNum(maxBytes, rules, opcode)
  if (!max.ok) return max.error
  pushBool(stack, min.value <= value.value && value.value < max.value)
  return null
}

function hashOp(stack: Uint8Array[], opcode: number): ScriptFailure | null {
  const missing = need(stack, 1, opcode)
  if (missing) return missing
  const top = stack.pop()
  if (top === undefined) return failure('script-invalid-stack', opcode)
  let hashed: Uint8Array
  if (opcode === OP_RIPEMD160) hashed = ripemd160(top)
  else if (opcode === OP_SHA1) hashed = sha1(top)
  else if (opcode === OP_SHA256) hashed = sha256(top)
  else if (opcode === OP_HASH160) hashed = ripemd160(sha256(top))
  else hashed = sha256(sha256(top))
  stack.push(hashed)
  return null
}

function cat(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const right = stack.pop()
  const left = stack[stack.length - 1]
  if (right === undefined || left === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  if (left.length + right.length > rules.maxElementBytes) {
    return failure('script-push-size', opcode)
  }
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  stack[stack.length - 1] = out
  return null
}

function split(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const positionBytes = stack.pop()
  const value = stack[stack.length - 1]
  if (positionBytes === undefined || value === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  const position = readNum(positionBytes, rules, opcode)
  if (!position.ok) return position.error
  if (position.value < 0n || position.value > BigInt(value.length)) {
    return failure('script-split', opcode)
  }
  const at = Number(position.value)
  stack[stack.length - 1] = value.slice(0, at)
  stack.push(value.slice(at))
  return null
}

function minimallyEncode(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0) return new Uint8Array(0)
  const last = bytes[bytes.length - 1] ?? 0
  if ((last & 0x7f) !== 0) return bytes.slice()
  if (bytes.length === 1) return new Uint8Array(0)
  if (((bytes[bytes.length - 2] ?? 0) & 0x80) !== 0) return bytes.slice()
  const buf = bytes.slice()
  for (let index = buf.length - 1; index > 0; index -= 1) {
    const previous = buf[index - 1] ?? 0
    if (previous !== 0) {
      if ((previous & 0x80) !== 0) {
        buf[index] = last
        return buf.slice(0, index + 1)
      }
      buf[index - 1] = previous | last
      return buf.slice(0, index)
    }
  }
  return new Uint8Array(0)
}

function num2bin(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 2, opcode)
  if (missing) return missing
  const sizeBytes = stack.pop()
  const raw = stack[stack.length - 1]
  if (sizeBytes === undefined || raw === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  const size = readNum(sizeBytes, rules, opcode)
  if (!size.ok) return size.error
  if (size.value < 0n || size.value > BigInt(rules.maxElementBytes)) {
    return failure(
      size.value > BigInt(rules.maxElementBytes)
        ? 'script-push-size'
        : 'script-encoding',
      opcode,
    )
  }
  const width = Number(size.value)
  const minimal = minimallyEncode(raw)
  if (minimal.length > width) return failure('script-encoding', opcode)
  if (minimal.length === width) {
    stack[stack.length - 1] = minimal
    return null
  }
  const out = new Uint8Array(width)
  const body = minimal.slice()
  let sign = 0
  if (body.length > 0) {
    sign = (body[body.length - 1] ?? 0) & 0x80
    body[body.length - 1] = (body[body.length - 1] ?? 0) & 0x7f
    out.set(body, 0)
  }
  let cursor = body.length - 1
  while (cursor < width - 2) {
    cursor += 1
    out[cursor] = 0
  }
  cursor += 1
  out[cursor] = sign
  stack[stack.length - 1] = out
  return null
}

function bin2num(
  stack: Uint8Array[],
  rules: ChainDescriptor['script'],
  opcode: number,
): ScriptFailure | null {
  const missing = need(stack, 1, opcode)
  if (missing) return missing
  const top = stack[stack.length - 1]
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const minimal = minimallyEncode(top)
  if (minimal.length > rules.maxScriptNumBytes) {
    return failure('script-number', opcode)
  }
  stack[stack.length - 1] = minimal
  return null
}

function reverse(stack: Uint8Array[], opcode: number): ScriptFailure | null {
  const missing = need(stack, 1, opcode)
  if (missing) return missing
  const top = stack[stack.length - 1]
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const out = new Uint8Array(top.length)
  for (let index = 0; index < top.length; index += 1) {
    out[index] = top[top.length - 1 - index] ?? 0
  }
  stack[stack.length - 1] = out
  return null
}

function lockTime(machine: Machine, opcode: number): ScriptFailure | null {
  const rules = machine.context.chain.script
  if (!rules.checkLockTime) {
    if (rules.discourageNops) return failure('script-discouraged', opcode)
    return null
  }
  const missing = need(machine.stack, 1, opcode)
  if (missing) return missing
  const top = machine.stack[machine.stack.length - 1]
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const value = readNum(top, rules, opcode, 5)
  if (!value.ok) return value.error
  if (value.value < 0n) return failure('script-locktime', opcode)
  const tx = requireTx(machine, opcode)
  if (tx === null || (typeof tx === 'object' && 'code' in tx)) {
    return tx === null ? failure('script-spent', opcode) : tx
  }
  const lock = BigInt(tx.locktime >>> 0)
  const valueHeight = value.value < LOCKTIME_THRESHOLD
  const txHeight = lock < LOCKTIME_THRESHOLD
  if (valueHeight !== txHeight || value.value > lock) {
    return failure('script-locktime', opcode)
  }
  const input = tx.inputs[machine.context.inputIndex ?? -1]
  if (input === undefined) return failure('script-index', opcode)
  if (input.sequence >>> 0 === 0xffffffff) {
    return failure('script-locktime', opcode)
  }
  return null
}

function sequenceTime(machine: Machine, opcode: number): ScriptFailure | null {
  const rules = machine.context.chain.script
  if (!rules.checkSequence) {
    if (rules.discourageNops) return failure('script-discouraged', opcode)
    return null
  }
  const missing = need(machine.stack, 1, opcode)
  if (missing) return missing
  const top = machine.stack[machine.stack.length - 1]
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const value = readNum(top, rules, opcode, 5)
  if (!value.ok) return value.error
  if (value.value < 0n) return failure('script-locktime', opcode)
  if ((value.value & SEQUENCE_DISABLE) !== 0n) return null
  const tx = requireTx(machine, opcode)
  if (tx === null || 'code' in tx) {
    return tx === null ? failure('script-spent', opcode) : tx
  }
  if (tx.version < 2) return failure('script-locktime', opcode)
  const input = tx.inputs[machine.context.inputIndex ?? -1]
  if (input === undefined) return failure('script-index', opcode)
  const mask = SEQUENCE_TYPE | SEQUENCE_MASK
  const sequence = BigInt(input.sequence >>> 0)
  if ((sequence & mask) < (value.value & mask)) {
    return failure('script-locktime', opcode)
  }
  return null
}

function requireTx(
  machine: Machine,
  opcode: number,
): Transaction | ScriptFailure | null {
  const tx = machine.context.transaction
  const index = machine.context.inputIndex
  if (tx === undefined || index === undefined) return null
  if (!Number.isInteger(index) || index < 0 || index >= tx.inputs.length) {
    return failure('script-index', opcode)
  }
  return tx
}

function introspect(machine: Machine, opcode: number): ScriptFailure | null {
  const tx = requireTx(machine, opcode)
  if (tx === null || 'code' in tx) {
    return tx === null ? failure('script-spent', opcode) : tx
  }
  const rules = machine.context.chain.script
  const current = machine.context.inputIndex ?? 0
  if (opcode === OP_INPUTINDEX) {
    return pushInt(machine.stack, BigInt(current), rules, opcode)
  }
  if (opcode === OP_ACTIVEBYTECODE) {
    const active = machine.script.subarray(machine.codeSep)
    if (active.length > rules.maxElementBytes) {
      return failure('script-push-size', opcode)
    }
    machine.stack.push(active.slice())
    return null
  }
  if (opcode === OP_TXVERSION) {
    return pushInt(machine.stack, BigInt(tx.version), rules, opcode)
  }
  if (opcode === OP_TXINPUTCOUNT) {
    return pushInt(machine.stack, BigInt(tx.inputs.length), rules, opcode)
  }
  if (opcode === OP_TXOUTPUTCOUNT) {
    return pushInt(machine.stack, BigInt(tx.outputs.length), rules, opcode)
  }
  if (opcode === OP_TXLOCKTIME) {
    return pushInt(machine.stack, BigInt(tx.locktime >>> 0), rules, opcode)
  }
  const top = machine.stack.pop()
  if (top === undefined) return failure('script-invalid-stack', opcode)
  const picked = readNum(top, rules, opcode)
  if (!picked.ok) return picked.error
  if (picked.value < 0n || !Number.isSafeInteger(Number(picked.value))) {
    return failure('script-index', opcode)
  }
  return pushIntrospected(machine, opcode, Number(picked.value))
}

function pushIntrospected(
  machine: Machine,
  opcode: number,
  at: number,
): ScriptFailure | null {
  const tx = machine.context.transaction
  const rules = machine.context.chain.script
  if (tx === undefined) return failure('script-spent', opcode)
  const input = tx.inputs[at]
  const output = tx.outputs[at]
  const spent = machine.context.spent?.[at]
  if (
    opcode === OP_UTXOVALUE ||
    opcode === OP_UTXOBYTECODE ||
    opcode === OP_OUTPOINTTXHASH ||
    opcode === OP_OUTPOINTINDEX
  ) {
    if (input === undefined) return failure('script-index', opcode)
  }
  if (opcode === OP_UTXOVALUE || opcode === OP_UTXOBYTECODE) {
    if (spent === undefined) return failure('script-spent', opcode)
  }
  if (opcode === OP_OUTPUTVALUE || opcode === OP_OUTPUTBYTECODE) {
    if (output === undefined) return failure('script-index', opcode)
  }
  if (opcode === OP_INPUTBYTECODE || opcode === OP_INPUTSEQUENCENUMBER) {
    if (input === undefined) return failure('script-index', opcode)
  }
  if (opcode === OP_UTXOVALUE && spent) {
    return pushInt(machine.stack, spent.value, rules, opcode)
  }
  if (opcode === OP_UTXOBYTECODE && spent) {
    if (spent.scriptPubKey.length > rules.maxElementBytes) {
      return failure('script-push-size', opcode)
    }
    machine.stack.push(spent.scriptPubKey.slice())
    return null
  }
  if (opcode === OP_OUTPOINTTXHASH && input) {
    machine.stack.push(input.prevout.txid.slice())
    return null
  }
  if (opcode === OP_OUTPOINTINDEX && input) {
    return pushInt(machine.stack, BigInt(input.prevout.vout), rules, opcode)
  }
  if (opcode === OP_INPUTBYTECODE && input) {
    if (input.scriptSig.length > rules.maxElementBytes) {
      return failure('script-push-size', opcode)
    }
    machine.stack.push(input.scriptSig.slice())
    return null
  }
  if (opcode === OP_INPUTSEQUENCENUMBER && input) {
    return pushInt(machine.stack, BigInt(input.sequence >>> 0), rules, opcode)
  }
  if (opcode === OP_OUTPUTVALUE && output) {
    return pushInt(machine.stack, output.value, rules, opcode)
  }
  if (opcode === OP_OUTPUTBYTECODE && output) {
    if (output.scriptPubKey.length > rules.maxElementBytes) {
      return failure('script-push-size', opcode)
    }
    machine.stack.push(output.scriptPubKey.slice())
    return null
  }
  return failure('script-bad-opcode', opcode)
}

function modInverse(value: bigint, modulus: bigint): bigint | null {
  let old = 0n
  let next = 1n
  let remainder = modulus
  let valueRemainder = value % modulus
  if (valueRemainder < 0n) valueRemainder += modulus
  while (valueRemainder !== 0n) {
    const quotient = remainder / valueRemainder
    const saved = next
    next = old - quotient * next
    old = saved
    const savedRemainder = valueRemainder
    valueRemainder = remainder - quotient * valueRemainder
    remainder = savedRemainder
  }
  if (remainder !== 1n) return null
  if (old < 0n) old += modulus
  return old
}

function verifyDigest(
  digest: Uint8Array,
  r: bigint,
  s: bigint,
  point: AffinePoint,
): boolean {
  if (digest.length !== 32) return false
  if (r <= 0n || s <= 0n || r >= SECP256K1_N || s >= SECP256K1_N) return false
  const inverse = modInverse(s, SECP256K1_N)
  if (inverse === null) return false
  const message = bytesToBigint(digest) % SECP256K1_N
  const u1 = (message * inverse) % SECP256K1_N
  const u2 = (r * inverse) % SECP256K1_N
  const left = u1 === 0n ? null : multiplyGenerator(u1)
  const right = u2 === 0n ? null : multiplyPoint(point, u2)
  if (left === null && right === null) return false
  const sum =
    left === null ? right : right === null ? left : addPoints(left, right)
  if (sum === null) return false
  return sum.x % SECP256K1_N === r
}

interface ParsedDer {
  readonly r: bigint
  readonly s: bigint
  readonly hashType: number | null
}

function parseDer(sig: Uint8Array, withHashType: boolean): ParsedDer | null {
  const min = withHashType ? 9 : 8
  const max = withHashType ? 73 : 72
  if (sig.length < min || sig.length > max) return null
  if (sig[0] !== 0x30) return null
  const expected = withHashType ? sig.length - 3 : sig.length - 2
  if (sig[1] !== expected) return null
  const lenR = sig[3] ?? 0
  if (5 + lenR >= sig.length) return null
  const lenS = sig[5 + lenR] ?? 0
  const total = withHashType ? lenR + lenS + 7 : lenR + lenS + 6
  if (total !== sig.length) return null
  if (sig[2] !== 0x02 || lenR === 0) return null
  if (((sig[4] ?? 0) & 0x80) !== 0) return null
  if (lenR > 1 && sig[4] === 0x00 && ((sig[5] ?? 0) & 0x80) === 0) return null
  if ((sig[lenR + 4] ?? 0) !== 0x02 || lenS === 0) return null
  if (((sig[lenR + 6] ?? 0) & 0x80) !== 0) return null
  if (
    lenS > 1 &&
    sig[lenR + 6] === 0x00 &&
    ((sig[lenR + 7] ?? 0) & 0x80) === 0
  ) {
    return null
  }
  return {
    r: bytesToBigint(sig.subarray(4, 4 + lenR)),
    s: bytesToBigint(sig.subarray(lenR + 6, lenR + 6 + lenS)),
    hashType: withHashType ? sig[sig.length - 1] ?? 0 : null,
  }
}

function looksSchnorr(sig: Uint8Array): boolean {
  const first = sig[0] ?? 0
  return (sig.length === 64 || sig.length === 65) && first !== 0x30
}

function hashTypeAccepted(hashType: number, family: ChainFamily): boolean {
  if (!Number.isInteger(hashType) || hashType < 0 || hashType > 0xff) {
    return false
  }
  if (family === 'xpi') {
    if ((hashType & 0x60) !== 0x60) return false
    if ((hashType & 0x03) === 0 || (hashType & 0x1c) !== 0) return false
    return true
  }
  const base = hashType & 0x1f
  if (base < 1 || base > 3) return false
  const extra = hashType & ~0x1f
  if (family === 'btc') return extra === 0 || extra === 0x80
  const withoutFork = extra & ~0x40
  return (extra & 0x40) === 0x40 && (withoutFork === 0 || withoutFork === 0x80)
}

function removeCodeSeparators(script: Uint8Array): Uint8Array {
  const out: number[] = []
  let pc = 0
  while (pc < script.length) {
    const op = readOp(script, pc)
    if (op === null) {
      for (let index = pc; index < script.length; index += 1) {
        out.push(script[index] ?? 0)
      }
      break
    }
    if (op.opcode !== OP_CODESEPARATOR) {
      for (let index = pc; index < op.next; index += 1)
        out.push(script[index] ?? 0)
    }
    pc = op.next
  }
  return Uint8Array.from(out)
}

function findAndDelete(script: Uint8Array, payload: Uint8Array): Uint8Array {
  const out: number[] = []
  let pc = 0
  while (pc < script.length) {
    const op = readOp(script, pc)
    if (op === null) {
      for (let index = pc; index < script.length; index += 1) {
        out.push(script[index] ?? 0)
      }
      break
    }
    const data = op.data
    const drop = data !== null && sameBytes(data, payload)
    if (!drop) {
      for (let index = pc; index < op.next; index += 1)
        out.push(script[index] ?? 0)
    }
    pc = op.next
  }
  return Uint8Array.from(out)
}

type SigMatch = boolean | ScriptFailure

function checkOne(
  machine: Machine,
  signature: Uint8Array,
  pubkey: Uint8Array,
  scriptCode: Uint8Array,
  opcode: number,
  dataSig: boolean,
  message?: Uint8Array,
): SigMatch {
  const rules = machine.context.chain.script
  const family = machine.context.chain.family
  if (signature.length === 0) return false
  if (looksSchnorr(signature) && family !== 'btc') {
    return failure('script-schnorr', opcode)
  }
  const parsed = parseDer(signature, !dataSig)
  if (parsed === null) {
    if (rules.derSig || rules.lowS || rules.strictEnc) {
      return failure('script-signature', opcode)
    }
    return false
  }
  if (rules.lowS && parsed.s > SECP256K1_N / 2n) {
    return failure('script-signature', opcode)
  }
  const formatOk =
    (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) ||
    (pubkey.length === 65 && pubkey[0] === 0x04)
  if (rules.strictEnc && !formatOk) return failure('script-signature', opcode)
  const point = pointFromPublicKey(pubkey)
  if (point === null) return false
  let digest: Uint8Array
  if (dataSig) {
    digest = sha256(message ?? new Uint8Array(0))
  } else {
    if (
      parsed.hashType === null ||
      !hashTypeAccepted(parsed.hashType, family)
    ) {
      return failure('script-signature', opcode)
    }
    const hashed = digestFor(machine, scriptCode, parsed.hashType, opcode)
    if (hashed === null || 'code' in hashed) {
      return hashed === null ? failure('script-spent', opcode) : hashed
    }
    digest = hashed
  }
  return verifyDigest(digest, parsed.r, parsed.s, point)
}

function digestFor(
  machine: Machine,
  scriptCode: Uint8Array,
  hashType: number,
  opcode: number,
): Uint8Array | ScriptFailure | null {
  const chain = machine.context.chain
  const tx = machine.context.transaction
  const inputIndex = machine.context.inputIndex
  if (tx === undefined || inputIndex === undefined) return null
  const algorithm: SighashAlgorithm =
    chain.family === 'btc'
      ? 'legacy'
      : chain.family === 'xpi'
      ? 'lotus'
      : 'forkid'
  const spentOutput = machine.context.spent?.[inputIndex]
  if (algorithm !== 'legacy' && spentOutput === undefined) return null
  if (
    algorithm === 'lotus' &&
    (machine.context.spent === undefined ||
      machine.context.spent.length !== tx.inputs.length)
  ) {
    return null
  }
  const locking = spentOutput?.scriptPubKey
  const active = machine.script.subarray(machine.codeSep)
  const sameLock = locking !== undefined && sameBytes(locking, active)
  const extend = algorithm === 'lotus' && (machine.separated || !sameLock)
  const hashed = sighash(tx, inputIndex, chain, hashType, {
    algorithm,
    scriptCode,
    amount: spentOutput?.value,
    spent: machine.context.spent,
    commitUtxos: false,
    executedScriptHash: extend
      ? sha256(removeCodeSeparators(active))
      : undefined,
    codeSeparatorPosition:
      extend && machine.separated ? machine.codeSep : undefined,
  })
  if (!hashed.ok) return failure('script-signature', opcode)
  return hashed.value
}

function checkSig(
  machine: Machine,
  opcode: number,
  verify: boolean,
): ScriptFailure | null {
  const missing = need(machine.stack, 2, opcode)
  if (missing) return missing
  const pubkey = machine.stack[machine.stack.length - 1]
  const signature = machine.stack[machine.stack.length - 2]
  if (pubkey === undefined || signature === undefined) {
    return failure('script-invalid-stack', opcode)
  }
  const code = findAndDelete(
    removeCodeSeparators(machine.script.subarray(machine.codeSep)),
    signature,
  )
  const matched = checkOne(machine, signature, pubkey, code, opcode, false)
  if (typeof matched !== 'boolean') return matched
  if (
    !matched &&
    machine.context.chain.script.nullFail &&
    signature.length > 0
  ) {
    return failure('script-nullfail', opcode)
  }
  machine.stack.pop()
  machine.stack.pop()
  pushBool(machine.stack, matched)
  if (verify) {
    if (!matched) return failure('script-verify', opcode)
    machine.stack.pop()
  }
  return null
}

function checkDataSig(
  machine: Machine,
  opcode: number,
  verify: boolean,
): ScriptFailure | null {
  const missing = need(machine.stack, 3, opcode)
  if (missing) return missing
  const pubkey = machine.stack[machine.stack.length - 1]
  const message = machine.stack[machine.stack.length - 2]
  const signature = machine.stack[machine.stack.length - 3]
  if (
    pubkey === undefined ||
    message === undefined ||
    signature === undefined
  ) {
    return failure('script-invalid-stack', opcode)
  }
  const matched = checkOne(
    machine,
    signature,
    pubkey,
    new Uint8Array(0),
    opcode,
    true,
    message,
  )
  if (typeof matched !== 'boolean') return matched
  if (
    !matched &&
    machine.context.chain.script.nullFail &&
    signature.length > 0
  ) {
    return failure('script-nullfail', opcode)
  }
  machine.stack.pop()
  machine.stack.pop()
  machine.stack.pop()
  pushBool(machine.stack, matched)
  if (verify) {
    if (!matched) return failure('script-verify', opcode)
    machine.stack.pop()
  }
  return null
}

function checkMultisig(
  machine: Machine,
  opcode: number,
  verify: boolean,
): ScriptFailure | null {
  const { stack } = machine
  const rules = machine.context.chain.script
  const missing = need(stack, 1, opcode)
  if (missing) return missing
  const keyCountBytes = stack[stack.length - 1]
  if (keyCountBytes === undefined)
    return failure('script-invalid-stack', opcode)
  const keyCount = readNum(keyCountBytes, rules, opcode)
  if (!keyCount.ok) return keyCount.error
  if (keyCount.value < 0n || keyCount.value > 20n) {
    return failure('script-invalid-stack', opcode)
  }
  const nKeys = Number(keyCount.value)
  machine.opCount += nKeys
  if (machine.opCount > rules.maxOps) return failure('script-op-count', opcode)
  if (stack.length < nKeys + 2) return failure('script-invalid-stack', opcode)
  const sigCountBytes = stack[stack.length - (nKeys + 2)]
  if (sigCountBytes === undefined)
    return failure('script-invalid-stack', opcode)
  const sigCount = readNum(sigCountBytes, rules, opcode)
  if (!sigCount.ok) return sigCount.error
  if (sigCount.value < 0n || sigCount.value > keyCount.value) {
    return failure('script-invalid-stack', opcode)
  }
  const nSigs = Number(sigCount.value)
  const width = nKeys + nSigs + 3
  if (stack.length < width) return failure('script-invalid-stack', opcode)
  const sigs: Uint8Array[] = []
  for (let index = 0; index < nSigs; index += 1) {
    const item = stack[stack.length - (nKeys + 3 + index)]
    if (item === undefined) return failure('script-invalid-stack', opcode)
    sigs.push(item)
  }
  const pubs: Uint8Array[] = []
  for (let index = 0; index < nKeys; index += 1) {
    const item = stack[stack.length - (2 + index)]
    if (item === undefined) return failure('script-invalid-stack', opcode)
    pubs.push(item)
  }
  let code = removeCodeSeparators(machine.script.subarray(machine.codeSep))
  for (const sig of sigs) code = findAndDelete(code, sig)
  let sigIndex = 0
  let keyIndex = 0
  let remaining = nSigs
  let keysLeft = nKeys
  let success = true
  while (success && remaining > 0) {
    const sig = sigs[sigIndex]
    const pub = pubs[keyIndex]
    if (sig === undefined || pub === undefined) {
      return failure('script-invalid-stack', opcode)
    }
    const matched = checkOne(machine, sig, pub, code, opcode, false)
    if (typeof matched !== 'boolean') return matched
    if (matched) {
      sigIndex += 1
      remaining -= 1
    }
    keyIndex += 1
    keysLeft -= 1
    if (remaining > keysLeft) success = false
  }
  if (!success && rules.nullFail) {
    for (const sig of sigs) {
      if (sig.length !== 0) return failure('script-nullfail', opcode)
    }
  }
  const dummy = stack[stack.length - width]
  if (dummy === undefined) return failure('script-invalid-stack', opcode)
  if (rules.nullDummy && dummy.length !== 0) {
    return failure('script-nulldummy', opcode)
  }
  for (let count = 0; count < width; count += 1) stack.pop()
  pushBool(stack, success)
  if (verify) {
    if (!success) return failure('script-verify', opcode)
    stack.pop()
  }
  return null
}
