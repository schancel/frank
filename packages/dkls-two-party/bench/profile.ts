/** Where signing time goes. `TSX_TSCONFIG_PATH=tsconfig.json node --import tsx bench/profile.ts` */
import { randomBytes } from 'crypto'

import { BASE_OT_COUNT } from '../src/base-ot.js'
import {
  extendReceiver,
  extendSender,
  receiverPads,
  senderPadPairs,
} from '../src/ot-extension.js'
import { voleReceive, voleSend, VOLE_COLUMNS } from '../src/vole.js'

const rng = (n: number): Uint8Array => new Uint8Array(randomBytes(n))
const pairs = rng(BASE_OT_COUNT * 64)
const delta = rng(16)
const seeds = new Uint8Array(BASE_OT_COUNT * 32)
for (let i = 0; i < BASE_OT_COUNT; i += 1) {
  const choice = (delta[i >> 3]! >> (i & 7)) & 1
  seeds.set(pairs.subarray((2 * i + choice) * 32, (2 * i + choice + 1) * 32), i * 32)
}
function time<T>(label: string, call: () => T): T {
  call()
  const runs = 5
  const started = performance.now()
  let value = call()
  for (let i = 1; i < runs; i += 1) value = call()
  console.log(label.padEnd(28), ((performance.now() - started) / runs).toFixed(1), 'ms')
  return value
}
const nonce = rng(32)
const receiver = time('extendReceiver', () => extendReceiver(pairs, nonce))
const rows = time('extendSender', () => extendSender(delta, seeds, nonce, receiver.message))
const prefix = rng(32)
const padPairs = time('senderPadPairs (4176 hashes)', () => senderPadPairs(prefix, rows, delta, VOLE_COLUMNS))
const pads = time('receiverPads (2088 hashes)', () => receiverPads(prefix, receiver.rows, VOLE_COLUMNS))
const context = rng(32)
const sent = time('voleSend', () => voleSend(rng, context, nonce, padPairs.zero, padPairs.one))
time('voleReceive', () => voleReceive(context, nonce, receiver.choices, pads, sent.message))
