/**
 * OT extension: SoftSpokenOT with k = 1 (Roy, ePrint 2022/192), which for
 * p = q = 2 and the length-128 repetition code is the IKNP shape with Roy's
 * consistency check.
 *
 *  - Subspace VOLE correction: Fig. 8 with C = Rep(F_2^128). The receiver's
 *    choice bits are the first column; it sends the 127 syndrome columns.
 *  - Consistency check: Fig. 9 with the hash family R = [X | 1_m], X uniform
 *    in F_2^{m x l} (the OOS shape, proven by Theorem 4.5 with advantage
 *    2 * 2^-m). X is derived by Fiat-Shamir from the correction, as in
 *    DKLs23 section 5.1; the statistical parameter therefore becomes
 *    computational and m = 136. V~ is sent hashed (section 4.2,
 *    "Optimizations").
 *  - Hashing to OT messages: Fig. 11 with a unique tweak per OT.
 *
 * Roles. The extension RECEIVER holds both seeds of every base OT (it was
 * the base-OT sender) and ends with choice bits and one pad per OT. The
 * extension SENDER holds Delta and one seed per base OT (it was the base-OT
 * receiver) and ends with both pads per OT.
 *
 * REUSE POLICY (the one place it is decided): the base-OT seeds of a key are
 * stretched once per signing session and direction under `extensionNonce`.
 * See that function.
 */
import { bit, concat, equalBytes, intToBytes, Reader } from './bytes.js'
import { BASE_OT_COUNT, CHOICE_BYTES } from './base-ot.js'
import { HASH_BYTES, transcript } from './group.js'
import { kernel } from './kernel.js'
import { fail } from './result.js'

/** Statistical security parameter of the multiplication (Asharov, Claim 5.5). */
export const STATISTICAL_BITS = 60
/**
 * OTs consumed by one multiplication: `log q + 2*kappa + 3*s = 692`, rounded
 * up to a multiple of 8 (Asharov section 5.2, "Concrete parameters").
 */
export const VOLE_OT_COUNT = 696
/** Extra OTs consumed and discarded by the consistency check (Fig. 9). */
export const CHECK_BITS = 136
export const EXTENDED_OT_COUNT = VOLE_OT_COUNT + CHECK_BITS

const COLUMN_BYTES = EXTENDED_OT_COUNT / 8
const HEAD_BYTES = VOLE_OT_COUNT / 8
const CHECK_BYTES = CHECK_BITS / 8
/** One row of the correlation: 128 bits. */
export const ROW_BYTES = BASE_OT_COUNT / 8
export const ROWS_BYTES = VOLE_OT_COUNT * ROW_BYTES

const SYNDROME_BYTES = (BASE_OT_COUNT - 1) * COLUMN_BYTES
export const EXTENSION_MESSAGE_BYTES =
  SYNDROME_BYTES + CHECK_BYTES + HASH_BYTES

/**
 * The nonce under which a key's base-OT seeds are stretched for one
 * extension batch. `binding` must contain the session id, both identities,
 * the key, the digest and at least the extension receiver's own fresh salt,
 * so an honest receiver never stretches twice under one nonce.
 *
 * The extension sender cannot rely on this nonce being fresh (the receiver
 * chooses the salt in it), so the pads it derives additionally hash the full
 * session binding, which contains the sender's own salt: see `padPrefix`.
 */
export function extensionNonce(
  binding: Uint8Array,
  receiverId: Uint8Array,
  senderId: Uint8Array,
): Uint8Array {
  return transcript('otx/nonce', binding, receiverId, senderId)
}

/** The pad-hash prefix: full session binding (both salts) and direction. */
export function padPrefix(
  fullBinding: Uint8Array,
  receiverId: Uint8Array,
  senderId: Uint8Array,
): Uint8Array {
  return transcript('otx/pad', fullBinding, receiverId, senderId)
}

/** `EXTENDED_OT_COUNT` pseudorandom bits from one seed under one nonce. */
function stretch(seed: Uint8Array, nonce: Uint8Array): Uint8Array {
  const out = new Uint8Array(COLUMN_BYTES)
  for (let block = 0; block * HASH_BYTES < COLUMN_BYTES; block += 1) {
    const bytes = transcript('otx/prg', nonce, seed, intToBytes(block, 4))
    out.set(
      bytes.subarray(0, Math.min(HASH_BYTES, COLUMN_BYTES - block * HASH_BYTES)),
      block * HASH_BYTES,
    )
    bytes.fill(0)
  }
  return out
}

