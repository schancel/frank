import { readFileSync } from 'fs'
import { join } from 'path'

import { hedgedScalar, G, multiply, pointBytes, scalarBytes } from './group.js'
import {
  kernel,
  loadWasmKernel,
  typescriptKernel,
  useKernel,
  type Kernel,
} from './kernel.js'
import { failureCode } from './result.js'
import { deterministicStream } from './rng.js'
import { hex, makeKeys, runSign, rng } from './test-support.js'

const WASM = join(__dirname, '..', 'kernel-wasm', 'dkls_kernel.wasm')

function code(run: () => unknown): string {
  try {
    run()
    return 'ok'
  } catch (error) {
    return failureCode(error)
  }
}

describe('the WebAssembly kernel', () => {
  let wasm: Kernel
  const stream = deterministicStream('kernel-test', new Uint8Array(32))
  const count = 128
  const secret = scalarBytes(hedgedScalar(stream, 'b', new Uint8Array(0)))
  const senderKey = pointBytes(
    multiply(G, BigInt('0x' + hex(secret))),
  )
  const choices = stream(16)
  const scalars = new Uint8Array(count * 32)
  for (let j = 0; j < count; j += 1) {
    scalars.set(
      scalarBytes(hedgedScalar(stream, 'a', Uint8Array.of(j))),
      j * 32,
    )
  }

  beforeAll(async () => {
    wasm = await loadWasmKernel(new Uint8Array(readFileSync(WASM)))
  })

  it('is byte-identical to the TypeScript kernel on both batches', () => {
    const tsReceiver = typescriptKernel.otReceiverPoints(
      senderKey,
      choices,
      scalars,
      count,
    )
    const wasmReceiver = wasm.otReceiverPoints(senderKey, choices, scalars, count)
    expect(hex(wasmReceiver)).toBe(hex(tsReceiver))
    const encoded = new Uint8Array(count * 33)
    for (let j = 0; j < count; j += 1) {
      encoded.set(tsReceiver.subarray(j * 66, j * 66 + 33), j * 33)
    }
    const tsSender = typescriptKernel.otSenderPoints(
      secret,
      senderKey,
      encoded,
      count,
    )
    const wasmSender = wasm.otSenderPoints(secret, senderKey, encoded, count)
    expect(hex(wasmSender)).toBe(hex(tsSender))
    // And the two batches agree with each other as the OT requires: the
    // receiver's shared point is the sender's pad point for its choice bit.
    for (let j = 0; j < count; j += 1) {
      const chosen = ((choices[j >> 3] ?? 0) >> (j & 7)) & 1
      expect(hex(tsReceiver.subarray(j * 66 + 33, j * 66 + 66))).toBe(
        hex(tsSender.subarray(j * 66 + 33 * chosen, j * 66 + 33 * chosen + 33)),
      )
    }
  })

  it('rejects the same bad inputs as the TypeScript kernel', () => {
    const encoded = new Uint8Array(count * 33)
    const good = typescriptKernel.otReceiverPoints(
      senderKey,
      choices,
      scalars,
      count,
    )
    for (let j = 0; j < count; j += 1) {
      encoded.set(good.subarray(j * 66, j * 66 + 33), j * 33)
    }
    const offCurve = encoded.slice()
    offCurve[0] = 0x04
    const notOnCurve = encoded.slice()
    notOnCurve.fill(0xff, 1, 33)
    const equalsKey = encoded.slice()
    equalsKey.set(senderKey, 33 * 7)
    for (const one of [typescriptKernel, wasm]) {
      for (const bad of [offCurve, notOnCurve, equalsKey]) {
        expect(
          code(() => one.otSenderPoints(secret, senderKey, bad, count)),
        ).toMatch(/invalid-point/)
      }
    }
    const zeroScalar = scalars.slice()
    zeroScalar.fill(0, 64, 96)
    expect(
      code(() =>
        typescriptKernel.otReceiverPoints(senderKey, choices, zeroScalar, count),
      ),
    ).not.toBe('ok')
    expect(
      code(() => wasm.otReceiverPoints(senderKey, choices, zeroScalar, count)),
    ).not.toBe('ok')
    // The wasm buffers are wiped after every call, including failed ones.
    expect(
      hex(wasm.otReceiverPoints(senderKey, choices, scalars, count)),
    ).toBe(hex(good))
  })

  it('runs whole key generations and signatures, mixed with the TypeScript kernel', () => {
    try {
      useKernel(wasm)
      expect(kernel().name).toBe('wasm')
      const { keys, trace } = makeKeys()
      // eslint-disable-next-line no-console
      console.info(
        `keygen with the wasm kernel: initiator ` +
          `${trace.initiator.elapsed.toFixed(0)} ms, responder ` +
          `${trace.responder.elapsed.toFixed(0)} ms`,
      )
      useKernel(typescriptKernel)
      expect(runSign(keys, rng(32)).failure).toBeNull()
    } finally {
      useKernel(typescriptKernel)
    }
  })

  it('produces the same key generation transcript as the TypeScript kernel', () => {
    const run = (one: Kernel): string[] => {
      useKernel(one)
      try {
        const seed = new Uint8Array(32).fill(7)
        const { trace } = makeKeys(
          undefined,
          deterministicStream('kernel-transcript', seed),
          seed,
        )
        return trace.messages.map(hex)
      } finally {
        useKernel(typescriptKernel)
      }
    }
    expect(run(wasm)).toEqual(run(typescriptKernel))
  })
})
