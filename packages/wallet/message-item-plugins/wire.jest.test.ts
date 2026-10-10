/**
 * The wire rule of the canonical direct message path: which frame each registered item type
 * travels in, that the dedicated frames keep their bytes, and what a reader does with an item it
 * cannot interpret.
 */
import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  TYPE_PLUGIN_MESSAGE_ITEM,
  encodeBlackjackHandV3Item,
  encodeCanonical,
  encodeChannelUpdateItem,
  encodeEmailMessageItem,
  encodeFrame,
  encodePluginMessageItem,
  encodeStealthMessageItem,
  fromHex,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type ChildFrame,
  type Encodable,
} from '@frank/codec'

import {
  DEFAULT_MESSAGE_ITEM_PLUGINS,
  createDefaultMessageItemRegistry,
} from './default-registry'
import {
  MessageItemEncodeError,
  MessageItemUnsupportedError,
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
} from './registry'
import {
  DEDICATED_ITEM_FRAMES,
  MessageItemBudgetExceededError,
  MessageItemNotCarriedError,
  NOT_CARRIED_ITEM_TYPES,
  SELF_ONLY_ITEM_TYPES,
  decodeItemFrames,
  encodeItemFrames,
  MAX_LEGACY_PLAINTEXT_CHARS,
  boundedLegacyPlaintext,
  itemFrameRule,
  receiveLegacyItems,
} from './wire'
import {
  DEDICATED_SAMPLES,
  GENERIC_SAMPLES,
  NEVER_FROM_A_PEER_SAMPLES,
  NOT_CARRIED_PROPOSAL_SAMPLES,
} from './wire-samples.testutil'

const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)

/** The child frames a reader's validation opens for these item frames. */
function children(frames: Uint8Array[]): ChildFrame[] {
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, frames],
      ]),
    ),
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
    throw new Error('expected a revision')
  return revision.typed.items
}
const receive = (frames: Uint8Array[]) =>
  decodeItemFrames(registry, children(frames), standaloneItemBudget())
const frameType = (frame: Uint8Array) => {
  const parsed = validateFrame(frame)
  if (parsed.kind !== 'parsed') throw new Error('expected a parsed frame')
  return parsed.typeId
}

