/**
 * The hot kernels, behind one interface so that a WebAssembly implementation
 * can replace the TypeScript one without touching protocol code. Every
 * function is a pure function of its arguments and must produce byte-identical
 * output in every implementation.
 *
 *  - `otReceiverPoints`, `otSenderPoints`: the two batches of 128 scalar
 *    multiplications of the base OT (key generation). Measured as the only
 *    part of the protocol where TypeScript misses the target; a Rust
 *    implementation compiled to WebAssembly is in `kernel-wasm/`.
 *  - `hashRows`: the OT-extension pad hash over many rows (signing).
 *    TypeScript only; it is not a bottleneck.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'

import {
  G,
  multiply,
  parsePoint,
  parseScalar,
  pointBytes,
  type Point,
} from './group.js'
import { fail } from './result.js'

export interface Kernel {
  readonly name: string
  /**
   * Base-OT receiver. For every j < count: `A_j = a_j*G + choice_j*B` and the
   * shared point `a_j*B`.
   *
   * @param senderKey B, 33 bytes.
   * @param choices bit j, least significant first within each byte.
   * @param scalars `count x 32` bytes, each a canonical scalar in [1, q).
   * @returns `count x (A_j (33) || a_j*B (33))`.
   */
  otReceiverPoints(
    senderKey: Uint8Array,
    choices: Uint8Array,
    scalars: Uint8Array,
    count: number,
  ): Uint8Array
  /**
   * Base-OT sender. For every j < count: `b*A_j` and `b*A_j - b*B`.
   * Fails with `invalid-point` if any input is not a point or any result is
   * the identity (which happens exactly when `A_j = B`).
   *
   * @param secret b, 32 bytes.
   * @param senderKey B, 33 bytes.
   * @param encoded `count x 33` bytes, the A_j.
   * @returns `count x (b*A_j (33) || (b*A_j - b*B) (33))`.
   */
  otSenderPoints(
    secret: Uint8Array,
    senderKey: Uint8Array,
    encoded: Uint8Array,
    count: number,
  ): Uint8Array
  /**
   * For every row `j < rows` and column `c < columns`:
   * `SHA256(prefix || j (4, big-endian) || c (1) || data[j*width .. (j+1)*width))`,
   * concatenated in row-major order (32 bytes each).
   */
  hashRows(
    prefix: Uint8Array,
    data: Uint8Array,
    width: number,
    rows: number,
    columns: number,
  ): Uint8Array
}

const POINT = 33
const SCALAR = 32

function hashRows(
  prefix: Uint8Array,
  data: Uint8Array,
  width: number,
  rows: number,
  columns: number,
): Uint8Array {
  const out = new Uint8Array(rows * columns * 32)
  const base = sha256.create().update(prefix)
  const suffix = new Uint8Array(5 + width)
  for (let row = 0; row < rows; row += 1) {
    suffix[0] = (row >>> 24) & 0xff
    suffix[1] = (row >>> 16) & 0xff
    suffix[2] = (row >>> 8) & 0xff
    suffix[3] = row & 0xff
    suffix.set(data.subarray(row * width, (row + 1) * width), 5)
    for (let column = 0; column < columns; column += 1) {
      suffix[4] = column
      out.set(
        base.clone().update(suffix).digest(),
        (row * columns + column) * 32,
      )
    }
  }
  suffix.fill(0)
  return out
}

/** The 33-byte encoding, failing with `invalid-point` for the identity. */
function encode(point: Point): Uint8Array {
  try {
    point.assertValidity()
  } catch {
    return fail('invalid-point')
  }
  return pointBytes(point)
}

