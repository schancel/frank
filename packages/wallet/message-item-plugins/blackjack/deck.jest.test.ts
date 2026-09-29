import { cardLabel, deriveDeck, handValue, sha256Hex } from './deck'

describe('blackjack deck derivation', () => {
  it('is deterministic for the same seeds', () => {
    const deckA = deriveDeck('server-secret', '0xdeadbeef', 0)
    const deckB = deriveDeck('server-secret', '0xdeadbeef', 0)
    expect(deckA).toEqual(deckB)
  })

  it('produces a full, non-degenerate 52-card permutation', () => {
    const deck = deriveDeck('server-secret', '0xdeadbeef', 0)
    expect(deck).toHaveLength(52)
    expect(new Set(deck).size).toBe(52)
    expect(Math.min(...deck)).toBe(0)
    expect(Math.max(...deck)).toBe(51)
  })

  it('produces a different deck for a different client seed', () => {
    const deckA = deriveDeck('server-secret', '0xaaaa', 0)
    const deckB = deriveDeck('server-secret', '0xbbbb', 0)
    expect(deckA).not.toEqual(deckB)
  })

  it('produces a different deck for a different server seed', () => {
    const deckA = deriveDeck('server-secret-1', '0xdeadbeef', 0)
    const deckB = deriveDeck('server-secret-2', '0xdeadbeef', 0)
    expect(deckA).not.toEqual(deckB)
  })

  it('produces a different deck for a different nonce (same hand, replayed)', () => {
    const deckA = deriveDeck('server-secret', '0xdeadbeef', 0)
    const deckB = deriveDeck('server-secret', '0xdeadbeef', 1)
    expect(deckA).not.toEqual(deckB)
  })
})

describe('handValue', () => {
  it('sums simple hands', () => {
    // 2 of clubs (rank 1, suit 3) + King of clubs (rank 12, suit 3)
    expect(handValue([1 + 13 * 3, 12 + 13 * 3]).total).toBe(12)
  })

  it('detects a natural blackjack', () => {
    // Ace of spades (0) + King of spades (12)
    const value = handValue([0, 12])
    expect(value.total).toBe(21)
    expect(value.blackjack).toBe(true)
  })

  it('downgrades a soft ace to avoid busting', () => {
    // Ace (0) + 9 of hearts (8+13) + 5 of hearts (4+13) = 11 + 9 + 5 = 25 -> downgrade ace to 1 -> 15
    const value = handValue([0, 8 + 13, 4 + 13])
    expect(value.total).toBe(15)
    expect(value.bust).toBe(false)
    expect(value.soft).toBe(false)
  })

  it('detects a genuine bust', () => {
    // King (12) + Queen (11) + 5 (rank 4) = 10 + 10 + 5 = 25, no aces to downgrade
    const value = handValue([12, 11, 4])
    expect(value.bust).toBe(true)
  })

  it('keeps a hand soft when an ace is still counted as 11', () => {
    // Ace (0) + 6 (rank 5) = 17, soft
    const value = handValue([0, 5])
    expect(value.total).toBe(17)
    expect(value.soft).toBe(true)
    expect(value.bust).toBe(false)
  })
})

describe('cardLabel', () => {
  it('labels aces and face cards legibly', () => {
    expect(cardLabel(0)).toBe('A♠')
    expect(cardLabel(12)).toBe('K♠')
    expect(cardLabel(13)).toBe('A♥')
  })
})

describe('sha256Hex', () => {
  it('matches a known test vector', () => {
    // echo -n "abc" | sha256sum
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})
