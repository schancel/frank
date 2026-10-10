/**
 * The limits the CBOR item plugins share, each chosen from what the app and the bots produce today
 * with room to spare. A value outside them is refused when an item is written and when it is read.
 */
import {
  decimal,
  hex,
  int,
  listOf,
  str,
  token,
  type Field,
} from './cbor-fields'

/** A table, round, match, roll, swap or instance identifier. Producers write 16 or 32 hex
 * characters, a UUID (36), or `inst-<id>-<time>`; 64 characters covers all of them. */
export const id: Field<string> = token(64)

/** A commitment or its opened secret as hex: producers write 16 bytes (a salt or server secret)
 * or 32 bytes (a seed). */
export const secret: Field<string> = hex(8, 64)

/** A short line a bot or person wrote (an error, a hand description). */
export const note: Field<string> = str(1024)

/** A card index in a 52-card deck. */
export const card: Field<number> = int(0, 51)
/** A card index, or -1 for a card that is face down or not dealt. */
export const cardOrHidden: Field<number> = int(-1, 51)
/** A face of a six-sided die. */
export const dieFace: Field<number> = int(1, 6)

/** Seats at one table. The bots seat 4 (liar's dice) and up to 9 (poker). */
export const MAX_PLAYERS = 16
/** Dice one player holds. The bot deals 5. */
export const MAX_DICE_PER_PLAYER = 10
/** Dice on a whole table: the largest quantity a bid or a count can name. */
export const MAX_TABLE_DICE = MAX_PLAYERS * MAX_DICE_PER_PLAYER
/** Play-money chips. The poker bot starts each seat with 1,000. */
export const chips: Field<number> = int(0, 1_000_000_000_000)
/** Entries in one raffle round. The bot's default is 5. */
export const MAX_RAFFLE_ENTRIES = 1000
/** A dice target or roll: the dice bot rolls 16 bits. */
export const diceRoll: Field<number> = int(0, 65_535)
/** A payout multiplier: at most 65,536 * 0.981 for the smallest target. */
export const multiplier: Field<number> = decimal(0, 65_536)
/** A nonce or output index of an account or transaction. */
export const nonce: Field<number> = int(0, Number.MAX_SAFE_INTEGER)
export const outputIndex: Field<number> = int(0, 4_294_967_295)

export const players = <T>(of: Field<T>): Field<T[]> => listOf(of, MAX_PLAYERS)
