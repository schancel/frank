// Lotus v2 static transaction cost: P05 "Static cost algebra", "Size-bounded
// charging" and "Unified Cost Units" under the approved cost schedule (Lotus
// repository docs/lotus-v2/decisions/resources-and-parameters.md).
//
// C_tx is static: it comes from the transaction bytes, the scripts its
// witnesses reveal and the coins it spends. No script runs. The outer terms
// follow the reference `resources.linear_cost` with `APPROVED`
// (tools/lotus-v2-reference/lotus_v2_reference/resources.py), and the
// invocation charge follows the reference size pass `vm_cost.static_size_cost`
// with the `recommended_opcodes()` table and the approved signature weights.
//
// Implemented: data pushes, numeric constants, the fixed stack shuffles,
// PICK/ROLL, CAT, EQUAL/EQUALVERIFY, VERIFY, SHA256/HASH256/BLAKE3,
// CHECKSIG/CHECKSIGVERIFY, IF/NOTIF/ELSE/ENDIF and the lock checks. Every other
// opcode, loops and automatic-success scripts are an explicit
// LotusV2UnsupportedError rather than a guessed charge.
//
// Pending in the spec, so flagged on every result that depends on it: the
// state-key weight (151 cu for a coin up to 158 bytes) is a placeholder until
// it is measured on the node's tree. The lock checks follow the P05 row added
// on 2026-11-19 (both pop N(kind) and N(bound) and push nothing).

import type { LotusV2ChainDescriptor } from '../chain/types.js'
import { encodeLotusV2CoinOutput, isLotusV2LegacyCoin } from './legacy.js'
import type { LotusV2Coin } from './legacy.js'
import { LotusV2UnsupportedError } from './sign.js'
import {
  encodeLotusV2Input,
  encodeLotusV2Output,
  encodeLotusV2Transaction,
} from './transaction.js'
import type { LotusV2Transaction } from './transaction.js'

const U64 = (1n << 64n) - 1n

/** P05 approved cost schedule (2026-11-18) and burn shifts. */
export interface LotusV2CostSchedule {
  /** cu per serialized wire byte (2). */
  readonly wireByteCu: bigint
  /** `S_tx_knee` (18): `C_tx = L + ((L * L) >> S_tx_knee)`. */
  readonly txKneeShift: bigint
  /** `E_min` (2^34 cu), the floor of the EMA price `M = max(E, E_min)`. */
  readonly emaMin: bigint
  /** `S_linear` (32). */
  readonly linearShift: bigint
  /** `S_quad` (32). */
  readonly quadShift: bigint
}

export const LOTUS_V2_APPROVED_COST_SCHEDULE: LotusV2CostSchedule =
  Object.freeze({
    wireByteCu: 2n,
    txKneeShift: 18n,
    emaMin: 1n << 34n,
    linearShift: 32n,
    quadShift: 32n,
  })

/** Spec items a cost depends on that are not final. */
export type LotusV2PendingCostItem =
  /** P05: the 151 cu state-key price is a placeholder. */
  | 'state-key-weight'
  /**
   * P05 prices no legacy-bridge verification; a bridge spend is charged one
   * BIP340 check, as the shared fee vectors derive it.
   */
  | 'legacy-bridge-charge'

// Outer weights: the reference `Schedule` (resources.py) as approved.
const HASH_BLOCK = 1n
const INVOCATION_BASE = 6n
const COIN_READ = 64n
const COIN_BYTE = 1n
const KEY_READ = 64n
const KEY_LEVELS = 27n
const PATH_MATCH = 2n
const ASSET_RECORD = 1n
const MINT_LOOKUP = 2n
const STRUCTURAL_BYTE = 1n

function cs(n: number): number {
  return n < 253 ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9
}

/** `h(n) = ceil((n + 64) / 64)`: one cu per BLAKE3 block, 64 bytes reserved for the tag. */
function h(n: number): bigint {
  return HASH_BLOCK * BigInt(Math.ceil((n + 64) / 64))
}

/** P02 `Coin` record length for an output of `n` bytes (outpoint, output, height, MTP, coinbase, version and lifespan suffix). */
function coinLength(n: number): number {
  return 32 + 4 + cs(n) + n + 8 + 8 + 1 + 1 + 8 + 8
}

/** State key: placeholder weight (P05, pending measurement). */
function stateKey(coin: number): bigint {
  return h(36) + h(33 + cs(coin) + coin) + KEY_LEVELS * h(67) + KEY_READ
}

// ---------------------------------------------------------------------------
// Invocation charge: the P05 size pass over the decoded script.

