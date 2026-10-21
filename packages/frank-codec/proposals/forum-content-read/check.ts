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
import {
  FORUM_AGGREGATE,
  FORUM_CONTENT,
  FORUM_CURSOR_LAST,
  FORUM_DISCOVERY_CURSOR,
  FORUM_DISCOVERY_ENTRY,
  FORUM_DISCOVERY_PAGE,
  FORUM_ENTRY,
  FORUM_OPERATION_STATUS,
  FORUM_POST_ENTRY,
  FORUM_SINGLE_VIEW,
  FORUM_TOPIC_CURSOR,
  FORUM_TOPIC_PAGE,
  FRANK_ENVELOPE,
  TIMESTAMP,
  TOPIC_POST,
  TOPIC_POST_SUBMISSION,
  TOPIC_VOTE_SUBMISSION,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
} from '../../src/constants'

const PATH = resolve('docs/protocol/proposals/forum-content-read/vectors.json')
const NET = 'monad-testnet',
  TOPIC = 'Forum/é',
  U64 = (1n << 64n) - 1n
const EPOCH = new Uint8Array(16).fill(7)
const M = (entries: [number, Encodable][]) => new Map(entries)
const stamp = (seconds = 1700000000n, nanos = 999999999) =>
  M([
    [TIMESTAMP.seconds, seconds],
    [TIMESTAMP.nanoseconds, nanos],
  ])