describe('the dispatch rule', () => {
  it('is stated for every registered type: dedicated frame, generic frame, or not carried', () => {
    const rules = Object.fromEntries(
      DEFAULT_MESSAGE_ITEM_PLUGINS.map(([type]) => {
        const rule = itemFrameRule(type)
        return [
          type,
          rule.carried === 'no' ? 'no' : `${rule.carried}:${rule.frameType}`,
        ]
      }),
    )
    expect(rules).toEqual({
      'text': 'dedicated:17',
      'blackjack-hand': 'dedicated:18',
      'stealth': 'dedicated:19',
      'channel-update': 'dedicated:24',
      'email': 'dedicated:26',
      'image': 'generic:27',
      'reply': 'generic:27',
      'digital-goods': 'generic:27',
      'raffle': 'generic:27',
      'rps': 'generic:27',
      'dice': 'generic:27',
      'liars-dice': 'generic:27',
      'poker': 'generic:27',
      'wallet-sync': 'no',
      'payment-transfer': 'no',
      'swap-record': 'no',
      'received-coin': 'no',
      'conversation-state': 'no',
      'device-claim': 'no',
      'p2pkh': 'no',
      'swap-offer': 'no',
      'blackjack-move': 'no',
    })
    expect([...DEDICATED_ITEM_FRAMES.keys()].every(t => registry.has(t))).toBe(
      true,
    )
    expect([...NOT_CARRIED_ITEM_TYPES].every(t => registry.has(t))).toBe(true)
    expect([...SELF_ONLY_ITEM_TYPES].every(t => registry.has(t))).toBe(true)
  })

  it('carries a self-only type in a message a wallet addresses to itself, and in no other', () => {
    expect([...SELF_ONLY_ITEM_TYPES]).toEqual([
      'wallet-sync',
      'swap-record',
      'received-coin',
      'conversation-state',
    ])
    for (const type of SELF_ONLY_ITEM_TYPES) {
      expect(NOT_CARRIED_ITEM_TYPES.has(type)).toBe(false)
      expect(itemFrameRule(type)).toEqual({ carried: 'no' })
      expect(itemFrameRule(type, { selfAddressed: false })).toEqual({
        carried: 'no',
      })
      expect(itemFrameRule(type, { selfAddressed: true })).toEqual({
        carried: 'generic',
        frameType: TYPE_PLUGIN_MESSAGE_ITEM,
      })
    }
    // Writing to oneself opens nothing else: a type that is not carried stays not carried.
    for (const type of NOT_CARRIED_ITEM_TYPES)
      expect(itemFrameRule(type, { selfAddressed: true })).toEqual({
        carried: 'no',
      })
  })

  it('a self-only item round-trips only when both ends say the message is self-addressed', () => {
    const note: MessageItem = {
      type: 'wallet-sync',
      direction: 'out',
      chainIdentifier: 'monad-testnet',
      txHash: '0x' + 'ab'.repeat(32),
      rawTx: '0x02abcd',
      spentInputs: [{ address: '0xA', nonce: 3, valueWei: '150' }],
      createdOutputs: [{ address: '0xB', valueWei: '100' }],
      timestamp: 1760000000000,
    }
    expect(() => encodeItemFrames(registry, [note])).toThrow(
      MessageItemNotCarriedError,
    )
    expect(() =>
      encodeItemFrames(registry, [note], { selfAddressed: false }),
    ).toThrow(MessageItemNotCarriedError)
    const frames = encodeItemFrames(registry, [note], { selfAddressed: true })
    expect(frames.map(frameType)).toEqual([TYPE_PLUGIN_MESSAGE_ITEM])
    expect(
      decodeItemFrames(registry, children(frames), standaloneItemBudget(), {
        selfAddressed: true,
      }),
    ).toEqual([note])
    // The same bytes in a message from anyone else are not the item.
    const kept = {
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'wallet-sync',
      frameType: 27,
      frame: toHex(frames[0]),
    }
    expect(receive(frames)).toEqual([kept])
    expect(
      decodeItemFrames(registry, children(frames), standaloneItemBudget(), {
        selfAddressed: false,
      }),
    ).toEqual([kept])
  })

  it('a type nobody listed travels in the generic frame: a new plugin needs no allocation', () => {
    expect(itemFrameRule('hologram')).toEqual({
      carried: 'generic',
      frameType: TYPE_PLUGIN_MESSAGE_ITEM,
    })
    const own = createMessageItemRegistry()
    own.register({
      type: 'hologram' as never,
      hydrate: raw => raw,
      previewText: () => 'A hologram',
      // Not CBOR at all: the wallet does not care how a plugin encodes.
      encode: () => Uint8Array.of(0xff, 0x01, 0x02),
      decode: bytes => {
        if (toHex(bytes) !== 'ff0102') throw new Error('not a hologram')
        return { type: 'hologram' } as never
      },
    })
    const frames = encodeItemFrames(own, [{ type: 'hologram' } as never])
    expect(frames).toEqual([
      encodePluginMessageItem({
        itemType: 'hologram',
        data: Uint8Array.of(0xff, 0x01, 0x02),
      }),
    ])
    expect(
      decodeItemFrames(own, children(frames), standaloneItemBudget()),
    ).toEqual([{ type: 'hologram' }])
  })
})

