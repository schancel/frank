/**
 * Provably-fair winner selection for the raffle bot demo -- same commit-reveal shape as
 * `../blackjack/deck.ts` (the bot commits to a seed's hash *before* it can know which
 * entrants -- and therefore which entry-payment tx hashes -- this round will end up with), reduced
 * to a single draw instead of a full deck shuffle, since a raffle only ever needs one winner index,
 * not 52 ordered cards. Reuses `sha256Hex` from `../blackjack/deck.ts` (a generic primitive, not
 * blackjack-specific); the HMAC draw itself is small and shaped differently enough (one draw vs. a
 * Fisher-Yates stream) that inlining it here is clearer than growing deck.ts into a shared-but-
 * barely-reused abstraction for it.
 *
 * Same "demo, not a certified RNG" caveat `deck.ts` already states applies here too, plus one more
 * specific to a many-entrant draw: the *last* entrant to join a round already knows every other
 * entrant's payment tx hash before their own payment is submitted, which in principle gives them
 * some grinding power over the combined entropy (re-sending their own entry with a different tx
 * would shift the result). This isn't addressed here -- each grind attempt costs a real, separate
 * on-chain entry payment, which is a real (if not airtight) economic deterrent at this stakes level,
 * not a free retry.
 *
 * Operator-side limitation (what a matching draw does NOT prove): the operator knows the seed
 * from the moment it commits, before any entry exists. It can therefore choose its own (sybil)
 * entry transactions, or decide which received entries count and which are dropped, until the
 * outcome favours it, and the draw would still verify: verification only shows that the seed was
 * not changed after the commitment and that the winner follows from the LISTED entrants and seed.
 * It says nothing about whether the listed entrants are real on-chain payments or complete.
 */
import * as forge from 'node-forge'

import { RaffleItem } from '@frank/cashweb/types/messages'

import { sha256Hex } from '../blackjack/deck'

export { sha256Hex }

/** Deterministic pick of one winner among `entrantCount` entrants (0-indexed), from `serverSeed`
 * (the bot's pre-committed secret, revealed at draw time) and `combinedEntropy` (every entrant's
 * own entry-payment tx hash, joined in a fixed order -- see `combineEntrantEntropy`). Same inputs
 * always produce the same result -- that determinism, not secrecy of the algorithm, is what lets
 * anyone recompute and verify a draw once `serverSeed` is revealed. */
export function pickWinnerIndex(
  serverSeed: string,
  combinedEntropy: string,
  entrantCount: number,
): number {
  if (entrantCount <= 0) {
    throw new Error('pickWinnerIndex requires at least one entrant')
  }
  const hmac = forge.hmac.create()
  // UTF-8 bytes, as any other HMAC implementation would key it (forge takes binary strings).
  hmac.start('sha256', forge.util.encodeUtf8(serverSeed))
  hmac.update(forge.util.encodeUtf8(combinedEntropy))
  const digest = hmac.digest().toHex()
  // First 8 hex chars = 32 bits, same truncation deck.ts's own stream uses -- plenty for an
  // unbiased-enough draw at this stakes level.
  const r = parseInt(digest.slice(0, 8), 16)
  return r % entrantCount
}

/** Fixes the deterministic order entry tx hashes are combined in for `pickWinnerIndex` -- join
 * order (the order entries were accepted in), never re-sorted, so the bot and any independent
 * verifier agree on the exact same combined string. */
export function combineEntrantEntropy(entryTxHashes: string[]): string {
  return entryTxHashes.join(':')
}

/** Independently verifies an announced raffle draw: that `serverSeed` matches the commitment hash
 * published when the round opened, and that recomputing the draw from `entryTxHashes` (in the same
 * join order `entrants` were recorded in) really does land on `winnerAddress`. Never trusts
 * `entrants`/`winnerAddress` on their own -- always recomputes from `serverSeed` and
 * `entryTxHashes`. */
export function verifyRaffleDraw(params: {
  serverSeed: string
  serverSeedHash: string
  entrants: string[]
  entryTxHashes: string[]
  winnerAddress: string
}): { valid: boolean; reason?: string } {
  const { serverSeed, serverSeedHash, entrants, entryTxHashes, winnerAddress } = params
  if (sha256Hex(serverSeed) !== serverSeedHash) {
    return {
      valid: false,
      reason: 'serverSeed does not match the committed hash',
    }
  }
  if (entrants.length === 0 || entrants.length !== entryTxHashes.length) {
    return {
      valid: false,
      reason: 'entrants and entryTxHashes must be the same non-empty length',
    }
  }
  const winnerIndex = pickWinnerIndex(
    serverSeed,
    combineEntrantEntropy(entryTxHashes),
    entrants.length,
  )
  if (entrants[winnerIndex] !== winnerAddress) {
    return {
      valid: false,
      reason: 'recomputed winner does not match the announced winner',
    }
  }
  return { valid: true }
}

/** Builds the `draw` item the bot sends to every entrant, and decides the winner and pot doing so
 * (one place, so the announced result and what the bot pays out cannot diverge). Carries
 * `serverSeedHash` so a client can tell which commitment the draw claims to open; a client still
 * verifies it against the commitment it saw *earlier* in the thread (see
 * `verifyRaffleDrawAgainstThread`), never against this field alone. */
export function buildRaffleDrawItem(params: {
  raffleId: string
  entryPriceWei: string
  serverSeed: string
  entrants: string[]
  entryTxHashes: string[]
}): RaffleItem & { winnerAddress: string; potWei: string } {
  const { raffleId, entryPriceWei, serverSeed, entrants, entryTxHashes } = params
  const winnerIndex = pickWinnerIndex(
    serverSeed,
    combineEntrantEntropy(entryTxHashes),
    entrants.length,
  )
  return {
    type: 'raffle',
    raffleId,
    action: 'draw',
    entryPriceWei,
    winnerAddress: entrants[winnerIndex],
    serverSeed,
    serverSeedHash: sha256Hex(serverSeed),
    entrants,
    entryTxHashes,
    potWei: (BigInt(entryPriceWei) * BigInt(entrants.length)).toString(),
  }
}

