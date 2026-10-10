import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initImagePlugin } from './plugin'

import { registryWith } from '../shared/plugin-contract.testutil'

describePluginContract({
  type: 'image',
  init: initImagePlugin,
  samples: [
    {
      item: { type: 'image', image: 'data:image/png;base64,AAAA' },
      preview: 'Sent image',
    },
    { item: { type: 'image', image: '' }, preview: 'Sent image' },
  ],
})

it('carries an image larger than the CBOR text-string limit', () => {
  const registry = registryWith('image', initImagePlugin)
  const item = { type: 'image' as const, image: 'A'.repeat(300_000) }
  const { bytes } = registry.encodeItem(item)
  expect(registry.decodeItem('image', bytes)).toEqual({ kind: 'item', item })
})