describe('sending', () => {
  it('writes the five dedicated frames byte for byte as before', () => {
    const [text, hand, stealth, channel, email] = DEDICATED_SAMPLES as never[]
    const before = [
      directMessageText((text as { text: string }).text),
      encodeBlackjackHandV3Item(hand),
      encodeStealthMessageItem(stealth),
      encodeChannelUpdateItem(channel),
      encodeEmailMessageItem(email),
    ]
    DEDICATED_SAMPLES.forEach((item, i) => {
      expect(toHex(encodeItemFrames(registry, [item])[0])).toBe(
        toHex(before[i]),
      )
    })
    // And all five in one message, in order.
    expect(encodeItemFrames(registry, DEDICATED_SAMPLES).map(toHex)).toEqual(
      before.map(toHex),
    )
  })

  it.each(GENERIC_SAMPLES.map(item => [item.type, item] as const))(
    'wraps a %s item in the generic plugin frame, and it reads back',
    (type, item) => {
      const [frame] = encodeItemFrames(registry, [item])
      expect(frameType(frame)).toBe(TYPE_PLUGIN_MESSAGE_ITEM)
      expect(frame).toEqual(
        encodePluginMessageItem({
          itemType: type,
          data: registry.encodeItem(item).bytes,
        }),
      )
      expect(receive([frame])).toEqual([item])
    },
  )

  it('a digital-goods item is no longer text on the wire or on receipt', () => {
    const item = GENERIC_SAMPLES.find(i => i.type === 'digital-goods')!
    const [frame] = encodeItemFrames(registry, [item])
    expect(frameType(frame)).not.toBe(17)
    expect(receive([frame])[0].type).toBe('digital-goods')
    // The old form, JSON in a text frame, is read as what it is: text.
    expect(receive([directMessageText(JSON.stringify(item))])).toEqual([
      { type: 'text', text: JSON.stringify(item) },
    ])
  })

  it('refuses an empty message, an unregistered type and a type that is not carried', () => {
    expect(() => encodeItemFrames(registry, [])).toThrow(
      'A direct message needs content',
    )
    expect(() =>
      encodeItemFrames(registry, [{ type: 'hologram' } as never]),
    ).toThrow(MessageItemUnsupportedError)
    for (const type of NOT_CARRIED_ITEM_TYPES)
      expect(() => encodeItemFrames(registry, [{ type } as never])).toThrow(
        MessageItemUnsupportedError,
      )
    // An item this reader kept as unsupported is never sent on as if it were understood.
    expect(() =>
      encodeItemFrames(registry, [
        { type: 'unsupported', reason: 'unknown-type', frame: '00' },
      ]),
    ).toThrow(MessageItemUnsupportedError)
  })

  it('refuses an item its plugin refuses, including one failure among good items', () => {
    const bad = { type: 'dice', action: 'cheat' } as never
    expect(() => encodeItemFrames(registry, [bad])).toThrow(
      MessageItemEncodeError,
    )
    expect(() =>
      encodeItemFrames(registry, [{ type: 'text', text: 'ok' }, bad]),
    ).toThrow(MessageItemEncodeError)
    // Text too long for a text frame is refused here, before any payment.
    expect(() =>
      encodeItemFrames(registry, [{ type: 'text', text: 'x'.repeat(262_145) }]),
    ).toThrow(MessageItemEncodeError)
    // A stealth item with nothing to send: the plugin's plain error becomes the typed one.
    expect(() =>
      encodeItemFrames(registry, [{ type: 'stealth', amount: 1 }]),
    ).toThrow(MessageItemEncodeError)
  })

  it('refuses a plugin that writes the wrong frame for a dedicated type, or bytes it cannot read back', () => {
    const wrong = createMessageItemRegistry()
    wrong.register({
      type: 'text',
      hydrate: raw => raw,
      previewText: raw => raw.text,
      encode: () =>
        encodePluginMessageItem({ itemType: 'x', data: new Uint8Array() }),
      decode: () => ({ type: 'text', text: '' }),
    })
    expect(() =>
      encodeItemFrames(wrong, [{ type: 'text', text: 'hi' }]),
    ).toThrow(MessageItemEncodeError)
    const oneWay = createMessageItemRegistry()
    oneWay.register({
      type: 'dice',
      hydrate: raw => raw,
      previewText: () => '',
      encode: () => Uint8Array.of(1),
      decode: () => {
        throw new Error('never readable')
      },
    })
    expect(() =>
      encodeItemFrames(oneWay, [{ type: 'dice', action: 'roll' }]),
    ).toThrow(MessageItemEncodeError)
  })

  it('refuses more items than one message may hold', () => {
    const many = Array.from({ length: 257 }, () => ({
      type: 'text' as const,
      text: 'x',
    }))
    expect(() => encodeItemFrames(registry, many)).toThrow(
      MessageItemEncodeError,
    )
  })
})