/** The hash matrix X of the check: `CHECK_BITS` rows of `VOLE_OT_COUNT` bits. */
function checkMatrix(nonce: Uint8Array, syndrome: Uint8Array): Uint8Array[] {
  const seed = transcript('otx/check', nonce, transcript('otx/syndrome', syndrome))
  const rows: Uint8Array[] = []
  for (let a = 0; a < CHECK_BITS; a += 1) {
    const row = new Uint8Array(HEAD_BYTES)
    for (let block = 0; block * HASH_BYTES < HEAD_BYTES; block += 1) {
      const bytes = transcript(
        'otx/check-row',
        seed,
        intToBytes(a, 4),
        intToBytes(block, 4),
      )
      row.set(
        bytes.subarray(0, Math.min(HASH_BYTES, HEAD_BYTES - block * HASH_BYTES)),
        block * HASH_BYTES,
      )
    }
    rows.push(row)
  }
  return rows
}

const PARITY = new Uint8Array(256)
for (let value = 1; value < 256; value += 1) {
  PARITY[value] = (PARITY[value >> 1] ?? 0) ^ (value & 1)
}

/**
 * One output bit of `R = [X | 1]` applied to a column of `EXTENDED_OT_COUNT`
 * bits: the inner product of row `a` of X with the first `VOLE_OT_COUNT` bits,
 * plus bit `VOLE_OT_COUNT + a`.
 */
function hashBit(row: Uint8Array, a: number, column: Uint8Array): number {
  let folded = 0
  for (let index = 0; index < HEAD_BYTES; index += 1) {
    folded ^= (row[index] ?? 0) & (column[index] ?? 0)
  }
  return (PARITY[folded] ?? 0) ^ bit(column, VOLE_OT_COUNT + a)
}

/** `R` applied to all 128 columns: `CHECK_BITS` rows of 128 bits. */
function hashColumns(
  matrix: readonly Uint8Array[],
  columns: readonly Uint8Array[],
): Uint8Array {
  const out = new Uint8Array(CHECK_BITS * ROW_BYTES)
  for (let a = 0; a < CHECK_BITS; a += 1) {
    const row = matrix[a]
    if (row === undefined) fail('internal-error')
    for (let i = 0; i < BASE_OT_COUNT; i += 1) {
      const column = columns[i]
      if (column === undefined) fail('internal-error')
      const index = a * ROW_BYTES + (i >> 3)
      out[index] = (out[index] ?? 0) | (hashBit(row, a, column) << (i & 7))
    }
  }
  return out
}

/** Rows `j < VOLE_OT_COUNT` of the matrix whose columns are given. */
function transpose(columns: readonly Uint8Array[]): Uint8Array {
  const rows = new Uint8Array(ROWS_BYTES)
  for (let i = 0; i < BASE_OT_COUNT; i += 1) {
    const column = columns[i]
    if (column === undefined) fail('internal-error')
    const byte = i >> 3
    const shift = i & 7
    for (let j = 0; j < VOLE_OT_COUNT; j += 1) {
      const index = j * ROW_BYTES + byte
      rows[index] = (rows[index] ?? 0) | (bit(column, j) << shift)
    }
  }
  return rows
}

function checkHash(nonce: Uint8Array, hashed: Uint8Array): Uint8Array {
  return transcript('otx/check-v', nonce, hashed)
}

export interface ReceiverExtension {
  /** SECRET choice bits of the `VOLE_OT_COUNT` usable OTs. */
  readonly choices: Uint8Array
  /** SECRET rows V_j, `VOLE_OT_COUNT` x 16 bytes. */
  readonly rows: Uint8Array
  /** `syndrome || u~ || H(V~)`. */
  readonly message: Uint8Array
}

/**
 * @param seedPairs `seed0_0 || seed1_0 || seed0_1 || ...`, 128 x 64 bytes.
 */
