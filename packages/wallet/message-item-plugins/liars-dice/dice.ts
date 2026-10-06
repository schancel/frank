/**
 * Cryptographic Mental Dice Engine for Liar's Dice (Perudo) (GAME-1).
 *
 * Implements dual-seed provably fair entropy derivation, wild 1s (Aces) counting,
 * and Perudo bidding progression validation.
 */
import { createHash, createHmac, randomBytes } from 'crypto'

export interface Bid {
  readonly bidder: string
  readonly quantity: number
  readonly face: number // 1 to 6
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function generateSeed(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Derives `count` dice faces (1..6) deterministically from server and player seeds.
 * Neither party alone can predict or bias the result.
 * Modulo bias is avoided using rejection sampling.
 */
export function derivePlayerDice(
  serverSeed: string,
  playerSeed: string,
  count: number,
): number[] {
  if (count <= 0) return []
  const dice: number[] = []
  let extraRound = 0

  while (dice.length < count) {
    const salt = extraRound === 0 ? playerSeed : `${playerSeed}:${extraRound}`
    const hmac = createHmac('sha256', serverSeed).update(salt).digest()

    for (let i = 0; i < hmac.length && dice.length < count; i++) {
      const b = hmac[i]
      // Reject bytes >= 252 (252 = 42 * 6) to eliminate modulo bias
      if (b < 252) {
        dice.push((b % 6) + 1)
      }
    }
    extraRound++
  }

  return dice.sort((a, b) => a - b)
}

/**
 * Counts occurrences of target face across all player cups.
 * If face is 2..6, Aces (1s) count as wild.
 * If face is 1, only natural Aces are counted.
 */
export function countMatchingDice(
  allCups: Record<string, number[]>,
  targetFace: number,
): {
  totalCount: number
  faceMatches: number
  wildAces: number
} {
  let faceMatches = 0
  let wildAces = 0

  for (const cup of Object.values(allCups)) {
    for (const die of cup) {
      if (die === targetFace) {
        faceMatches++
      } else if (targetFace !== 1 && die === 1) {
        wildAces++
      }
    }
  }

  return {
    totalCount: faceMatches + wildAces,
    faceMatches,
    wildAces,
  }
}

/**
 * Validates whether `nextBid` is a legal Perudo raise over `prevBid`.
 *
 * Rules:
 * 1. Face must be integer 1..6.
 * 2. Quantity must be >= 1 and <= total dice in play.
 * 3. Opening bid (no prevBid): can be any face 2..6 (or 1 if allowed), quantity >= 1.
 * 4. Normal bids (faces 2..6 to 2..6):
 *    - Higher quantity (any face 2..6), OR
 *    - Same quantity with strictly higher face.
 * 5. Bidding on Aces (face 1):
 *    - From normal bid: quantity must be at least ceil(prevBid.quantity / 2).
 *    - From Ace bid: quantity must strictly increase (quantity > prevBid.quantity).
 * 6. Switching from Aces (face 1) back to normal (2..6):
 *    - Quantity must be at least (2 * prevBid.quantity + 1).
 */
export function validateBid(
  prevBid: Bid | undefined,
  nextBid: Bid,
  totalDiceInPlay: number,
): { valid: boolean; reason?: string } {
  if (
    !Number.isInteger(nextBid.face) ||
    nextBid.face < 1 ||
    nextBid.face > 6
  ) {
    return { valid: false, reason: 'Die face must be an integer between 1 and 6' }
  }

  if (
    !Number.isInteger(nextBid.quantity) ||
    nextBid.quantity < 1
  ) {
    return { valid: false, reason: 'Quantity must be at least 1' }
  }

  if (nextBid.quantity > totalDiceInPlay) {
    return {
      valid: false,
      reason: `Bid quantity (${nextBid.quantity}) cannot exceed total dice in play (${totalDiceInPlay})`,
    }
  }

  if (!prevBid) {
    return { valid: true }
  }

  const prevIsAce = prevBid.face === 1
  const nextIsAce = nextBid.face === 1

  if (!prevIsAce && !nextIsAce) {
    // Both are standard bids (2..6)
    if (nextBid.quantity > prevBid.quantity) {
      return { valid: true }
    }
    if (nextBid.quantity === prevBid.quantity && nextBid.face > prevBid.face) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `Bid must increase quantity or have higher face at same quantity (${prevBid.quantity}x ${prevBid.face}s)`,
    }
  }

  if (!prevIsAce && nextIsAce) {
    // Switching from normal to Aces: half quantity rounded up
    const minAces = Math.ceil(prevBid.quantity / 2)
    if (nextBid.quantity >= minAces) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `Bid on Aces must be at least half the previous quantity (${minAces})`,
    }
  }

  if (prevIsAce && nextIsAce) {
    // Raising an existing Ace bid
    if (nextBid.quantity > prevBid.quantity) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `Raising an Ace bid must strictly increase quantity (greater than ${prevBid.quantity})`,
    }
  }

  if (prevIsAce && !nextIsAce) {
    // Switching from Aces back to normal numbers: 2 * aces + 1
    const minNormal = prevBid.quantity * 2 + 1
    if (nextBid.quantity >= minNormal) {
      return { valid: true }
    }
    return {
      valid: false,
      reason: `Switching from Aces to normal numbers requires at least 2*Aces + 1 (${minNormal})`,
    }
  }

  return { valid: false, reason: 'Invalid bid progression' }
}
