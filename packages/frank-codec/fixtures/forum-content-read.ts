/** Active conformance recipes. Accepted proposal bytes are immutable inputs, not a second parser. */
import proposal from '../../../docs/protocol/proposals/forum-content-read/vectors.json'
import {
  encodeFrame,
  encodeCanonical,
  decodeCanonical,
  fromHex,
  toHex,
  Encodable,
  FrankValue,
} from '../src'
import {
  FORUM_AGGREGATE,
  FORUM_DISCOVERY_PAGE,
  FORUM_SINGLE_VIEW,
  FORUM_TOPIC_PAGE,
  TOPIC_POST,
  TYPE_FORUM_DISCOVERY_PAGE,
  TYPE_FORUM_OPERATION_STATUS,
  TYPE_FORUM_TOPIC_PAGE,
  TYPE_FORUM_VIEW,
  TYPE_TOPIC_POST,
} from '../src/constants'

export type Recipe =
  | null
  | boolean
  | string
  | Recipe[]
  | { int: string }
  | { hex: string }
  | { map: [number, Recipe][] }
export function recipeValue(r: Recipe): Encodable {
  if (r === null || typeof r === 'boolean' || typeof r === 'string') return r
  if (Array.isArray(r)) return r.map(recipeValue)
  if ('int' in r) return BigInt(r.int)
  if ('hex' in r) return fromHex(r.hex)
  return new Map(r.map.map(([k, v]) => [k, recipeValue(v)]))
}
function recipe(value: Encodable): Recipe {
  if (typeof value === 'bigint' || typeof value === 'number')
    return { int: String(value) }
  if (value instanceof Uint8Array) return { hex: toHex(value) }
  if (value instanceof Map)
    return { map: [...value].map(([k, v]) => [Number(k), recipe(v)]) }
  if (Array.isArray(value)) return value.map(recipe)
  return value as null | boolean | string
}
export interface ForumFixture {
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
  error?: string
  context?: {
    readerVersion?: number
    topicSchema?: number
    retention?: boolean
  }
  retained?: boolean
}
export function forumFixture(id: string): ForumFixture {
  const f = proposal.frames.find(f => f.id === id)
  if (!f) throw Error(id)
  return f as ForumFixture
}
export function payloadOf(id: string): Map<number, Encodable> {
  return recipeValue(forumFixture(id).payload) as Map<number, Encodable>
}
export function buildForumCorpus() {
  const frames: ForumFixture[] = proposal.frames.map(
    f => ({ ...f } as ForumFixture),
  )
  const add = (
    id: string,
    type: number,
    payload: Encodable,
    valid: boolean,
    error?: string,
    schema = type === TYPE_TOPIC_POST ? 2 : 1,
    min = type === TYPE_TOPIC_POST ? 2 : 1,
    context?: ForumFixture['context'],
    retained?: boolean,
  ) => {
    frames.push({
      id,
      origin: 'active-typescript',
      type,
      schema,
      min,
      payload: recipe(payload),
      hex: toHex(
        encodeFrame(
          { typeId: type, schemaVersion: schema, minReaderVersion: min },
          payload,
        ),
      ),
      valid,
      ...(error ? { error } : {}),
      ...(context ? { context } : {}),
      ...(retained ? { retained: true } : {}),
    })
  }
  for (const [label, network] of [
    ['uppercase', 'Monad'],
    ['unicode', 'mönad'],
    ['empty', ''],
    ['leading', '-monad'],
    ['long', 'm'.repeat(65)],
  ]) {
    for (const [type, id] of [
      [TYPE_TOPIC_POST, 'typescript-origin'],
      [TYPE_FORUM_VIEW, 'view-large-aggregate'],
      [TYPE_FORUM_TOPIC_PAGE, 'equal-time-page'],
      [TYPE_FORUM_DISCOVERY_PAGE, 'discovery-u64'],
      [TYPE_FORUM_OPERATION_STATUS, 'confirmed-a'],
    ] as const) {
      const p = payloadOf(id)
      // raw-cbor-key: field 0 is network in every forum type this loop covers
      p.set(0, network)
      add(`network-${type}-${label}`, type, p, false, 'schema@8.2')
    }
  }
  // raw-cbor-key: schema-version list, not a map entry
  for (const schema of [2, 3])
    add(
      `min-reader-${schema}-one`,
      TYPE_TOPIC_POST,
      payloadOf('typescript-origin'),
      false,
      'unsupported@7',
      schema,
      1,
    )
  add(
    'per-type-schema-one-reject',
    TYPE_TOPIC_POST,
    payloadOf('typescript-origin'),
    false,
    'unsupported@7',
    2,
    2,
    { topicSchema: 1 },
  )
  add(
    'per-type-schema-one-retain',
    TYPE_TOPIC_POST,
    payloadOf('typescript-origin'),
    true,
    undefined,
    2,
    2,
    { topicSchema: 1, retention: true },
    true,
  )
  add(
    'reader-one-reject',
    TYPE_TOPIC_POST,
    payloadOf('typescript-origin'),
    false,
    'unsupported@7',
    2,
    2,
    { readerVersion: 1 },
  )
  add(
    'reader-one-retain',
    TYPE_TOPIC_POST,
    payloadOf('typescript-origin'),
    true,
    undefined,
    2,
    2,
    { readerVersion: 1, retention: true },
    true,
  )
  add(
    'required-child-per-type-one',
    TYPE_FORUM_VIEW,
    payloadOf('view-large-aggregate'),
    false,
    'unsupported@7',
    1,
    1,
    { topicSchema: 1, retention: true },
  )
  add(
    'opaque-schema-one-cbor',
    TYPE_TOPIC_POST,
    payloadOf('typescript-origin'),
    true,
    undefined,
    1,
    1,
  )
  // raw-cbor-key: schema-version list, not a map entry
  for (const schema of [1, 2]) {
    const p = payloadOf('view-large-aggregate'),
      agg = new Map(
        p.get(FORUM_SINGLE_VIEW.aggregate) as Map<number, Encodable>,
      )
    // raw-cbor-key: key 2 is undeclared in the closed forum aggregate
    agg.set(2, true)
    p.set(FORUM_SINGLE_VIEW.aggregate, agg)
    add(
      `closed-aggregate-schema-${schema}`,
      TYPE_FORUM_VIEW,
      p,
      false,
      'schema@8.2',
      schema,
      1,
    )
  }
  // raw-cbor-key: byte-length list, not a map entry
  for (const length of [31, 33]) {
    const p = payloadOf('view-large-aggregate')
    p.set(
      FORUM_SINGLE_VIEW.aggregate,
      new Map<number, Encodable>([
        [FORUM_AGGREGATE.negative, false],
        [FORUM_AGGREGATE.magnitude, new Uint8Array(length)],
      ]),
    )
    add(`aggregate-size-${length}`, TYPE_FORUM_VIEW, p, false, 'schema@8.2')
  }
  const max = payloadOf('view-large-aggregate')
  max.set(
    FORUM_SINGLE_VIEW.aggregate,
    new Map<number, Encodable>([
      [FORUM_AGGREGATE.negative, true],
      [FORUM_AGGREGATE.magnitude, new Uint8Array(32).fill(255)],
    ]),
  )
  add('aggregate-negative-max', TYPE_FORUM_VIEW, max, true)
  const sign = payloadOf('view-large-aggregate')
  sign.set(
    FORUM_SINGLE_VIEW.aggregate,
    new Map<number, Encodable>([
      [FORUM_AGGREGATE.negative, 1],
      [FORUM_AGGREGATE.magnitude, new Uint8Array(32).fill(1)],
    ]),
  )
  add('aggregate-nonboolean', TYPE_FORUM_VIEW, sign, false, 'schema@8.2')
  for (const type of [TYPE_FORUM_TOPIC_PAGE, TYPE_FORUM_DISCOVERY_PAGE]) {
    const p = payloadOf(
      type === TYPE_FORUM_TOPIC_PAGE ? 'equal-time-page' : 'discovery-u64',
    )
    p.set(
      type === TYPE_FORUM_TOPIC_PAGE
        ? FORUM_TOPIC_PAGE.rows
        : FORUM_DISCOVERY_PAGE.entries,
      [],
    )
    p.set(
      type === TYPE_FORUM_TOPIC_PAGE
        ? FORUM_TOPIC_PAGE.nextCursor
        : FORUM_DISCOVERY_PAGE.nextCursor,
      fromHex(proposal.cursors[type - TYPE_FORUM_TOPIC_PAGE].expected),
    )
    add(`empty-next-${type}`, type, p, false, 'semantic@9')
  }
  // Field-0 grammar must apply inside a required child even when the parent is valid.
  const child = payloadOf('typescript-origin')
  child.set(TOPIC_POST.network, 'UPPER')
  const view = payloadOf('view-large-aggregate')
  view.set(
    FORUM_SINGLE_VIEW.postFrame,
    encodeFrame(
      { typeId: TYPE_TOPIC_POST, schemaVersion: 2, minReaderVersion: 2 },
      child,
    ),
  )
  add('nested-network-grammar', TYPE_FORUM_VIEW, view, false, 'schema@8.2')
  return {
    format: 'active-forum-content-read-v1',
    chainFacts: proposal.chainFacts,
    frames,
    cursors: proposal.cursors.map(c => ({ hex: c.expected })),
    observations: proposal.observations,
  }
}

/** Rewraps one exact nested body for targeted boundary probes. */
export function contentPayload(body: FrankValue): Map<number, Encodable> {
  const p = payloadOf('typescript-origin')
  p.set(TOPIC_POST.body, encodeCanonical(body))
  return p
}
export function baseContent(): Map<bigint, FrankValue> {
  return decodeCanonical(
    payloadOf('typescript-origin').get(TOPIC_POST.body) as Uint8Array,
  ) as Map<bigint, FrankValue>
}