/** Structural checks on a draw before its winner is recomputed. `expectedEntries` is the round
 * size announced up front (a draw happens when the round is full), when known. */
function drawShapeProblem(
  draw: RaffleItem,
  entrants: string[],
  entryTxHashes: string[],
  expectedEntries: number | undefined,
  announcedPrice: string | undefined,
): string | undefined {
  if (entrants.length === 0 || entrants.length !== entryTxHashes.length) {
    return 'entrants and entryTxHashes must be the same non-empty length'
  }
  if (new Set(entrants.map(e => e.toLowerCase())).size !== entrants.length) {
    return 'the draw lists the same entrant more than once'
  }
  if (new Set(entryTxHashes.map(h => h.toLowerCase())).size !== entryTxHashes.length) {
    return 'the draw lists the same entry payment more than once'
  }
  if (expectedEntries !== undefined && entrants.length !== expectedEntries) {
    return `the draw lists ${entrants.length} entrants but the round announced ${expectedEntries}`
  }
  if (announcedPrice !== undefined) {
    // The price the round announced up front binds the draw: same price, pot = price * entrants.
    if (draw.entryPriceWei !== announcedPrice) {
      return 'the draw names a different entry price than the round announced'
    }
    if (draw.potWei === undefined) return 'the draw does not state the pot'
  }
  if (draw.entryPriceWei !== undefined && draw.potWei !== undefined) {
    try {
      if (BigInt(draw.entryPriceWei) * BigInt(entrants.length) !== BigInt(draw.potWei)) {
        return 'the pot is not the entry price times the number of entrants'
      }
    } catch {
      return 'the entry price or pot is not a number'
    }
  }
  return undefined
}

/** Verifies a `draw` against the seed commitment the bot published *before* the round opened for
 * entries: the `serverSeedHash` on an earlier `announce` item of the same round (`priorItems`,
 * oldest first, only items that arrived before the draw from the same sender; the caller
 * enforces that). Only `announce` counts: a `joined` reply is sent after the entrant's own
 * payment, so it is not a pre-entry commitment. A hash that arrives with the draw proves
 * nothing, since the operator could pick the seed after seeing the entries.
 *
 * Returns `null` when there is nothing to verify against (a partial draw, or no commitment
 * seen): callers show no claim then. Conflicting commitments for one round, a draw naming a
 * different hash, duplicate entrants or payments, or a count that differs from the announced
 * round size are failures.
 *
 * A pass proves ONLY that the seed was not changed after the commitment and that the winner
 * follows from the listed entrants and seed. It does not prove the entrants are real on-chain
 * payments or that no entry was dropped (see this file's header). */
export function verifyRaffleDrawAgainstThread(
  draw: RaffleItem,
  priorItems: RaffleItem[],
): { valid: boolean; reason?: string; countVerified?: boolean } | null {
  const { winnerAddress, serverSeed, entrants, entryTxHashes } = draw
  if (!winnerAddress || !serverSeed || !entrants || !entryTxHashes) return null
  // Peer data: wrong types are a failed verification, never an exception into the caller.
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(x => typeof x === 'string')
  if (
    typeof winnerAddress !== 'string' ||
    typeof serverSeed !== 'string' ||
    !isStrings(entrants) ||
    !isStrings(entryTxHashes) ||
    (draw.entryPriceWei !== undefined && typeof draw.entryPriceWei !== 'string') ||
    (draw.potWei !== undefined && typeof draw.potWei !== 'string') ||
    (draw.serverSeedHash !== undefined && typeof draw.serverSeedHash !== 'string')
  ) {
    return { valid: false, reason: 'the draw is malformed' }
  }
  try {
    const announces = priorItems.filter(
      item =>
        item.raffleId === draw.raffleId &&
        item.action === 'announce' &&
        typeof item.serverSeedHash === 'string' &&
        item.serverSeedHash,
    )
    const committed = new Set(announces.map(item => item.serverSeedHash as string))
    if (committed.size === 0) return null
    if (committed.size > 1) {
      return { valid: false, reason: 'the round announced conflicting seed commitments' }
    }
    const [serverSeedHash] = committed
    if (draw.serverSeedHash !== undefined && draw.serverSeedHash !== serverSeedHash) {
      return {
        valid: false,
        reason: 'the draw names a different commitment than the one announced',
      }
    }
    const sizes = new Set(
      announces.map(item => item.maxEntries).filter((n): n is number => typeof n === 'number'),
    )
    if (sizes.size > 1) return { valid: false, reason: 'the round announced conflicting sizes' }
    const prices = new Set(
      announces.map(item => item.entryPriceWei).filter((p): p is string => typeof p === 'string'),
    )
    if (prices.size > 1) return { valid: false, reason: 'the round announced conflicting prices' }
    const problem = drawShapeProblem(draw, entrants, entryTxHashes, [...sizes][0], [...prices][0])
    if (problem) return { valid: false, reason: problem }
    const result = verifyRaffleDraw({
      serverSeed,
      serverSeedHash,
      entrants,
      entryTxHashes,
      winnerAddress,
    })
    // Without an announced round size the entrant count itself is not checked.
    return result.valid ? { ...result, countVerified: sizes.size === 1 } : result
  } catch {
    return { valid: false, reason: 'the draw could not be verified' }
  }
}
