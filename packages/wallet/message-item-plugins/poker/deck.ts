/**
 * Mental Poker Deck and Cryptographic Shuffle (GAME-2).
 *
 * Implements standard 52-card representations, rank/suit utilities,
 * and deterministic dual-seed Fisher-Yates shuffle with rejection sampling.
 */
import { createHmac } from 'crypto'

export const SUIT_SYMBOLS = ['♣', '♦', '♥', '♠']
export const RANK_NAMES = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
]

/**
 * Card encoding: 0..51.
 * rank = card % 13 (0 = '2' ... 12 = 'A')
 * suit = Math.floor(card / 13) (0 = Clubs, 1 = Diamonds, 2 = Hearts, 3 = Spades)
 */
export function cardRank(card: number): number {
  return card % 13
}

export function cardSuit(card: number): number {
  return Math.floor(card / 13)
}

export function formatCard(card: number): string {
  const r = RANK_NAMES[cardRank(card)] ?? '?'
  const s = SUIT_SYMBOLS[cardSuit(card)] ?? '?'
  return `${r}${s}`
}

export function isRedSuit(card: number): boolean {
  const suit = cardSuit(card)
  return suit === 1 || suit === 2 // Diamonds or Hearts
}

/**
 * Deterministically shuffles a standard 52-card deck using Fisher-Yates
 * seeded by HMAC-SHA256 of server and client seeds.
 * Rejection sampling eliminates modulo bias.
 */
export function derivePokerDeck(serverSeed: string, clientSeed: string): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i)
  let round = 0
  let hmac = createHmac('sha256', serverSeed).update(clientSeed).digest()
  let byteIndex = 0

  for (let i = 51; i > 0; i--) {
    const range = i + 1
    // Largest multiple of `range` that fits in 256
    const limit = 256 - (256 % range)

    while (true) {
      if (byteIndex >= hmac.length) {
        round++
        hmac = createHmac('sha256', serverSeed)
          .update(`${clientSeed}:${round}`)
          .digest()
        byteIndex = 0
      }

      const b = hmac[byteIndex++]
      if (b < limit) {
        const j = b % range
        const tmp = deck[i]
        deck[i] = deck[j]
        deck[j] = tmp
        break
      }
    }
  }

  return deck
}
