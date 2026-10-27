import type { EvmNativeOperationStatus } from '@frank/wallet/chain'

/**
 * How far a send the wallet is still carrying out has got: how many of its transactions are
 * in a block, of how many. Undefined when the operation is not in that state.
 *
 * A transaction set (a Send max, or a transfer gathered from several coins) sends its funding
 * first and its payment once the funding has landed. Until then the payment has not been sent,
 * so the journal knows nothing about it on the chain (`unknown`), and the operation's outcome is
 * `unknown`, which reads "unresolved, funds may have moved". That is not an ambiguous outcome
 * when every transaction is either in a block, waiting in the mempool, being offered again, or
 * not yet sent. Only a transaction that was sent and whose fate the chain could not tell (or a
 * reverted or replaced one) leaves the outcome open, and then its own wording stays. Every other
 * outcome (`partial`, `pending`, …) already says what is known, and keeps its line.
 *
 * Presentation only: the journal's outcome and its reconciliation are unchanged.
 */
export function nativeOperationProgress(
  operation: Pick<EvmNativeOperationStatus, 'payment' | 'members'>,
): { confirmed: number; total: number } | undefined {
  if (operation.payment !== 'unknown') return undefined
  const { members } = operation
  if (members.length === 0) return undefined
  const underWay = members.every(
    member =>
      member.state === 'included-success' ||
      member.state === 'pending' ||
      member.state === 'missing' ||
      (member.state === 'unknown' && !member.submitted),
  )
  if (!underWay) return undefined
  return {
    confirmed: members.filter(member => member.state === 'included-success')
      .length,
    total: members.length,
  }
}

/** The line that states an operation's outcome, as a translation key and its parameters. */
export function nativeOperationOutcome(
  operation: Pick<EvmNativeOperationStatus, 'payment' | 'members'> | undefined,
  network: string,
): { key: string; params: Record<string, string | number> } {
  const progress = operation && nativeOperationProgress(operation)
  if (progress)
    return { key: 'nativeOperation.sending', params: { ...progress, network } }
  return {
    key: `nativeOperation.${operation?.payment ?? 'unknown'}`,
    params: { network },
  }
}
