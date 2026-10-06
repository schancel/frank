/**
 * 7-Card Texas Hold'em Hand Evaluator (GAME-2).
 *
 * Evaluates the best 5-card poker hand out of up to 7 cards (2 hole cards + 5 board cards).
 * Produces deterministic rank scores for showdown comparison with tie-breaking kickers.
 */
import { cardRank, cardSuit, formatCard, RANK_NAMES } from './deck'

export enum HandCategory {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
}

export interface HandEvaluation {
  score: number
  category: HandCategory
  categoryName: string
  description: string
  best5: number[]
}

const CATEGORY_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: 'High Card',
  [HandCategory.OnePair]: 'One Pair',
  [HandCategory.TwoPair]: 'Two Pair',
  [HandCategory.ThreeOfAKind]: 'Three of a Kind',
  [HandCategory.Straight]: 'Straight',
  [HandCategory.Flush]: 'Flush',
  [HandCategory.FullHouse]: 'Full House',
  [HandCategory.FourOfAKind]: 'Four of a Kind',
  [HandCategory.StraightFlush]: 'Straight Flush',
}

/**
 * Evaluates an exact 5-card poker hand and computes a monotonic rank score.
 */
export function evaluate5CardHand(cards: number[]): {
  score: number
  category: HandCategory
  description: string
} {
  if (cards.length !== 5) {
    throw new Error(`Expected 5 cards, got ${cards.length}`)
  }

  const ranks = cards.map(cardRank).sort((a, b) => b - a)
  const suits = cards.map(cardSuit)

  const isFlush = suits.every(s => s === suits[0])

  // Check for straight
  let isStraight = false
  let straightHigh = ranks[0]

  // Normal straight: 5 consecutive ranks
  if (
    ranks[0] - ranks[1] === 1 &&
    ranks[1] - ranks[2] === 1 &&
    ranks[2] - ranks[3] === 1 &&
    ranks[3] - ranks[4] === 1
  ) {
    isStraight = true
    straightHigh = ranks[0]
  } else if (
    // Ace-low straight (A-2-3-4-5: ranks 12, 3, 2, 1, 0)
    ranks[0] === 12 &&
    ranks[1] === 3 &&
    ranks[2] === 2 &&
    ranks[3] === 1 &&
    ranks[4] === 0
  ) {
    isStraight = true
    straightHigh = 3 // 5-high straight
  }

  // Count rank frequencies
  const freqMap = new Map<number, number>()
  for (const r of ranks) {
    freqMap.set(r, (freqMap.get(r) ?? 0) + 1)
  }

  const freqEntries = [...freqMap.entries()].sort((a, b) => {
    // Sort by count descending, then by rank descending
    if (b[1] !== a[1]) return b[1] - a[1]
    return b[0] - a[0]
  })

  // 1. Straight Flush / Royal Flush
  if (isStraight && isFlush) {
    const isRoyal = straightHigh === 12
    const desc = isRoyal
      ? 'Royal Flush'
      : `Straight Flush, ${RANK_NAMES[straightHigh]} High`
    const score = (HandCategory.StraightFlush << 20) | (straightHigh << 16)
    return { score, category: HandCategory.StraightFlush, description: desc }
  }

  // 2. Four of a Kind
  if (freqEntries[0][1] === 4) {
    const fourRank = freqEntries[0][0]
    const kicker = freqEntries[1][0]
    const desc = `Four of a Kind, ${RANK_NAMES[fourRank]}s`
    const score = (HandCategory.FourOfAKind << 20) | (fourRank << 16) | (kicker << 12)
    return { score, category: HandCategory.FourOfAKind, description: desc }
  }

  // 3. Full House
  if (freqEntries[0][1] === 3 && freqEntries[1][1] === 2) {
    const threeRank = freqEntries[0][0]
    const pairRank = freqEntries[1][0]
    const desc = `Full House, ${RANK_NAMES[threeRank]}s full of ${RANK_NAMES[pairRank]}s`
    const score = (HandCategory.FullHouse << 20) | (threeRank << 16) | (pairRank << 12)
    return { score, category: HandCategory.FullHouse, description: desc }
  }

  // 4. Flush
  if (isFlush) {
    const desc = `Flush, ${RANK_NAMES[ranks[0]]} High`
    const score =
      (HandCategory.Flush << 20) |
      (ranks[0] << 16) |
      (ranks[1] << 12) |
      (ranks[2] << 8) |
      (ranks[3] << 4) |
      ranks[4]
    return { score, category: HandCategory.Flush, description: desc }
  }

  // 5. Straight
  if (isStraight) {
    const desc = `Straight, ${RANK_NAMES[straightHigh]} High`
    const score = (HandCategory.Straight << 20) | (straightHigh << 16)
    return { score, category: HandCategory.Straight, description: desc }
  }

  // 6. Three of a Kind
  if (freqEntries[0][1] === 3) {
    const threeRank = freqEntries[0][0]
    const k1 = freqEntries[1][0]
    const k2 = freqEntries[2][0]
    const desc = `Three of a Kind, ${RANK_NAMES[threeRank]}s`
    const score =
      (HandCategory.ThreeOfAKind << 20) |
      (threeRank << 16) |
      (k1 << 12) |
      (k2 << 8)
    return { score, category: HandCategory.ThreeOfAKind, description: desc }
  }

  // 7. Two Pair
  if (freqEntries[0][1] === 2 && freqEntries[1][1] === 2) {
    const highPair = freqEntries[0][0]
    const lowPair = freqEntries[1][0]
    const kicker = freqEntries[2][0]
    const desc = `Two Pair, ${RANK_NAMES[highPair]}s and ${RANK_NAMES[lowPair]}s`
    const score =
      (HandCategory.TwoPair << 20) |
      (highPair << 16) |
      (lowPair << 12) |
      (kicker << 8)
    return { score, category: HandCategory.TwoPair, description: desc }
  }

  // 8. One Pair
  if (freqEntries[0][1] === 2) {
    const pairRank = freqEntries[0][0]
    const k1 = freqEntries[1][0]
    const k2 = freqEntries[2][0]
    const k3 = freqEntries[3][0]
    const desc = `One Pair of ${RANK_NAMES[pairRank]}s`
    const score =
      (HandCategory.OnePair << 20) |
      (pairRank << 16) |
      (k1 << 12) |
      (k2 << 8) |
      (k3 << 4)
    return { score, category: HandCategory.OnePair, description: desc }
  }

  // 9. High Card
  const desc = `High Card, ${RANK_NAMES[ranks[0]]}`
  const score =
    (HandCategory.HighCard << 20) |
    (ranks[0] << 16) |
    (ranks[1] << 12) |
    (ranks[2] << 8) |
    (ranks[3] << 4) |
    ranks[4]
  return { score, category: HandCategory.HighCard, description: desc }
}

/**
 * Finds all k-combinations from an array of elements.
 */
function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const head = arr[0]
  const tail = arr.slice(1)
  const withHead = combinations(tail, k - 1).map(c => [head, ...c])
  const withoutHead = combinations(tail, k)
  return [...withHead, ...withoutHead]
}

/**
 * Evaluates the best 5-card poker hand out of 5 to 7 cards.
 */
export function evaluate7CardHand(cards: number[]): HandEvaluation {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`Expected between 5 and 7 cards, got ${cards.length}`)
  }

  const allCombos = combinations(cards, 5)
  let bestScore = -1
  let bestEvaluation!: { score: number; category: HandCategory; description: string }
  let best5: number[] = []

  for (const combo of allCombos) {
    const evaluation = evaluate5CardHand(combo)
    if (evaluation.score > bestScore) {
      bestScore = evaluation.score
      bestEvaluation = evaluation
      best5 = combo
    }
  }

  return {
    score: bestScore,
    category: bestEvaluation.category,
    categoryName: CATEGORY_NAMES[bestEvaluation.category],
    description: bestEvaluation.description,
    best5,
  }
}
