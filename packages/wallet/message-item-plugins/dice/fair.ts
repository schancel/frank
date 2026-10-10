/**
 * The dice game's rules and its fairness check, shared by the bot that rolls and the app that
 * verifies, so both use one derivation. Pure: no I/O.
 *
 * Protocol (see `SatoshiDiceItem`): the bot publishes `commitment = SHA-256(serverSecret)` before
 * the bet; the player's bet repeats it and adds a random `clientSeed`; the number rolled is the
 * first 16 bits of `HMAC-SHA256(key = serverSecret, message = clientSeed)`; the result reveals
 * `serverSecret`. The bot cannot choose the number (it committed before it saw the seed) and the
 * player cannot (it does not know the secret). One commitment is used for one roll.
 */
import * as forge from 'node-forge'

import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'

import { sha256Hex } from '../blackjack/deck'

export const DICE_MODULO = 65_536
export const DICE_DEFAULT_TARGET = 32_768
/** The house keeps 1.9%: a fair payout times 981/1000. */
const PAYOUT_NUMERATOR = 981n
const PAYOUT_DENOMINATOR = 1000n

const strip = (hex: string) => hex.replace(/^0x/, '').toLowerCase()

export function diceCommitment(serverSecret: string): string {
  return sha256Hex(strip(serverSecret))
}

/** The number rolled, 0..65535. */
export function diceRoll(serverSecret: string, clientSeed: string): number {
  const hmac = forge.hmac.create()
  hmac.start('sha256', strip(serverSecret))
  hmac.update(strip(clientSeed))
  return parseInt(hmac.digest().toHex().slice(0, 4), 16)
}

export function isDiceTarget(target: unknown): target is number {
  return (
    typeof target === 'number' &&
    Number.isInteger(target) &&
    target >= 1 &&
    target < DICE_MODULO
  )
}

/** What a winning roll under `target` pays for `wagerWei`, stake included. */
export function dicePayoutWei(wagerWei: bigint, target: number): bigint {
  return (
    (wagerWei * BigInt(DICE_MODULO) * PAYOUT_NUMERATOR) /
    (BigInt(target) * PAYOUT_DENOMINATOR)
  )
}

export function diceMultiplier(target: number): number {
  return Number(((DICE_MODULO * 0.981) / target).toFixed(4))
}

export type FairCheck = { ok: true } | { ok: false; reason: string }
const no = (reason: string): FairCheck => ({ ok: false, reason })

/**
 * Checks a `result` against the player's own `bet` (the `roll` item the player sent) and every
 * other result the player has from this bot. `ok` only if the bot rolled for the commitment and
 * seed the player bet on, the revealed secret opens that commitment, the number, the outcome and
 * the payout all follow from it, and the commitment was used for this roll alone.
 */
export function verifyDiceResult(
  result: SatoshiDiceItem,
  bet: SatoshiDiceItem | undefined,
  otherResults: readonly SatoshiDiceItem[] = [],
): FairCheck {
  if (!bet || bet.action !== 'roll' || !bet.rollId || bet.rollId !== result.rollId)
    return no('No bet of yours matches this result.')
  if (!bet.commitment || !bet.clientSeed || !isDiceTarget(bet.target))
    return no('Your bet named no commitment, seed or target.')
  if (!result.commitment || strip(result.commitment) !== strip(bet.commitment))
    return no('The result is for a different commitment than you bet on.')
  if (!result.clientSeed || strip(result.clientSeed) !== strip(bet.clientSeed))
    return no('The result does not use the random value you sent.')
  if (result.target !== bet.target)
    return no('The result uses a different target than you chose.')
  if (!result.serverSecret) return no('The bot did not reveal its secret.')
  if (diceCommitment(result.serverSecret) !== strip(bet.commitment))
    return no('The revealed secret does not match the commitment.')
  const rolled = diceRoll(result.serverSecret, bet.clientSeed)
  if (result.luckyNumber !== rolled)
    return no(`The secret and your value give ${rolled}, not the number shown.`)
  const won = rolled < bet.target
  if (result.isWin !== won) return no('The outcome shown is not what was rolled.')
  const wager = BigInt(bet.wagerWei ?? '0')
  if (BigInt(result.wagerWei ?? '0') !== wager)
    return no('The result is for a different stake than you bet.')
  const owed = won ? dicePayoutWei(wager, bet.target) : 0n
  if (BigInt(result.payoutWei ?? '0') !== owed)
    return no('The payout shown is not what the roll pays.')
  if (
    otherResults.some(
      other =>
        other !== result &&
        other.action === 'result' &&
        !!other.commitment &&
        strip(other.commitment) === strip(bet.commitment as string),
    )
  )
    return no('The bot used this commitment for more than one roll.')
  return { ok: true }
}