describe('receiving', () => {
  const text = directMessageText('still here')

  it('keeps an item of an unregistered type, with its type and original bytes, beside the others', () => {
    const unknown = encodePluginMessageItem({
      itemType: 'hologram',
      data: Uint8Array.of(1, 2, 3),
    })
    expect(receive([text, unknown, text])).toEqual([
      { type: 'text', text: 'still here' },
      {
        type: 'unsupported',
        reason: 'unknown-type',
        itemType: 'hologram',
        frameType: 27,
        frame: toHex(unknown),
      },
      { type: 'text', text: 'still here' },
    ])
    expect(registry.previewText(receive([unknown])[0])).toBe(
      'Unsupported message',
    )
  })

  it('keeps a frame of an unknown frame type exactly', () => {
    const frame = fromHex('46524e4b010000000ea4001affff0001010102010341a0')
    expect(receive([frame, text])).toEqual([
      {
        type: 'unsupported',
        reason: 'unknown-type',
        frameType: 0xffff0001,
        frame: toHex(frame),
      },
      { type: 'text', text: 'still here' },
    ])
  })

  it('keeps a known frame type that has no item (a container) as unsupported', () => {
    const container = encodeFrame(
      { typeId: 16, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, Encodable>([[0, [text]]]),
    )
    expect(receive([container])).toEqual([
      {
        type: 'unsupported',
        reason: 'unknown-type',
        frameType: 16,
        frame: toHex(container),
      },
    ])
  })

  it('marks a registered type whose bytes its plugin refuses as malformed, without losing the rest', () => {
    const malformed = encodePluginMessageItem({
      itemType: 'dice',
      data: encodeCanonical(new Map<number, Encodable>([[0, 'cheat']])),
    })
    const notCbor = encodePluginMessageItem({
      itemType: 'raffle',
      data: Uint8Array.of(0xff, 0x00),
    })
    expect(receive([malformed, text, notCbor])).toEqual([
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'dice',
        frameType: 27,
        frame: toHex(malformed),
      },
      { type: 'text', text: 'still here' },
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'raffle',
        frameType: 27,
        frame: toHex(notCbor),
      },
    ])
  })

  it('does not read a type that has a dedicated frame from the generic frame', () => {
    const smuggled = encodePluginMessageItem({ itemType: 'text', data: text })
    expect(receive([smuggled])).toEqual([
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'text',
        frameType: 27,
        frame: toHex(smuggled),
      },
    ])
  })

  it.each([...NOT_CARRIED_ITEM_TYPES, ...SELF_ONLY_ITEM_TYPES])(
    'does not interpret a %s item from a peer',
    type => {
      const sample: Record<string, MessageItem> = {}
      for (const item of NEVER_FROM_A_PEER_SAMPLES) sample[item.type] = item
      // Well-formed bytes of the real plugin: still not interpreted on this path.
      const frame = encodePluginMessageItem({
        itemType: type,
        data: registry.encodeItem(sample[type]).bytes,
      })
      // Sending the same well-formed item is refused before anything is paid.
      expect(() => encodeItemFrames(registry, [sample[type]])).toThrow(
        MessageItemNotCarriedError,
      )
      // What arrives is not the item: its self-reported value reaches no total.
      expect(registry.tallyValue(receive([frame]))).toBe(0)
      expect(receive([frame])).toEqual([
        {
          type: 'unsupported',
          reason: 'unknown-type',
          itemType: type,
          frameType: 27,
          frame: toHex(frame),
        },
      ])
    },
  )

  it('refuses the whole message when items that are each valid alone exceed its limits together', () => {
    // A liars-dice item whose revealed cups hold 4,000 entries: about 8,000 containers. One is
    // inside MAX_CONTAINERS (16,384); from the third on, the items of one message are over it.
    const players = Array.from(
      { length: 4000 },
      (_, i) => `p${String(i).padStart(4, '0')}`,
    )
    const heavy = encodePluginMessageItem({
      itemType: 'liars-dice',
      data: encodeCanonical(
        new Map<number, Encodable>([
          [0, '8899aabbccddeeff'],
          [1, 'showdown'],
          [17, players.map(key => [key, []] as Encodable)],
        ]),
      ),
    })
    // Alone, under a whole budget, it does not exhaust it.
    expect(() => receive([heavy])).not.toThrow(MessageItemBudgetExceededError)
    const five = [heavy, heavy, heavy, heavy, heavy]
    expect(() => receive([text, ...five])).toThrow(
      MessageItemBudgetExceededError,
    )
    // The sender is refused the same set before it pays.
    const own = createMessageItemRegistry()
    own.register({
      type: 'liars-dice',
      hydrate: raw => raw,
      previewText: () => '',
      encode: () => validateHeavy(heavy),
      decode: (bytes, context) => {
        context.budget.decodeCbor(bytes)
        return { type: 'liars-dice', tableId: 't', action: 'showdown' }
      },
    })
    const item = {
      type: 'liars-dice',
      tableId: 't',
      action: 'showdown',
    } as const
    expect(() => encodeItemFrames(own, [item])).not.toThrow()
    expect(() => encodeItemFrames(own, [item, item, item, item, item])).toThrow(
      MessageItemEncodeError,
    )
  })

  it('a plugin cannot hide an exhausted budget by swallowing the error', () => {
    const own = createMessageItemRegistry()
    own.register({
      type: 'dice',
      hydrate: raw => raw,
      previewText: () => '',
      encode: () => new Uint8Array(),
      decode: (bytes, context) => {
        try {
          context.budget.decodeCbor(bytes)
        } catch {
          // swallowed
        }
        return { type: 'dice', action: 'roll' }
      },
    })
    const big = encodeCanonical(
      Array.from({ length: 3 }, () => Array.from({ length: 8000 }, () => [])),
    )
    const frame = encodePluginMessageItem({ itemType: 'dice', data: big })
    expect(() =>
      decodeItemFrames(own, children([frame]), standaloneItemBudget()),
    ).toThrow(MessageItemBudgetExceededError)
  })
})

