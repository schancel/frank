import type { DirectMessagePreparationProgress } from '@frank/wallet/chain'

type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * User-facing text for the stamp/burn-account preparation stages a send, topic post or vote goes
 * through before its own transaction (ticket #273). `formatFee` renders the raw fee reserve in the
 * chain's display unit so this stays free of chain imports.
 */
export function stampPreparationStatus(
  progress: DirectMessagePreparationProgress,
  t: Translate,
  fee: { format: (raw: bigint) => string; unit: string },
): string {
  if (progress.stage === 'checking') return t('stampPreparation.checking')
  if (progress.stage === 'funding') {
    return t('stampPreparation.funding', {
      completed: progress.completed,
      total: progress.total,
      feeReserve: fee.format(progress.feeReserveWei),
      unit: fee.unit,
    })
  }
  return t('stampPreparation.ready')
}