export function extendReceiver(
  seedPairs: Uint8Array,
  nonce: Uint8Array,
): ReceiverExtension {
  if (seedPairs.length !== 2 * BASE_OT_COUNT * HASH_BYTES) {
    fail('internal-error')
  }
  const zeros: Uint8Array[] = []
  const sums: Uint8Array[] = []
  for (let i = 0; i < BASE_OT_COUNT; i += 1) {
    const zero = stretch(
      seedPairs.subarray(2 * i * HASH_BYTES, (2 * i + 1) * HASH_BYTES),
      nonce,
    )
    const one = stretch(
      seedPairs.subarray((2 * i + 1) * HASH_BYTES, (2 * i + 2) * HASH_BYTES),
      nonce,
    )
    for (let index = 0; index < COLUMN_BYTES; index += 1) {
      one[index] = (one[index] ?? 0) ^ (zero[index] ?? 0)
    }
    zeros.push(zero)
    sums.push(one)
  }
  // Fig. 8: the choice vector is column 0 of U'; the syndrome is every other
  // column plus column 0.
  const all = sums[0]
  if (all === undefined) return fail('internal-error')
  const syndrome = new Uint8Array(SYNDROME_BYTES)
  for (let i = 1; i < BASE_OT_COUNT; i += 1) {
    const sum = sums[i]
    if (sum === undefined) return fail('internal-error')
    for (let index = 0; index < COLUMN_BYTES; index += 1) {
      syndrome[(i - 1) * COLUMN_BYTES + index] =
        (sum[index] ?? 0) ^ (all[index] ?? 0)
    }
  }
  // Fig. 9.
  const matrix = checkMatrix(nonce, syndrome)
  const hashedChoices = new Uint8Array(CHECK_BYTES)
  for (let a = 0; a < CHECK_BITS; a += 1) {
    const row = matrix[a]
    if (row === undefined) return fail('internal-error')
    const index = a >> 3
    hashedChoices[index] =
      (hashedChoices[index] ?? 0) | (hashBit(row, a, all) << (a & 7))
  }
  const hashedRows = hashColumns(matrix, zeros)
  const message = concat(syndrome, hashedChoices, checkHash(nonce, hashedRows))
  const rows = transpose(zeros)
  const choices = all.slice(0, HEAD_BYTES)
  hashedRows.fill(0)
  for (const column of zeros) column.fill(0)
  for (const column of sums) column.fill(0)
  return { choices, rows, message }
}

/**
 * Verifies the receiver's message and returns the sender's rows
 * `W_j = V_j xor x_j * Delta`. Fails with `ot-extension-check-failed`; after
 * that failure the caller must never use `delta` or `seeds` again.
 *
 * @param delta 16 bytes, the base-OT choice bits.
 * @param seeds 128 x 32 bytes, `seed_i^{Delta_i}`.
 */
export function extendSender(
  delta: Uint8Array,
  seeds: Uint8Array,
  nonce: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  if (
    delta.length !== CHOICE_BYTES ||
    seeds.length !== BASE_OT_COUNT * HASH_BYTES
  ) {
    fail('internal-error')
  }
  if (message.length !== EXTENSION_MESSAGE_BYTES) fail('malformed-message')
  const reader = new Reader(message)
  const syndrome = reader.take(SYNDROME_BYTES)
  const hashedChoices = reader.take(CHECK_BYTES)
  const claimed = reader.take(HASH_BYTES)
  reader.finish()

  const columns: Uint8Array[] = []
  for (let i = 0; i < BASE_OT_COUNT; i += 1) {
    const column = stretch(
      seeds.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES),
      nonce,
    )
    if (i > 0) {
      // Masked rather than branched on the secret bit.
      const mask = -bit(delta, i) & 0xff
      const offset = (i - 1) * COLUMN_BYTES
      for (let index = 0; index < COLUMN_BYTES; index += 1) {
        column[index] =
          (column[index] ?? 0) ^ ((syndrome[offset + index] ?? 0) & mask)
      }
    }
    columns.push(column)
  }
  const matrix = checkMatrix(nonce, syndrome)
  const expected = hashColumns(matrix, columns)
  for (let a = 0; a < CHECK_BITS; a += 1) {
    const mask = -bit(hashedChoices, a) & 0xff
    for (let index = 0; index < ROW_BYTES; index += 1) {
      const at = a * ROW_BYTES + index
      expected[at] = (expected[at] ?? 0) ^ ((delta[index] ?? 0) & mask)
    }
  }
  const good = equalBytes(checkHash(nonce, expected), claimed)
  expected.fill(0)
  if (!good) {
    for (const column of columns) column.fill(0)
    fail('ot-extension-check-failed')
  }
  const rows = transpose(columns)
  for (const column of columns) column.fill(0)
  return rows
}

/** The receiver's pads: `VOLE_OT_COUNT x columns` hashes of 32 bytes. */
export function receiverPads(
  prefix: Uint8Array,
  rows: Uint8Array,
  columns: number,
): Uint8Array {
  return kernel().hashRows(prefix, rows, ROW_BYTES, VOLE_OT_COUNT, columns)
}

/** The sender's two pad matrices, for choice bit 0 and choice bit 1. */
export function senderPadPairs(
  prefix: Uint8Array,
  rows: Uint8Array,
  delta: Uint8Array,
  columns: number,
): { readonly zero: Uint8Array; readonly one: Uint8Array } {
  const shifted = new Uint8Array(rows.length)
  for (let index = 0; index < rows.length; index += 1) {
    shifted[index] = (rows[index] ?? 0) ^ (delta[index % ROW_BYTES] ?? 0)
  }
  const zero = kernel().hashRows(prefix, rows, ROW_BYTES, VOLE_OT_COUNT, columns)
  const one = kernel().hashRows(
    prefix,
    shifted,
    ROW_BYTES,
    VOLE_OT_COUNT,
    columns,
  )
  shifted.fill(0)
  return { zero, one }
}
