/**
 * What every EVM exchange's swap shares, whatever its protocol: an encoded contract call, the
 * slippage floor on a quoted output, and the shape of a receipt log an outcome is read from.
 */

/** One contract call: where it goes, its calldata, and the native coin it pays. */
export interface EncodedCall {
  readonly to: string
  readonly data: string
  readonly value: bigint
}

/** Slippage the form accepts, in basis points. Above 50% a "minimum" protects nothing. */
export const MAX_SLIPPAGE_BPS = 5000

/** The least output the swap may deliver before it reverts. Rounds down, never to zero output. */
export function minimumOutput(amountOut: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > MAX_SLIPPAGE_BPS
  )
    throw new RangeError('Slippage must be between 0% and 50%')
  if (amountOut <= 0n) throw new RangeError('Quoted output must be positive')
  const minimum = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  return minimum > 0n ? minimum : 1n
}

/** A log of a transaction receipt, as an exchange reads its outcome from it. */
export interface ReceiptLog {
  readonly address: string
  readonly topics: readonly string[]
  readonly data: string
}
