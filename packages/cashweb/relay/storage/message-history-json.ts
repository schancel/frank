import SuperJSON from 'superjson'

// Local history only. Message-item wire codecs never use this representation.
const BYTE_TRANSFORM = 'frank-history-bytes'
const byteAnnotation = () => [['custom', BYTE_TRANSFORM]]
const historyJson = new SuperJSON()

function decodeBytes(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error('Invalid history byte encoding')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value)
    throw new Error('Noncanonical history byte encoding')
  return Uint8Array.from(bytes)
}

historyJson.registerCustom<Uint8Array, string>(
  {
    isApplicable: (value): value is Uint8Array => value instanceof Uint8Array,
    serialize: value => Buffer.from(value).toString('base64'),
    deserialize: decodeBytes,
  },
  BYTE_TRANSFORM,
)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  )
}

function isWrapper(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    record(value.message) &&
    typeof value.index === 'string' &&
    typeof value.outbound === 'boolean' &&
    typeof value.senderAddress === 'string' &&
    typeof value.copartyAddress === 'string'
  )
}

/** Validate library annotations before they can direct object access or instantiate values. */
function validateAnnotations(json: unknown, meta: unknown): void {
  if (
    !record(meta) ||
    !exactKeys(meta, ['values', 'v']) ||
    meta.v !== 1 ||
    !record(meta.values) ||
    Object.keys(meta.values).length === 0
  )
    throw new Error('Invalid history byte annotations')
  for (const [path, annotation] of Object.entries(meta.values)) {
    if (
      JSON.stringify(annotation) !== JSON.stringify(byteAnnotation()) ||
      !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)
    )
      throw new Error('Unsupported history byte annotation')
    let target: unknown = json
    for (const key of path.split('.')) {
      if (
        ['__proto__', 'prototype', 'constructor'].includes(key) ||
        target === null ||
        typeof target !== 'object' ||
        !Object.hasOwn(target, key) ||
        (Array.isArray(target) && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        throw new Error('Invalid history byte path')
      target = (target as Record<string, unknown>)[key]
    }
    decodeBytes(target)
  }
}

/** Ordinary JSON history keeps its exact representation and JSON normalization semantics. */
export function stringifyMessageHistory(value: object): string {
  let byteCount = 0
  let rootInvocation = true
  const normalized = JSON.stringify(value, function (key, current: unknown) {
    // Buffer.toJSON runs before the replacer. Inspect its holder to retain actual bytes.
    const original: unknown = rootInvocation ? value : this[key]
    rootInvocation = false
    if (!(original instanceof Uint8Array)) return current
    byteCount += 1
    return Buffer.from(original).toString('base64')
  })
  if (byteCount === 0) return normalized
  const encoded = historyJson.serialize(value)
  const values = Object.fromEntries(
    Object.entries(encoded.meta?.values ?? {}).filter(
      ([, annotation]) =>
        JSON.stringify(annotation) === JSON.stringify(byteAnnotation()),
    ),
  )
  const result = {
    json: JSON.parse(normalized) as unknown,
    meta: { values, v: 1 },
  }
  if (Object.keys(values).length !== byteCount)
    throw new Error('History bytes must occupy ordinary JSON properties')
  validateAnnotations(result.json, result.meta)
  return JSON.stringify(result)
}

/** Only the explicit outer annotation envelope can revive bytes; payload lookalikes cannot. */
export function parseMessageHistory(value: string): unknown {
  const parsed: unknown = JSON.parse(value)
  if (isWrapper(parsed)) return parsed
  if (
    !record(parsed) ||
    !exactKeys(parsed, ['json', 'meta']) ||
    !isWrapper(parsed.json)
  )
    throw new Error('Invalid message history wrapper')
  validateAnnotations(parsed.json, parsed.meta)
  return historyJson.deserialize({
    json: parsed.json,
    meta: parsed.meta,
  } as Parameters<typeof historyJson.deserialize>[0])
}