const MAX_ELEMENT_BYTES = 8192
const MIN_NUMERIC_BYTES = 16
const BIP340_CU = 210n

type OpCharge = readonly [base: number, operandKib: number, resultKib: number]
const DEFAULT_OP: OpCharge = [1, 1, 1]
/** Reference `recommended_opcodes()` entries for the opcodes implemented here. */
const OP_CHARGES: Readonly<Record<number, OpCharge>> = Object.freeze({
  0x88: [1, 0, 1], // CAT
  0x91: [1, 1, 1], // EQUAL
  0x92: [1, 1, 1], // EQUALVERIFY
  0xb8: [3, 5, 0], // SHA256
  0xb9: [4, 5, 0], // HASH256
  0xba: [2, 11, 0], // BLAKE3
})

function charge(
  op: number,
  operands: readonly number[],
  results: readonly number[],
): bigint {
  if (op === 0xbb || op === 0xbc) return BIP340_CU
  const [base, operand, result] = OP_CHARGES[op] ?? DEFAULT_OP
  const sized =
    operand * operands.reduce((a, b) => a + b, 0) +
    result * results.reduce((a, b) => a + b, 0)
  return BigInt(base + Math.ceil(sized / 1024))
}

/** Charge at the maximum operand: what the reference's `worst_charge` gives for these opcodes. */
function worstCharge(op: number): bigint {
  return charge(
    op,
    new Array<number>(6).fill(MAX_ELEMENT_BYTES),
    new Array<number>(4).fill(MAX_ELEMENT_BYTES),
  )
}

interface Instruction {
  readonly kind: 'op'
  readonly op: number
  readonly data?: Uint8Array
}
interface Conditional {
  readonly kind: 'if'
  readonly op: number
  readonly then: readonly Node[]
  readonly otherwise: readonly Node[]
  readonly hasElse: boolean
}
type Node = Instruction | Conditional

const IMPLEMENTED = new Set<number>([
  0x00,
  ...Array.from({ length: 0x5d - 0x4d + 1 }, (_, i) => 0x4d + i),
  0x65, // VERIFY
  0x72, // 2DROP
  0x73, // 2DUP
  0x74, // 3DUP
  0x75, // 2OVER
  0x76, // 2ROT
  0x77, // 2SWAP
  0x79, // DROP
  0x7a, // DUP
  0x7b, // NIP
  0x7c, // OVER
  0x7d, // PICK
  0x7e, // ROLL
  0x7f, // ROT
  0x80, // SWAP
  0x81, // TUCK
  0x88, // CAT
  0x91, // EQUAL
  0x92, // EQUALVERIFY
  0xb8, // SHA256
  0xb9, // HASH256
  0xba, // BLAKE3
  0xbb, // CHECKSIG
  0xbc, // CHECKSIGVERIFY
  0xf3, // CHECKLOCKTIMEVERIFY
  0xf4, // CHECKSEQUENCEVERIFY
])

function decodeScript(script: Uint8Array): Node[] {
  let pos = 0
  const unsupported = (what: string): never => {
    throw new LotusV2UnsupportedError(`static cost of ${what}`)
  }
  const read = (): Instruction => {
    const op = script[pos++] as number
    if (op >= 1 && op <= 75) {
      if (pos + op > script.length) unsupported('a truncated push')
      const data = script.subarray(pos, pos + op)
      pos += op
      return { kind: 'op', op, data }
    }
    if (op === 0x4c) {
      const first = script[pos]
      if (first === undefined) return unsupported('a truncated push')
      let length = first
      pos += 1
      if (first === 0xfd) {
        length = (script[pos] ?? 0) | ((script[pos + 1] ?? 0) << 8)
        pos += 2
      } else if (first > 0xfd) unsupported('an oversized push')
      if (
        (length >= 1 && length <= 75) ||
        length > MAX_ELEMENT_BYTES ||
        pos + length > script.length
      )
        unsupported('a noncanonical push')
      const data = script.subarray(pos, pos + length)
      pos += length
      return { kind: 'op', op, data }
    }
    return { kind: 'op', op }
  }
  const sequence = (
    ends: readonly number[],
  ): { nodes: Node[]; end: number | undefined } => {
    const nodes: Node[] = []
    while (pos < script.length) {
      const ins = read()
      if (ins.data !== undefined) {
        nodes.push(ins)
        continue
      }
      const op = ins.op
      if (op === 0x63 || op === 0x64) {
        if (!ends.includes(op)) unsupported('an unmatched ELSE/ENDIF')
        return { nodes, end: op }
      }
      if (op === 0x61 || op === 0x62) {
        const then = sequence([0x63, 0x64])
        let otherwise: Node[] = []
        let end = then.end
        if (end === 0x63) {
          const rest = sequence([0x64])
          otherwise = rest.nodes
          end = rest.end
        }
        if (end !== 0x64) unsupported('an unclosed IF')
        nodes.push({
          kind: 'if',
          op,
          then: then.nodes,
          otherwise,
          hasElse: then.end === 0x63,
        })
        continue
      }
      if (op === 0x69 || op === 0x6a) unsupported('a loop (ENUMERATE) script')
      if (!IMPLEMENTED.has(op))
        unsupported(`opcode 0x${op.toString(16).padStart(2, '0')}`)
      nodes.push(ins)
    }
    return { nodes, end: undefined }
  }
  const { nodes } = sequence([])
  return nodes
}

