import {
  encodeBlackjackHandItem,
  encodeBlackjackHandV3Item,
} from '@frank/codec'

import { BLACKJACK_HAND_V3_ITEMS } from '../../../frank-codec/fixtures/blackjack-hand-v3'
import { handPreviewText } from '../blackjack/hand'
import { MessageItemDecodeError } from '../registry'
import {
  standaloneDecodeContext,
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initBlackjackHandPlugin } from './plugin'

const PREVIEWS: Record<string, string> = {
  challenge: 'Blackjack challenge',
  accept: 'Blackjack challenge accepted',
  bet: 'Placed a blackjack bet',
  deal: 'Blackjack hand dealt',
  hit: 'Hit',
  stand: 'Stood',
  double: 'Doubled down',
  card: 'Blackjack card dealt',
  reveal: 'Blackjack hand resolved',
  refund: 'Blackjack bet refunded',
}

describePluginContract({
  type: 'blackjack-hand',
  init: initBlackjackHandPlugin,
  samples: BLACKJACK_HAND_V3_ITEMS.map(({ item }) => ({
    item,
    preview: PREVIEWS[item.action],
  })),
})

describe('blackjack-hand wire bytes', () => {
  const registry = registryWith('blackjack-hand', initBlackjackHandPlugin)

  it('covers every hand action', () => {
    expect(
      new Set(BLACKJACK_HAND_V3_ITEMS.map(({ item }) => item.action)),
    ).toEqual(new Set(Object.keys(PREVIEWS)))
  })

  it('are the bytes the canonical path writes today, with the shared preview and thread key', () => {
    for (const { item } of BLACKJACK_HAND_V3_ITEMS) {
      expect(registry.encodeItem(item).bytes).toEqual(
        encodeBlackjackHandV3Item(item),
      )
      expect(registry.previewText(item)).toBe(handPreviewText(item))
      expect(registry.get('blackjack-hand')!.threadKey!(item)).toBe(item.gameId)
    }
  })

  it('rejects a schema-2 hand frame', () => {
    const schema2 = encodeBlackjackHandItem({
      type: 'blackjack-hand',
      gameId: '0'.repeat(32),
      action: 'hit',
    })
    expect(() =>
      registry.decodeItem('blackjack-hand', schema2, standaloneDecodeContext()),
    ).toThrow(MessageItemDecodeError)
  })
})
