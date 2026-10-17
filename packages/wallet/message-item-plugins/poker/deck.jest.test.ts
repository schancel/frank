import {
  cardRank,
  cardSuit,
  formatCard,
  isRedSuit,
  derivePokerDeck,
  deriveJointPokerSeed,
  commitSeed,
  commitHoleCards,
  verifyHoleCardsCommitment,
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

  it('mixes multi-party player seeds so no single party can unilaterally choose the deck', () => {
    const serverSeed = 'server-secret-seed-1'
    const playerSeeds1 = {
      '0xAlice': 'alice-seed-1',
      '0xBob': 'bob-seed-1',
    }
    const playerSeeds2 = {
      '0xAlice': 'alice-seed-1',
      '0xBob': 'bob-seed-2',
    }

    const joint1 = deriveJointPokerSeed(serverSeed, playerSeeds1, ['0xAlice', '0xBob'])
    const joint2 = deriveJointPokerSeed(serverSeed, playerSeeds2, ['0xAlice', '0xBob'])
    expect(joint1).not.toBe(joint2)

    const deck1 = derivePokerDeck(serverSeed, playerSeeds1, ['0xAlice', '0xBob'])
    const deck2 = derivePokerDeck(serverSeed, playerSeeds2, ['0xAlice', '0xBob'])
    expect(deck1).not.toEqual(deck2)
    expect(new Set(deck1).size).toBe(52)
  })

  it('commits and verifies hole cards and rejects tampered cards or salts', () => {
    const hole: [number, number] = [12, 51]
    const salt = 'random-salt-xyz'
    const commit = commitHoleCards(hole, salt)
    expect(commit).toHaveLength(64)
    expect(verifyHoleCardsCommitment(hole, salt, commit)).toBe(true)
    expect(verifyHoleCardsCommitment([12, 50], salt, commit)).toBe(false)
    expect(verifyHoleCardsCommitment(hole, 'wrong-salt', commit)).toBe(false)
    expect(commitSeed('my-secret')).toHaveLength(64)
  })
})
