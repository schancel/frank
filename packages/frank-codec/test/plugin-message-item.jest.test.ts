// Type 27, the generic plugin message item: the committed container vectors, the writer, its
// limits, and the rule that an item's opaque bytes are decoded under the enclosing operation's
// budget and never under a fresh one.
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  FrankCodecError,
  MAX_PLUGIN_ITEM_PAYLOAD_BYTES,
  TYPE_PLUGIN_MESSAGE_ITEM,
  beginDirectMessageValidation,
  defaultContext,
  encodeCanonical,
  encodePluginMessageItem,
  fromHex,
  isPluginItemType,
  isPluginMessageItemFrame,
  projectPluginMessageItem,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type Encodable,
  type NestedItemBudget,
} from '../src'
import {
  M,
  NET,
  T3C,
  acct1,
  bytesOf,
  deliveryPayload,
  fr,
  rev8Frame,
  textItem,
} from '../fixtures/builders'

interface FrameCase {
  id: string
  frameHex: string
  operation: 'typed'
  expected: { result: string; stage?: string; category?: string }
  application?: { itemType: string; dataHex: string }
}
const corpus = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../docs/protocol/cbor/vectors/plugin-message-item.json',
    ),
    'utf8',
  ),
) as { allocation: Record<string, unknown>; frames: FrameCase[] }

function outcome(run: () => unknown): FrameCase['expected'] {
  try {
    const result = run() as { kind: string }
    return { result: result.kind }
  } catch (error) {
    if (!(error instanceof FrankCodecError)) throw error
    return { result: 'reject', stage: error.stage, category: error.category }
  }
}

describe('type 27 vectors (docs/protocol/cbor/vectors/plugin-message-item.json)', () => {
  it('states the allocation the codec implements', () => {
    expect(corpus.allocation).toEqual({
      typeId: TYPE_PLUGIN_MESSAGE_ITEM,
      schemaVersion: 1,
      minReaderVersion: 1,
      maximumTypeBytes: 64,
      maximumDataBytes: MAX_PLUGIN_ITEM_PAYLOAD_BYTES,
      typePattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
    })
    expect(TYPE_PLUGIN_MESSAGE_ITEM).toBe(27)
  })

  it.each(corpus.frames.map(c => [c.id, c] as const))('%s', (_, c) => {
    const frame = fromHex(c.frameHex)
    expect(outcome(() => validateFrame(frame))).toEqual(c.expected)
    if (!c.application) return
    const parsed = validateFrame(frame)
    if (parsed.kind !== 'parsed') throw new Error('expected a parsed frame')
    expect(isPluginMessageItemFrame(parsed)).toBe(true)
    const projected = projectPluginMessageItem(parsed)
    expect(projected.itemType).toBe(c.application.itemType)
    expect(toHex(projected.data)).toBe(c.application.dataHex)
    // The writer gives the committed bytes for every exact-schema case.
    if (parsed.schemaVersion === 1)
      expect(toHex(encodePluginMessageItem(projected))).toBe(c.frameHex)
  })

  it('opens a plugin item inside a revision as a parsed child, next to a text item', () => {
    const c = corpus.frames.find(
      f => f.id === 'revision-with-text-and-plugin-item',
    )!
    const parsed = validateFrame(fromHex(c.frameHex))
    if (parsed.kind !== 'parsed' || parsed.typed?.type !== 8)
      throw new Error('expected a type-8 revision')
    expect(parsed.typed.items.map(i => i.kind)).toEqual(['parsed', 'parsed'])
    expect(isPluginMessageItemFrame(parsed.typed.items[1])).toBe(true)
  })
})

describe('type 27 writer and limits', () => {
  it.each([
    ['', false],
    ['dice', true],
    ['liars-dice', true],
    ['p2pkh', true],
    ['a'.repeat(64), true],
    ['a'.repeat(65), false],
    ['Dice', false],
    ['dice ', false],
    ['liars_dice', false],
    ['-dice', false],
    ['dice-', false],
    ['a--b', false],
    ['dïce', false],
    [27, false],
    [undefined, false],
  ])('isPluginItemType(%p) is %p', (value, expected) => {
    expect(isPluginItemType(value)).toBe(expected)
  })

  it('refuses to write a bad identifier, non-bytes, or oversize bytes', () => {
    const data = Uint8Array.of(1)
    for (const itemType of ['', 'Dice', 'a b', 'a'.repeat(65)])
      expect(() => encodePluginMessageItem({ itemType, data })).toThrow(
        FrankCodecError,
      )
    expect(() =>
      encodePluginMessageItem({
        itemType: 'dice',
        data: 'roll' as unknown as Uint8Array,
      }),
    ).toThrow(FrankCodecError)
    expect(() =>
      encodePluginMessageItem({
        itemType: 'dice',
        data: new Uint8Array(MAX_PLUGIN_ITEM_PAYLOAD_BYTES + 1),
      }),
    ).toThrow(FrankCodecError)
  })

  it('accepts bytes at the limit and rejects one more byte as a resource error at 8.1', () => {
    const at = encodePluginMessageItem({
      itemType: 'image',
      data: new Uint8Array(MAX_PLUGIN_ITEM_PAYLOAD_BYTES),
    })
    expect(validateFrame(at).kind).toBe('parsed')
    const over = fr(
      27,
      M([
        [0, 'image'],
        [1, new Uint8Array(MAX_PLUGIN_ITEM_PAYLOAD_BYTES + 1)],
      ]),
    )
    expect(outcome(() => validateFrame(over))).toEqual({
      result: 'reject',
      stage: '8.1',
      category: 'resource',
    })
  })

  it('does not copy-alias the caller bytes into the projection', () => {
    const data = Uint8Array.of(1, 2, 3)
    const parsed = validateFrame(
      encodePluginMessageItem({ itemType: 'dice', data }),
    )
    if (parsed.kind !== 'parsed') throw new Error('expected a parsed frame')
    const projected = projectPluginMessageItem(parsed)
    projected.data[0] = 9
    expect(toHex(projectPluginMessageItem(parsed).data)).toBe('010203')
  })
})

