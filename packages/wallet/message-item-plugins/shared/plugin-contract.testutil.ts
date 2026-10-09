/**
 * The checks every message-item plugin directory runs against its own `init`: it registers exactly
 * its type, cannot be installed without capabilities, round-trips its samples through its own
 * bytes, keeps its preview text, and rejects malformed bytes with the typed error.
 */
import type { MessageItem } from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemPluginCapabilitiesMissingError,
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
  type MessageItemPluginCapabilities,
  type MessageItemPluginInit,
  type MessageItemRegistry,
} from '../registry'

export interface PluginSample {
  item: MessageItem
  /** The preview text this item has always produced. */
  preview: string
  /** What decoding the item's bytes yields, when the encoding normalizes it. Default: `item`. */
  decoded?: MessageItem
  /** The decoded item may carry more than the sample (a projection's bookkeeping fields). */
  decodedHasExtras?: boolean
}

export function registryWith(
  type: string,
  init: MessageItemPluginInit,
): MessageItemRegistry {
  const registry = createMessageItemRegistry()
  init(registry, pluginCapabilitiesNotYetAvailable.forPlugin(type))
  return registry
}

/** Bytes no plugin may accept: nothing, noise, and well-formed data of the wrong shape. */
const ALWAYS_MALFORMED: Array<[string, Uint8Array]> = [
  ['no bytes', new Uint8Array()],
  ['noise', Uint8Array.of(0xff, 0x00, 0x13, 0x37)],
  [
    'a CBOR map with an unknown key',
    Uint8Array.of(0xa1, 0x19, 0x03, 0xe7, 0x61, 0x78),
  ],
  ['a CBOR text string', Uint8Array.of(0x62, 0x68, 0x69)],
  // FRNK frame of the proof-only unknown type 0xffff0001 (docs/protocol/cbor section 1).
  [
    'a frame of an unknown type',
    Uint8Array.from(
      Buffer.from('46524e4b010000000ea4001affff0001010102010341a0', 'hex'),
    ),
  ],
]

export function describePluginContract(params: {
  type: string
  init: MessageItemPluginInit
  samples: PluginSample[]
}): void {
  const { type, init, samples } = params

  describe(`${type} plugin contract`, () => {
    it('registers exactly its own type, and only when init is called', () => {
      const registry = createMessageItemRegistry()
      expect(registry.types()).toEqual([])
      init(registry, pluginCapabilitiesNotYetAvailable.forPlugin(type))
      expect(registry.types()).toEqual([type])
    })

    it('cannot be initialised without capabilities', () => {
      const registry = createMessageItemRegistry()
      for (const missing of [undefined, {}, { spendPublicKey: () => 0 }]) {
        expect(() =>
          init(registry, missing as unknown as MessageItemPluginCapabilities),
        ).toThrow(MessageItemPluginCapabilitiesMissingError)
      }
      expect(registry.types()).toEqual([])
    })

    it.each(samples.map((s, i) => [i, s] as const))(
      'sample %i round-trips through its own bytes and keeps its preview',
      (_, sample) => {
        const registry = registryWith(type, init)
        expect(registry.previewText(sample.item)).toBe(sample.preview)
        const encoded = registry.encodeItem(sample.item)
        expect(encoded.type).toBe(type)
        expect(encoded.bytes).toBeInstanceOf(Uint8Array)
        const decoded = registry.decodeItem(type, encoded.bytes)
        const expected = { kind: 'item', item: sample.decoded ?? sample.item }
        if (sample.decodedHasExtras) expect(decoded).toMatchObject(expected)
        else expect(decoded).toEqual(expected)
        // Encoding is deterministic: the decoded item gives the same bytes again.
        if (decoded.kind !== 'item') throw new Error('expected an item')
        expect(registry.encodeItem(decoded.item).bytes).toEqual(encoded.bytes)
      },
    )

    it.each(ALWAYS_MALFORMED)('rejects %s with the typed error', (_, bytes) => {
      const registry = registryWith(type, init)
      expect(() => registry.decodeItem(type, bytes)).toThrow(
        MessageItemDecodeError,
      )
    })

    it('rejects truncated and padded bytes with the typed error', () => {
      const registry = registryWith(type, init)
      const { bytes } = registry.encodeItem(samples[0].item)
      expect(() => registry.decodeItem(type, bytes.slice(0, -1))).toThrow(
        MessageItemDecodeError,
      )
      expect(() =>
        registry.decodeItem(type, Uint8Array.of(...bytes, 0x00)),
      ).toThrow(MessageItemDecodeError)
    })
  })
}
