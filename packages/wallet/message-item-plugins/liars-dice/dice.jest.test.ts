import {
  derivePlayerDice,
  countMatchingDice,
  validateBid,
  sha256Hex,
  type Bid,
} from './dice'

describe("Liar's Dice (Perudo) Dice Engine", () => {
  const serverSeed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const playerSeed = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'

  it('deterministically derives dice in range 1..6 from dual seeds', () => {
    const dice1 = derivePlayerDice(serverSeed, playerSeed, 5)
    const dice2 = derivePlayerDice(serverSeed, playerSeed, 5)

    expect(dice1).toEqual(dice2)
    expect(dice1).toHaveLength(5)
    for (const d of dice1) {
      expect(Number.isInteger(d)).toBe(true)
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThanOrEqual(6)
    }

    // Different seed produces different roll
    const diceOther = derivePlayerDice(serverSeed, 'different-seed', 5)
    expect(diceOther).not.toEqual(dice1)
  })

  it('computes matching dice with wild Aces (1s)', () => {
    const cups = {
      playerA: [1, 2, 2, 4, 6], // one 1, two 2s, one 4, one 6
      playerB: [1, 1, 3, 5, 6], // two 1s, one 3, one 5, one 6
    }

    // For face 2: two natural 2s + three wild 1s = 5
    const match2 = countMatchingDice(cups, 2)
    expect(match2.faceMatches).toBe(2)
    expect(match2.wildAces).toBe(3)
    expect(match2.totalCount).toBe(5)

    // For face 6: two natural 6s + three wild 1s = 5
    const match6 = countMatchingDice(cups, 6)
    expect(match6.faceMatches).toBe(2)
    expect(match6.wildAces).toBe(3)
    expect(match6.totalCount).toBe(5)

    // For face 1 (Aces): only natural 1s count (wild does not apply to Aces themselves)
    const match1 = countMatchingDice(cups, 1)
    expect(match1.faceMatches).toBe(3)
    expect(match1.wildAces).toBe(0)
    expect(match1.totalCount).toBe(3)
  })

  describe('validateBid', () => {
    const totalDice = 10

    it('accepts valid opening bids', () => {
      const open: Bid = { bidder: 'alice', quantity: 2, face: 3 }
      expect(validateBid(undefined, open, totalDice).valid).toBe(true)
    })

    it('rejects invalid face or quantity', () => {
      expect(validateBid(undefined, { bidder: 'alice', quantity: 0, face: 3 }, totalDice).valid).toBe(false)
      expect(validateBid(undefined, { bidder: 'alice', quantity: 2, face: 7 }, totalDice).valid).toBe(false)
      expect(validateBid(undefined, { bidder: 'alice', quantity: 15, face: 3 }, totalDice).valid).toBe(false)
    })

    it('validates standard raises (faces 2..6)', () => {
      const prev: Bid = { bidder: 'alice', quantity: 3, face: 4 }

      // Same quantity, higher face: valid
      expect(validateBid(prev, { bidder: 'bob', quantity: 3, face: 5 }, totalDice).valid).toBe(true)
      expect(validateBid(prev, { bidder: 'bob', quantity: 3, face: 6 }, totalDice).valid).toBe(true)

      // Same quantity, lower or equal face: invalid
      expect(validateBid(prev, { bidder: 'bob', quantity: 3, face: 4 }, totalDice).valid).toBe(false)
      expect(validateBid(prev, { bidder: 'bob', quantity: 3, face: 3 }, totalDice).valid).toBe(false)

      // Higher quantity, any face 2..6: valid
      expect(validateBid(prev, { bidder: 'bob', quantity: 4, face: 2 }, totalDice).valid).toBe(true)
      expect(validateBid(prev, { bidder: 'bob', quantity: 4, face: 4 }, totalDice).valid).toBe(true)

      // Lower quantity: invalid
      expect(validateBid(prev, { bidder: 'bob', quantity: 2, face: 6 }, totalDice).valid).toBe(false)
    })

    it('validates transitions to and from Aces (wild 1s)', () => {
      const prevNormal: Bid = { bidder: 'alice', quantity: 4, face: 5 }

      // Transition to Aces: can halve quantity rounded up (4 / 2 = 2)
      expect(validateBid(prevNormal, { bidder: 'bob', quantity: 2, face: 1 }, totalDice).valid).toBe(true)
      expect(validateBid(prevNormal, { bidder: 'bob', quantity: 3, face: 1 }, totalDice).valid).toBe(true)
      expect(validateBid(prevNormal, { bidder: 'bob', quantity: 1, face: 1 }, totalDice).valid).toBe(false)

      // Raising an existing Ace bid: must increase quantity
      const prevAce: Bid = { bidder: 'bob', quantity: 2, face: 1 }
      expect(validateBid(prevAce, { bidder: 'charlie', quantity: 3, face: 1 }, totalDice).valid).toBe(true)
      expect(validateBid(prevAce, { bidder: 'charlie', quantity: 2, face: 1 }, totalDice).valid).toBe(false)

      // Transitioning from Aces back to normal numbers: 2 * aces + 1 (2 * 2 + 1 = 5)
      expect(validateBid(prevAce, { bidder: 'charlie', quantity: 5, face: 3 }, totalDice).valid).toBe(true)
      expect(validateBid(prevAce, { bidder: 'charlie', quantity: 4, face: 3 }, totalDice).valid).toBe(false)
    })
  })
})
