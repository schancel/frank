// Offline proposal evidence only. No exports, runtime admission, network or file writes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  decodeCanonical,
  encodeCanonical,
  Encodable,
  FrankValue,
} from '../../src/cbor'
import { encodeFrame } from '../../src/frame'
import {
  commonTranscript,
  fromHex,
  toHex,
  topicVoteCommitment,
} from '../../src/hash'

const PATH = resolve('docs/protocol/proposals/forum-content-read/vectors.json')
const NET = 'monad-testnet',
  TOPIC = 'Forum/é',
  U64 = (1n << 64n) - 1n
const EPOCH = new Uint8Array(16).fill(7)
const M = (entries: [number, Encodable][]) => new Map(entries)
const stamp = (seconds = 1700000000n, nanos = 999999999) =>
  M([
    [0, seconds],
    [1, nanos],
  ])
const sha = (bytes: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(bytes).digest())
const t1 = (bytes: Uint8Array) =>
  sha(
    commonTranscript(
      'frank/content-hash/v1',
      get(open(bytes).payload, 0) as string,
      bytes,
    ),
  )
const equal = (a: Encodable, b: Encodable) =>
  toHex(encodeCanonical(a)) === toHex(encodeCanonical(b))
function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw Error(reason)
}
const map = (v: FrankValue): ReadonlyMap<bigint, FrankValue> => {
  requireThat(v instanceof Map, 'map')
  return v
}
const get = (v: FrankValue, k: number): FrankValue => {
  const x = map(v).get(BigInt(k))
  requireThat(x !== undefined, `field ${k}`)
  return x
}
const has = (v: FrankValue, k: number) => map(v).has(BigInt(k))
const bytes = (v: FrankValue, min: number, max = min): Uint8Array => {
  requireThat(
    v instanceof Uint8Array && v.length >= min && v.length <= max,
    'bytes',
  )
  return v
}
const uint = (v: FrankValue, max = U64): bigint => {
  requireThat(typeof v === 'bigint' && v >= 0 && v <= max, 'uint')
  return v
}
const text = (v: FrankValue, min: number, max: number): string => {
  requireThat(
    typeof v === 'string' &&
      Buffer.byteLength(v) >= min &&
      Buffer.byteLength(v) <= max,
    'text',
  )
  return v
}
const keys = (v: FrankValue, allowed: number[], future = false) => {
  for (const k of map(v).keys())
    requireThat(future || allowed.includes(Number(k)), 'unknown key')
}
const timestamp = (v: FrankValue) => {
  keys(v, [0, 1])
  const s = get(v, 0)
  requireThat(
    typeof s === 'bigint' && s >= -(1n << 63n) && s < 1n << 63n,
    'seconds',
  )
  uint(get(v, 1), 999999999n)
}
const timeOrder = (a: FrankValue, b: FrankValue) => {
  const x = get(a, 0) as bigint,
    y = get(b, 0) as bigint
  return x < y
    ? -1
    : x > y
    ? 1
    : Number((get(a, 1) as bigint) - (get(b, 1) as bigint))
}

type Recipe =
  | null
  | boolean
  | string
  | Recipe[]
  | { int: string }
  | { hex: string }
  | { map: [number, Recipe][] }
