import type { MessageItem, TextItem } from '@frank/cashweb/types/messages'

import {
  MessageItemCapabilityUnavailableError,
  MessageItemDecodeError,
  MessageItemPluginAlreadyRegisteredError,
  MessageItemPluginCapabilitiesMissingError,
  MessageItemUnsupportedError,
  UNSUPPORTED_MESSAGE_ITEM_PREVIEW,
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
  requirePluginCapabilities,
  type MessageItemPlugin,
} from './registry'

const textPlugin = (
  over: Partial<MessageItemPlugin<TextItem>> = {},
): MessageItemPlugin<TextItem> => ({
  type: 'text',
  hydrate: raw => raw,
  previewText: raw => raw.text,
  encode: raw => new TextEncoder().encode(raw.text),
  decode: bytes => {
    if (bytes.length === 0) throw new MessageItemDecodeError('text', 'empty')
    return { type: 'text', text: new TextDecoder().decode(bytes) }
  },
  ...over,
})

const unknownItem = { type: 'hologram', beam: 1 } as unknown as MessageItem

describe('message item registry', () => {
  it('starts empty and is an independent object each time', () => {
    const a = createMessageItemRegistry()
    const b = createMessageItemRegistry()
    a.register(textPlugin())
    expect(a.types()).toEqual(['text'])
    expect(a.has('text')).toBe(true)
    expect(b.types()).toEqual([])
    expect(b.has('text')).toBe(false)
    expect(b.get('text')).toBeUndefined()
  })

  it('refuses a second plugin for a type and keeps the first', () => {
    const registry = createMessageItemRegistry()
    registry.register(textPlugin())
    expect(() =>
      registry.register(textPlugin({ previewText: () => 'other' })),
    ).toThrow(MessageItemPluginAlreadyRegisteredError)
    expect(registry.previewText({ type: 'text', text: 'hi' })).toBe('hi')
  })

  it('encodes through the plugin and labels the bytes with the type', () => {
    const registry = createMessageItemRegistry()
    registry.register(textPlugin())
    expect(registry.encodeItem({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      bytes: Uint8Array.of(0x68, 0x69),
    })
    expect(registry.decodeItem('text', Uint8Array.of(0x68, 0x69))).toEqual({
      kind: 'item',
      item: { type: 'text', text: 'hi' },
    })
  })

  it('never looks inside the bytes: any encoding a plugin chooses is carried', () => {
    const registry = createMessageItemRegistry()
    // Not CBOR, not a frame: the registry does not care.
    const bytes = Uint8Array.of(0xff, 0xfe, 0x00)
    registry.register(
      textPlugin({
        encode: () => bytes,
        decode: () => ({ type: 'text', text: 'x' }),
      }),
    )
    expect(registry.encodeItem({ type: 'text', text: 'x' }).bytes).toBe(bytes)
    expect(registry.decodeItem('text', bytes)).toEqual({
      kind: 'item',
      item: { type: 'text', text: 'x' },
    })
  })

  it('lets a malformed item of a known type fail with the typed error', () => {
    const registry = createMessageItemRegistry()
    registry.register(textPlugin())
    expect(() => registry.decodeItem('text', new Uint8Array())).toThrow(
      MessageItemDecodeError,
    )
  })

  it('preserves an unregistered type and its bytes instead of interpreting them', () => {
    const registry = createMessageItemRegistry()
    const decode = jest.fn()
    registry.register(textPlugin({ decode }))
    const bytes = Uint8Array.of(1, 2, 3)
    const result = registry.decodeItem('hologram', bytes)
    expect(result).toEqual({
      kind: 'unsupported',
      type: 'hologram',
      bytes: Uint8Array.of(1, 2, 3),
    })
    // A copy: later changes to the caller's buffer do not alter what was preserved.
    bytes[0] = 9
    expect(result.kind === 'unsupported' && result.bytes[0]).toBe(1)
    expect(decode).not.toHaveBeenCalled()
  })

  it('gives an unsupported item a fixed preview, no value, and no hydration', async () => {
    const registry = createMessageItemRegistry()
    const hydrate = jest.fn((raw: TextItem) => raw)
    registry.register(textPlugin({ hydrate, tallyValue: () => 5 }))
    expect(UNSUPPORTED_MESSAGE_ITEM_PREVIEW).toBe('Unsupported message')
    expect(registry.previewText(unknownItem)).toBe('Unsupported message')
    const text: TextItem = { type: 'text', text: 'hi' }
    expect(registry.tallyValue([unknownItem, text])).toBe(5)
    const message = { items: [unknownItem, text] } as never
    const hydrated = await registry.hydrateItems(message, {} as never)
    expect(hydrated[0]).toEqual({ kind: 'unsupported', item: unknownItem })
    expect(hydrated[1]).toMatchObject({
      kind: 'hydrated',
      item: text,
      hydrated: text,
    })
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledWith(text, {
      message,
      index: 1,
      provider: {},
    })
  })

  it('cannot encode an item whose type has no plugin', () => {
    expect(() => createMessageItemRegistry().encodeItem(unknownItem)).toThrow(
      MessageItemUnsupportedError,
    )
  })
})

describe('plugin capabilities', () => {
  it('the not-yet-available provider rejects every capability with the typed error', async () => {
    const capabilities =
      pluginCapabilitiesNotYetAvailable.forPlugin('swap-offer')
    const attempts: Array<[string, Promise<unknown>]> = [
      [
        'spendPublicKey',
        capabilities.spendPublicKey({
          pluginType: 'swap-offer',
          chainIdentifier: 'monad-testnet',
        }),
      ],
      [
        'addCoin',
        capabilities.addCoin({
          pluginType: 'swap-offer',
          chainIdentifier: 'monad-testnet',
          location: { kind: 'account', account: '0xA', nonce: 0 },
          amount: 1n,
          key: { kind: 'spend-key-tweak', tweak: new Uint8Array(32) },
        }),
      ],
      [
        'requestTransaction',
        capabilities.requestTransaction({
          pluginType: 'swap-offer',
          chainIdentifier: 'monad-testnet',
          call: { family: 'evm', to: '0xE', data: new Uint8Array(), value: 0n },
          spendFrom: { kind: 'own-plugin-coins' },
          purpose: 'Deposit into the swap escrow',
        }),
      ],
    ]
    for (const [capability, attempt] of attempts) {
      await expect(attempt).rejects.toBeInstanceOf(
        MessageItemCapabilityUnavailableError,
      )
      await expect(attempt).rejects.toMatchObject({
        pluginType: 'swap-offer',
        capability,
      })
    }
  })

  it('offers a plugin exactly three capabilities and no way to sign or read a key', () => {
    expect(
      Object.keys(pluginCapabilitiesNotYetAvailable.forPlugin('text')).sort(),
    ).toEqual(['addCoin', 'requestTransaction', 'spendPublicKey'])
  })

  it('requirePluginCapabilities refuses a missing or partial object', () => {
    const whole = pluginCapabilitiesNotYetAvailable.forPlugin('text')
    expect(requirePluginCapabilities('text', whole)).toBe(whole)
    for (const partial of [
      undefined,
      null,
      {},
      { ...whole, addCoin: undefined },
      { ...whole, requestTransaction: 'yes' },
    ]) {
      expect(() => requirePluginCapabilities('text', partial as never)).toThrow(
        MessageItemPluginCapabilitiesMissingError,
      )
    }
  })
})
