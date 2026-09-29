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
 */
import * as forge from 'node-forge'

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
  hmac.start('sha256', serverSeed)
  hmac.update(combinedEntropy)
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
    return { valid: false, reason: 'serverSeed does not match the committed hash' }
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
    return { valid: false, reason: 'recomputed winner does not match the announced winner' }
  }
  return { valid: true }
}