const sha = (bytes: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(bytes).digest())
const t1 = (bytes: Uint8Array) =>
  sha(
    commonTranscript(
      'frank/content-hash/v1',
      get(open(bytes).payload, TOPIC_POST.network) as string,
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
  keys(v, [TIMESTAMP.seconds, TIMESTAMP.nanoseconds])
  const s = get(v, TIMESTAMP.seconds)
  requireThat(
    typeof s === 'bigint' && s >= -(1n << 63n) && s < 1n << 63n,
    'seconds',
  )
  uint(get(v, TIMESTAMP.nanoseconds), 999999999n)
}
const timeOrder = (a: FrankValue, b: FrankValue) => {
  const x = get(a, TIMESTAMP.seconds) as bigint,
    y = get(b, TIMESTAMP.seconds) as bigint
  return x < y
    ? -1
    : x > y
    ? 1
    : Number(
        (get(a, TIMESTAMP.nanoseconds) as bigint) -
          (get(b, TIMESTAMP.nanoseconds) as bigint),
      )
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
  keys(env, [
    FRANK_ENVELOPE.typeId,
    FRANK_ENVELOPE.schemaVersion,
    FRANK_ENVELOPE.minReaderVersion,
    FRANK_ENVELOPE.payload,
  ])
  const type = Number(uint(get(env, FRANK_ENVELOPE.typeId), 0xffffffffn)),
    schema = Number(uint(get(env, FRANK_ENVELOPE.schemaVersion), 0xffffffffn)),
    min = Number(uint(get(env, FRANK_ENVELOPE.minReaderVersion), 0xffffffffn))
  requireThat(schema >= 1 && min >= 1 && min <= schema, 'version')
  return {
    type,
    schema,
    min,
    payload: decodeCanonical(
      bytes(get(env, FRANK_ENVELOPE.payload), 1, 8388608),
    ),
    raw,
  }
}
function validate(raw: Uint8Array): Opened {
  const f = open(raw),
    p = f.payload,
    future = f.schema > (f.type === TYPE_TOPIC_POST ? 2 : 1)
  requireThat(
    f.min <= (f.type === TYPE_TOPIC_POST ? 2 : 1) &&
      f.schema >= (f.type === TYPE_TOPIC_POST ? 2 : 1),
    'required version',
  )
  // raw-cbor-key: field 0 is network in every forum type
  text(get(p, 0), 1, 64)
  if (f.type === TYPE_TOPIC_POST) {
    requireThat(raw.length <= 1048576, 'post limit')
    keys(
      p,
      [
        TOPIC_POST.network,
        TOPIC_POST.topic,
        TOPIC_POST.parentHash,
        TOPIC_POST.body,
      ],
      future,
    )
    text(get(p, TOPIC_POST.topic), 1, 512)
    if (has(p, TOPIC_POST.parentHash)) bytes(get(p, TOPIC_POST.parentHash), 32)
    const content = decodeCanonical(bytes(get(p, TOPIC_POST.body), 1, 524288))
    keys(content, [FORUM_CONTENT.authored, FORUM_CONTENT.entries], future)
    timestamp(get(content, FORUM_CONTENT.authored))
    const entries = get(content, FORUM_CONTENT.entries)
    requireThat(
      Array.isArray(entries) && entries.length >= 1 && entries.length <= 64,
      'entry count',
    )
    for (const entry of entries) {
      const kind = uint(get(entry, FORUM_POST_ENTRY.kind))
      requireThat(kind === 1n || future, 'kind')
      if (kind === 1n) {
        keys(
          entry,
          [
            FORUM_POST_ENTRY.kind,
            FORUM_POST_ENTRY.title,
            FORUM_POST_ENTRY.url,
            FORUM_POST_ENTRY.message,
          ],
          future,
        )
        for (const k of [
          FORUM_POST_ENTRY.title,
          FORUM_POST_ENTRY.url,
          FORUM_POST_ENTRY.message,
        ])
          if (has(entry, k)) text(get(entry, k), 0, 262144)
      }
    }
  } else if (
    f.type === TYPE_TOPIC_POST_SUBMISSION ||
    f.type === TYPE_TOPIC_VOTE_SUBMISSION
  ) {
    keys(
      p,
      [
        TOPIC_POST_SUBMISSION.network,
        TOPIC_POST_SUBMISSION.postFrame,
        TOPIC_POST_SUBMISSION.burnTx,
      ],
      future,
    )
    requireThat(
      raw.length <= (f.type === TYPE_TOPIC_POST_SUBMISSION ? 1048576 : 65536),
      'submission limit',
    )
    bytes(get(p, TOPIC_POST_SUBMISSION.burnTx), 1, 16384)
    if (f.type === TYPE_TOPIC_POST_SUBMISSION) {
      const post = validate(
        bytes(get(p, TOPIC_POST_SUBMISSION.postFrame), 9, 1048576),
      )
      requireThat(
        post.type === TYPE_TOPIC_POST &&
          equal(
            get(post.payload, TOPIC_POST.network),
            get(p, TOPIC_POST_SUBMISSION.network),
          ),
        'post network',
      )
    } else bytes(get(p, TOPIC_VOTE_SUBMISSION.targetHash), 32)
  } else if (f.type === TYPE_FORUM_VIEW) {
    requireThat(raw.length <= 2097152, 'view limit')
    keys(
      p,
      [
        FORUM_SINGLE_VIEW.network,
        FORUM_SINGLE_VIEW.postFrame,
        FORUM_SINGLE_VIEW.author,
        FORUM_SINGLE_VIEW.authorBurnTx,
        FORUM_SINGLE_VIEW.transactionHash,
        FORUM_SINGLE_VIEW.firstVisible,
        FORUM_SINGLE_VIEW.block,
        FORUM_SINGLE_VIEW.transactionIndex,
        FORUM_SINGLE_VIEW.aggregate,
        FORUM_SINGLE_VIEW.revision,
        FORUM_SINGLE_VIEW.epoch,
      ],
      future,
    )
    const post = validate(
      bytes(get(p, FORUM_SINGLE_VIEW.postFrame), 9, 1048576),
    )
    requireThat(
      post.type === TYPE_TOPIC_POST &&
        equal(
          get(post.payload, TOPIC_POST.network),
          get(p, FORUM_SINGLE_VIEW.network),
        ),
      'view network',
    )
    bytes(get(p, FORUM_SINGLE_VIEW.author), 20)
    bytes(get(p, FORUM_SINGLE_VIEW.authorBurnTx), 1, 16384)
    bytes(get(p, FORUM_SINGLE_VIEW.transactionHash), 32)
    timestamp(get(p, FORUM_SINGLE_VIEW.firstVisible))
    for (const k of [
      FORUM_SINGLE_VIEW.block,
      FORUM_SINGLE_VIEW.transactionIndex,
      FORUM_SINGLE_VIEW.revision,
    ])
      uint(get(p, k))
    bytes(get(p, FORUM_SINGLE_VIEW.epoch), 16)
    const a = get(p, FORUM_SINGLE_VIEW.aggregate)
    keys(a, [FORUM_AGGREGATE.negative, FORUM_AGGREGATE.magnitude], future)
    requireThat(typeof get(a, FORUM_AGGREGATE.negative) === 'boolean', 'sign')
    const mag = bytes(get(a, FORUM_AGGREGATE.magnitude), 32)
    requireThat(
      get(a, FORUM_AGGREGATE.negative) === false || mag.some(x => x !== 0),
      'negative zero',
    )
  } else if (
    f.type === TYPE_FORUM_TOPIC_PAGE ||
    f.type === TYPE_FORUM_DISCOVERY_PAGE
  ) {
    requireThat(raw.length <= 4194304, 'page limit')
    keys(
      p,
      f.type === TYPE_FORUM_TOPIC_PAGE
        ? [
            FORUM_TOPIC_PAGE.network,
            FORUM_TOPIC_PAGE.topic,
            FORUM_TOPIC_PAGE.since,
            FORUM_TOPIC_PAGE.revision,
            FORUM_TOPIC_PAGE.rows,
            FORUM_TOPIC_PAGE.nextCursor,
            FORUM_TOPIC_PAGE.epoch,
            FORUM_TOPIC_PAGE.requestCursor,
          ]
        : [
            FORUM_DISCOVERY_PAGE.network,
            FORUM_DISCOVERY_PAGE.revision,
            FORUM_DISCOVERY_PAGE.entries,
            FORUM_DISCOVERY_PAGE.nextCursor,
            FORUM_DISCOVERY_PAGE.epoch,
            FORUM_DISCOVERY_PAGE.requestCursor,
          ],
      future,
    )
    const topic = f.type === TYPE_FORUM_TOPIC_PAGE
    if (topic) {
      text(get(p, FORUM_TOPIC_PAGE.topic), 1, 512)
      timestamp(get(p, FORUM_TOPIC_PAGE.since))
    }
    const rev = get(
      p,
      topic ? FORUM_TOPIC_PAGE.revision : FORUM_DISCOVERY_PAGE.revision,
    )
    uint(rev)
    const epoch = bytes(
        get(p, topic ? FORUM_TOPIC_PAGE.epoch : FORUM_DISCOVERY_PAGE.epoch),
        16,
      ),
      rows = get(
        p,
        topic ? FORUM_TOPIC_PAGE.rows : FORUM_DISCOVERY_PAGE.entries,
      )
    requireThat(Array.isArray(rows) && rows.length <= 128, 'row count')
    for (const k of topic
      ? [FORUM_TOPIC_PAGE.nextCursor, FORUM_TOPIC_PAGE.requestCursor]
      : [FORUM_DISCOVERY_PAGE.nextCursor, FORUM_DISCOVERY_PAGE.requestCursor])
      if (has(p, k)) bytes(get(p, k), 1, 2048)
    requireThat(
      rows.length > 0 ||
        !has(
          p,
          topic ? FORUM_TOPIC_PAGE.nextCursor : FORUM_DISCOVERY_PAGE.nextCursor,
        ),
      'empty continuation',
    )
    let previous: FrankValue | undefined, previousId: Uint8Array | undefined
    for (const row of rows) {
      if (topic) {
        const v = validate(bytes(row, 9, 2097152))
        requireThat(v.type === TYPE_FORUM_VIEW, 'row type')
        const post = validate(
          get(v.payload, FORUM_SINGLE_VIEW.postFrame) as Uint8Array,
        )
        requireThat(
          equal(
            get(v.payload, FORUM_SINGLE_VIEW.network),
            get(p, FORUM_TOPIC_PAGE.network),
          ) &&
            equal(
              get(post.payload, TOPIC_POST.topic),
              get(p, FORUM_TOPIC_PAGE.topic),
            ) &&
            equal(get(v.payload, FORUM_SINGLE_VIEW.revision), rev) &&
            equal(get(v.payload, FORUM_SINGLE_VIEW.epoch), epoch),
          'row binding',
        )
        const time = get(v.payload, FORUM_SINGLE_VIEW.firstVisible),
          id = t1(post.raw)
        requireThat(
          timeOrder(time, get(p, FORUM_TOPIC_PAGE.since)) >= 0,
          'since',
        )
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
        keys(
          row,
          [
            FORUM_DISCOVERY_ENTRY.topic,
            FORUM_DISCOVERY_ENTRY.count,
            FORUM_DISCOVERY_ENTRY.lastActivity,
          ],
          future,
        )
        const name = text(get(row, FORUM_DISCOVERY_ENTRY.topic), 1, 512)
        uint(get(row, FORUM_DISCOVERY_ENTRY.count))
        timestamp(get(row, FORUM_DISCOVERY_ENTRY.lastActivity))
        if (previous !== undefined)
          requireThat(
            Buffer.compare(Buffer.from(previous as string), Buffer.from(name)) <
              0,
            'discovery order',
          )
        previous = name
      }
    }
  } else if (f.type === TYPE_FORUM_OPERATION_STATUS) {
    requireThat(raw.length <= 2097152, 'status limit')
    keys(
      p,
      [
        FORUM_OPERATION_STATUS.network,
        FORUM_OPERATION_STATUS.submittedFrame,
        FORUM_OPERATION_STATUS.targetHash,
        FORUM_OPERATION_STATUS.transactionHash,
        FORUM_OPERATION_STATUS.sender,
        FORUM_OPERATION_STATUS.direction,
        FORUM_OPERATION_STATUS.value,
        FORUM_OPERATION_STATUS.state,
        FORUM_OPERATION_STATUS.block,
        FORUM_OPERATION_STATUS.transactionIndex,
        FORUM_OPERATION_STATUS.revision,
        FORUM_OPERATION_STATUS.epoch,
      ],
      future,
    )
    const sub = validate(
      bytes(get(p, FORUM_OPERATION_STATUS.submittedFrame), 9, 1048576),
    )
    requireThat(
      (sub.type === TYPE_TOPIC_POST_SUBMISSION ||
        sub.type === TYPE_TOPIC_VOTE_SUBMISSION) &&
        equal(
          get(sub.payload, TOPIC_POST_SUBMISSION.network),
          get(p, FORUM_OPERATION_STATUS.network),
        ),
      'status network',
    )
    const target =
      sub.type === TYPE_TOPIC_POST_SUBMISSION
        ? t1(get(sub.payload, TOPIC_POST_SUBMISSION.postFrame) as Uint8Array)
        : get(sub.payload, TOPIC_POST_SUBMISSION.postFrame)
    requireThat(
      equal(bytes(get(p, FORUM_OPERATION_STATUS.targetHash), 32), target),
      'status target',
    )
    bytes(get(p, FORUM_OPERATION_STATUS.transactionHash), 32)
    bytes(get(p, FORUM_OPERATION_STATUS.sender), 20)
    uint(get(p, FORUM_OPERATION_STATUS.direction), 1n)
    uint(get(p, FORUM_OPERATION_STATUS.value))
    const state = uint(get(p, FORUM_OPERATION_STATUS.state), 3n)
    requireThat(
      has(p, FORUM_OPERATION_STATUS.block) === (state === 2n) &&
        has(p, FORUM_OPERATION_STATUS.transactionIndex) === (state === 2n),
      'confirmation position',
    )
    if (state === 2n) {
      uint(get(p, FORUM_OPERATION_STATUS.block))
      uint(get(p, FORUM_OPERATION_STATUS.transactionIndex))
    }
    if (state === 1n || state === 2n)
      requireThat(
        (get(p, FORUM_OPERATION_STATUS.value) as bigint) > 0n &&
          (get(p, FORUM_OPERATION_STATUS.value) as bigint) <= (1n << 63n) - 1n,
        'burn ceiling',
      )
    uint(get(p, FORUM_OPERATION_STATUS.revision))
    bytes(get(p, FORUM_OPERATION_STATUS.epoch), 16)
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
    schema = type === TYPE_TOPIC_POST ? 2 : 1,
    min = type === TYPE_TOPIC_POST ? 2 : 1,
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
      ...(type === TYPE_TOPIC_POST
        ? { t1: toHex(t1(raw)), t7: toHex(topicVoteCommitment(NET, t1(raw))) }
        : {}),
    })
    return raw
  }
  const content = (
    entry: Encodable = M([
      [FORUM_POST_ENTRY.kind, 1],
      [FORUM_POST_ENTRY.title, 'Title'],
      [FORUM_POST_ENTRY.url, 'https://example.invalid/é?q=é'],
      [FORUM_POST_ENTRY.message, 'Body 😀 é é'],
    ]),
    time = stamp(),
  ) =>
    encodeCanonical(
      M([
        [FORUM_CONTENT.authored, time],
        [FORUM_CONTENT.entries, [entry]],
      ]),
    )
  const post = (body: Uint8Array, parent?: Uint8Array) =>
    M([
      [TOPIC_POST.network, NET],
      [TOPIC_POST.topic, TOPIC],
      ...(parent
        ? [[TOPIC_POST.parentHash, parent] as [number, Encodable]]
        : []),
      [TOPIC_POST.body, body],
    ])
  const top = add('typescript-origin', TYPE_TOPIC_POST, post(content()))
  const rust = add(
    'rust-origin',
    TYPE_TOPIC_POST,
    post(
      content(
        M([
          [FORUM_POST_ENTRY.kind, 1],
          [FORUM_POST_ENTRY.message, 'Rust origin λ'],
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
    TYPE_TOPIC_POST,
    post(
      content(
        M([
          [FORUM_POST_ENTRY.kind, 1],
          [FORUM_POST_ENTRY.message, 'Reply'],
        ]),
      ),
      t1(top),
    ),
  )
  add(
    'different-authored-time',
    TYPE_TOPIC_POST,
    post(content(undefined, stamp(1700000001n))),
  )
  add(
    'multiple-entries',
    TYPE_TOPIC_POST,
    post(
      encodeCanonical(
        M([
          [FORUM_CONTENT.authored, stamp()],
          [
            FORUM_CONTENT.entries,
            [
              M([
                [FORUM_POST_ENTRY.kind, 1],
                [FORUM_POST_ENTRY.title, 'First'],
              ]),
              M([
                [FORUM_POST_ENTRY.kind, 1],
                [FORUM_POST_ENTRY.message, 'Second'],
              ]),
            ],
          ],
        ]),
      ),
    ),
  )
  add(
    'empty-optionals',
    TYPE_TOPIC_POST,
    post(
      content(
        M([
          [FORUM_POST_ENTRY.kind, 1],
          [FORUM_POST_ENTRY.title, ''],
          [FORUM_POST_ENTRY.url, ''],
          [FORUM_POST_ENTRY.message, ''],
        ]),
      ),
    ),
  )
  add(
    'absent-optionals',
    TYPE_TOPIC_POST,
    post(content(M([[FORUM_POST_ENTRY.kind, 1]]))),
  )
  add(
    'future-retention',
    TYPE_TOPIC_POST,
    post(
      encodeCanonical(
        M([
          [FORUM_CONTENT.authored, stamp()],
          [
            FORUM_CONTENT.entries,
            [
              M([
                [FORUM_POST_ENTRY.kind, 1],
                [FORUM_POST_ENTRY.message, 'Known'],
                // raw-cbor-key: key 99 is undeclared: a future field the reader retains
                [99, fromHex('aabb')],
              ]),
              M([
                [FORUM_POST_ENTRY.kind, 27],
                // raw-cbor-key: key 42 is undeclared: an unknown future entry kind's field
                [42, 'opaque'],
              ]),
            ],
          ],
          // raw-cbor-key: key 77 is undeclared: a future field the reader retains
          [77, fromHex('0102')],
        ]),
      ),
    ),
    true,
    3,
    2,
  )
  add('required-version', TYPE_TOPIC_POST, post(content()), false, 3, 3)
  add(
    'unknown-kind',
    TYPE_TOPIC_POST,
    post(content(M([[FORUM_ENTRY.kind, 27]]))),
    false,
  )
  add(
    'unknown-key-current',
    TYPE_TOPIC_POST,
    post(
      content(
        M([
          [FORUM_POST_ENTRY.kind, 1],
          // raw-cbor-key: key 9 is undeclared in a current-schema post entry
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
    add(id, TYPE_TOPIC_POST, post(fromHex(raw)), false)
  add(
    'empty-entries',
    TYPE_TOPIC_POST,
    post(
      encodeCanonical(
        M([
          [FORUM_CONTENT.authored, stamp()],
          [FORUM_CONTENT.entries, []],
        ]),
      ),
    ),
    false,
  )
  add(
    'too-many-entries',
    TYPE_TOPIC_POST,
    post(
      encodeCanonical(
        M([
          [FORUM_CONTENT.authored, stamp()],
          [
            FORUM_CONTENT.entries,
            Array(65).fill(M([[FORUM_POST_ENTRY.kind, 1]])),
          ],
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
      TYPE_TOPIC_POST_SUBMISSION,
      M([
        [TOPIC_POST_SUBMISSION.network, NET],
        [TOPIC_POST_SUBMISSION.postFrame, top],
        [TOPIC_POST_SUBMISSION.burnTx, txA],
      ]),
    ),
    subB = add(
      'submission-b',
      TYPE_TOPIC_POST_SUBMISSION,
      M([
        [TOPIC_POST_SUBMISSION.network, NET],
        [TOPIC_POST_SUBMISSION.postFrame, top],
        [TOPIC_POST_SUBMISSION.burnTx, txB],
      ]),
    )
  add(
    'vote',
    TYPE_TOPIC_VOTE_SUBMISSION,
    M([
      [TOPIC_VOTE_SUBMISSION.network, NET],
      [TOPIC_VOTE_SUBMISSION.targetHash, t1(top)],
      [TOPIC_VOTE_SUBMISSION.burnTx, txB],
    ]),
  )
  const magnitude = fromHex(
    '0000000000000000000000000000000000000000000000010000000000000001',
  )
  const view = (frame: Uint8Array, epoch = EPOCH) => {
    const tx = frame === rust ? fromHex('02aabb03') : txA
    return M([
      [FORUM_SINGLE_VIEW.network, NET],
      [FORUM_SINGLE_VIEW.postFrame, frame],
      [FORUM_SINGLE_VIEW.author, sender],
      [FORUM_SINGLE_VIEW.authorBurnTx, tx],
      [FORUM_SINGLE_VIEW.transactionHash, keccak_256(tx)],
      [FORUM_SINGLE_VIEW.firstVisible, stamp()],
      [FORUM_SINGLE_VIEW.block, U64],
      [FORUM_SINGLE_VIEW.transactionIndex, 0],
      [
        FORUM_SINGLE_VIEW.aggregate,
        M([
          [FORUM_AGGREGATE.negative, false],
          [FORUM_AGGREGATE.magnitude, magnitude],
        ]),
      ],
      [FORUM_SINGLE_VIEW.revision, U64],
      [FORUM_SINGLE_VIEW.epoch, epoch],
    ])
  }
  const viewA = add('view-large-aggregate', TYPE_FORUM_VIEW, view(top)),
    viewB = add('view-rust', TYPE_FORUM_VIEW, view(rust))
  const negative = view(top)
  negative.set(
    8,
    M([
      [FORUM_AGGREGATE.negative, true],
      [FORUM_AGGREGATE.magnitude, new Uint8Array(32)],
    ]),
  )
  add('negative-zero', TYPE_FORUM_VIEW, negative, false)
  const pageRows = [viewA, viewB].sort((a, b) =>
    Buffer.compare(
      Buffer.from(
        t1(get(open(a).payload, FORUM_SINGLE_VIEW.postFrame) as Uint8Array),
      ),
      Buffer.from(
        t1(get(open(b).payload, FORUM_SINGLE_VIEW.postFrame) as Uint8Array),
      ),
    ),
  )
  add(
    'equal-time-page',
    TYPE_FORUM_TOPIC_PAGE,
    M([
      [FORUM_TOPIC_PAGE.network, NET],
      [FORUM_TOPIC_PAGE.topic, TOPIC],
      [FORUM_TOPIC_PAGE.since, stamp()],
      [FORUM_TOPIC_PAGE.revision, U64],
      [FORUM_TOPIC_PAGE.rows, pageRows],
      [FORUM_TOPIC_PAGE.epoch, EPOCH],
    ]),
  )
  add(
    'wrong-topic-page',
    TYPE_FORUM_TOPIC_PAGE,
    M([
      [FORUM_TOPIC_PAGE.network, NET],
      [FORUM_TOPIC_PAGE.topic, 'other'],
      [FORUM_TOPIC_PAGE.since, stamp()],
      [FORUM_TOPIC_PAGE.revision, U64],
      [FORUM_TOPIC_PAGE.rows, pageRows],
      [FORUM_TOPIC_PAGE.epoch, EPOCH],
    ]),
    false,
  )
  add(
    'wrong-epoch-page',
    TYPE_FORUM_TOPIC_PAGE,
    M([
      [FORUM_TOPIC_PAGE.network, NET],
      [FORUM_TOPIC_PAGE.topic, TOPIC],
      [FORUM_TOPIC_PAGE.since, stamp()],
      [FORUM_TOPIC_PAGE.revision, U64],
      [FORUM_TOPIC_PAGE.rows, pageRows],
      [FORUM_TOPIC_PAGE.epoch, new Uint8Array(16)],
    ]),
    false,
  )
  add(
    'discovery-u64',
    TYPE_FORUM_DISCOVERY_PAGE,
    M([
      [FORUM_DISCOVERY_PAGE.network, NET],
      [FORUM_DISCOVERY_PAGE.revision, U64],
      [
        FORUM_DISCOVERY_PAGE.entries,
        [
          M([
            [FORUM_DISCOVERY_ENTRY.topic, 'a'],
            [FORUM_DISCOVERY_ENTRY.count, U64],
            [FORUM_DISCOVERY_ENTRY.lastActivity, stamp()],
          ]),
          M([
            [FORUM_DISCOVERY_ENTRY.topic, 'é'],
            [FORUM_DISCOVERY_ENTRY.count, 1],
            [FORUM_DISCOVERY_ENTRY.lastActivity, stamp()],
          ]),
        ],
      ],
      [FORUM_DISCOVERY_PAGE.epoch, EPOCH],
    ]),
  )
  const status = (submission: Uint8Array, state: number) =>
    M([
      [FORUM_OPERATION_STATUS.network, NET],
      [FORUM_OPERATION_STATUS.submittedFrame, submission],
      [FORUM_OPERATION_STATUS.targetHash, t1(top)],
      [
        FORUM_OPERATION_STATUS.transactionHash,
        keccak_256(submission === subA ? txA : txB),
      ],
      [FORUM_OPERATION_STATUS.sender, sender],
      [FORUM_OPERATION_STATUS.direction, 1],
      [FORUM_OPERATION_STATUS.value, 9007199254740993n],
      [FORUM_OPERATION_STATUS.state, state],
      ...(state === 2
        ? ([
            [FORUM_OPERATION_STATUS.block, U64],
            [FORUM_OPERATION_STATUS.transactionIndex, 0],
          ] as [number, Encodable][])
        : []),
      [FORUM_OPERATION_STATUS.revision, U64],
      [FORUM_OPERATION_STATUS.epoch, EPOCH],
    ])
  add('confirmed-a', TYPE_FORUM_OPERATION_STATUS, status(subA, 2))
  add('unknown-b-same-post', TYPE_FORUM_OPERATION_STATUS, status(subB, 0))
  add('pending-a', TYPE_FORUM_OPERATION_STATUS, status(subA, 1))
  add('rejected-b', TYPE_FORUM_OPERATION_STATUS, status(subB, 3))
  for (const [label, key, v] of [
    ['tx', FORUM_OPERATION_STATUS.transactionHash, new Uint8Array(32)],
    ['sender', FORUM_OPERATION_STATUS.sender, new Uint8Array(20)],
    ['direction', FORUM_OPERATION_STATUS.direction, 0],
    ['value', FORUM_OPERATION_STATUS.value, 1n],
  ] as [string, number, Encodable][]) {
    const changed = status(subA, 2)
    changed.set(key, v)
    add(`mismatched-response-${label}`, TYPE_FORUM_OPERATION_STATUS, changed)
  }
  const wrongTarget = status(subA, 2)
  wrongTarget.set(FORUM_OPERATION_STATUS.targetHash, new Uint8Array(32))
  add('wrong-target', TYPE_FORUM_OPERATION_STATUS, wrongTarget, false)
  const wrongNet = status(subA, 2)
  wrongNet.set(FORUM_OPERATION_STATUS.network, 'other')
  add('wrong-network', TYPE_FORUM_OPERATION_STATUS, wrongNet, false)
  const highBurn = status(subA, 2)
  highBurn.set(FORUM_OPERATION_STATUS.value, U64)
  add('u64-burn-not-admitted', TYPE_FORUM_OPERATION_STATUS, highBurn, false)
  const unknownPosition = status(subB, 0)
  unknownPosition.set(FORUM_OPERATION_STATUS.block, 1)
  add(
    'unknown-cannot-have-position',
    TYPE_FORUM_OPERATION_STATUS,
    unknownPosition,
    false,
  )
  return out
}

// Local fixture policy boundaries. Synthetic observations deliberately do not assert signatures.
function bindStatus(
  raw: Uint8Array,
  request: FrankValue,
  observed?: FrankValue,
): string {
  const p = validate(raw).payload
  for (const k of [
    FORUM_OPERATION_STATUS.network,
    FORUM_OPERATION_STATUS.submittedFrame,
    FORUM_OPERATION_STATUS.targetHash,
    FORUM_OPERATION_STATUS.transactionHash,
    FORUM_OPERATION_STATUS.sender,
    FORUM_OPERATION_STATUS.direction,
    FORUM_OPERATION_STATUS.value,
  ])
    requireThat(equal(get(p, k), get(request, k)), `request mismatch ${k}`)
  const state = get(p, FORUM_OPERATION_STATUS.state)
  if (state === 0n || state === 3n) return 'unverified-request'
  requireThat(observed !== undefined, 'missing observation')
  const submission = open(
    get(p, FORUM_OPERATION_STATUS.submittedFrame) as Uint8Array,
  )
  requireThat(
    equal(
      get(p, FORUM_OPERATION_STATUS.transactionHash),
      keccak_256(
        get(submission.payload, TOPIC_POST_SUBMISSION.burnTx) as Uint8Array,
      ),
    ),
    'raw transaction hash',
  )
  for (const k of [
    FORUM_OPERATION_STATUS.network,
    FORUM_OPERATION_STATUS.submittedFrame,
    FORUM_OPERATION_STATUS.targetHash,
    FORUM_OPERATION_STATUS.transactionHash,
    FORUM_OPERATION_STATUS.sender,
    FORUM_OPERATION_STATUS.direction,
    FORUM_OPERATION_STATUS.value,
  ])
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
      get(p, FORUM_SINGLE_VIEW.authorBurnTx) as Uint8Array,
      t1(get(p, FORUM_SINGLE_VIEW.postFrame) as Uint8Array),
      get(p, FORUM_SINGLE_VIEW.network) as string,
    )
    assert.equal(
      toHex(get(p, FORUM_SINGLE_VIEW.author) as Uint8Array),
      fact.sender,
    )
    assert.equal(
      toHex(get(p, FORUM_SINGLE_VIEW.transactionHash) as Uint8Array),
      fact.hash,
    )
    assert.equal(fact.direction, 1)
    rejects(() =>
      factFor(
        get(p, FORUM_SINGLE_VIEW.authorBurnTx) as Uint8Array,
        new Uint8Array(32),
        NET,
      ),
    )
  }
  for (const id of ['confirmed-a', 'pending-a']) {
    const raw = fromHex(all.find(f => f.id === id)!.hex),
      p = validate(raw).payload,
      sub = open(get(p, FORUM_OPERATION_STATUS.submittedFrame) as Uint8Array)
    const fact = factFor(
      get(sub.payload, TOPIC_POST_SUBMISSION.burnTx) as Uint8Array,
      get(p, FORUM_OPERATION_STATUS.targetHash) as Uint8Array,
      get(p, FORUM_OPERATION_STATUS.network) as string,
    )
    const observed = M([
      [FORUM_OPERATION_STATUS.network, fact.network],
      [
        FORUM_OPERATION_STATUS.submittedFrame,
        get(p, FORUM_OPERATION_STATUS.submittedFrame),
      ],
      [FORUM_OPERATION_STATUS.targetHash, fromHex(fact.target)],
      [FORUM_OPERATION_STATUS.transactionHash, fromHex(fact.hash)],
      [FORUM_OPERATION_STATUS.sender, fromHex(fact.sender)],
      [FORUM_OPERATION_STATUS.direction, fact.direction],
      [FORUM_OPERATION_STATUS.value, BigInt(fact.value)],
    ])
    assert.equal(
      bindStatus(raw, p, decodeCanonical(encodeCanonical(observed))),
      id === 'confirmed-a' ? 'relay-confirmed' : 'relay-pending',
    )
  }
}
function cursorFixtures(all: Fixture[], family = TYPE_FORUM_TOPIC_PAGE) {
  const top = fromHex(all.find(f => f.id === 'typescript-origin')!.hex)
  const cursor = M([
    [FORUM_TOPIC_CURSOR.network, NET],
    [FORUM_TOPIC_CURSOR.family, TYPE_FORUM_TOPIC_PAGE],
    [FORUM_TOPIC_CURSOR.revision, U64],
    [FORUM_TOPIC_CURSOR.epoch, EPOCH],
    [
      FORUM_TOPIC_CURSOR.last,
      M([
        [FORUM_CURSOR_LAST.timestamp, stamp()],
        [FORUM_CURSOR_LAST.hash, t1(top)],
      ]),
    ],
    [FORUM_TOPIC_CURSOR.topic, TOPIC],
    [FORUM_TOPIC_CURSOR.since, stamp()],
    [FORUM_TOPIC_CURSOR.incarnation, 1n],
  ])
  if (family === TYPE_FORUM_DISCOVERY_PAGE) {
    cursor.set(FORUM_DISCOVERY_CURSOR.family, TYPE_FORUM_DISCOVERY_PAGE)
    cursor.set(FORUM_DISCOVERY_CURSOR.last, TOPIC)
    cursor.delete(FORUM_TOPIC_CURSOR.topic)
    cursor.delete(FORUM_TOPIC_CURSOR.since)
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
  add(
    family === TYPE_FORUM_TOPIC_PAGE ? 'topic-cursor' : 'discovery-cursor',
    raw,
    true,
  )
  for (const k of cursor.keys()) {
    const changed = new Map(cursor)
    changed.set(
      k,
      k === FORUM_TOPIC_CURSOR.epoch ? new Uint8Array(16) : 'forged',
    )
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
  recreated.set(FORUM_TOPIC_CURSOR.incarnation, 2n)
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
  missingIncarnation.delete(FORUM_TOPIC_CURSOR.incarnation)
  add('missing-incarnation', encodeCanonical(missingIncarnation), false)
  const lastIncarnation = new Map(cursor)
  lastIncarnation.set(FORUM_TOPIC_CURSOR.incarnation, U64)
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
      retained.set(
        BigInt(FORUM_TOPIC_CURSOR.incarnation),
        BigInt(f.retainedIncarnation),
      )
      keys(c, [...retained.keys()].map(Number))
      const lookupKey = (cursor: FrankValue) =>
        `${toHex(bytes(get(cursor, FORUM_TOPIC_CURSOR.epoch), 16))}:${uint(
          get(cursor, FORUM_TOPIC_CURSOR.incarnation),
        )}`
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
  for (const key of [
    FORUM_OPERATION_STATUS.network,
    FORUM_OPERATION_STATUS.submittedFrame,
    FORUM_OPERATION_STATUS.targetHash,
    FORUM_OPERATION_STATUS.transactionHash,
    FORUM_OPERATION_STATUS.sender,
    FORUM_OPERATION_STATUS.direction,
    FORUM_OPERATION_STATUS.value,
  ]) {
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
        cursors: [
          cursorFixtures(frames),
          cursorFixtures(frames, TYPE_FORUM_DISCOVERY_PAGE),
        ],
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
  assert.deepEqual(doc.cursors, [
    cursorFixtures(all),
    cursorFixtures(all, TYPE_FORUM_DISCOVERY_PAGE),
  ])
  doc.cursors.forEach(checkCursors)
  assert.deepEqual(doc.observations, observations(all))
  checkObserved(all, doc.observations)
  console.log(
    `TypeScript proposal: ${all.length} shared frames, independent encode/T1/T7, hostile binding/cursor/restart policies passed`,
  )
}
