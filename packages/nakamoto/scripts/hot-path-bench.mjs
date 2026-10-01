// Hot-path benchmark. Issue 255.
//
// Command, after yarn install, from the repo root:
//   yarn workspace @frank/nakamoto bench
// From packages/nakamoto:
//   yarn bench
//
// .github/workflows/nakamoto.yml does not run this file. `yarn test` does
// not run it either. The full timing stays off the push path.
//
// The baseline is the Phase 0 table in docs/nakamoto-audit.md, recorded on
// Node v26.8.2, arm64, darwin. This process prints a measurement of the
// installed backend. It does not replace that table and it does not change
// the default backend (cryptoBackend).
//
// Shapes follow that table. HMAC key and message lengths were not recorded
// there; this run uses 32 and 32. Point add goes through the backend, so
// the points are compressed on the way in and out. The audit's noble
// point-add range was projective and did not re-encode. 2,048 is a power
// of two, so the merkle odd-level rule is not on this path. The chain
// argument is BTC mainnet only to pick a descriptor.
// Hash, base58, cashaddr, and point-add loops are HASH_ITERS. Sign, verify,
// and ECDH are SIGN_ITERS. The merkle loop is MERKLE_ITERS.

import { performance } from 'node:perf_hooks'

import { encodeCashaddr } from '../dist/cashaddr.js'
import {
  BTC_MAINNET,
  cryptoBackend,
  encodeBase58,
  internalHashFromBytes,
  merkleRoot,
  privateKeyFromSecretBytes,
  publicFromPrivate,
} from '../dist/index.js'

const HASH_ITERS = 20000
const SIGN_ITERS = 400
const MERKLE_ITERS = 200
const WARMUP = 20

let sink = 0

function keep(value) {
  if (value === true || value === false) {
    sink ^= value ? 1 : 2
    return
  }
  if (typeof value === 'string') {
    sink ^= value.length
    return
  }
  sink ^= value.length
  sink ^= value[0] ?? 0
}

function must(result, label) {
  if (!result || result.ok !== true) {
    const code = result && result.error ? result.error.code : 'failed'
    throw new Error(`${label}: ${code}`)
  }
  return result.value
}

function scalar(last) {
  const bytes = new Uint8Array(32)
  bytes[31] = last
  return bytes
}

function fill(length, byte) {
  const bytes = new Uint8Array(length)
  bytes.fill(byte)
  return bytes
}

function time(label, iterations, fn) {
  const warmup = Math.min(WARMUP, iterations)
  for (let index = 0; index < warmup; index += 1) fn()
  const start = performance.now()
  for (let index = 0; index < iterations; index += 1) fn()
  const elapsed = performance.now() - start
  const rate = elapsed > 0 ? Math.round((iterations * 1000) / elapsed) : 0
  console.log(
    [
      label.padEnd(42),
      `${String(rate).padStart(10)} ops/s`,
      `${String(iterations).padStart(8)} iters`,
      `${elapsed.toFixed(1).padStart(9)} ms`,
    ].join('  '),
  )
}

