// Offline synthetic fixture checks. No custody imports, RPC, funding or broadcast.
import assert from 'node:assert/strict'
import { createHash, createHmac, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { ed25519 } = require('@noble/curves/ed25519')
const {
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
  TransactionMessage,
  SystemInstruction,
} = require('@solana/web3.js')
const fixtures = JSON.parse(
  readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'),
)
const Point = ed25519.ExtendedPoint
const L = ed25519.CURVE.n
const bytes = hex => Buffer.from(hex, 'hex')
const hex = value => Buffer.from(value).toString('hex')
const sha = value => createHash('sha512').update(value).digest()
const integer = raw =>
  BigInt(`0x${Buffer.from(raw).reverse().toString('hex') || '0'}`)
const le = value =>
  Buffer.from(value.toString(16).padStart(64, '0'), 'hex').reverse()
const hs = value => integer(sha(value)) % L
const mul = (point, scalar) =>
  scalar === 0n ? Point.ZERO : point.multiply(scalar)
const encode = point => Buffer.from(point.toRawBytes())

function head(major, n) {
  n = BigInt(n)
  if (n < 24n) return Buffer.from([major * 32 + Number(n)])
  for (const [size, marker] of [
    [1, 24],
    [2, 25],
    [4, 26],
    [8, 27],
  ]) {
    if (n < 1n << BigInt(size * 8)) {
      return Buffer.concat([
        Buffer.from([major * 32 + marker]),
        Buffer.from(n.toString(16).padStart(size * 2, '0'), 'hex'),
      ])
    }
  }
  throw new Error('outside uint64')
}

function cbor(value) {
  if (typeof value === 'number' || typeof value === 'bigint')
    return head(0, value)
  if (typeof value === 'string') {
    const raw = Buffer.from(value)
    return Buffer.concat([head(3, raw.length), raw])
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value])
  if (Array.isArray(value))
    return Buffer.concat([head(4, value.length), ...value.map(cbor)])
  throw new Error('unsupported CBOR value')
}

function strictPoint(raw) {
  assert.equal(raw.length, 32)
  const point = Point.fromHex(raw)
  assert.equal(hex(encode(point)), hex(raw))
  assert(!point.equals(Point.ZERO))
  assert(point.isTorsionFree())
  return point
}

function standardVerify(publicKey, message, signature) {
  const key = createPublicKey({
    format: 'der',
    type: 'spki',
    key: Buffer.concat([bytes('302a300506032b6570032100'), publicKey]),
  })
  return verify(null, message, key, signature)
}

function transcript(v, overrides = {}) {
  const input = { ...v, ...overrides }
  return cbor([
    'frank:solana-stealth:edwards-add:v1',
    input.chainIdentifier,
    input.asset.map(x => (typeof x === 'string' ? bytes(x) : x)),
    bytes(input.B),
    bytes(input.R),
    bytes(input.operationId),
    input.memberIndex,
    bytes(input.messageContext),
    BigInt(input.amount),
  ])
}