const recipe = (v: Encodable): Recipe => {
  if (typeof v === 'bigint' || typeof v === 'number') return { int: String(v) }
  if (v instanceof Uint8Array) return { hex: toHex(v) }
  if (v instanceof Map)
    return { map: [...v].map(([k, x]) => [Number(k), recipe(x)]) }
  if (Array.isArray(v)) return v.map(recipe)
  return v as null | boolean | string
}
const value = (r: Recipe): Encodable => {
  if (r === null || typeof r === 'boolean' || typeof r === 'string')
    return r as null | boolean | string
  if (Array.isArray(r)) return r.map(value)
  if ('int' in r) return BigInt(r.int)
  if ('hex' in r) return fromHex(r.hex)
  return M(r.map.map(([k, x]) => [k, value(x)]))
}
interface Fixture {
  id: string
  origin: string
  type: number
  schema: number
  min: number
  payload: Recipe
  hex: string
  valid: boolean
  t1?: string
  t7?: string
}
interface Opened {
  type: number
  schema: number
  min: number
  payload: FrankValue
  raw: Uint8Array
}
function open(raw: Uint8Array): Opened {
  requireThat(
    raw.length >= 9 &&
      raw.length <= 8388617 &&
      toHex(raw.slice(0, 5)) === '46524e4b01',
    'frame',
  )
  requireThat(
    new DataView(raw.buffer, raw.byteOffset).getUint32(5) === raw.length - 9,
    'length',
  )
  const env = decodeCanonical(raw.slice(9))
  keys(env, [0, 1, 2, 3])
  const type = Number(uint(get(env, 0), 0xffffffffn)),
    schema = Number(uint(get(env, 1), 0xffffffffn)),
    min = Number(uint(get(env, 2), 0xffffffffn))
  requireThat(schema >= 1 && min >= 1 && min <= schema, 'version')
  return {
    type,
    schema,
    min,
    payload: decodeCanonical(bytes(get(env, 3), 1, 8388608)),
    raw,
  }
}
function validate(raw: Uint8Array): Opened {
  const f = open(raw),
    p = f.payload,
    future = f.schema > (f.type === 9 ? 2 : 1)
  requireThat(
    f.min <= (f.type === 9 ? 2 : 1) && f.schema >= (f.type === 9 ? 2 : 1),
    'required version',
  )
  text(get(p, 0), 1, 64)
  if (f.type === 9) {
    requireThat(raw.length <= 1048576, 'post limit')
    keys(p, [0, 1, 2, 3], future)
    text(get(p, 1), 1, 512)
    if (has(p, 2)) bytes(get(p, 2), 32)
    const content = decodeCanonical(bytes(get(p, 3), 1, 524288))
    keys(content, [0, 1], future)
    timestamp(get(content, 0))
    const entries = get(content, 1)
    requireThat(
      Array.isArray(entries) && entries.length >= 1 && entries.length <= 64,
      'entry count',
    )
    for (const entry of entries) {
      const kind = uint(get(entry, 0))
      requireThat(kind === 1n || future, 'kind')
      if (kind === 1n) {
        keys(entry, [0, 1, 2, 3], future)
        for (const k of [1, 2, 3])
          if (has(entry, k)) text(get(entry, k), 0, 262144)
      }
    }
  } else if (f.type === 10 || f.type === 11) {
    keys(p, [0, 1, 2], future)
    requireThat(
      raw.length <= (f.type === 10 ? 1048576 : 65536),
      'submission limit',
    )
    bytes(get(p, 2), 1, 16384)
    if (f.type === 10) {
      const post = validate(bytes(get(p, 1), 9, 1048576))
      requireThat(
        post.type === 9 && equal(get(post.payload, 0), get(p, 0)),
        'post network',
      )
    } else bytes(get(p, 1), 32)
  } else if (f.type === 12) {
    requireThat(raw.length <= 2097152, 'view limit')
    keys(p, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], future)
    const post = validate(bytes(get(p, 1), 9, 1048576))
    requireThat(
      post.type === 9 && equal(get(post.payload, 0), get(p, 0)),
      'view network',
    )
    bytes(get(p, 2), 20)
    bytes(get(p, 3), 1, 16384)
    bytes(get(p, 4), 32)
    timestamp(get(p, 5))
    for (const k of [6, 7, 9]) uint(get(p, k))
    bytes(get(p, 10), 16)
    const a = get(p, 8)
    keys(a, [0, 1], future)
    requireThat(typeof get(a, 0) === 'boolean', 'sign')
    const mag = bytes(get(a, 1), 32)
    requireThat(get(a, 0) === false || mag.some(x => x !== 0), 'negative zero')
  } else if (f.type === 13 || f.type === 14) {
    requireThat(raw.length <= 4194304, 'page limit')
    keys(
      p,
      f.type === 13 ? [0, 1, 2, 3, 4, 5, 6, 7] : [0, 1, 2, 3, 4, 5],
      future,
    )
    const topic = f.type === 13
    if (topic) {
      text(get(p, 1), 1, 512)
      timestamp(get(p, 2))
    }
    const rev = get(p, topic ? 3 : 1)
    uint(rev)
    const epoch = bytes(get(p, topic ? 6 : 4), 16),
      rows = get(p, topic ? 4 : 2)
    requireThat(Array.isArray(rows) && rows.length <= 128, 'row count')
    for (const k of topic ? [5, 7] : [3, 5])
      if (has(p, k)) bytes(get(p, k), 1, 2048)
    requireThat(rows.length > 0 || !has(p, topic ? 5 : 3), 'empty continuation')
    let previous: FrankValue | undefined, previousId: Uint8Array | undefined
    for (const row of rows) {
      if (topic) {
        const v = validate(bytes(row, 9, 2097152))
        requireThat(v.type === 12, 'row type')
        const post = validate(get(v.payload, 1) as Uint8Array)
        requireThat(
          equal(get(v.payload, 0), get(p, 0)) &&
            equal(get(post.payload, 1), get(p, 1)) &&
            equal(get(v.payload, 9), rev) &&
            equal(get(v.payload, 10), epoch),
          'row binding',
        )
        const time = get(v.payload, 5),
          id = t1(post.raw)
        requireThat(timeOrder(time, get(p, 2)) >= 0, 'since')
        if (previous !== undefined)
          requireThat(
            timeOrder(previous, time) < 0 ||
              (timeOrder(previous, time) === 0 &&
                Buffer.compare(Buffer.from(previousId!), Buffer.from(id)) < 0),
            'row order',
          )
        previous = time
        previousId = id
      } else {
        keys(row, [0, 1, 2], future)
        const name = text(get(row, 0), 1, 512)
        uint(get(row, 1))
        timestamp(get(row, 2))
        if (previous !== undefined)
          requireThat(
            Buffer.compare(Buffer.from(previous as string), Buffer.from(name)) <
              0,
            'discovery order',
          )
        previous = name
      }
    }
  } else if (f.type === 15) {
    requireThat(raw.length <= 2097152, 'status limit')
    keys(p, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], future)
    const sub = validate(bytes(get(p, 1), 9, 1048576))
    requireThat(
      (sub.type === 10 || sub.type === 11) &&
        equal(get(sub.payload, 0), get(p, 0)),
      'status network',
    )
    const target =
      sub.type === 10
        ? t1(get(sub.payload, 1) as Uint8Array)
        : get(sub.payload, 1)
    requireThat(equal(bytes(get(p, 2), 32), target), 'status target')
    bytes(get(p, 3), 32)
    bytes(get(p, 4), 20)
    uint(get(p, 5), 1n)
    uint(get(p, 6))
    const state = uint(get(p, 7), 3n)
    requireThat(
      has(p, 8) === (state === 2n) && has(p, 9) === (state === 2n),
      'confirmation position',
    )
    if (state === 2n) {
      uint(get(p, 8))
      uint(get(p, 9))
    }
    if (state === 1n || state === 2n)
      requireThat(
        (get(p, 6) as bigint) > 0n && (get(p, 6) as bigint) <= (1n << 63n) - 1n,
        'burn ceiling',
      )
    uint(get(p, 10))
    bytes(get(p, 11), 16)
  } else throw Error('unknown type')
  return f
}

