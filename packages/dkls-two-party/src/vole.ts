/**
 * Random vector OLE from random OT: Protocol 4.2 ("Variant II") of Asharov,
 * "Revisiting DKLs Threshold ECDSA" (ePrint 2026/976), with vector length
 * l = 2 and one mask column, over the scalar field of secp256k1.
 *
 * The receiver's round 1 is the OT-extension message (`ot-extension.ts`);
 * its choice bits are w. This file is round 2 (the sender) and the
 * receiver's output computation.
 *
 * Output relation: the sender gets (alpha_1, alpha_2) and (t_1, t_2), the
 * receiver gets beta and (r_1, r_2), with  t_c + r_c = alpha_c * beta.
 *
 * Both countermeasures of the paper's section 4.5 are in place: the OT pads
 * are random-oracle outputs the sender cannot choose, and the challenge chi
 * and the gadget vector g hash the concrete OT-extension transcript
 * (footnote 2 of Protocol 4.2).
 *
 * Parameters (Theorem 4.4, Variant II): m >= log q + 2*kappa + 3*s. One mask
 * column suffices because log q >= kappa + 2 log m (Claim B.8).
 */
import { bit, concat, equalBytes, Reader } from './bytes.js'
import {
  CURVE_ORDER,
  HASH_BYTES,
  hedgedScalar,
  SCALAR_BYTES,
  transcript,
  transcriptScalar,
} from './group.js'
import { kernel } from './kernel.js'
import { VOLE_OT_COUNT } from './ot-extension.js'
import { fail } from './result.js'
import type { RandomBytes } from './rng.js'

/** Vector length: the nonce share and the key share. */
export const VOLE_LENGTH = 2
/** Columns of the OT messages: the vector plus one mask. */
export const VOLE_COLUMNS = VOLE_LENGTH + 1

const MATRIX_BYTES = VOLE_OT_COUNT * VOLE_COLUMNS * SCALAR_BYTES
export const VOLE_MESSAGE_BYTES = MATRIX_BYTES + HASH_BYTES + SCALAR_BYTES

const q = CURVE_ORDER

const HEX: string[] = []
for (let value = 0; value < 256; value += 1) {
  HEX.push(value.toString(16).padStart(2, '0'))
}

/** 32 big-endian bytes at `offset`, reduced mod q. */
function scalarAt(bytes: Uint8Array, offset: number): bigint {
  let hex = '0x'
  for (let index = offset; index < offset + SCALAR_BYTES; index += 1) {
    hex += HEX[bytes[index] ?? 0]
  }
  return BigInt(hex) % q
}

function writeScalar(out: Uint8Array, offset: number, value: bigint): void {
  const hex = value.toString(16).padStart(2 * SCALAR_BYTES, '0')
  for (let index = 0; index < SCALAR_BYTES; index += 1) {
    out[offset + index] = Number.parseInt(hex.substr(2 * index, 2), 16)
  }
}

function scalars(bytes: Uint8Array, count: number): bigint[] {
  const out: bigint[] = []
  for (let index = 0; index < count; index += 1) {
    out.push(scalarAt(bytes, index * SCALAR_BYTES))
  }
  return out
}

/** The instance context: full session binding (both salts) and direction. */
export function voleContext(
  fullBinding: Uint8Array,
  receiverId: Uint8Array,
  senderId: Uint8Array,
): Uint8Array {
  return transcript('vole/context', fullBinding, receiverId, senderId)
}

/**
 * The digest of the concrete OT-extension message of this instance. Both
 * parties pass it to `voleSend` / `voleReceive` as `extension`.
 */
export function extensionDigest(extensionMessage: Uint8Array): Uint8Array {
  return transcript('vole/extension', extensionMessage)
}

/**
 * chi_1, chi_2 = RO(context, OT transcript, Q). Exported, like `checkHash`,
 * only so that tests can build a cheating sender; both take public inputs.
 */