/** The plugin bytes inside a generic frame. */
function validateHeavy(frame: Uint8Array): Uint8Array {
  const parsed = validateFrame(frame)
  if (parsed.kind !== 'parsed' || parsed.typed?.type !== 27)
    throw new Error('expected a plugin item')
  return parsed.typed.data
}

describe('a swap offer and a legacy blackjack move from a peer', () => {
  const [swapOffer, blackjackMove] = NOT_CARRIED_PROPOSAL_SAMPLES

  it('the samples are well formed: their own plugins read them', () => {
    for (const item of NOT_CARRIED_PROPOSAL_SAMPLES) {
      const { bytes } = registry.encodeItem(item)
      expect(
        registry.decodeItem(item.type, bytes, {
          budget: standaloneItemBudget(),
        }),
      ).toEqual({ kind: 'item', item })
    }
    // A swap offer's own plugin would count its offered amount.
    expect(registry.tallyValue([swapOffer])).toBe(0.5)
  })

  it('an accepted swap offer naming the peer own hash lock arrives as unsupported, with no value', () => {
    const hostile = {
      ...swapOffer,
      status: 'accepted',
      hashLock: 'ab'.repeat(32),
      offeredAmount: '1000000',
    } as MessageItem
    const frame = encodePluginMessageItem({
      itemType: 'swap-offer',
      data: registry.encodeItem(hostile).bytes,
    })
    const [arrived] = receive([frame])
    expect(arrived).toEqual({
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'swap-offer',
      frameType: 27,
      frame: toHex(frame),
    })
    // Nothing of the offer survives for a renderer to act on, and nothing is tallied.
    expect(arrived).not.toHaveProperty('status')
    expect(arrived).not.toHaveProperty('hashLock')
    expect(registry.tallyValue([arrived])).toBe(0)
  })

  it('a blackjack-move bet arrives as unsupported in the generic frame and in a bare type-18 frame', () => {
    const bet = {
      type: 'blackjack-move',
      gameId: 'g',
      action: 'bet',
      wagerTxHash: '0x' + 'cd'.repeat(32),
    } as MessageItem
    const bytes = registry.encodeItem(bet).bytes
    const generic = encodePluginMessageItem({
      itemType: 'blackjack-move',
      data: bytes,
    })
    // Its bytes are a type-18 schema-1 frame; sent bare, it is not a blackjack hand either.
    for (const frame of [generic, bytes]) {
      const [arrived] = receive([frame])
      expect(arrived.type).toBe('unsupported')
      expect(arrived).not.toHaveProperty('action')
      expect(arrived).not.toHaveProperty('wagerTxHash')
    }
    expect(receive([generic])[0]).toMatchObject({
      reason: 'unknown-type',
      itemType: 'blackjack-move',
    })
    expect(blackjackMove.type).toBe('blackjack-move')
  })
})

