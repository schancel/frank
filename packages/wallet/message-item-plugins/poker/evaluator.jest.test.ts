import {
  evaluate5CardHand,
  evaluate7CardHand,
  HandCategory,
} from './evaluator'

describe('7-Card Poker Hand Evaluator', () => {
  // Helper to map card notation to number:
  // e.g. "A♠" -> suit 3, rank 12 -> 3 * 13 + 12 = 51
  function parseCard(str: string): number {
    const rankStr = str.slice(0, -1)
    const suitStr = str.slice(-1)
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
    const suits = ['♣', '♦', '♥', '♠']
    const rank = ranks.indexOf(rankStr)
    const suit = suits.indexOf(suitStr)
    if (rank === -1 || suit === -1) throw new Error(`Invalid card notation: ${str}`)
    return suit * 13 + rank
  }

  function parseCards(arr: string[]): number[] {
    return arr.map(parseCard)
  }

  it('correctly evaluates Royal Flush', () => {
    const cards = parseCards(['A♠', 'K♠', 'Q♠', 'J♠', '10♠', '2♣', '3♦'])
    const result = evaluate7CardHand(cards)
    expect(result.category).toBe(HandCategory.StraightFlush)
    expect(result.description).toContain('Royal Flush')
  })

  it('correctly evaluates Four of a Kind', () => {
    const cards = parseCards(['9♠', '9♥', '9♦', '9♣', 'K♠', '2♣', '4♦'])
    const result = evaluate7CardHand(cards)
    expect(result.category).toBe(HandCategory.FourOfAKind)
    expect(result.description).toContain('Four of a Kind, 9s')
  })

  it('correctly evaluates Full House', () => {
    const cards = parseCards(['K♠', 'K♥', 'K♦', '10♣', '10♠', '2♣', '4♦'])
    const result = evaluate7CardHand(cards)
    expect(result.category).toBe(HandCategory.FullHouse)
    expect(result.description).toContain('Full House, Ks full of 10s')
  })

  it('correctly evaluates Flush', () => {
    const cards = parseCards(['A♥', '10♥', '7♥', '6♥', '2♥', 'K♠', 'Q♣'])
    const result = evaluate7CardHand(cards)
    expect(result.category).toBe(HandCategory.Flush)
    expect(result.description).toContain('Flush, A High')
  })

  it('correctly evaluates standard Straight and Ace-low Wheel straight', () => {
    // Normal straight: 9-high (5, 6, 7, 8, 9)
    const normalCards = parseCards(['9♠', '8♥', '7♦', '6♣', '5♠', '2♣', 'K♦'])
    const normalResult = evaluate7CardHand(normalCards)
    expect(normalResult.category).toBe(HandCategory.Straight)
    expect(normalResult.description).toContain('Straight, 9 High')

    // Ace-low wheel straight (A-2-3-4-5)
    const wheelCards = parseCards(['A♠', '2♥', '3♦', '4♣', '5♠', 'K♣', 'Q♦'])
    const wheelResult = evaluate7CardHand(wheelCards)
    expect(wheelResult.category).toBe(HandCategory.Straight)
    expect(wheelResult.description).toContain('Straight, 5 High')

    // Normal 6-high straight beats 5-high wheel straight
    const sixHigh = parseCards(['6♠', '5♥', '4♦', '3♣', '2♠', 'K♣', 'Q♦'])
    expect(evaluate7CardHand(sixHigh).score).toBeGreaterThan(wheelResult.score)
  })

  it('correctly ranks hand categories monotonically', () => {
    const royal = evaluate7CardHand(parseCards(['A♠', 'K♠', 'Q♠', 'J♠', '10♠', '2♣', '3♦'])).score
    const quads = evaluate7CardHand(parseCards(['9♠', '9♥', '9♦', '9♣', 'K♠', '2♣', '4♦'])).score
    const fullHouse = evaluate7CardHand(parseCards(['K♠', 'K♥', 'K♦', '10♣', '10♠', '2♣', '4♦'])).score
    const flush = evaluate7CardHand(parseCards(['A♥', '10♥', '7♥', '6♥', '2♥', 'K♠', 'Q♣'])).score
    const straight = evaluate7CardHand(parseCards(['9♠', '8♥', '7♦', '6♣', '5♠', '2♣', 'K♦'])).score
    const trips = evaluate7CardHand(parseCards(['8♠', '8♥', '8♦', 'K♣', '2♠', '3♣', '4♦'])).score
    const twoPair = evaluate7CardHand(parseCards(['8♠', '8♥', '7♦', '7♣', 'A♠', '2♣', '3♦'])).score
    const onePair = evaluate7CardHand(parseCards(['8♠', '8♥', 'A♦', 'K♣', 'Q♠', '2♣', '3♦'])).score
    const highCard = evaluate7CardHand(parseCards(['A♠', 'K♥', 'Q♦', 'J♣', '9♠', '2♣', '3♦'])).score

    expect(royal).toBeGreaterThan(quads)
    expect(quads).toBeGreaterThan(fullHouse)
    expect(fullHouse).toBeGreaterThan(flush)
    expect(flush).toBeGreaterThan(straight)
    expect(straight).toBeGreaterThan(trips)
    expect(trips).toBeGreaterThan(twoPair)
    expect(twoPair).toBeGreaterThan(onePair)
    expect(onePair).toBeGreaterThan(highCard)
  })

  it('correctly breaks ties with kickers', () => {
    // Pair of Aces with King kicker beats Pair of Aces with Queen kicker
    const pairAceKing = evaluate7CardHand(parseCards(['A♠', 'A♥', 'K♦', '8♣', '4♠', '2♣', '3♦']))
    const pairAceQueen = evaluate7CardHand(parseCards(['A♦', 'A♣', 'Q♦', '8♠', '4♥', '2♣', '3♦']))
    expect(pairAceKing.score).toBeGreaterThan(pairAceQueen.score)

    // Equal hands tie exactly
    const handA = evaluate7CardHand(parseCards(['A♠', 'K♥', 'Q♦', 'J♣', '9♠', '2♣', '3♦']))
    const handB = evaluate7CardHand(parseCards(['A♦', 'K♣', 'Q♠', 'J♥', '9♦', '2♥', '3♠']))
    expect(handA.score).toBe(handB.score)
  })
})
