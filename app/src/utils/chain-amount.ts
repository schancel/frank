import type { ActiveChain } from '@frank/wallet/chain'

type ChainAmountAdapter = Pick<
  ActiveChain,
  'unit' | 'fromDisplayAmount' | 'toDisplayAmount'
>

/** Forum paid inputs stay exact from the display parser to the wallet boundary. */
export function displayToRawAmount(
  chain: ChainAmountAdapter,
  display: string,
): bigint {
  return chain.fromDisplayAmount(display)
}

export function formatRawAmount(
  chain: ChainAmountAdapter,
  raw: string | bigint,
): string {
  return `${chain.toDisplayAmount(BigInt(raw))} ${chain.unit}`
}

/** Decimals kept for an amount of one unit or more. */
export const DISPLAY_MAX_DECIMALS = 4
/** Significant digits kept for an amount below one unit. */
export const DISPLAY_SIGNIFICANT_DIGITS = 4

/**
 * Shortens an exact decimal string ("0.86192379322624184") for reading. Display only: never feed
 * the result back into arithmetic, validation or an amount input.
 *
 * - one unit or more: at most `DISPLAY_MAX_DECIMALS` decimals;
 * - below one unit: the leading zeros plus `DISPLAY_SIGNIFICANT_DIGITS` significant digits, so a
 *   non-zero amount never reads as "0";
 * - digits are cut, never rounded up (a balance is never shown larger than it is), and trailing
 *   zeros are dropped ("1.0" reads "1").
 *
 * Text that is not a plain decimal number is returned unchanged.
 */
export function shortenDisplayAmount(exact: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(exact.trim())
  if (!match) return exact
  const [, sign, whole, fraction = ''] = match
  const firstDigit = fraction.search(/[1-9]/)
  const kept = /^0+$/.test(whole)
    ? firstDigit < 0
      ? ''
      : fraction.slice(0, firstDigit + DISPLAY_SIGNIFICANT_DIGITS)
    : fraction.slice(0, DISPLAY_MAX_DECIMALS)
  const decimals = kept.replace(/0+$/, '')
  const integer = whole.replace(/^0+(?=\d)/, '')
  if (decimals === '') return /^0+$/.test(integer) ? '0' : `${sign}${integer}`
  return `${sign}${integer}.${decimals}`
}

/** The one formatter for amounts a user reads (balances, stamps, bets, payouts, prices): the
 * shortened number without its unit. The exact value stays available through `formatRawAmount`,
 * which is what a `title` or a detail view shows. */
export function formatDisplayNumber(
  chain: Pick<ChainAmountAdapter, 'toDisplayAmount'>,
  raw: string | bigint,
): string {
  return shortenDisplayAmount(chain.toDisplayAmount(BigInt(raw)))
}

/** `formatDisplayNumber` with the chain's unit: "0.8619 MONT". */
export function formatDisplayAmount(
  chain: Pick<ChainAmountAdapter, 'unit' | 'toDisplayAmount'>,
  raw: string | bigint,
): string {
  return `${formatDisplayNumber(chain, raw)} ${chain.unit}`
}

/** SI prefixes the compact form may use, largest first, as powers of ten of the display unit. */
const COMPACT_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['G', 9],
  ['M', 6],
  ['k', 3],
  ['', 0],
  ['m', -3],
  ['μ', -6],
  ['n', -9],
  ['p', -12],
  ['f', -15],
  ['a', -18],
]

/**
 * The compact form of an exact decimal string, for places where space is tight (lists, chips,
 * table cells). It is the full form (`shortenDisplayAmount`: digits cut, never rounded) with its
 * decimal point moved to an SI prefix ("0.02271" reads "22.71" with prefix "m"), so one amount
 * never shows different digits in two places; a large amount is then cut once more to the same
 * limit ("1234.5678" reads "1.2345" with prefix "k"). Text that is not a plain decimal number is
 * returned unchanged with no prefix.
 */
export function compactDisplayNumber(exact: string): {
  number: string
  prefix: string
} {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(
    shortenDisplayAmount(exact.trim()),
  )
  if (!match) return { number: exact, prefix: '' }
  const [, sign, wholeRaw, fraction = ''] = match
  const whole = wholeRaw.replace(/^0+/, '')
  const digits = whole + fraction
  const first = digits.search(/[1-9]/)
  if (first < 0) return { number: '0', prefix: '' }
  // The value is at least 10^magnitude and below 10^(magnitude + 1).
  const magnitude = whole.length - 1 - first
  const [prefix, power] =
    COMPACT_PREFIXES.find(([, p]) => p <= magnitude) ??
    COMPACT_PREFIXES[COMPACT_PREFIXES.length - 1]
  const point = whole.length - power
  const scaled =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`
  return { number: shortenDisplayAmount(sign + scaled), prefix }
}

/** The compact twin of `formatDisplayAmount`: "20 mMONT" where that reads "0.02 MONT". */
export function formatCompactAmount(
  chain: Pick<ChainAmountAdapter, 'unit' | 'toDisplayAmount'>,
  raw: string | bigint,
): string {
  const { number, prefix } = compactDisplayNumber(
    chain.toDisplayAmount(BigInt(raw)),
  )
  return `${number} ${prefix}${chain.unit}`
}

/** `formatCompactAmount` for an amount that already arrives as "<exact number> <unit>" text
 * (the multichain balance observations). Anything else (a status line) is returned unchanged. */
export function compactAmountText(text: string): string {
  const match = /^(-?\d+(?:\.\d+)?)\s*(\S.*)?$/.exec(text.trim())
  if (!match) return text
  const { number, prefix } = compactDisplayNumber(match[1])
  return `${number} ${prefix}${match[2] ?? ''}`.trim()
}
