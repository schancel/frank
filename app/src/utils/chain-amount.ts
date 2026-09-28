import { ActiveChain } from '@frank/wallet/chain'

type ChainAmountAdapter = Pick<
  ActiveChain,
  'unit' | 'fromDisplayAmount' | 'toDisplayAmount'
>

/**
 * Convert a display amount to the temporary number-backed topic model without silently losing
 * wei. The topic wire/model migration will replace this bridge with bigint end to end.
 */
export function displayToSafeRawAmount(
  chain: ChainAmountAdapter,
  display: string,
): number {
  const raw = chain.fromDisplayAmount(display)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Amount ${display} ${chain.unit} exceeds the forum's current exact-value limit`,
    )
  }
  return value
}

/** Convert a raw bigint to the temporary number-backed topic model without losing precision. */
export function rawToSafeNumber(
  chain: ChainAmountAdapter,
  raw: bigint,
): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `Raw ${chain.unit} amount exceeds the forum's current exact-value limit`,
    )
  }
  return value
}

/** Format an exactly represented raw topic amount in the active chain's display denomination. */
export function formatSafeRawAmount(
  chain: ChainAmountAdapter,
  raw: number,
): string {
  if (!Number.isSafeInteger(raw)) {
    throw new Error('Forum vote weight is not an exactly represented integer')
  }
  return `${chain.toDisplayAmount(BigInt(raw))} ${chain.unit}`
}
