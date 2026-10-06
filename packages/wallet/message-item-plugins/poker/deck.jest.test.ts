import {
  cardRank,
  cardSuit,
  formatCard,
  isRedSuit,
  derivePokerDeck,
} from './deck'

describe('Mental Poker Deck', () => {
  it('correctly maps cards to ranks and suits', () => {
    // Card 0: 2 of Clubs (rank 0, suit 0)
    expect(cardRank(0)).toBe(0)
    expect(cardSuit(0)).toBe(0)
    expect(formatCard(0)).toBe('2♣')
    expect(isRedSuit(0)).toBe(false)

    // Card 12: Ace of Clubs (rank 12, suit 0)
    expect(cardRank(12)).toBe(12)
    expect(cardSuit(12)).toBe(0)
    expect(formatCard(12)).toBe('A♣')

    // Card 25: Ace of Diamonds (rank 12, suit 1)
    expect(cardRank(25)).toBe(12)
    expect(cardSuit(25)).toBe(1)
    expect(formatCard(25)).toBe('A♦')
    expect(isRedSuit(25)).toBe(true)

    // Card 38: Ace of Hearts (rank 12, suit 2)
    expect(formatCard(38)).toBe('A♥')
    expect(isRedSuit(38)).toBe(true)

    // Card 51: Ace of Spades (rank 12, suit 3)
    expect(formatCard(51)).toBe('A♠')
    expect(isRedSuit(51)).toBe(false)
  })

  it('deterministically shuffles a full 52-card deck without duplicate cards', () => {
    const sSeed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const cSeed = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

    const deck1 = derivePokerDeck(sSeed, cSeed)
    const deck2 = derivePokerDeck(sSeed, cSeed)

    expect(deck1).toEqual(deck2)
    expect(deck1).toHaveLength(52)

    // All 52 cards unique
    const unique = new Set(deck1)
    expect(unique.size).toBe(52)

    // Different seed produces different shuffle
    const deckOther = derivePokerDeck(sSeed, 'other-seed')
    expect(deckOther).not.toEqual(deck1)
    expect(new Set(deckOther).size).toBe(52)
  })
})