export function challenge(
  context: Uint8Array,
  extension: Uint8Array,
  matrix: Uint8Array,
): bigint[] {
  const hashed = transcript('vole/q', matrix)
  const out: bigint[] = []
  for (let c = 0; c < VOLE_LENGTH; c += 1) {
    out.push(
      transcriptScalar('vole/chi', context, extension, hashed, Uint8Array.of(c)),
    )
  }
  return out
}

/** g = RO(context, OT transcript, whole sender message). */
function gadget(
  context: Uint8Array,
  extension: Uint8Array,
  message: Uint8Array,
): bigint[] {
  const seed = transcript(
    'vole/gadget',
    context,
    extension,
    transcript('vole/message', message),
  )
  return scalars(
    kernel().hashRows(seed, new Uint8Array(0), 0, VOLE_OT_COUNT, 1),
    VOLE_OT_COUNT,
  )
}

export function checkHash(
  context: Uint8Array,
  values: readonly bigint[],
): Uint8Array {
  const bytes = new Uint8Array(values.length * SCALAR_BYTES)
  values.forEach((value, index) => {
    writeScalar(bytes, index * SCALAR_BYTES, value)
  })
  const hashed = transcript('vole/u', context, bytes)
  bytes.fill(0)
  return hashed
}

export interface VoleSenderOutput {
  /** `Q || H_u || v`. */
  readonly message: Uint8Array
  /** SECRET alpha_1, alpha_2. */
  readonly alpha: readonly bigint[]
  /** SECRET t_1, t_2. */
  readonly shares: readonly bigint[]
}

/**
 * VOLE.S.Round2. `extension` is `extensionDigest(...)`; `pads0` and `pads1` are the sender's OT pads for choice bit
 * 0 and 1 (`VOLE_OT_COUNT x VOLE_COLUMNS` hashes, row-major).
 */
export function voleSend(
  rng: RandomBytes,
  context: Uint8Array,
  extension: Uint8Array,
  pads0: Uint8Array,
  pads1: Uint8Array,
  ...secrets: readonly Uint8Array[]
): VoleSenderOutput {
  if (pads0.length !== MATRIX_BYTES || pads1.length !== MATRIX_BYTES) {
    fail('internal-error')
  }
  const count = VOLE_OT_COUNT * VOLE_COLUMNS
  const t0 = scalars(pads0, count)
  const t1 = scalars(pads1, count)
  // 2a: alpha_1, alpha_2 and the mask.
  const alpha: bigint[] = []
  for (let c = 0; c < VOLE_COLUMNS; c += 1) {
    alpha.push(
      hedgedScalar(rng, 'vole/alpha', context, Uint8Array.of(c), ...secrets),
    )
  }
  // 2b: Q = T0 - T1 + A.
  const matrix = new Uint8Array(MATRIX_BYTES)
  for (let index = 0; index < count; index += 1) {
    const value =
      ((t0[index] ?? 0n) - (t1[index] ?? 0n) + (alpha[index % VOLE_COLUMNS] ?? 0n) + q) %
      q
    writeScalar(matrix, index * SCALAR_BYTES, value)
  }
  // 2c-2e: chi, u = T0 * chi, v = <alpha, chi>.
  const chi = challenge(context, extension, matrix)
  const u: bigint[] = []
  for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
    let sum = t0[j * VOLE_COLUMNS + VOLE_LENGTH] ?? 0n
    for (let c = 0; c < VOLE_LENGTH; c += 1) {
      sum += (chi[c] ?? 0n) * (t0[j * VOLE_COLUMNS + c] ?? 0n)
    }
    u.push(sum % q)
  }
  let v = alpha[VOLE_LENGTH] ?? 0n
  for (let c = 0; c < VOLE_LENGTH; c += 1) {
    v += (chi[c] ?? 0n) * (alpha[c] ?? 0n)
  }
  v %= q
  // 2f-2g.
  const tail = new Uint8Array(SCALAR_BYTES)
  writeScalar(tail, 0, v)
  const message = concat(matrix, checkHash(context, u), tail)
  // 2h, 2j: t_c = -sum_j g_j * T0[j][c].
  const g = gadget(context, extension, message)
  const shares: bigint[] = []
  for (let c = 0; c < VOLE_LENGTH; c += 1) {
    let sum = 0n
    for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
      sum += (g[j] ?? 0n) * (t0[j * VOLE_COLUMNS + c] ?? 0n)
    }
    shares.push((q - (sum % q)) % q)
  }
  t0.fill(0n)
  t1.fill(0n)
  u.fill(0n)
  return { message, alpha: alpha.slice(0, VOLE_LENGTH), shares }
}

