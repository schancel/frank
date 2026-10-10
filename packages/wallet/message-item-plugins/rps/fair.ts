/**
 * Rock-paper-scissors rules and the fairness check, shared by the bot and the app. Pure.
 *
 * The bot commits to its move first: `commitHash = SHA-256("<move>:<salt>")`, published in its
 * `start` item under a `matchId`. The player's `move` item names that `matchId` and repeats the
 * `commitHash`; the `resolve` item reveals the move and the salt.
 */
import type { RpsItem } from '@frank/cashweb/types/messages'

import { sha256Hex } from '../blackjack/deck'
import type { FairCheck } from '../dice/fair'

export type RpsMove = 'rock' | 'paper' | 'scissors'
export const RPS_MOVES: readonly RpsMove[] = ['rock', 'paper', 'scissors']

const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()
const no = (reason: string): FairCheck => ({ ok: false, reason })

export function rpsCommitment(move: RpsMove, salt: string): string {
  return sha256Hex(`${move}:${salt}`)
}

/** The player's outcome. */
export function evaluateRps(
  player: RpsMove,
  bot: RpsMove,
): 'win' | 'lose' | 'tie' {
  if (player === bot) return 'tie'
  return (player === 'rock' && bot === 'scissors') ||
    (player === 'paper' && bot === 'rock') ||
    (player === 'scissors' && bot === 'paper')
    ? 'win'
    : 'lose'
}

/** A win pays twice the stake, a tie returns it, a loss pays nothing. */
export function rpsPayoutWei(
  wagerWei: bigint,
  outcome: 'win' | 'lose' | 'tie',
): bigint {
  return outcome === 'win' ? wagerWei * 2n : outcome === 'tie' ? wagerWei : 0n
}

/** Checks a `resolve` of a match the player played by typing its move (so for nothing, and with
 * no `move` item of its own) against the bot's own earlier `start`: the revealed move and salt
 * must open the commitment the bot sent first, and the outcome must follow. */
export function verifyRpsTypedResult(
  result: RpsItem,
  start: RpsItem | undefined,
): FairCheck {
  if (!start || start.action !== 'start' || !start.matchId || start.matchId !== result.matchId)
    return no('The bot sent no commitment for this match before its result.')
  if (BigInt(result.wagerWei ?? '0') !== 0n)
    return no('No move of yours matches this result.')
  if (!start.commitHash || !result.commitHash || strip(result.commitHash) !== strip(start.commitHash))
    return no('The result is for a different commitment than the bot sent first.')
  if (!result.botMove || !result.secretSalt || !result.playerMove)
    return no('The bot did not reveal its move and salt.')
  if (rpsCommitment(result.botMove, result.secretSalt) !== strip(start.commitHash))
    return no('The revealed move does not match the commitment.')
  if (result.outcome !== evaluateRps(result.playerMove, result.botMove))
    return no('The outcome shown is not what the moves give.')
  return { ok: true }
}

/** Checks a `resolve` against the player's own `move` item for that match: the revealed move and
 * salt must open the commitment the player answered, and the outcome must follow. */
export function verifyRpsResult(
  result: RpsItem,
  mine: RpsItem | undefined,
): FairCheck {
  if (!mine || mine.action !== 'move' || !mine.matchId || mine.matchId !== result.matchId)
    return no('No move of yours matches this result.')
  if (!mine.commitHash || !mine.playerMove)
    return no('Your move named no commitment.')
  if (!result.commitHash || strip(result.commitHash) !== strip(mine.commitHash))
    return no('The result is for a different commitment than you answered.')
  if (result.playerMove !== mine.playerMove)
    return no('The result does not use the move you made.')
  if (!result.botMove || !result.secretSalt)
    return no('The bot did not reveal its move and salt.')
  if (rpsCommitment(result.botMove, result.secretSalt) !== strip(mine.commitHash))
    return no('The revealed move does not match the commitment.')
  if (result.outcome !== evaluateRps(mine.playerMove, result.botMove))
    return no('The outcome shown is not what the moves give.')
  if (BigInt(result.wagerWei ?? '0') !== BigInt(mine.wagerWei ?? '0'))
    return no('The result is for a different stake than you bet.')
  return { ok: true }
}
