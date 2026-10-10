import { formatUnits, parseUnits } from 'ethers'

/** A typed amount in base units, or undefined when it is not a positive number that fits. */
export function parseTokenAmount(
  input: string,
  decimals: number,
): bigint | undefined {
  const text = input.trim()
  if (!/^\d*\.?\d*$/.test(text) || !/\d/.test(text)) return undefined
  const [, fraction = ''] = text.split('.')
  if (fraction.length > decimals) return undefined
  try {
    const value = parseUnits(text, decimals)
    return value > 0n ? value : undefined
  } catch {
    return undefined
  }
}

/** Every digit, for a tooltip or a confirmation. */
export function exactTokenAmount(amount: bigint, decimals: number): string {
  const text = formatUnits(amount, decimals)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/**
 * An amount for reading: at most `places` decimals, rounded down so a balance or a received
 * amount is never shown larger than it is, and a nonzero amount is never shown as zero.
 */
export function readableTokenAmount(
  amount: bigint,
  decimals: number,
  places = 6,
): string {
  const kept = Math.min(places, decimals)
  const unit = 10n ** BigInt(decimals - kept)
  const floored = (amount / unit) * unit
  if (floored === 0n && amount > 0n) return `<${formatUnits(unit, decimals)}`
  return exactTokenAmount(floored, decimals)
}

/** Parts per million as a percentage with two decimals; a nonzero value below that says so. */
export function readablePercent(ppm: number): string {
  if (ppm > 0 && ppm < 100) return '<0.01%'
  return `${(ppm / 10_000).toFixed(2)}%`
}

/** What one whole unit of the input buys at the quoted rate, in the output's base units. */
export function outputPerUnit(
  amountIn: bigint,
  amountOut: bigint,
  inputDecimals: number,
): bigint {
  return (amountOut * 10n ** BigInt(inputDecimals)) / amountIn
}
