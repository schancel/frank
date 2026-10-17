/**
 * Mental Poker Deck and Cryptographic Shuffle (GAME-2).
 *
 * Implements standard 52-card representations, rank/suit utilities,
 * and deterministic dual-seed Fisher-Yates shuffle with rejection sampling.
 */
import { createHash, createHmac, randomBytes } from 'crypto'

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

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function generatePokerSeed(): string {
  return randomBytes(32).toString('hex')
}

export function commitSeed(seed: string): string {
  return sha256Hex(seed)
}

export function commitHoleCards(
  holeCards: readonly number[],
  salt: string,
): string {
  if (holeCards.length !== 2) {
    throw new Error(`Expected 2 hole cards, got ${holeCards.length}`)
  }
  return sha256Hex(`poker-hole:${holeCards[0]},${holeCards[1]}:${salt}`)
}

export function verifyHoleCardsCommitment(
  holeCards: readonly number[],
  salt: string,
  commitment: string,
): boolean {
  if (holeCards.length !== 2 || !salt || !commitment) return false
  return commitHoleCards(holeCards, salt) === commitment.replace(/^0x/, '').toLowerCase()
}

/**
 * Combines the dealer/server seed with every participating player's revealed seed
 * so no single party (neither bot nor any single player) can unilaterally choose
 * or predict the deck shuffle.
 */
export function deriveJointPokerSeed(
  serverSeed: string,
  playerSeeds: string | readonly string[] | Record<string, string>,
  playerOrder?: readonly string[],
): string {
  if (typeof playerSeeds === 'string') {
    return createHmac('sha256', serverSeed).update(playerSeeds).digest('hex')
  }
  if (Array.isArray(playerSeeds)) {
    const joined = playerSeeds.join(':')
    return createHmac('sha256', serverSeed).update(joined).digest('hex')
  }
  const record = playerSeeds as Record<string, string>
  const normalized = new Map<string, string>()
  for (const [addr, s] of Object.entries(record)) {
    normalized.set(addr.toLowerCase(), s)
  }
  const orderedKeys: string[] = []
  if (playerOrder && playerOrder.length > 0) {
    for (const addr of playerOrder) {
      const k = addr.toLowerCase()
      if (normalized.has(k) && !orderedKeys.includes(k)) {
        orderedKeys.push(k)
      }
    }
  }
  const remainingKeys = [...normalized.keys()]
    .filter(k => !orderedKeys.includes(k))
    .sort()
  orderedKeys.push(...remainingKeys)

  const transcript = orderedKeys
    .map(k => `${k}:${normalized.get(k) ?? ''}`)
    .join('|')
  return createHmac('sha256', serverSeed).update(transcript).digest('hex')
}

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
 * seeded by HMAC-SHA256 of server and client/multi-party seeds.
 * Rejection sampling eliminates modulo bias.
 */
export function derivePokerDeck(
  serverSeed: string,
  clientSeed: string | readonly string[] | Record<string, string>,
  playerOrder?: readonly string[],
): number[] {
  const effectiveClientSeed =
    typeof clientSeed === 'string'
      ? clientSeed
      : deriveJointPokerSeed(serverSeed, clientSeed, playerOrder)
  const deck = Array.from({ length: 52 }, (_, i) => i)
  let round = 0
  let hmac = createHmac('sha256', serverSeed).update(effectiveClientSeed).digest()
  let byteIndex = 0

  for (let i = 51; i > 0; i--) {
    const range = i + 1
    // Largest multiple of `range` that fits in 256
    const limit = 256 - (256 % range)

    while (true) {
      if (byteIndex >= hmac.length) {
        round++
        hmac = createHmac('sha256', serverSeed)
          .update(`${effectiveClientSeed}:${round}`)
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