/** `_literal`: the number a constant instruction pushes, if it is one. */
function literal(ins: Instruction | undefined): number | undefined {
  if (ins === undefined) return undefined
  if (ins.data !== undefined) {
    if (ins.data.length !== 16) return undefined
    let v = 0n
    for (let i = 15; i >= 0; i -= 1) v = (v << 8n) | BigInt(ins.data[i] ?? 0)
    if (v >= 1n << 127n) v -= 1n << 128n
    return v >= -(1n << 53n) && v <= 1n << 53n ? Number(v) : undefined
  }
  if (ins.op === 0x00) return 0
  if (ins.op === 0x4d) return -1
  if (ins.op >= 0x4e && ins.op <= 0x5d) return ins.op - 0x4d
  return undefined
}

/** Size-pass state: one bound per stack item, or `undefined` for Unknown. */
type Sizes = { main: number[]; alt: number[] } | undefined

class Underflow extends Error {}

function transfer(
  ins: Instruction,
  state: Sizes,
  previous: Instruction | undefined,
): { state: Sizes; cost: bigint } {
  const op = ins.op
  if (state === undefined) return { state: undefined, cost: worstCharge(op) }
  const main = [...state.main]
  const alt = [...state.alt]
  const operands: number[] = []
  const results: number[] = []
  const pop = (): number => {
    const size = main.pop()
    if (size === undefined) throw new Underflow()
    operands.push(size)
    return size
  }
  const push = (size: number): void => {
    const s = Math.min(size, MAX_ELEMENT_BYTES)
    main.push(s)
    results.push(s)
  }
  const need = (n: number): void => {
    if (main.length < n) throw new Underflow()
  }
  try {
    if (ins.data !== undefined) push(ins.data.length)
    else if (op === 0x00 || (op >= 0x4d && op <= 0x5d)) push(16)
    else if (op === 0xf3 || op === 0xf4) {
      // N(kind) N(bound) -> nothing (P05 row, 2026-11-19).
      pop()
      pop()
    } else if (op === 0x72) {
      pop()
      pop()
    } else if (op === 0x73 || op === 0x74 || op === 0x75) {
      const [count, offset] =
        op === 0x73 ? [2, 2] : op === 0x74 ? [3, 3] : [2, 4]
      need(offset)
      const end = -offset + count
      const copied = main.slice(-offset, end === 0 ? undefined : end)
      for (const size of copied) push(size)
    } else if (op === 0x76 || op === 0x77) {
      const count = op === 0x76 ? 6 : 4
      need(count)
      operands.push(...main.slice(-count))
      const moved = [
        ...main.slice(-count + 2),
        ...main.slice(-count, -count + 2),
      ]
      main.splice(main.length - count, count, ...moved)
    } else if (op === 0x79) pop()
    else if (op === 0x7a) {
      need(1)
      const top = main[main.length - 1] as number
      operands.push(top)
      push(top)
    } else if (op === 0x7b) {
      need(2)
      operands.push(main.splice(main.length - 2, 1)[0] as number)
    } else if (op === 0x7c) {
      need(2)
      const second = main[main.length - 2] as number
      operands.push(second)
      push(second)
    } else if (op === 0x7d || op === 0x7e) {
      pop()
      const index = literal(previous)
      if (index !== undefined && index >= 0 && index < main.length) {
        const at = main.length - 1 - index
        const selected = main[at] as number
        operands.push(selected)
        if (op === 0x7d) push(selected)
        else push(main.splice(at, 1)[0] as number)
      } else {
        const largest = main.length ? Math.max(...main) : MAX_ELEMENT_BYTES
        operands.push(largest)
        if (op === 0x7d) push(largest)
        else main.fill(largest)
      }
    } else if (op === 0x7f) {
      need(3)
      operands.push(...main.slice(-3))
      const [a, b, c] = main.splice(main.length - 3, 3) as [
        number,
        number,
        number,
      ]
      main.push(b, c, a)
    } else if (op === 0x80) {
      need(2)
      operands.push(...main.slice(-2))
      const [a, b] = main.splice(main.length - 2, 2) as [number, number]
      main.push(b, a)
    } else if (op === 0x81) {
      need(2)
      const [a, b] = main.splice(main.length - 2, 2) as [number, number]
      operands.push(a, b)
      main.push(b, a, b)
      results.push(b)
    } else if (op === 0x88) {
      const b = pop()
      const a = pop()
      push(a + b)
    } else if (op === 0x91 || op === 0x92) {
      pop()
      pop()
      if (op === 0x91) push(16)
    } else if (op === 0xb8 || op === 0xb9 || op === 0xba) {
      pop()
      push(32)
    } else if (op === 0xbb || op === 0xbc) {
      pop()
      pop()
      if (op === 0xbb) push(16)
    } else throw new LotusV2UnsupportedError(`static cost of opcode ${op}`)
  } catch (e) {
    if (e instanceof Underflow)
      return { state: undefined, cost: worstCharge(op) }
    throw e
  }
  return { state: { main, alt }, cost: charge(op, operands, results) }
}