// A structural type-1 -> type-5 -> type-6 -> type-8 message whose items are plugin items.
function session(items: Uint8Array[]): NestedItemBudget {
  const encrypted = fr(
    5,
    M([
      [0, NET],
      [1, acct1(9)],
      [2, acct1(3)],
      [3, 1],
      [4, Uint8Array.of(0xa0)],
      [5, T3C.ephemeral],
      [6, T3C.shared],
      [7, T3C.proof],
    ]),
    2,
    2,
  )
  const root = fr(1, deliveryPayload({ payloadFrame: encrypted }), 1, 1)
  const content = fr(
    6,
    M([
      [0, NET],
      [1, bytesOf(16, 7)],
      [2, rev8Frame(items)],
      [3, bytesOf(32, 8)],
      [4, bytesOf(16, 8)],
    ]),
  )
  return beginDirectMessageValidation(
    root,
    defaultContext(),
  ).completeAuthenticatedContent(content).itemBudget
}
const pluginItem = (value: Encodable): Uint8Array =>
  encodePluginMessageItem({ itemType: 'dice', data: encodeCanonical(value) })
const dataOf = (frame: Uint8Array): Uint8Array => {
  const parsed = validateFrame(frame)
  if (parsed.kind !== 'parsed') throw new Error('expected a parsed frame')
  return projectPluginMessageItem(parsed).data
}
const nested = (levels: number): Encodable => {
  let value: Encodable = 0
  for (let i = 0; i < levels; i++) value = [value]
  return value
}
const resource = { result: 'reject', stage: '8.4', category: 'resource' }

describe('a plugin item is decoded under the enclosing budget', () => {
  // 4,096 empty arrays inside one array: 4,097 containers. One such item is far below
  // MAX_CONTAINERS (16,384); four of them in one message are over it.
  const heavy = pluginItem(Array.from({ length: 4096 }, () => []))

  it('one item alone is within a whole budget', () => {
    expect(() => standaloneItemBudget().decodeCbor(dataOf(heavy))).not.toThrow()
  })

  it('items that are each valid alone are refused together when they exceed the message limits', () => {
    const items = [heavy, heavy, heavy, heavy]
    const budget = session(items)
    const results = items.map(item =>
      outcome(() => ({ kind: typeof budget.decodeCbor(dataOf(item)) })),
    )
    expect(results.slice(0, 3)).toEqual([
      { result: 'object' },
      { result: 'object' },
      { result: 'object' },
    ])
    expect(results[3]).toEqual(resource)
    // The budget stays exhausted: nothing later in this message is given a new one.
    expect(outcome(() => budget.decodeCbor(dataOf(heavy)))).toEqual(resource)
  })

  it('charges item counts as well as containers', () => {
    // 8,192 scalars per array, 8 arrays: 65,545 items per plugin item; two exceed MAX_ITEMS.
    const wide = pluginItem(
      Array.from({ length: 8 }, () => Array.from({ length: 8192 }, () => 0)),
    )
    const budget = session([wide, wide])
    expect(() => budget.decodeCbor(dataOf(wide))).not.toThrow()
    expect(outcome(() => budget.decodeCbor(dataOf(wide)))).toEqual(resource)
  })

  it('continues the enclosing depth instead of starting at zero', () => {
    // The bytes sit eleven levels deep in a type-1 delivery, so 21 more levels reach MAX_DEPTH.
    const budget = session([pluginItem(0)])
    expect(() => budget.decodeCbor(encodeCanonical(nested(21)))).not.toThrow()
    expect(
      outcome(() => budget.decodeCbor(encodeCanonical(nested(22)))),
    ).toEqual(resource)
    expect(
      outcome(() =>
        standaloneItemBudget().decodeCbor(encodeCanonical(nested(22))),
      ),
    ).toEqual(resource)
  })

  it('counts a frame nested in plugin bytes against the 256 opened items of the message', () => {
    const items = Array.from({ length: 255 }, () => textItem('x'))
    const budget = session(items)
    expect(budget.openFrame(textItem('nested')).kind).toBe('parsed')
    expect(outcome(() => budget.openFrame(textItem('nested')))).toEqual(
      resource,
    )
  })

  it('returns an unknown nested frame retained, never interpreted', () => {
    const unknown = fr(0xffff0001, M([[0, 1]]))
    const opened = standaloneItemBudget().openFrame(unknown)
    expect(opened.kind).toBe('retained')
    expect(toHex(opened.frame)).toBe(toHex(unknown))
  })
})