function citeBaseline() {
  console.log(
    `runtime: Node ${process.version} ${process.arch} ${process.platform}`,
  )
  console.log(`backend: ${cryptoBackend.name}`)
  console.log(
    'baseline: docs/nakamoto-audit.md Phase 0 table (Node v26.8.2, arm64, darwin). This run is not a new baseline.',
  )
  console.log('Phase 0 audit baseline (cited, not measured here):')
  console.log(
    '  SHA-256d 80-byte header ops/s: node:crypto 941000, @noble/hashes 556000, hash-wasm 1829000',
  )
  console.log(
    '  RIPEMD-160 32-byte ops/s: node:crypto 1928000, @noble/hashes 1079000, hash-wasm 2578000',
  )
  console.log(
    '  HASH160 33-byte ops/s: node:crypto 1048000, @noble/hashes 757000, hash-wasm not timed as a pair',
  )
  console.log(
    '  HMAC-SHA256 ops/s: node:crypto createHmac 155000, @noble/hashes 440000, hash-wasm 808000',
  )
  console.log(
    '  ECDSA sign ops/s: @noble/curves 4200 to 5700, elliptic 1900 to 2600, tiny-secp256k1 6800',
  )
  console.log(
    '  ECDSA verify ops/s: @noble/curves 820 to 970, elliptic 1000 to 1120, tiny-secp256k1 5200',
  )
  console.log(
    '  ECDH ops/s: @noble/curves 480 to 620, elliptic 1370 to 1540, tiny-secp256k1 6300',
  )
  console.log(
    '  point add ops/s: @noble/curves projective 360000 to 486000, elliptic 29000 to 31000, tiny-secp256k1 27000',
  )
  console.log('  Base58-encode 21 bytes ops/s: @scure/base 351000')
  console.log('  CashAddr polymod encode ops/s: local ABC polymod 201000')
  console.log(
    '  Merkle root of 2048 txids ops/s: node:crypto SHA-256d 417, @noble/hashes SHA-256d 260',
  )
}

const header = fill(80, 0)
const ripe = fill(32, 1)
const hash160Input = fill(33, 2)
const hmacKey = fill(32, 3)
const hmacMessage = fill(32, 4)
const base58Payload = fill(21, 5)
const cashaddrPayload = fill(21, 6)
const one = must(privateKeyFromSecretBytes(scalar(1), true), 'scalar-1')
const two = must(privateKeyFromSecretBytes(scalar(2), true), 'scalar-2')
const pointOne = must(publicFromPrivate(one), 'point-1').compressed
const pointTwo = must(publicFromPrivate(two), 'point-2').compressed
const digest = fill(32, 7)
const signature = cryptoBackend.signEcdsa(one.bytes, digest)
const txids = []
for (let index = 0; index < 2048; index += 1) {
  const leaf = new Uint8Array(32)
  leaf[0] = index & 0xff
  leaf[1] = (index >> 8) & 0xff
  leaf[2] = 9
  txids.push(must(internalHashFromBytes(leaf), 'txid'))
}

keep(cryptoBackend.verifyEcdsa(signature, digest, pointOne))
keep(cryptoBackend.pointAdd(pointOne, pointTwo))
keep(must(encodeCashaddr('bitcoincash', cashaddrPayload), 'cashaddr'))
keep(merkleRoot(txids, BTC_MAINNET))

citeBaseline()
console.log('measurement:')
time('SHA-256d of an 80-byte header', HASH_ITERS, () => {
  keep(cryptoBackend.sha256d(header))
})
time('RIPEMD-160 of 32 bytes', HASH_ITERS, () => {
  keep(cryptoBackend.ripemd160(ripe))
})
time('HASH160 of 33 bytes', HASH_ITERS, () => {
  keep(cryptoBackend.hash160(hash160Input))
})
time('HMAC-SHA256', HASH_ITERS, () => {
  keep(cryptoBackend.hmacSha256(hmacKey, hmacMessage))
})
time('ECDSA sign', SIGN_ITERS, () => {
  keep(cryptoBackend.signEcdsa(one.bytes, digest))
})
time('ECDSA verify', SIGN_ITERS, () => {
  keep(cryptoBackend.verifyEcdsa(signature, digest, pointOne))
})
time('ECDH', SIGN_ITERS, () => {
  keep(cryptoBackend.ecdh(two.bytes, pointOne))
})
time('point add', HASH_ITERS, () => {
  keep(cryptoBackend.pointAdd(pointOne, pointTwo))
})
time('Base58-encode 21 bytes', HASH_ITERS, () => {
  keep(encodeBase58(base58Payload))
})
time('CashAddr polymod encode', HASH_ITERS, () => {
  keep(must(encodeCashaddr('bitcoincash', cashaddrPayload), 'cashaddr'))
})
time('Merkle root of 2,048 txids', MERKLE_ITERS, () => {
  keep(merkleRoot(txids, BTC_MAINNET))
})
console.log(`used: ${sink}`)
