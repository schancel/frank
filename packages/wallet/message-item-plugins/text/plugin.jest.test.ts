import { directMessageText } from '@frank/cashweb/relay/canonical-dm'

import {
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initTextPlugin } from './plugin'

describePluginContract({
  type: 'text',
  init: initTextPlugin,
  samples: [
    { item: { type: 'text', text: 'hi' }, preview: 'hi' },
    { item: { type: 'text', text: '' }, preview: '' },
    {
      item: { type: 'text', text: 'héllo ✉️\nline two' },
      preview: 'héllo ✉️\nline two',
    },
  ],
})

describe('text wire bytes', () => {
  it('are the bytes the canonical path writes today', () => {
    const registry = registryWith('text', initTextPlugin)
    for (const text of ['hi', '', 'héllo ✉️']) {
      expect(registry.encodeItem({ type: 'text', text }).bytes).toEqual(
        directMessageText(text),
      )
    }
    // The worked example of docs/protocol/cbor section 1.
    expect(
      Buffer.from(
        registry.encodeItem({ type: 'text', text: 'hi' }).bytes,
      ).toString('hex'),
    ).toBe('46524e4b010000000ea40011010102010345a100626869')
  })
})