function fixtures(): Fixture[] {
  const out: Fixture[] = []
  function add(
    id: string,
    type: number,
    payload: Encodable,
    valid = true,
    schema = type === 9 ? 2 : 1,
    min = type === 9 ? 2 : 1,
    origin = 'typescript',
  ) {
    const raw = encodeFrame(
      { typeId: type, schemaVersion: schema, minReaderVersion: min },
      payload,
    )
    out.push({
      id,
      origin,
      type,
      schema,
      min,
      payload: recipe(payload),
      hex: toHex(raw),
      valid,
      ...(type === 9
        ? { t1: toHex(t1(raw)), t7: toHex(topicVoteCommitment(NET, t1(raw))) }
        : {}),
    })
    return raw
  }
  const content = (
    entry: Encodable = M([
      [0, 1],
      [1, 'Title'],
      [2, 'https://example.invalid/é?q=é'],
      [3, 'Body 😀 é é'],
    ]),
    time = stamp(),
  ) =>
    encodeCanonical(
      M([
        [0, time],
        [1, [entry]],
      ]),
    )
  const post = (body: Uint8Array, parent?: Uint8Array) =>
    M([
      [0, NET],
      [1, TOPIC],
      ...(parent ? [[2, parent] as [number, Encodable]] : []),
      [3, body],
    ])
  const top = add('typescript-origin', 9, post(content()))
  const rust = add(
    'rust-origin',
    9,
    post(
      content(
        M([
          [0, 1],
          [3, 'Rust origin λ'],
        ]),
        stamp(-1n, 1),
      ),
    ),
    true,
    2,
    2,
    'rust',
  )
  add(
    'reply',
    9,
    post(
      content(
        M([
          [0, 1],
          [3, 'Reply'],
        ]),
      ),
      t1(top),
    ),
  )
  add(
    'different-authored-time',
    9,
    post(content(undefined, stamp(1700000001n))),
  )
  add(
    'multiple-entries',
    9,
    post(
      encodeCanonical(
        M([
          [0, stamp()],
          [
            1,
            [
              M([
                [0, 1],
                [1, 'First'],
              ]),
              M([
                [0, 1],
                [3, 'Second'],
              ]),
            ],
          ],
        ]),
      ),
    ),
  )
  add(
    'empty-optionals',
    9,
    post(
      content(
        M([
          [0, 1],
          [1, ''],
          [2, ''],
          [3, ''],
        ]),
      ),
    ),
  )
  add('absent-optionals', 9, post(content(M([[0, 1]]))))
  add(
    'future-retention',
    9,
    post(
      encodeCanonical(
        M([
          [0, stamp()],
          [
            1,
            [
              M([
                [0, 1],
                [3, 'Known'],
                [99, fromHex('aabb')],
              ]),
              M([
                [0, 27],
                [42, 'opaque'],
              ]),
            ],
          ],
          [77, fromHex('0102')],
        ]),
      ),
    ),
    true,
    3,
    2,
  )
  add('required-version', 9, post(content()), false, 3, 3)
  add('unknown-kind', 9, post(content(M([[0, 27]]))), false)
  add(
    'unknown-key-current',
    9,
    post(
      content(
        M([
          [0, 1],
          [9, 'x'],
        ]),
      ),
    ),
    false,
  )
  for (const [id, raw] of [
    ['duplicate-content', 'a200a2000001000080'],
    ['nonshortest-content', 'a200a200180001000181a10001'],
    ['invalid-utf8-content', 'a200a2000001000181a200010361ff'],
    ['trailing-content', 'a200a2000001000181a1000100'],
    ['malformed-content', 'a2'],
  ] as const)
    add(id, 9, post(fromHex(raw)), false)
  add(
    'empty-entries',
    9,
    post(
      encodeCanonical(
        M([
          [0, stamp()],
          [1, []],
        ]),
      ),
    ),
    false,
  )
  add(
    'too-many-entries',
    9,
    post(
      encodeCanonical(
        M([
          [0, stamp()],
          [1, Array(65).fill(M([[0, 1]]))],
        ]),
      ),
    ),
    false,
  )
  const txA = fromHex('02aabb01'),
    txB = fromHex('02aabb02'),
    sender = new Uint8Array(20).fill(3)
  const subA = add(
      'submission-a',
      10,
      M([
        [0, NET],
        [1, top],
        [2, txA],
      ]),
    ),
    subB = add(
      'submission-b',
      10,
      M([
        [0, NET],
        [1, top],
        [2, txB],
      ]),
    )
  add(
    'vote',
    11,
    M([
      [0, NET],
      [1, t1(top)],
      [2, txB],
    ]),
  )
  const magnitude = fromHex(
    '0000000000000000000000000000000000000000000000010000000000000001',
  )
  const view = (frame: Uint8Array, epoch = EPOCH) => {
    const tx = frame === rust ? fromHex('02aabb03') : txA
    return M([
      [0, NET],
      [1, frame],
      [2, sender],
      [3, tx],
      [4, keccak_256(tx)],
      [5, stamp()],
      [6, U64],
      [7, 0],
      [
        8,
        M([
          [0, false],
          [1, magnitude],
        ]),
      ],
      [9, U64],
      [10, epoch],
    ])
  }
  const viewA = add('view-large-aggregate', 12, view(top)),
    viewB = add('view-rust', 12, view(rust))
  const negative = view(top)
  negative.set(
    8,
    M([
      [0, true],
      [1, new Uint8Array(32)],
    ]),
  )
  add('negative-zero', 12, negative, false)
  const pageRows = [viewA, viewB].sort((a, b) =>
    Buffer.compare(
      Buffer.from(t1(get(open(a).payload, 1) as Uint8Array)),
      Buffer.from(t1(get(open(b).payload, 1) as Uint8Array)),
    ),
  )
  add(
    'equal-time-page',
    13,
    M([
      [0, NET],
      [1, TOPIC],
      [2, stamp()],
      [3, U64],
      [4, pageRows],
      [6, EPOCH],
    ]),
  )
  add(
    'wrong-topic-page',
    13,
    M([
      [0, NET],
      [1, 'other'],
      [2, stamp()],
      [3, U64],
      [4, pageRows],
      [6, EPOCH],
    ]),
    false,
  )
  add(
    'wrong-epoch-page',
    13,
    M([
      [0, NET],
      [1, TOPIC],
      [2, stamp()],
      [3, U64],
      [4, pageRows],
      [6, new Uint8Array(16)],
    ]),
    false,
  )
  add(
    'discovery-u64',
    14,
    M([
      [0, NET],
      [1, U64],
      [
        2,
        [
          M([
            [0, 'a'],
            [1, U64],
            [2, stamp()],
          ]),
          M([
            [0, 'é'],
            [1, 1],
            [2, stamp()],
          ]),
        ],
      ],
      [4, EPOCH],
    ]),
  )
  const status = (submission: Uint8Array, state: number) =>
    M([
      [0, NET],
      [1, submission],
      [2, t1(top)],
      [3, keccak_256(submission === subA ? txA : txB)],
      [4, sender],
      [5, 1],
      [6, 9007199254740993n],
      [7, state],
      ...(state === 2
        ? ([
            [8, U64],
            [9, 0],
          ] as [number, Encodable][])
        : []),
      [10, U64],
      [11, EPOCH],
    ])
  add('confirmed-a', 15, status(subA, 2))
  add('unknown-b-same-post', 15, status(subB, 0))
  add('pending-a', 15, status(subA, 1))
  add('rejected-b', 15, status(subB, 3))
  for (const [label, key, v] of [
    ['tx', 3, new Uint8Array(32)],
    ['sender', 4, new Uint8Array(20)],
    ['direction', 5, 0],
    ['value', 6, 1n],
  ] as [string, number, Encodable][]) {
    const changed = status(subA, 2)
    changed.set(key, v)
    add(`mismatched-response-${label}`, 15, changed)
  }
  const wrongTarget = status(subA, 2)
  wrongTarget.set(2, new Uint8Array(32))
  add('wrong-target', 15, wrongTarget, false)
  const wrongNet = status(subA, 2)
  wrongNet.set(0, 'other')
  add('wrong-network', 15, wrongNet, false)
  const highBurn = status(subA, 2)
  highBurn.set(6, U64)
  add('u64-burn-not-admitted', 15, highBurn, false)
  const unknownPosition = status(subB, 0)
  unknownPosition.set(8, 1)
  add('unknown-cannot-have-position', 15, unknownPosition, false)
  return out
}