export const typescriptKernel: Kernel = {
  name: 'typescript',

  otReceiverPoints(senderKey, choices, scalars, count) {
    const B = parsePoint(senderKey)
    // A window table for B makes the remaining multiplications several times
    // faster. The generator already has one.
    const table = secp256k1.utils.precompute(
      4,
      secp256k1.ProjectivePoint.fromHex(senderKey),
    )
    const out = new Uint8Array(count * 2 * POINT)
    for (let j = 0; j < count; j += 1) {
      const scalar = parseScalar(scalars.subarray(j * SCALAR, (j + 1) * SCALAR))
      const plain = multiply(G, scalar)
      // Both candidates are computed; the choice only selects.
      const shifted = plain.add(B)
      const chosen = ((choices[j >> 3] ?? 0) >> (j & 7)) & 1
      out.set(encode(chosen === 1 ? shifted : plain), j * 2 * POINT)
      out.set(encode(multiply(table, scalar)), j * 2 * POINT + POINT)
    }
    return out
  },

  otSenderPoints(secret, senderKey, encoded, count) {
    const b = parseScalar(secret)
    const offset = multiply(parsePoint(senderKey), b)
    const out = new Uint8Array(count * 2 * POINT)
    for (let j = 0; j < count; j += 1) {
      const point = parsePoint(encoded.subarray(j * POINT, (j + 1) * POINT))
      const product = multiply(point, b)
      out.set(encode(product), j * 2 * POINT)
      out.set(encode(product.subtract(offset)), j * 2 * POINT + POINT)
    }
    return out
  },

  hashRows,
}

// The package compiles without DOM or Node typings; this is all it needs.
declare const WebAssembly: {
  instantiate(
    bytes: Uint8Array,
    imports: Record<string, never>,
  ): Promise<{ readonly instance: { readonly exports: unknown } }>
}

/** The exports of `kernel-wasm` (see its `src/lib.rs` for the ABI). */
interface WasmExports {
  readonly memory: { readonly buffer: ArrayBuffer }
  input_ptr(): number
  output_ptr(): number
  input_len(): number
  output_len(): number
  wipe(): void
  ot_receiver_points(count: number): number
  ot_sender_points(count: number): number
}

/**
 * Wraps the compiled `kernel-wasm/dkls_kernel.wasm`. The two curve batches
 * run in WebAssembly (constant-time `k256` arithmetic); hashing stays in
 * TypeScript, where it is not a bottleneck. Its output is byte-identical to
 * `typescriptKernel`'s, which the test suite checks.
 */
export async function loadWasmKernel(bytes: Uint8Array): Promise<Kernel> {
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const wasm = instance.exports as WasmExports
  const capacity = wasm.input_len()
  const call = (
    input: readonly Uint8Array[],
    count: number,
    run: (count: number) => number,
  ): Uint8Array => {
    let length = 0
    for (const part of input) length += part.length
    if (length > capacity || count * 2 * POINT > wasm.output_len()) {
      fail('internal-error')
    }
    try {
      // The view is taken per call: memory growth would detach an old one.
      const memory = new Uint8Array(wasm.memory.buffer)
      let offset = wasm.input_ptr()
      for (const part of input) {
        memory.set(part, offset)
        offset += part.length
      }
      const status = run(count)
      // Every failure of this kernel is a bad point or scalar in the input.
      if (status !== 0) fail('invalid-point')
      const start = wasm.output_ptr()
      return new Uint8Array(wasm.memory.buffer).slice(
        start,
        start + count * 2 * POINT,
      )
    } finally {
      wasm.wipe()
    }
  }
  return {
    name: 'wasm',
    otReceiverPoints(senderKey, choices, scalars, count) {
      if (
        senderKey.length !== POINT ||
        choices.length !== 16 ||
        scalars.length !== count * SCALAR
      ) {
        fail('internal-error')
      }
      return call([senderKey, choices, scalars], count, wasm.ot_receiver_points)
    },
    otSenderPoints(secret, senderKey, encoded, count) {
      if (
        secret.length !== SCALAR ||
        senderKey.length !== POINT ||
        encoded.length !== count * POINT
      ) {
        fail('internal-error')
      }
      return call([secret, senderKey, encoded], count, wasm.ot_sender_points)
    },
    hashRows,
  }
}

let active: Kernel = typescriptKernel

/** The kernel protocol code uses. */
export function kernel(): Kernel {
  return active
}

/**
 * Installs another kernel (for example a WebAssembly one). It must be
 * byte-identical to `typescriptKernel`; the test suite checks any kernel
 * against it.
 */
export function useKernel(replacement: Kernel): void {
  active = replacement
}