let signatures = 0
let parsedTransactions = 0
for (const v of fixtures.vectors) {
  const check = (name, actual) =>
    assert.equal(hex(actual), v[name], `${v.name}: ${name}`)
  const seed = bytes(v.seed)
  const h = sha(seed)
  check('h', h)
  const pruned = Buffer.from(h.subarray(0, 32))
  pruned[0] &= 248
  pruned[31] &= 63
  pruned[31] |= 64
  check('pruned', pruned)
  const b = integer(pruned) % L
  check('b', le(b))
  const extended = ed25519.utils.getExtendedPublicKey(seed)
  assert.equal(extended.scalar, b)
  check('z', extended.prefix)
  const B = strictPoint(bytes(v.B))
  assert(B.equals(mul(Point.BASE, b)))
  check('B', ed25519.getPublicKey(seed))
  const r = integer(bytes(v.r))
  assert(r > 0n && r < L)
  const R = strictPoint(bytes(v.R))
  assert(R.equals(mul(Point.BASE, r)))
  const D = mul(B, r)
  assert(D.equals(mul(R, b)))
  check('senderD', encode(D))
  check('recipientD', encode(D))
  const Q = transcript(v)
  check('Q', Q)
  const tweakInput = cbor(['frank:solana-stealth:tweak:v1', Q, encode(D)])
  check('tweakHash', sha(tweakInput))
  const t = hs(tweakInput)
  check('t', le(t))
  assert(t !== 0n)
  const P = B.add(mul(Point.BASE, t))
  const p = (b + t) % L
  assert(p !== 0n)
  assert(P.equals(mul(Point.BASE, p)))
  strictPoint(encode(P))
  check('P', encode(P))
  check('p', le(p))
  const nonceInput = cbor([
    'frank:solana-stealth:nonce-prefix:v1',
    Q,
    encode(P),
  ])
  check('nonceInput', nonceInput)
  const zP = createHmac('sha512', bytes(v.z))
    .update(nonceInput)
    .digest()
    .subarray(0, 32)
  check('zP', zP)
  for (const s of v.signatures) {
    const M = bytes(s.message)
    const k = hs(Buffer.concat([zP, M]))
    assert.equal(hex(le(k)), s.k)
    const U = encode(mul(Point.BASE, k))
    assert.equal(hex(U), s.U)
    const c = hs(Buffer.concat([U, encode(P), M]))
    assert.equal(hex(le(c)), s.challenge)
    const S = (k + c * p) % L
    assert.equal(hex(le(S)), s.S)
    const signature = Buffer.concat([U, le(S)])
    assert.equal(hex(signature), s.signature)
    assert(
      standardVerify(encode(P), M, signature),
      'independent Node/OpenSSL verification',
    )
    assert(ed25519.verify(signature, M, encode(P), { zip215: false }))
    // A shared-secret-only seed candidate and arbitrary seed keys cannot authorize P.
    for (const wrongSeed of [
      sha(encode(D)).subarray(0, 32),
      seed,
      le(r),
      le(p),
    ]) {
      const wrongSignature = ed25519.sign(M, wrongSeed)
      assert(!standardVerify(encode(P), M, wrongSignature))
    }
    if (M.length) {
      const altered = Buffer.from(M)
      altered[0] ^= 1
      assert(!standardVerify(encode(P), altered, signature))
    }
    signatures++
    if (s.kind === 'solana-v0-native') {
      const message = VersionedMessage.deserialize(M)
      const decoded = TransactionMessage.decompile(message)
      assert.equal(hex(decoded.payerKey.toBytes()), v.P)
      assert.equal(message.header.numRequiredSignatures, 1)
      assert.equal(decoded.instructions.length, 1)
      const transfer = SystemInstruction.decodeTransfer(decoded.instructions[0])
      assert.equal(hex(transfer.fromPubkey.toBytes()), v.P)
      assert.equal(
        hex(transfer.toPubkey.toBytes()),
        hex(Buffer.from(Array.from({ length: 32 }, (_, i) => i + 96))),
      )
      assert.equal(BigInt(transfer.lamports), 1n)
      const transaction = new VersionedTransaction(message)
      transaction.addSignature(new PublicKey(bytes(v.P)), signature)
      const reopened = VersionedTransaction.deserialize(transaction.serialize())
      assert.equal(hex(reopened.message.serialize()), s.message)
      assert(
        standardVerify(
          bytes(v.P),
          reopened.message.serialize(),
          reopened.signatures[0],
        ),
      )
      parsedTransactions++
    }
  }
  for (const alteration of [
    { chainIdentifier: 'solana-mainnet' },
    { memberIndex: v.memberIndex + 10 },
    { amount: (BigInt(v.amount) - 1n).toString() },
    { messageContext: 'ff'.repeat(32) },
    { asset: [1, '11'.repeat(32), '22'.repeat(32)] },
    { B: hex(encode(Point.BASE.negate())) },
  ]) {
    if (JSON.stringify(alteration.asset) === JSON.stringify(v.asset)) continue
    const changed = hs(
      cbor([
        'frank:solana-stealth:tweak:v1',
        transcript(v, alteration),
        encode(D),
      ]),
    )
    assert.notEqual(changed, t, 'descriptor mutation changes tweak')
  }
}
for (const [name, raw] of Object.entries(fixtures.invalidPoints)) {
  assert.throws(() => strictPoint(bytes(raw)), undefined, name)
}
const original = fixtures.vectors.find(v => v.name === 'native-0-0')
const related = fixtures.vectors.find(
  v => v.name === 'native-changed-context-index',
)
assert.notEqual(original.zP, related.zP)
assert.equal(original.signatures[0].message, related.signatures[0].message)
assert.equal(original.signatures[1].message, related.signatures[1].message)
for (let i = 0; i < original.signatures.length; i++) {
  assert.notEqual(original.signatures[i].k, related.signatures[i].k)
}
// Test-only exceptional tweak cases, without any production hash override.
const acceptableDestination = (B, t) =>
  t !== 0n && !B.add(mul(Point.BASE, t)).equals(Point.ZERO)
assert(!acceptableDestination(strictPoint(bytes(original.B)), 0n))
assert(
  !acceptableDestination(
    strictPoint(bytes(original.B)),
    L - integer(bytes(original.b)),
  ),
)
assert(
  acceptableDestination(
    strictPoint(bytes(original.B)),
    integer(bytes(original.t)),
  ),
)
// Boundary arithmetic: zero nonce is representable without an unstated retry counter.
assert(mul(Point.BASE, 0n).equals(Point.ZERO))
assert.equal((0n + 0n * 1n) % L, 0n)
console.log(
  `PASS: ${fixtures.vectors.length} independent arithmetic vectors, ${signatures} standard signatures, ${parsedTransactions} Solana parsed transaction round trips, malformed points and descriptor mutations`,
)
