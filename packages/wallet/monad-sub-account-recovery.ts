import type { Provider } from 'ethers'

import type { MonadHdKeyring } from './monad-hd-keyring'

export const DEFAULT_MAX_SUB_ACCOUNT_INDEX_SEARCH = 2 ** 20

export async function isSubAccountIndexUsed(
  provider: Provider,
  address: string
): Promise<boolean> {
  const [nonce, balance] = await Promise.all([
    provider.getTransactionCount(address),
    provider.getBalance(address),
  ])
  return nonce > 0 || balance > BigInt(0)
}

/** Seed-only sender-branch discovery. Allocation is monotonic, so this uses exponential search
 * plus bisection and never materializes or spreads the derivation history. RPC failure propagates
 * without returning a guess. */
export async function recoverNextSubAccountIndex(params: {
  keyring: MonadHdKeyring
  provider: Provider
  maxIndex?: number
  /** First allocatable index. Restored roots reserve index 0, so they search from 1. */
  minimumIndex?: number
}): Promise<number> {
  const maxIndex = params.maxIndex ?? DEFAULT_MAX_SUB_ACCOUNT_INDEX_SEARCH
  const minimumIndex = params.minimumIndex ?? 0
  if (!Number.isSafeInteger(maxIndex) || maxIndex < 1) {
    throw new Error(`maxIndex must be a positive safe integer, got ${maxIndex}`)
  }
  if (
    !Number.isSafeInteger(minimumIndex) ||
    minimumIndex < 0 ||
    minimumIndex >= maxIndex
  ) {
    throw new Error(`minimumIndex must be within the bounded search range`)
  }
  const usedAt = (index: number): Promise<boolean> =>
    isSubAccountIndexUsed(
      params.provider,
      params.keyring.deriveSubAccount(index).address
    )
  if (!(await usedAt(minimumIndex))) return minimumIndex
  let lo = minimumIndex
  let hi = minimumIndex + 1
  while (await usedAt(hi)) {
    lo = hi
    hi = minimumIndex + (hi - minimumIndex) * 2
    if (hi > maxIndex) {
      throw new Error(
        `recoverNextSubAccountIndex: every index up to ${maxIndex} appears used`
      )
    }
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (await usedAt(mid)) lo = mid
    else hi = mid
  }
  return hi
}
