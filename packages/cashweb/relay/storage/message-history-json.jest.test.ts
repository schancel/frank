import { parseMessageRecord, stringifyMessageRecord } from './message-record-json'
const parseHistory = (value: string) => parseMessageRecord(value, value => !!value && typeof value === 'object' && 'message' in value && 'index' in value)

const wrapper = (payload: unknown) => ({
  index: 'fixture',
  outbound: false,
  senderAddress: 'sender',
  copartyAddress: 'peer',
  message: { items: [{ type: 'fixture', payload }] },
})

it('leaves existing JSON history byte-for-byte unchanged and never revives payload lookalikes', () => {
  const original = wrapper({
    json: { bytes: 'AA==' },
    meta: { values: { bytes: [['custom', 'frank-history-bytes']] }, v: 1 },
    type: 'Buffer',
    data: [0, 255],
    omitted: undefined,
    date: new Date('2026-01-01'),
    values: [undefined, NaN, Infinity, , null],
  })
  expect(stringifyMessageRecord(original)).toBe(JSON.stringify(original))
  expect(parseHistory(JSON.stringify(original))).toEqual(
    JSON.parse(JSON.stringify(original)),
  )
})

it('preserves ordinary empty-string properties without confusing them with the root', () => {
  const original = wrapper({ '': { '': 'ordinary JSON' } })
  expect(stringifyMessageRecord(original)).toBe(JSON.stringify(original))
  expect(parseHistory(stringifyMessageRecord(original))).toEqual(
    original,
  )
})

it('rejects byte values at unsupported empty-string paths instead of silently writing objects', () => {
  expect(() =>
    stringifyMessageRecord(wrapper({ '': Uint8Array.of(0, 255) })),
  ).toThrow('Unsupported history byte annotation')
})

it('preserves repeated bytes, Buffer, offsets and JSON semantics alongside binary values', () => {
  const repeated = Uint8Array.of(0, 255, 128)
  const original = wrapper({
    first: repeated,
    second: repeated,
    empty: new Uint8Array(),
    buffer: Buffer.from([255, 0]),
    subarray: Uint8Array.of(42, 128, 255, 42).subarray(1, 3),
    omitted: undefined,
    date: new Date('2026-01-01'),
    values: [undefined, NaN, Infinity, , null],
  })
  const restored = parseHistory(
    stringifyMessageRecord(original),
  ) as ReturnType<typeof wrapper>
  expect(restored.message.items[0].payload).toEqual({
    first: repeated,
    second: repeated,
    empty: new Uint8Array(),
    buffer: Uint8Array.of(255, 0),
    subarray: Uint8Array.of(128, 255),
    date: '2026-01-01T00:00:00.000Z',
    values: [null, null, null, null, null],
  })
  const payload = restored.message.items[0].payload as {
    first: Uint8Array
    second: Uint8Array
  }
  expect(payload.first).toBeInstanceOf(Uint8Array)
  expect(payload.second).toBeInstanceOf(Uint8Array)
  expect(payload.first).not.toBe(repeated)
  expect(payload.second).not.toBe(payload.first)
})

const annotation = [['custom', 'frank-history-bytes']]

it('round-trips a full 512 KiB byte value with base64-sized local storage overhead', () => {
  const bytes = new Uint8Array(512 * 1024).fill(255)
  const encoded = stringifyMessageRecord(wrapper(bytes))
  expect(encoded.length).toBeLessThan(4 * Math.ceil(bytes.length / 3) + 512)
  expect(parseHistory(encoded)).toEqual(wrapper(bytes))
})

const envelope = (
  path = 'message.items.0.payload',
  value: unknown = 'AP+A',
  transform: unknown = annotation,
) => ({
  json: wrapper(value),
  meta: { v: 1, values: { [path]: transform } },
})

it.each([
  envelope('message.items.0.payload', 'AB=='),
  envelope('message.items.0.payload', 'not base64'),
  envelope('message.items.0.payload', [0, 255]),
  envelope('message.items.0.payload', 'AA==', ['Date']),
  envelope('message.items.0.payload', 'AA==', [['typed-array', 'Uint8Array']]),
  envelope('message.items.0.payload', 'AA==', [['custom', 'unknown']]),
  envelope('message.__proto__.polluted'),
  envelope('message.constructor.prototype.polluted'),
  envelope('message.items.00.payload'),
  envelope('message.missing'),
  envelope('message.items.0.payload\\.bad'),
  { ...envelope(), extra: true },
  {
    ...envelope(),
    meta: { ...envelope().meta, referentialEqualities: { a: ['b'] } },
  },
])(
  'rejects unsupported or unsafe annotation envelopes before revival: %j',
  value => {
    expect(() => parseHistory(JSON.stringify(value))).toThrow()
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  },
)

it('keeps annotated-looking objects ordinary within a byte-containing payload', () => {
  const lookalike = envelope()
  const restored = parseHistory(
    stringifyMessageRecord(wrapper({ bytes: Uint8Array.of(255), lookalike })),
  )
  expect(restored).toEqual(wrapper({ bytes: Uint8Array.of(255), lookalike }))
})

it('keeps ordinary JSON behavior for containers without JSON byte properties', () => {
  // JSON represents a Map as {}, so its contents have no durable JSON property path.
  expect(
    stringifyMessageRecord(wrapper(new Map([['bytes', Uint8Array.of(1)]]))),
  ).toBe(JSON.stringify(wrapper({})))
})
