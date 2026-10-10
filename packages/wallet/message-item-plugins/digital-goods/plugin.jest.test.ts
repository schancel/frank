import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError } from '../registry'
import {
  standaloneDecodeContext,
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initDigitalGoodsPlugin } from './plugin'

const catalog: DigitalGoodsItem = {
  type: 'digital-goods',
  action: 'catalog',
  catalog: [
    { itemId: 'sticker', description: 'A sticker', priceWei: '1000' },
    {
      itemId: 'poster',
      description: 'A poster',
      priceWei: '2000',
      thumbnail: 'data:image/png;base64,AAAA',
    },
  ],
}
const request: DigitalGoodsItem = {
  type: 'digital-goods',
  action: 'request',
  itemId: 'sticker',
}

describePluginContract({
  type: 'digital-goods',
  init: initDigitalGoodsPlugin,
  samples: [
    { item: catalog, preview: 'Sent a catalog (2 items)' },
    {
      item: {
        type: 'digital-goods',
        action: 'catalog',
        catalog: [catalog.catalog![0]],
      },
      preview: 'Sent a catalog (1 item)',
    },
    { item: request, preview: 'Requested: sticker' },
    {
      item: { type: 'digital-goods', action: 'request' },
      preview: 'Requested: an item',
    },
    {
      item: { type: 'digital-goods', action: 'fulfill' },
      preview: 'Delivered a purchase',
    },
    {
      item: { type: 'digital-goods', action: 'error' },
      preview: 'Purchase error',
    },
    {
      item: {
        type: 'digital-goods',
        action: 'error',
        message: 'unknown itemId',
      },
      preview: 'unknown itemId',
    },
  ],
})

describe('digital-goods wire bytes', () => {
  const registry = registryWith('digital-goods', initDigitalGoodsPlugin)

  it('are a CBOR map, no longer JSON in a text frame', () => {
    for (const item of [catalog, request]) {
      const { bytes } = registry.encodeItem(item)
      expect(bytes).not.toEqual(directMessageText(JSON.stringify(item)))
      // Major type 5 (a map), not the "FRNK" magic of a frame.
      expect(bytes[0] >> 5).toBe(5)
    }
  })

  // The old form is not read: there is no second reader.
  it.each([
    ['the old JSON text frame of a request', JSON.stringify(request)],
    ['the old JSON text frame of a catalog', JSON.stringify(catalog)],
    ['plain text', 'hello'],
  ])('rejects %s', (_, text) => {
    expect(() =>
      registry.decodeItem(
        'digital-goods',
        directMessageText(text),
        standaloneDecodeContext(),
      ),
    ).toThrow(MessageItemDecodeError)
    expect(() =>
      registry.decodeItem(
        'digital-goods',
        new TextEncoder().encode(text),
        standaloneDecodeContext(),
      ),
    ).toThrow(MessageItemDecodeError)
  })

  it('hydrate still takes the paid amount from the message stamp only', async () => {
    const message = { items: [request], stampValueWei: 5n } as never
    const [entry] = await registry.hydrateItems(message, {} as never)
    expect(entry).toMatchObject({ kind: 'hydrated', hydrated: { paidWei: 5n } })
  })
})