export interface VoleReceiverOutput {
  /** SECRET beta. */
  readonly beta: bigint
  /** SECRET r_1, r_2. */
  readonly shares: readonly bigint[]
}

/**
 * VOLE.R.ComputeOutput. Fails with `multiplication-check-failed` when the
 * sender's rows are inconsistent; whether that happens can depend on up to
 * `s` bits of `choices`, which is the leakage the paper's proof accounts for.
 *
 * @param choices the receiver's OT choice bits w.
 * @param pads the receiver's OT pads (`VOLE_OT_COUNT x VOLE_COLUMNS` hashes).
 */
export function voleReceive(
  context: Uint8Array,
  extension: Uint8Array,
  choices: Uint8Array,
  pads: Uint8Array,
  message: Uint8Array,
): VoleReceiverOutput {
  if (pads.length !== MATRIX_BYTES) fail('internal-error')
  if (message.length !== VOLE_MESSAGE_BYTES) fail('malformed-message')
  const reader = new Reader(message)
  const matrix = reader.take(MATRIX_BYTES)
  const claimed = reader.take(HASH_BYTES)
  const tail = reader.take(SCALAR_BYTES)
  reader.finish()
  const count = VOLE_OT_COUNT * VOLE_COLUMNS
  // Strict parsing: every scalar of the message is canonical.
  for (let index = 0; index <= count; index += 1) {
    const source = index < count ? matrix : tail
    const offset = index < count ? index * SCALAR_BYTES : 0
    let hex = '0x'
    for (let at = offset; at < offset + SCALAR_BYTES; at += 1) {
      hex += HEX[source[at] ?? 0]
    }
    if (BigInt(hex) >= q) fail('out-of-range')
  }
  const s = scalars(pads, count)
  const big = scalars(matrix, count)
  const v = scalarAt(tail, 0)
  // 3a: R = S + w * Q. The product with the choice bit avoids a branch.
  const rows: bigint[] = []
  const w: bigint[] = []
  for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
    const choice = BigInt(bit(choices, j))
    w.push(choice)
    for (let c = 0; c < VOLE_COLUMNS; c += 1) {
      const index = j * VOLE_COLUMNS + c
      rows.push(((s[index] ?? 0n) + choice * (big[index] ?? 0n)) % q)
    }
  }
  // 3b-3d: u'_j = <R_j, chi> - w_j * v.
  const chi = challenge(context, extension, matrix)
  const u: bigint[] = []
  for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
    let sum = rows[j * VOLE_COLUMNS + VOLE_LENGTH] ?? 0n
    for (let c = 0; c < VOLE_LENGTH; c += 1) {
      sum += (chi[c] ?? 0n) * (rows[j * VOLE_COLUMNS + c] ?? 0n)
    }
    sum += (w[j] ?? 0n) * (q - v)
    u.push(sum % q)
  }
  const good = equalBytes(checkHash(context, u), claimed)
  u.fill(0n)
  s.fill(0n)
  if (!good) {
    rows.fill(0n)
    fail('multiplication-check-failed')
  }
  // 3e-3g: beta = <g, w>, r_c = sum_j g_j * R[j][c].
  const g = gadget(context, extension, message)
  let beta = 0n
  for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
    beta += (g[j] ?? 0n) * (w[j] ?? 0n)
  }
  beta %= q
  const shares: bigint[] = []
  for (let c = 0; c < VOLE_LENGTH; c += 1) {
    let sum = 0n
    for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
      sum += (g[j] ?? 0n) * (rows[j * VOLE_COLUMNS + c] ?? 0n)
    }
    shares.push(sum % q)
  }
  rows.fill(0n)
  w.fill(0n)
  return { beta, shares }
}