function merge(a: Sizes | null, b: Sizes | null): Sizes | null {
  if (a === null) return b
  if (b === null) return a
  if (
    a === undefined ||
    b === undefined ||
    a.main.length !== b.main.length ||
    a.alt.length !== b.alt.length
  )
    return undefined
  return {
    main: a.main.map((x, i) => Math.max(x, b.main[i] as number)),
    alt: a.alt.map((x, i) => Math.max(x, b.alt[i] as number)),
  }
}

function sequenceCost(
  nodes: readonly Node[],
  start: Sizes,
): { cost: bigint; state: Sizes } {
  let current: Sizes = start
  let total = 0n
  let previous: Instruction | undefined
  for (const node of nodes) {
    if (node.kind === 'op' && node.data === undefined && node.op === 0x65) {
      // VERIFY is charged on its condition's bound, also from Unknown.
      const top =
        current !== undefined && current.main.length
          ? (current.main[current.main.length - 1] as number)
          : MAX_ELEMENT_BYTES
      current =
        current !== undefined && current.main.length
          ? { main: current.main.slice(0, -1), alt: [...current.alt] }
          : undefined
      total += charge(0x65, [top], [])
      previous = node
      continue
    }
    if (node.kind === 'op') {
      const next = transfer(node, current, previous)
      current = next.state
      total += next.cost
      previous = node
      continue
    }
    const conditionSize =
      current !== undefined && current.main.length
        ? (current.main[current.main.length - 1] as number)
        : MAX_ELEMENT_BYTES
    const armStart: Sizes =
      current !== undefined && current.main.length
        ? { main: current.main.slice(0, -1), alt: [...current.alt] }
        : undefined
    const left = sequenceCost(node.then, armStart)
    const right = sequenceCost(node.otherwise, armStart)
    let part = charge(node.op, [conditionSize], []) + charge(0x64, [], [])
    if (node.hasElse) part += charge(0x63, [], [])
    part += left.cost > right.cost ? left.cost : right.cost
    total += part
    current = merge(left.state, right.state) ?? undefined
    previous = undefined
  }
  return { cost: total, state: current }
}

/**
 * The invocation's static charge in cu: 1 cu per script byte (P05 structural
 * charge) plus the size pass's `cost(script)`, the reference's
 * `len(script) + vm_cost.static_size_cost(...).cost`. `argumentSizes` are the
 * witness arguments' lengths, bottom first (the pass's initial state); a mint
 * invocation also starts with its 16-byte mint delta on top. The
 * per-invocation setup charge is an outer term of L(tx), not part of this.
 */
export function lotusV2InvocationCost(
  script: Uint8Array,
  argumentSizes: readonly number[],
  invocation: 'spend' | 'mint' = 'spend',
): bigint {
  const nodes = decodeScript(script)
  const start: Sizes = {
    main: [
      ...argumentSizes.map(s => Math.min(s, MAX_ELEMENT_BYTES)),
      ...(invocation === 'mint' ? [MIN_NUMERIC_BYTES] : []),
    ],
    alt: [],
  }
  return (
    STRUCTURAL_BYTE * BigInt(script.length) + sequenceCost(nodes, start).cost
  )
}

