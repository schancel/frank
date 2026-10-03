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
    schema = type === 9 ? 2 : 1,
    min = type === 9 ? 2 : 1,
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
      [9, 'typescript-origin'],
      [12, 'view-large-aggregate'],
      [13, 'equal-time-page'],
      [14, 'discovery-u64'],
      [15, 'confirmed-a'],
    ] as const) {
      const p = payloadOf(id)
      p.set(0, network)
      add(`network-${type}-${label}`, type, p, false, 'schema@8.2')
    }
  }
  for (const schema of [2, 3])
    add(
      `min-reader-${schema}-one`,
      9,
      payloadOf('typescript-origin'),
      false,
      'unsupported@7',
      schema,
      1,
    )
  add(
    'per-type-schema-one-reject',
    9,
    payloadOf('typescript-origin'),
    false,
    'unsupported@7',
    2,
    2,
    { topicSchema: 1 },
  )
  add(
    'per-type-schema-one-retain',
    9,
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
    9,
    payloadOf('typescript-origin'),
    false,
    'unsupported@7',
    2,
    2,
    { readerVersion: 1 },
  )
  add(
    'reader-one-retain',
    9,
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
    12,
    payloadOf('view-large-aggregate'),
    false,
    'unsupported@7',
    1,
    1,
    { topicSchema: 1, retention: true },
  )
  add(
    'opaque-schema-one-cbor',
    9,
    payloadOf('typescript-origin'),
    true,
    undefined,
    1,
    1,
  )
  for (const schema of [1, 2]) {
    const p = payloadOf('view-large-aggregate'),
      agg = new Map(p.get(8) as Map<number, Encodable>)
    agg.set(2, true)
    p.set(8, agg)
    add(
      `closed-aggregate-schema-${schema}`,
      12,
      p,
      false,
      'schema@8.2',
      schema,
      1,
    )
  }
  for (const length of [31, 33]) {
    const p = payloadOf('view-large-aggregate')
    p.set(
      8,
      new Map<number, Encodable>([
        [0, false],
        [1, new Uint8Array(length)],
      ]),
    )
    add(`aggregate-size-${length}`, 12, p, false, 'schema@8.2')
  }
  const max = payloadOf('view-large-aggregate')
  max.set(
    8,
    new Map<number, Encodable>([
      [0, true],
      [1, new Uint8Array(32).fill(255)],
    ]),
  )
  add('aggregate-negative-max', 12, max, true)
  const sign = payloadOf('view-large-aggregate')
  sign.set(
    8,
    new Map<number, Encodable>([
      [0, 1],
      [1, new Uint8Array(32).fill(1)],
    ]),
  )
  add('aggregate-nonboolean', 12, sign, false, 'schema@8.2')
  for (const type of [13, 14]) {
    const p = payloadOf(type === 13 ? 'equal-time-page' : 'discovery-u64')
    p.set(type === 13 ? 4 : 2, [])
    p.set(type === 13 ? 5 : 3, fromHex(proposal.cursors[type - 13].expected))
    add(`empty-next-${type}`, type, p, false, 'semantic@9')
  }
  // Field-0 grammar must apply inside a required child even when the parent is valid.
  const child = payloadOf('typescript-origin')
  child.set(0, 'UPPER')
  const view = payloadOf('view-large-aggregate')
  view.set(
    1,
    encodeFrame({ typeId: 9, schemaVersion: 2, minReaderVersion: 2 }, child),
  )
  add('nested-network-grammar', 12, view, false, 'schema@8.2')
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
  p.set(3, encodeCanonical(body))
  return p
}
export function baseContent(): Map<bigint, FrankValue> {
  return decodeCanonical(
    payloadOf('typescript-origin').get(3) as Uint8Array,
  ) as Map<bigint, FrankValue>
}
