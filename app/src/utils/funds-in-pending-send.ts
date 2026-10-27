import { fundsInPendingSend } from '@frank/wallet/evm-transaction-set-types'

/**
 * The words for a send the wallet refused because the money that would pay it is still in an
 * earlier send's change that has not reached the chain yet (`FundsInPendingSendError`, owner
 * ruling 2026-10-26): it is not queued, and the user tries again in a moment. Undefined for
 * any other failure. `format` turns the amount in wei into "0.05 MON".
 */
export function fundsInPendingSendMessage(
  error: unknown,
  format: (wei: bigint) => string,
  t: (key: string, params?: Record<string, unknown>) => string,
): string | undefined {
  const refusal = fundsInPendingSend(error)
  if (!refusal) return undefined
  return t('outgoing.reasonFundsInPendingSend', {
    amount: format(refusal.tiedUpWei),
  })
}

/** The same words from a failed message's saved reason, with the amount its `detail` kept
 * (wei, decimal) when there is one. */
export function fundsInPendingSendReasonText(
  detail: string | undefined,
  format: (wei: bigint) => string,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  return detail !== undefined && /^[1-9]\d*$/.test(detail)
    ? t('outgoing.reasonFundsInPendingSend', { amount: format(BigInt(detail)) })
    : t('outgoing.reasonFundsInPendingSendNoAmount')
}
