import { JsonRpcProvider } from 'ethers'
import type {
  ApplicationMessageItem,
  Message,
} from '@frank/cashweb/types/messages'
import {
  encodeCanonical,
  encodeFrame,
  encodePluginMessageItem,
  standaloneItemBudget,
  toHex,
  TYPE_MESSAGE_CONTENT_REVISION,
  validateFrame,
  type ChildFrame,
} from '@frank/codec'
import { messageItemType, validateApplicationValue } from '@frank/cashweb/message-items/application-item'
import {
  createMessageItemRegistry,
  MessageItemDecodeError,
  MessageItemEncodeError,
  MessageItemPluginAlreadyRegisteredError,
  type ApplicationItemPlugin,
} from '@frank/cashweb/message-items/registry'
import {
  decodeItemFrames,
  encodeItemFrames,
  MessageItemBudgetExceededError,
  MessageItemNotCarriedError,
  DEDICATED_ITEM_FRAMES,
  SELF_ONLY_ITEM_TYPES,
  NOT_CARRIED_ITEM_TYPES,
  receiveLegacyItems,
} from './wire'

// This feature-owned type is deliberately absent from the cashweb union.
interface Note {
  label: string
}
const read = (value: unknown): Note => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('label' in value) ||
    typeof value.label !== 'string'
  )
    throw new Error('Expected a note label')
  return { label: value.label }
}
const plugin = (itemType: string): ApplicationItemPlugin<Note> => ({
  itemType,
  read,
  encode: value => new TextEncoder().encode(value.label),
  decode: bytes => ({ label: new TextDecoder().decode(bytes) }),
  previewText: value => `${itemType}: ${value.label}`,
})
const item = (
  itemType: string,
  value: unknown = { label: 'hello' },
): ApplicationMessageItem => ({ type: 'application', itemType, value })
const children = (frames: Uint8Array[]): ChildFrame[] => {
  const parsed = validateFrame(
    encodeFrame(
      {
        typeId: TYPE_MESSAGE_CONTENT_REVISION,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      new Map([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('Expected revision')
  return parsed.typed.items
}

describe('typed application item bridge', () => {
  it('routes two feature-owned values, persists plain data and hydrates validated values', async () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(plugin('note-a'))
    registry.registerApplication(plugin('note-b'))
    const values = [item('note-a'), item('note-b', { label: 'second' })]
    const restored: unknown = JSON.parse(JSON.stringify(values))
    expect(restored).toEqual(values)
    const frames = encodeItemFrames(registry, values)
    expect(frames.map(toHex)).toEqual(
      values.map(value =>
        toHex(
          encodePluginMessageItem({
            itemType: value.itemType,
            data: registry.encodeItem(value).bytes,
          }),
        ),
      ),
    )
    expect(
      decodeItemFrames(registry, children(frames), standaloneItemBudget()),
    ).toEqual(values)
    expect(receiveLegacyItems(registry, values)).toEqual(values)
    expect(values.map(value => registry.previewText(value))).toEqual([
      'note-a: hello',
      'note-b: second',
    ])
    expect(registry.tallyValue(values)).toBe(0)
    const message: Message = {
      outbound: false,
      status: 'confirmed',
      receivedTime: 0,
      serverTime: 0,
      senderAddress: 'peer',
      items: values,
      outpoints: [],
    }
    const provider = new JsonRpcProvider()
    try {
      const hydrated = await registry.hydrateItems(message, provider)
      expect(
        hydrated.map(value =>
          value.kind === 'hydrated' ? value.hydrated : null,
        ),
      ).toEqual([{ label: 'hello' }, { label: 'second' }])
    } finally {
      provider.destroy()
    }
    const copied = createMessageItemRegistry()
    for (const type of registry.types()) copied.register(registry.get(type)!)
    expect(copied.previewText(values[0])).toBe('note-a: hello')
  })

  it('validates identifiers and values before feature callbacks, including persistence hazards', () => {
    const registry = createMessageItemRegistry()
    const encode = jest.fn(() => new Uint8Array())
    const previewText = jest.fn(() => '')
    registry.registerApplication({ ...plugin('note-a'), encode, previewText })
    for (const identifier of ['', 'A', '-a', 'a'.repeat(65), 'application']) {
      expect(() => registry.encodeItem(item(identifier))).toThrow()
      expect(() => registry.registerApplication(plugin(identifier))).toThrow()
    }
    class CustomArray extends Array<number> {
      toJSON() {
        return 'changed'
      }
    }
    expect(JSON.stringify(new CustomArray(1, 2))).toBe('"changed"')
    expect(() => validateApplicationValue(new CustomArray(1, 2))).toThrow()
    expect(() => validateApplicationValue([1, 2])).not.toThrow()
    for (const value of [
      { label: 1 },
      { label: 'ok', bad: 1n },
      new Uint8Array(2),
      { label: 'ok', bad: undefined },
      { label: 'ok', bad: NaN },
      new Date(),
      new CustomArray(1),
      [, 1],
    ]) {
      expect(() => registry.encodeItem(item('note-a', value))).toThrow(
        MessageItemEncodeError,
      )
      expect(() => registry.previewText(item('note-a', value))).toThrow()
    }
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => validateApplicationValue(cyclic)).toThrow()
    expect(encode).not.toHaveBeenCalled()
    expect(previewText).not.toHaveBeenCalled()
  })

  it('rejects duplicate identifiers across both registration paths and wrong decoder identities', () => {
    const registry = createMessageItemRegistry()
    registry.registerApplication(plugin('note-a'))
    expect(() => registry.registerApplication(plugin('note-a'))).toThrow(
      MessageItemPluginAlreadyRegisteredError,
    )
    expect(() =>
      registry.register({
        type: 'note-a',
        carrier: 'application',
        hydrate: raw => raw,
        previewText: () => '',
        encode: () => new Uint8Array(),
        decode: () => item('note-a'),
      }),
    ).toThrow(MessageItemPluginAlreadyRegisteredError)
    const other = createMessageItemRegistry()
    other.register<ApplicationMessageItem>({
      type: 'note-b',
      carrier: 'application',
      hydrate: raw => raw,
      previewText: () => '',
      encode: () => new Uint8Array(),
      decode: () => item('note-a'),
    })
    expect(() => other.registerApplication(plugin('note-b'))).toThrow(
      MessageItemPluginAlreadyRegisteredError,
    )
    expect(() =>
      other.decodeItem('note-b', new Uint8Array(), {
        budget: standaloneItemBudget(),
      }),
    ).toThrow(MessageItemDecodeError)
    expect(messageItemType(item('note-a'))).toBe('note-a')
  })

  it('retains unknown and malformed frames without running the preview', () => {
    const registry = createMessageItemRegistry()
    const previewText = jest.fn(() => '')
    registry.registerApplication({
      ...plugin('note-a'),
      decode: () => {
        throw new Error('bad note')
      },
      previewText,
    })
    const frames = ['note-a', 'note-b'].map(itemType =>
      encodePluginMessageItem({ itemType, data: Uint8Array.of(1) }),
    )
    expect(
      decodeItemFrames(registry, children(frames), standaloneItemBudget()),
    ).toEqual(
      frames.map((frame, index) => ({
        type: 'unsupported',
        reason: index === 0 ? 'malformed' : 'unknown-type',
        itemType: index === 0 ? 'note-a' : 'note-b',
        frameType: 27,
        frame: toHex(frame),
      })),
    )
    expect(previewText).not.toHaveBeenCalled()
  })

  it('cannot wrap historical dedicated, self-only or not-carried identities', () => {
    for (const type of new Set([
      ...DEDICATED_ITEM_FRAMES.keys(),
      ...SELF_ONLY_ITEM_TYPES,
      ...NOT_CARRIED_ITEM_TYPES,
    ])) {
      const registry = createMessageItemRegistry()
      registry.registerApplication(plugin(type))
      expect(() =>
        encodeItemFrames(registry, [item(type)], { selfAddressed: true }),
      ).toThrow(MessageItemNotCarriedError)
      const frame = encodePluginMessageItem({
        itemType: type,
        data: Uint8Array.of(1),
      })
      expect(
        decodeItemFrames(registry, children([frame]), standaloneItemBudget(), {
          selfAddressed: true,
        })[0].type,
      ).toBe('unsupported')
    }
  })

  it('uses the enclosing aggregate budget and cannot swallow its exhaustion', () => {
    const heavy = encodeCanonical(Array.from({ length: 4000 }, () => [[], []]))
    for (const swallow of [false, true]) {
      const registry = createMessageItemRegistry()
      registry.registerApplication({
        ...plugin('heavy-note'),
        encode: () => heavy,
        decode: (bytes, context) => {
          try {
            context.budget.decodeCbor(bytes)
          } catch (error) {
            if (!swallow) throw error
          }
          return { label: 'heavy' }
        },
      })
      const frame = encodePluginMessageItem({
        itemType: 'heavy-note',
        data: heavy,
      })
      expect(() =>
        decodeItemFrames(registry, children([frame]), standaloneItemBudget()),
      ).not.toThrow()
      expect(() =>
        decodeItemFrames(
          registry,
          children([frame, frame]),
          standaloneItemBudget(),
        ),
      ).toThrow(MessageItemBudgetExceededError)
      expect(() =>
        encodeItemFrames(registry, [item('heavy-note'), item('heavy-note')]),
      ).toThrow(MessageItemEncodeError)
    }
  })
})
