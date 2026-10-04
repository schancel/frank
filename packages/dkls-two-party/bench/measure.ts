/**
 * Measurements for the README's cost table. Run from this package:
 *
 *   TSX_TSCONFIG_PATH=tsconfig.json node --import tsx bench/measure.ts [rounds] [wasm]
 *
 * Single process, both parties in turn; each party's time is the wall time
 * spent inside its own calls.
 */
import { randomBytes as nodeRandomBytes } from 'crypto'
import { loadavg } from 'os'

import {
  createCommitmentLock,
  keygenStep,
  signStep,
  startKeygen,
  startSign,
  type AdaptorLock,
  type DklsResult,
  type KeyShare,
  type LockOpening,
  type RoleName,
  type Step,
} from '../src/index.js'
import { readFileSync } from 'fs'

import { kernel, loadWasmKernel, useKernel } from '../src/kernel.js'

const rng = (length: number): Uint8Array => new Uint8Array(nodeRandomBytes(length))
const ids = { initiator: Uint8Array.of(1), responder: Uint8Array.of(2) }

function must<T>(result: DklsResult<T>): T {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

interface Run<R> {
  initiator: number
  responder: number
  sizes: number[]
  results: { initiator: R; responder: R }
  perStep: number[]
}

function drive<S, R>(
  start: (role: RoleName) => DklsResult<Step<S, R>>,
  step: (session: S, message: Uint8Array) => DklsResult<Step<S, R>>,
): Run<R> {
  const time = { initiator: 0, responder: 0 }
  const perStep: number[] = []
  const timed = <T>(role: RoleName, call: () => T): T => {
    const started = performance.now()
    const value = call()
    const elapsed = performance.now() - started
    time[role] += elapsed
    perStep.push(elapsed)
    return value
  }
  const a = must(timed('initiator', () => start('initiator')))
  const b = must(timed('responder', () => start('responder')))
  const sessions = { initiator: a.session, responder: b.session }
  const results: { initiator: R | null; responder: R | null } = {
    initiator: null,
    responder: null,
  }
  const sizes: number[] = []
  let outgoing = a.outgoing
  let to: RoleName = 'responder'
  while (outgoing !== null) {
    sizes.push(outgoing.length)
    const message = outgoing
    const stepped = must(timed(to, () => step(sessions[to], message)))
    sessions[to] = stepped.session
    results[to] = stepped.result ?? results[to]
    outgoing = stepped.outgoing
    to = to === 'initiator' ? 'responder' : 'initiator'
  }
  if (results.initiator === null || results.responder === null) {
    throw new Error('no result')
  }
  return {
    ...time,
    sizes,
    perStep,
    results: { initiator: results.initiator, responder: results.responder },
  }
}

function keygen(): Run<KeyShare> {
  const sessionId = rng(32)
  return drive(
    role =>
      startKeygen({
        role,
        sessionId,
        localId: ids[role],
        peerId: ids[role === 'initiator' ? 'responder' : 'initiator'],
        randomBytes: rng,
      }),
    keygenStep,
  )
}

function sign(
  keys: { initiator: KeyShare; responder: KeyShare },
  lock?: AdaptorLock,
  lockOpening?: LockOpening,
) {
  const sessionId = rng(32)
  const digest = rng(32)
  return drive(
    role =>
      startSign({
        keyShare: keys[role],
        role,
        sessionId,
        digest,
        lock,
        lockOpening: role === 'responder' ? lockOpening : undefined,
        randomBytes: rng,
      }),
    signStep,
  )
}

function report(label: string, runs: Run<unknown>[]): void {
  const median = (values: number[]): number =>
    [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0
  const steps = runs[0]?.perStep.map((_, index) =>
    median(runs.map(run => run.perStep[index] ?? 0)).toFixed(0),
  )
  console.log(
    `${label}: initiator ${median(runs.map(run => run.initiator)).toFixed(0)} ms, ` +
      `responder ${median(runs.map(run => run.responder)).toFixed(0)} ms ` +
      `(median of ${runs.length}); sizes ${runs[0]?.sizes.join('/')}; ` +
      `per call ${steps?.join('/')} ms`,
  )
}

const rounds = Number(process.argv[2] ?? 5)
if (process.argv[3] === 'wasm') {
  useKernel(
    await loadWasmKernel(
      new Uint8Array(
        readFileSync(new URL('../kernel-wasm/dkls_kernel.wasm', import.meta.url)),
      ),
    ),
  )
}
console.log(
  `kernel ${kernel().name}; node ${process.version}; load average ` +
    loadavg().map(value => value.toFixed(1)).join(' '),
)
keygen() // warm up
const keygens: Run<KeyShare>[] = []
for (let index = 0; index < rounds; index += 1) keygens.push(keygen())
report('key generation', keygens)
const keys = keygens[0]?.results
if (keys === undefined) throw new Error('no keys')
sign(keys)
const signs = []
for (let index = 0; index < rounds * 2; index += 1) signs.push(sign(keys))
report('signing', signs)
const material = must(
  createCommitmentLock({ keyShare: keys.responder, value: 7, randomBytes: rng }),
)
const lock: AdaptorLock = {
  kind: 'commitment',
  commitment: material.commitment,
  proof: material.proof,
  index: 7,
}
const pres = []
for (let index = 0; index < rounds * 2; index += 1) {
  pres.push(sign(keys, lock, material.opening))
}
report('pre-signing', pres)
console.log(`load average after ${loadavg().map(value => value.toFixed(1)).join(' ')}`)