// Local fixture policy boundaries. Synthetic observations deliberately do not assert signatures.
function bindStatus(
  raw: Uint8Array,
  request: FrankValue,
  observed?: FrankValue,
): string {
  const p = validate(raw).payload
  for (const k of [0, 1, 2, 3, 4, 5, 6])
    requireThat(equal(get(p, k), get(request, k)), `request mismatch ${k}`)
  const state = get(p, 7)
  if (state === 0n || state === 3n) return 'unverified-request'
  requireThat(observed !== undefined, 'missing observation')
  const submission = open(get(p, 1) as Uint8Array)
  requireThat(
    equal(get(p, 3), keccak_256(get(submission.payload, 2) as Uint8Array)),
    'raw transaction hash',
  )
  for (const k of [0, 1, 2, 3, 4, 5, 6])
    requireThat(equal(get(p, k), get(observed, k)), `observation mismatch ${k}`)
  return state === 2n ? 'relay-confirmed' : 'relay-pending'
}
function rejects(run: () => unknown) {
  assert.throws(run)
}
function observations(all: Fixture[]) {
  return [
    ['02aabb01', 'typescript-origin'],
    ['02aabb02', 'typescript-origin'],
    ['02aabb03', 'rust-origin'],
  ].map(([raw, id]) => {
    const target = t1(fromHex(all.find(f => f.id === id)!.hex))
    return {
      raw,
      hash: toHex(keccak_256(fromHex(raw))),
      network: NET,
      target: toHex(target),
      commitment: toHex(topicVoteCommitment(NET, target)),
      sender: '03'.repeat(20),
      direction: 1,
      value: '9007199254740993',
    }
  })
}
function checkObserved(all: Fixture[], facts: ReturnType<typeof observations>) {
  const factFor = (raw: Uint8Array, target: Uint8Array, network: string) => {
    const fact = facts.find(x => x.raw === toHex(raw))
    requireThat(fact, 'missing synthetic observation')
    requireThat(
      fact.network === network &&
        fact.target === toHex(target) &&
        fact.hash === toHex(keccak_256(raw)) &&
        fact.commitment === toHex(topicVoteCommitment(network, target)),
      'transaction-derived binding',
    )
    return fact
  }
  for (const id of ['view-large-aggregate', 'view-rust']) {
    const p = validate(fromHex(all.find(f => f.id === id)!.hex)).payload
    const fact = factFor(
      get(p, 3) as Uint8Array,
      t1(get(p, 1) as Uint8Array),
      get(p, 0) as string,
    )
    assert.equal(toHex(get(p, 2) as Uint8Array), fact.sender)
    assert.equal(toHex(get(p, 4) as Uint8Array), fact.hash)
    assert.equal(fact.direction, 1)
    rejects(() => factFor(get(p, 3) as Uint8Array, new Uint8Array(32), NET))
  }
  for (const id of ['confirmed-a', 'pending-a']) {
    const raw = fromHex(all.find(f => f.id === id)!.hex),
      p = validate(raw).payload,
      sub = open(get(p, 1) as Uint8Array)
    const fact = factFor(
      get(sub.payload, 2) as Uint8Array,
      get(p, 2) as Uint8Array,
      get(p, 0) as string,
    )
    const observed = M([
      [0, fact.network],
      [1, get(p, 1)],
      [2, fromHex(fact.target)],
      [3, fromHex(fact.hash)],
      [4, fromHex(fact.sender)],
      [5, fact.direction],
      [6, BigInt(fact.value)],
    ])
    assert.equal(
      bindStatus(raw, p, decodeCanonical(encodeCanonical(observed))),
      id === 'confirmed-a' ? 'relay-confirmed' : 'relay-pending',
    )
  }
}
function cursorFixtures(all: Fixture[], family = 13) {
  const top = fromHex(all.find(f => f.id === 'typescript-origin')!.hex)
  const cursor = M([
    [0, NET],
    [1, 13],
    [2, U64],
    [3, EPOCH],
    [
      4,
      M([
        [0, stamp()],
        [1, t1(top)],
      ]),
    ],
    [5, TOPIC],
    [6, stamp()],
    [7, 1n],
  ])
  if (family === 14) {
    cursor.set(1, 14)
    cursor.set(4, TOPIC)
    cursor.delete(5)
    cursor.delete(6)
  }
  const expected = toHex(encodeCanonical(cursor))
  const out: {
    id: string
    hex: string
    transport: string
    valid: boolean
    active: boolean
    age: number
    retainedIncarnation: string
  }[] = []
  const add = (
    id: string,
    raw: Uint8Array,
    valid: boolean,
    active = true,
    age = 0,
    spelling?: string,
    retainedIncarnation = '1',
  ) =>
    out.push({
      id,
      hex: toHex(raw),
      transport: spelling ?? Buffer.from(raw).toString('base64url'),
      valid,
      active,
      age,
      retainedIncarnation,
    })
  const raw = fromHex(expected)
  add(family === 13 ? 'topic-cursor' : 'discovery-cursor', raw, true)
  for (const k of cursor.keys()) {
    const changed = new Map(cursor)
    changed.set(k, k === 3 ? new Uint8Array(16) : 'forged')
    add(`forged-field-${k}`, encodeCanonical(changed), false)
  }
  for (const [id, hex] of [
    ['duplicate', 'a200010001'],
    ['nonshortest', 'a1001801'],
    ['utf8', 'a10061ff'],
    ['trailing', expected + '00'],
  ])
    add(id, fromHex(hex), false)
  add('restart-expired', raw, false, false)
  add('ttl-expired', raw, false, true, 120000)
  // The preceding TTL case expires incarnation 1. A fresh matching snapshot
  // starts at age zero; its original cursor must stay expired.
  add('expired-recreated-original-cursor', raw, false, true, 0, undefined, '2')
  const recreated = new Map(cursor)
  recreated.set(7, 2n)
  add(
    'recreated-current-cursor',
    encodeCanonical(recreated),
    true,
    true,
    0,
    undefined,
    '2',
  )
  const missingIncarnation = new Map(cursor)
  missingIncarnation.delete(7)
  add('missing-incarnation', encodeCanonical(missingIncarnation), false)
  const lastIncarnation = new Map(cursor)
  lastIncarnation.set(7, U64)
  add(
    'u64-incarnation',
    encodeCanonical(lastIncarnation),
    true,
    true,
    0,
    undefined,
    String(U64),
  )
  add(
    'padded-transport',
    raw,
    false,
    true,
    0,
    Buffer.from(raw).toString('base64url') + '=',
  )
  add('oversized', new Uint8Array(2049), false)
  add('invalid-base64', Uint8Array.of(0), false, true, 0, 'a')
  return { expected, cases: out }
}
function checkCursors(shared: ReturnType<typeof cursorFixtures>) {
  for (const f of shared.cases) {
    const run = () => {
      requireThat(
        f.transport.length <= 2731 && /^[A-Za-z0-9_-]+$/.test(f.transport),
        'cursor transport',
      )
      const raw = Buffer.from(f.transport, 'base64url')
      requireThat(
        raw.length <= 2048 && raw.toString('base64url') === f.transport,
        'cursor spelling',
      )
      assert.equal(toHex(raw), f.hex)
      const c = decodeCanonical(raw)
      const retained = new Map(map(decodeCanonical(fromHex(shared.expected))))
      retained.set(7n, BigInt(f.retainedIncarnation))
      keys(c, [...retained.keys()].map(Number))
      const lookupKey = (cursor: FrankValue) =>
        `${toHex(bytes(get(cursor, 3), 16))}:${uint(get(cursor, 7))}`
      // The retained store is keyed by lifetime identity, never query/revision.
      const snapshots = new Map([[lookupKey(retained), retained]])
      const snapshot = snapshots.get(lookupKey(c))
      requireThat(snapshot && f.active && f.age < 120000, 'cursor-expired')
      requireThat(equal(c, snapshot), 'cursor binding/tuple membership')
    }
    if (f.valid) run()
    else rejects(run)
  }
}
function policies(all: Fixture[]) {
  const raw = (id: string) => fromHex(all.find(f => f.id === id)!.hex)
  const confirmed = open(raw('confirmed-a')).payload,
    unknown = open(raw('unknown-b-same-post')).payload
  assert.equal(
    bindStatus(raw('confirmed-a'), confirmed, confirmed),
    'relay-confirmed',
  )
  assert.equal(
    bindStatus(raw('unknown-b-same-post'), unknown),
    'unverified-request',
  )
  rejects(() => bindStatus(raw('confirmed-a'), unknown, confirmed))
  for (const label of ['tx', 'sender', 'direction', 'value'])
    rejects(() =>
      bindStatus(raw(`mismatched-response-${label}`), confirmed, confirmed),
    )
  for (const key of [0, 1, 2, 3, 4, 5, 6]) {
    const changed = new Map(map(confirmed))
    const v = get(confirmed, key)
    changed.set(
      BigInt(key),
      typeof v === 'bigint'
        ? v + 1n
        : typeof v === 'string'
        ? v + 'x'
        : Uint8Array.of(0),
    )
    rejects(() => bindStatus(raw('confirmed-a'), changed, confirmed))
    rejects(() => bindStatus(raw('confirmed-a'), confirmed, changed))
  }
  // Exclusive whole-tuple continuation preserves equal-time neighbors.
  const ids = [t1(raw('typescript-origin')), t1(raw('rust-origin'))].sort(
    (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )
  assert.equal(
    ids.filter(x => Buffer.compare(Buffer.from(x), Buffer.from(ids[0])) > 0)
      .length,
    1,
  )
  assert.equal(new Set([...ids, ...ids].map(toHex)).size, 2)
  const apply = (
    current: { epoch: string; rev: bigint; generation: number },
    incoming: typeof current,
  ) =>
    incoming.generation === current.generation &&
    incoming.epoch === current.epoch &&
    incoming.rev >= current.rev
  assert.equal(
    apply(
      { epoch: 'new', rev: 1n, generation: 2 },
      { epoch: 'old', rev: U64, generation: 1 },
    ),
    false,
  )
  assert.equal(
    apply(
      { epoch: 'same', rev: U64, generation: 2 },
      { epoch: 'same', rev: 1n, generation: 2 },
    ),
    false,
  )
  assert.equal(
    apply(
      { epoch: 'same', rev: U64, generation: 2 },
      { epoch: 'same', rev: U64, generation: 1 },
    ),
    false,
  )
  const capacity = (count: number, total: number, one: number) =>
    count < 16 && one <= 64 * 1024 * 1024 && total + one <= 256 * 1024 * 1024
  assert.equal(capacity(15, 192 * 1024 * 1024, 64 * 1024 * 1024), true)
  assert.equal(capacity(16, 0, 1), false)
  assert.equal(capacity(1, 256 * 1024 * 1024, 1), false)
  assert.equal(capacity(0, 0, 64 * 1024 * 1024 + 1), false)
  const max = (1n << 256n) - 1n
  rejects(() => requireThat(max + 1n <= max, 'aggregate overflow'))
  assert.notEqual(
    toHex(t1(raw('typescript-origin'))),
    toHex(t1(raw('different-authored-time'))),
  )
}

if (process.argv.includes('--emit')) {
  const frames = fixtures()
  console.log(
    JSON.stringify(
      {
        format: 'PROPOSED-forum-content-read-v1',
        chainFacts:
          'synthetic exact-byte observations; not signed transaction evidence',
        frames,
        cursors: [cursorFixtures(frames), cursorFixtures(frames, 14)],
        observations: observations(frames),
      },
      null,
      2,
    ),
  )
} else {
  const doc = JSON.parse(readFileSync(PATH, 'utf8'))
  const all = doc.frames as Fixture[]
  assert.equal(doc.format, 'PROPOSED-forum-content-read-v1')
  assert.deepEqual(all, fixtures())
  for (const f of all) {
    const encoded = encodeFrame(
      { typeId: f.type, schemaVersion: f.schema, minReaderVersion: f.min },
      value(f.payload),
    )
    assert.equal(toHex(encoded), f.hex, f.id)
    if (f.t1) {
      assert.equal(toHex(t1(encoded)), f.t1)
      assert.equal(toHex(topicVoteCommitment(NET, t1(encoded))), f.t7)
    }
    if (f.valid) {
      const parsed = validate(encoded)
      assert.equal(toHex(parsed.raw), f.hex)
      assert.deepEqual(
        encodeCanonical(parsed.payload),
        encodeCanonical(value(f.payload)),
      )
    } else rejects(() => validate(encoded))
  }
  policies(all)
  assert.deepEqual(doc.cursors, [cursorFixtures(all), cursorFixtures(all, 14)])
  doc.cursors.forEach(checkCursors)
  assert.deepEqual(doc.observations, observations(all))
  checkObserved(all, doc.observations)
  console.log(
    `TypeScript proposal: ${all.length} shared frames, independent encode/T1/T7, hostile binding/cursor/restart policies passed`,
  )
}
