/** Public-writer origin inputs; no generic-frame encoder substitutes for typed origins. */
import { encodeBlackjackItem, toHex, type BlackjackItem } from '../src'

export const TYPESCRIPT_BLACKJACK_ORIGINS: readonly {
  id: string
  item: BlackjackItem
}[] = [
  {
    id: 'typescript-welcome-wide-unicode',
    item: {
      type: 'blackjack-move',
      action: 'welcome',
      gameId: 'welcome',
      minWagerWei: '9007199254740993',
      maxWagerWei: '9999999999999999999999999999999999999999',
      feeHintWei: '0',
      rules: 'Keep café and café distinct — 🎴',
    },
  },
  {
    id: 'typescript-reveal-unicode',
    item: {
      type: 'blackjack-move',
      action: 'reveal',
      gameId: 'bj-🎴-é',
      dealerCards: [51, 0, 13],
      serverSeed: '0123456789abcdef'.repeat(4),
      outcome: 'push',
    },
  },
]

export function typescriptBlackjackOriginFrames() {
  return TYPESCRIPT_BLACKJACK_ORIGINS.map(({ id, item }) => ({
    id,
    origin: 'typescript',
    operation: 'typed',
    context: 'type18-reader1',
    frameHex: toHex(encodeBlackjackItem(item)),
    expected: { result: 'accept' },
    application: item,
    note: 'Independently encoded through the active TypeScript public typed writer for #782.',
  }))
}
