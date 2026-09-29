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
}): Promise<number> {
  const maxIndex = params.maxIndex ?? DEFAULT_MAX_SUB_ACCOUNT_INDEX_SEARCH
  if (!Number.isSafeInteger(maxIndex) || maxIndex < 1) {
    throw new Error(`maxIndex must be a positive safe integer, got ${maxIndex}`)
  }
  const usedAt = (index: number): Promise<boolean> =>
    isSubAccountIndexUsed(
      params.provider,
      params.keyring.deriveSubAccount(index).address
    )
  if (!(await usedAt(0))) return 0
  let lo = 0
  let hi = 1
  while (await usedAt(hi)) {
    lo = hi
    hi *= 2
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