describe('items read from the legacy JSON mailbox', () => {
  const jsonHex = (value: unknown) =>
    toHex(new TextEncoder().encode(JSON.stringify(value)))
  /** What a legacy sender's JSON becomes on the way in. */
  const arrive = (items: unknown[]) =>
    receiveLegacyItems(registry, JSON.parse(JSON.stringify(items)))

  it('covers every type that is never interpreted from a peer', () => {
    expect(NEVER_FROM_A_PEER_SAMPLES.map(item => item.type).sort()).toEqual(
      [...NOT_CARRIED_ITEM_TYPES, ...SELF_ONLY_ITEM_TYPES].sort(),
    )
  })

  it.each(NEVER_FROM_A_PEER_SAMPLES.map(item => [item.type, item] as const))(
    'a %s item arrives as unsupported, never as the item',
    (type, item) => {
      const received = arrive([item, { type: 'text', text: 'beside it' }])
      expect(received).toEqual([
        {
          type: 'unsupported',
          reason: 'unknown-type',
          itemType: type,
          frame: jsonHex(item),
        },
        { type: 'text', text: 'beside it' },
      ])
      // No field of the item survives for a renderer, a bot or a total to act on.
      expect(Object.keys(received[0]).sort()).toEqual([
        'frame',
        'itemType',
        'reason',
        'type',
      ])
      expect(registry.tallyValue(received)).toBe(0)
    },
  )

  it('an accepted swap offer, the item whose card offers a deposit, is not delivered as an offer', () => {
    const offer = {
      ...NEVER_FROM_A_PEER_SAMPLES.find(item => item.type === 'swap-offer')!,
      status: 'accepted',
    }
    expect(arrive([offer]).map(item => item.type)).toEqual(['unsupported'])
  })

  // JSON has no bytes: an item holding some (a channel update's state) does not survive it.
  const survivesJson = (item: MessageItem) =>
    !Object.values(item).some(value => value instanceof Uint8Array)

  it.each(
    [...DEDICATED_SAMPLES, ...GENERIC_SAMPLES]
      .filter(survivesJson)
      .map(item => [item.type, item] as const),
  )('a carried %s item arrives as what its plugin reads', (_type, item) => {
    const frames = encodeItemFrames(registry, [item])
    expect(arrive([item])).toEqual(receive(frames))
  })

  it('a carried item JSON has mangled arrives as malformed, not as the mangled object', () => {
    const mangled = [...DEDICATED_SAMPLES, ...GENERIC_SAMPLES].filter(
      item => !survivesJson(item),
    )
    expect(mangled.map(item => item.type)).toEqual(['channel-update'])
    expect(arrive(mangled)).toEqual([
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'channel-update',
        frame: jsonHex(mangled[0]),
      },
    ])
  })

  it('delivers what the plugin read, not the object that arrived', () => {
    expect(
      arrive([
        {
          type: 'text',
          text: 'hello',
          status: 'accepted',
          amount: 5,
          recipientAddress: '0x' + '0b'.repeat(20),
        },
      ]),
    ).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('a known type its plugin refuses arrives as malformed', () => {
    const bad = { type: 'dice', action: 'cheat' }
    expect(arrive([bad, { type: 'text' }])).toEqual([
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'dice',
        frame: jsonHex(bad),
      },
      {
        type: 'unsupported',
        reason: 'malformed',
        itemType: 'text',
        frame: jsonHex({ type: 'text' }),
      },
    ])
  })

  it('anything that is not an item with a known type arrives as unsupported', () => {
    const odd = [
      null,
      7,
      'text',
      [],
      {},
      { type: 5 },
      { type: 'hologram', power: 9000 },
      { type: 'unsupported', reason: 'unknown-type', frame: '00' },
    ]
    const received = arrive(odd)
    expect(received.map(item => item.type)).toEqual(odd.map(() => 'unsupported'))
    expect(received[6]).toEqual({
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'hologram',
      frame: jsonHex(odd[6]),
    })
    // An item that calls itself unsupported is not taken at its word either.
    expect(received[7]).toEqual({
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'unsupported',
      frame: jsonHex(odd[7]),
    })
  })

  it('reads all items of one message under one budget: items valid alone are refused together', () => {
    // A plugin whose every item costs about 8,000 containers to read (the canonical test's
    // liars-dice shape): one is inside a message's limits, five together are not.
    const players = Array.from(
      { length: 4000 },
      (_, i) => `p${String(i).padStart(4, '0')}`,
    )
    const heavy = encodeCanonical(
      new Map<number, Encodable>([
        [0, '8899aabbccddeeff'],
        [1, 'showdown'],
        [17, players.map(key => [key, []] as Encodable)],
      ]),
    )
    const own = createMessageItemRegistry()
    own.register({
      type: 'liars-dice',
      hydrate: raw => raw,
      previewText: () => '',
      encode: () => heavy,
      decode: (bytes, context) => {
        context.budget.decodeCbor(bytes)
        return { type: 'liars-dice', tableId: 't', action: 'showdown' }
      },
    })
    const item = { type: 'liars-dice', tableId: 't', action: 'showdown' }
    expect(receiveLegacyItems(own, [item])).toEqual([item])
    expect(() =>
      receiveLegacyItems(own, [item, item, item, item, item]),
    ).toThrow(MessageItemBudgetExceededError)
  })

  it('refuses a plaintext too long to parse before parsing it', () => {
    expect(boundedLegacyPlaintext('[]')).toBe('[]')
    expect(boundedLegacyPlaintext('x'.repeat(MAX_LEGACY_PLAINTEXT_CHARS))).toHaveLength(
      MAX_LEGACY_PLAINTEXT_CHARS,
    )
    expect(() =>
      boundedLegacyPlaintext('x'.repeat(MAX_LEGACY_PLAINTEXT_CHARS + 1)),
    ).toThrow(MessageItemBudgetExceededError)
  })

  it('does not keep an oversized item it could not read', () => {
    const [kept] = arrive([{ type: 'hologram', blob: 'x'.repeat(70_000) }])
    expect(kept).toEqual({
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'hologram',
      frame: '',
    })
  })
})
