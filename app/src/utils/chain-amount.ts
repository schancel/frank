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

/**
 * Formats a raw chain amount compactly using standard SI prefixes:
 * G (10^9), M (10^6), k (10^3), base (1), m (10^-3), μ (10^-6), n (10^-9), p (10^-12), f (10^-15), a (10^-18).
 *
 * For example:
 * 10^12 wei (10^-6 MONT) -> "1 μMONT"
 * 10^15 wei (10^-3 MONT) -> "1 mMONT"
 * 2.5 * 10^12 wei -> "2.5 μMONT"
 * 0 wei -> "0 MONT"
 */
export function formatCompactAmount(
  chain: ChainAmountAdapter,
  raw: string | bigint,
  maxFractionDigits = 3,
): string {
  const value = BigInt(raw)
  if (value === 0n) return `0 ${chain.unit}`

  const negative = value < 0n
  const abs = negative ? -value : value
  const sign = negative ? '-' : ''

  // 1 display unit in raw wei (e.g. 10^18)
  const oneUnit = chain.fromDisplayAmount('1')

  const scales: Array<{ prefix: string; rawThreshold: bigint }> = [
    { prefix: 'G', rawThreshold: oneUnit * 1_000_000_000n },
    { prefix: 'M', rawThreshold: oneUnit * 1_000_000n },
    { prefix: 'k', rawThreshold: oneUnit * 1_000n },
    { prefix: '', rawThreshold: oneUnit },
    { prefix: 'm', rawThreshold: oneUnit / 1_000n },
    { prefix: 'μ', rawThreshold: oneUnit / 1_000_000n },
    { prefix: 'n', rawThreshold: oneUnit / 1_000_000_000n },
    { prefix: 'p', rawThreshold: oneUnit / 1_000_000_000_000n },
    { prefix: 'f', rawThreshold: oneUnit / 1_000_000_000_000_000n },
    { prefix: 'a', rawThreshold: 1n },
  ]

  let chosen = scales[scales.length - 1]
  for (const scale of scales) {
    if (scale.rawThreshold > 0n && abs >= scale.rawThreshold) {
      chosen = scale
      break
    }
  }

  const divisor = chosen.rawThreshold > 0n ? chosen.rawThreshold : 1n
  const whole = abs / divisor
  const remainder = abs % divisor

  if (remainder === 0n || maxFractionDigits <= 0) {
    return `${sign}${whole} ${chosen.prefix}${chain.unit}`
  }

  const factor = 10n ** BigInt(maxFractionDigits)
  const frac = (remainder * factor) / divisor
  if (frac === 0n) {
    return `${sign}${whole} ${chosen.prefix}${chain.unit}`
  }

  const fracStr = frac
    .toString()
    .padStart(maxFractionDigits, '0')
    .replace(/0+$/, '')

  return `${sign}${whole}.${fracStr} ${chosen.prefix}${chain.unit}`
}
