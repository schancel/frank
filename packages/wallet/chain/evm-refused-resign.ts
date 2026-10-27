/**
 * When a signed EVM transaction the node keeps refusing may be signed again, and how.
 *
 * A Monad node refuses a transaction whose sender's balance is younger than a few blocks
 * ("Signer had insufficient balance", docs/protocol/chains/monad-reserve-balance.md) and then
 * goes on refusing those exact bytes for minutes, long after the balance has matured, while a
 * different transaction of the same account at the same nonce is taken at once. Measured on
 * monad-solonet (client 0.16.4): bytes refused at the funding block were refused again 2, 6, 19
 * and 39 blocks later; the same transfer signed again at its nonce with only the tip one wei
 * lower was accepted at once and mined three blocks later.
 *
 * One rule for every wallet path that re-signs (DM stamp payments, Send to Address transaction
 * sets): sign the SAME transaction again at the same nonce. Only the tip changes, one wei lower
 * than the previous signing; the chain ID, nonce, recipient, value, data, gas limit and fee
 * ceiling (the most it can be charged) stay exactly as authorized. A nonce is consumed once, so
 * at most one of the signings can ever be mined: signing again can never pay twice, and never
 * costs more than the first signing could.
 */
import { Transaction } from 'ethers'

/** A transaction is signed again once the node has refused its bytes this often, */
export const REFUSALS_BEFORE_RESIGN = 2
/** over at least this long (what made the node refuse may pass in a few blocks: then the next
 * transaction is not refused for the same reason), */
export const RESIGN_AFTER_MS = { value: 3_000 }
/** and one transaction is signed at most this many times in all (the first signing included). */
export const MAX_SIGNINGS = 4

/**
 * The node answered and refused the transaction (an error of its own), as opposed to not
 * answering at all. What a second broadcaster of the same bytes is told ("already known",
 * "nonce too low") is not a refusal: whether those bytes landed is read from the chain.
 */
export function isNodeRefusal(error: unknown): boolean {
  const raised = error as {
    code?: unknown
    message?: unknown
    error?: { code?: unknown; message?: unknown }
    info?: { error?: { code?: unknown; message?: unknown } }
  }
  if (
    raised?.code === 'NETWORK_ERROR' ||
    raised?.code === 'TIMEOUT' ||
    raised?.code === 'SERVER_ERROR'
  )
    return false
  const text = [raised?.message, raised?.error?.message, raised?.info?.error?.message]
    .map(part => String(part ?? ''))
    .join(' ')
  if (
    /already known|known transaction|already imported|nonce too low|nonce has already been used/i.test(
      text,
    )
  )
    return false
  return (
    typeof raised?.error?.code === 'number' ||
    typeof raised?.info?.error?.code === 'number'
  )
}

/**
 * How often the running node has refused each signed transaction (by its bytes). Process
 * memory: a restart starts counting again, which only delays a re-signing.
 */
export class RefusalLedger {
  private readonly refusals = new Map<string, { count: number; sinceMs: number }>()

  /** Notes what the node said to `rawTx`: a refusal counts, anything else clears it. */
  note(rawTx: string, error?: unknown): void {
    if (error !== undefined && isNodeRefusal(error)) {
      const seen = this.refusals.get(rawTx)
      this.refusals.set(rawTx, {
        count: (seen?.count ?? 0) + 1,
        sinceMs: seen?.sinceMs ?? Date.now(),
      })
    } else this.refusals.delete(rawTx)
  }

  /** Whether `rawTx`, the newest of `signings` signings of one transaction, may be signed again
   * now: refused often enough, for long enough, and the transaction not yet signed too often. */
  due(rawTx: string, signings: number): boolean {
    const seen = this.refusals.get(rawTx)
    return (
      seen !== undefined &&
      seen.count >= REFUSALS_BEFORE_RESIGN &&
      Date.now() - seen.sinceMs >= RESIGN_AFTER_MS.value &&
      signings < MAX_SIGNINGS
    )
  }

  forget(rawTx: string): void {
    this.refusals.delete(rawTx)
  }
}

/** The fee ceiling of a transaction: the most it can be charged per gas. */
function ceilingOf(tx: Transaction): bigint {
  const ceiling = tx.type === 2 ? tx.maxFeePerGas : tx.gasPrice
  if (ceiling === null) throw new Error('The transaction has no fee')
  return ceiling
}

/**
 * The unsigned transaction to sign in place of `previous` (the newest signing of it): the same
 * transaction at the same nonce, as an EIP-1559 transaction whose fee ceiling is `previous`'s
 * and whose tip is one wei lower than `previous`'s (a legacy `gasPrice` is all tip). Throws when
 * the tip is already zero: nothing else may change.
 */
export function resignedTransaction(previous: Transaction): Transaction {
  if (previous.type !== 0 && previous.type !== 2)
    throw new Error(`A type ${previous.type} transaction is not signed again`)
  if (previous.chainId === 0n)
    throw new Error('A transaction without a chain ID is not signed again')
  const ceiling = ceilingOf(previous)
  const tip = previous.type === 2 ? previous.maxPriorityFeePerGas! : ceiling
  if (tip <= 0n) throw new Error('The transaction cannot be signed again: its tip is zero')
  return Transaction.from({
    type: 2,
    chainId: previous.chainId,
    nonce: previous.nonce,
    to: previous.to,
    value: previous.value,
    data: previous.data,
    gasLimit: previous.gasLimit,
    maxFeePerGas: ceiling,
    maxPriorityFeePerGas: tip - 1n,
  })
}

/**
 * Whether `later` is `earlier` signed again under {@link resignedTransaction}'s rule, possibly
 * more than once: the same chain, nonce, recipient, value, data, gas limit and fee ceiling, an
 * EIP-1559 transaction, and a lower tip.
 */
export function isResigningOf(earlier: Transaction, later: Transaction): boolean {
  const earlierTip = earlier.type === 2 ? earlier.maxPriorityFeePerGas : earlier.gasPrice
  return (
    (earlier.type === 0 || earlier.type === 2) &&
    later.type === 2 &&
    later.chainId === earlier.chainId &&
    later.nonce === earlier.nonce &&
    later.to?.toLowerCase() === earlier.to?.toLowerCase() &&
    later.value === earlier.value &&
    later.data === earlier.data &&
    later.gasLimit === earlier.gasLimit &&
    later.maxFeePerGas === ceilingOf(earlier) &&
    later.accessList?.length === 0 &&
    earlierTip !== null &&
    later.maxPriorityFeePerGas !== null &&
    later.maxPriorityFeePerGas < earlierTip
  )
}