// ---------------------------------------------------------------------------
// L(tx) and C_tx.

export interface LotusV2StaticCost {
  /** Complete serialized bytes. */
  readonly size: number
  /** `L(tx)`, cu. */
  readonly linearCost: bigint
  /** `C_tx = L + ((L * L) >> S_tx_knee)`, cu. */
  readonly transactionCost: bigint
  /** Static charge of each invocation, by input then witness. */
  readonly invocationCosts: readonly (readonly bigint[])[]
  readonly pending: readonly LotusV2PendingCostItem[]
}

/** `C_tx = L + ((L * L) >> S_tx_knee)` with the u64 checks of P05. */
export function lotusV2TransactionCost(
  linearCost: bigint,
  schedule: LotusV2CostSchedule = LOTUS_V2_APPROVED_COST_SCHEDULE,
): bigint {
  if (linearCost < 0n || linearCost > U64)
    throw new RangeError('linear cost out of u64 range')
  const c = linearCost + ((linearCost * linearCost) >> schedule.txKneeShift)
  if (c > U64) throw new RangeError('transaction cost exceeds u64')
  return c
}

/**
 * `L(tx)` and `C_tx` of an ordinary transaction from its bytes, the scripts
 * its witnesses reveal and `coins[i]`, the complete output each spend input
 * spends (undefined for a mint input). Deterministic before execution.
 * A coinbase is not priced this way (it pays from its claim) and is an
 * explicit {@link LotusV2UnsupportedError}.
 */
export function lotusV2StaticCost(
  chain: LotusV2ChainDescriptor,
  tx: LotusV2Transaction,
  coins: readonly (LotusV2Coin | undefined)[],
  schedule: LotusV2CostSchedule = LOTUS_V2_APPROVED_COST_SCHEDULE,
): LotusV2StaticCost {
  const size = encodeLotusV2Transaction(chain, tx).length
  const pending = new Set<LotusV2PendingCostItem>()
  const invocationCosts: bigint[][] = []
  let total = schedule.wireByteCu * BigInt(size) + 2n * h(112)
  let spends = 0
  tx.inputs.forEach((input, i) => {
    if (input.kind === 'coinbase')
      throw new LotusV2UnsupportedError('the static cost of a coinbase')
    const core = encodeLotusV2Input(input, true).length
    const full = encodeLotusV2Input(input).length
    total += h(core) + h(full)
    const witnesses = input.kind === 'spend' ? input.witnesses : [input.witness]
    const spent = input.kind === 'spend' ? coins[i] : undefined
    if (input.kind === 'spend' && spent === undefined)
      throw new RangeError(`input ${i} has no resolved coin`)
    const bridge = spent !== undefined && isLotusV2LegacyCoin(spent)
    if (bridge) pending.add('legacy-bridge-charge')
    const costs: bigint[] = []
    for (const w of witnesses) {
      // A legacy bridge runs no V2 script: its one BIP340 check.
      const invocation = bridge
        ? BIP340_CU
        : lotusV2InvocationCost(
            w.script,
            w.arguments.map(a => a.length),
            input.kind,
          )
      costs.push(invocation)
      total +=
        invocation +
        INVOCATION_BASE +
        h(1 + cs(w.script.length) + w.script.length) +
        BigInt(w.siblings.length) * h(65)
    }
    invocationCosts.push(costs)
    if (spent !== undefined) {
      spends += 1
      const n = encodeLotusV2CoinOutput(spent).length
      const record = coinLength(n)
      total += COIN_READ + COIN_BYTE * BigInt(record)
      total += h(cs(n) + n) + h(core + cs(n) + n)
      total += PATH_MATCH + stateKey(record)
      pending.add('state-key-weight')
    } else total += h(0) + MINT_LOOKUP
  })
  total +=
    (6n * BigInt(Math.max(tx.inputs.length, 1)) +
      2n * BigInt(Math.max(tx.outputs.length, 1))) *
    h(66)
  for (const output of tx.outputs) {
    const n = encodeLotusV2Output(output).length
    total += h(cs(n) + n)
    if (!output.burn) {
      total += stateKey(coinLength(n))
      pending.add('state-key-weight')
    }
  }
  total += ASSET_RECORD * BigInt(tx.inputs.length + tx.outputs.length + spends)
  if (total > U64) throw new RangeError('transaction linear cost exceeds u64')
  return {
    size,
    linearCost: total,
    transactionCost: lotusV2TransactionCost(total, schedule),
    invocationCosts,
    pending: [...pending],
  }
}
