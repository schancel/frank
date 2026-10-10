import { directMessageText } from '@frank/cashweb/relay/canonical-dm'
import type { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import { MessageItemDecodeError } from '../registry'
import {
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

  it('are the JSON text frame the canonical path writes today', () => {
    for (const item of [catalog, request]) {
      expect(registry.encodeItem(item).bytes).toEqual(
        directMessageText(JSON.stringify(item)),
      )
    }
  })

  it.each([
    ['plain text', 'hello'],
    [
      'JSON of another type',
      JSON.stringify({ type: 'raffle', action: 'enter' }),
    ],
    [
      'an unknown action',
      JSON.stringify({ type: 'digital-goods', action: 'steal' }),
    ],
    ['an unknown field', JSON.stringify({ ...request, priceWei: '1' })],
    ['a non-text itemId', JSON.stringify({ ...request, itemId: 7 })],
    [
      'a catalog that is not an array',
      JSON.stringify({ ...catalog, catalog: {} }),
    ],
    [
      'a catalog entry without a price',
      JSON.stringify({
        ...catalog,
        catalog: [{ itemId: 'a', description: 'b' }],
      }),
    ],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('rejects a text frame holding %s', (_, text) => {
    expect(() =>
      registry.decodeItem('digital-goods', directMessageText(text)),
    ).toThrow(MessageItemDecodeError)
  })

  it('hydrate still takes the paid amount from the message stamp only', async () => {
    const message = { items: [request], stampValueWei: 5n } as never
    const [entry] = await registry.hydrateItems(message, {} as never)
    expect(entry).toMatchObject({ kind: 'hydrated', hydrated: { paidWei: 5n } })
  })
})
