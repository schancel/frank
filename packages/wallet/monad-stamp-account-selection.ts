/** Greedy Stamp-style selection over independently funded Monad sender accounts. */

export interface StampAccountCapacity {
  index: number
  address: string
  /** Spendable payment value after reserving this account's maximum transaction fee. */
  capacityWei: bigint
}

export interface SelectedStampAccount extends StampAccountCapacity {
  paymentValueWei: bigint
}

/**
 * Mirrors Stamp's greatest-lower-bound/smallest-upper-bound UTXO selection, treating each
 * single-use EVM account as one independently spendable coin. `desiredMinimumTransactions` is a
 * shaping goal only: a single upper-bound account may satisfy the whole amount, and the result is
 * valid whenever its values sum to `amountWei`.
 */
export function selectStampAccounts(params: {
  amountWei: bigint
  accounts: StampAccountCapacity[]
  desiredMinimumTransactions?: number
}): SelectedStampAccount[] {
  if (params.amountWei <= BigInt(0)) {
    throw new Error(`Stamp amount must be positive, got ${params.amountWei}`)
  }
  const desiredMinimumTransactions = params.desiredMinimumTransactions ?? 2
  if (
    !Number.isInteger(desiredMinimumTransactions) ||
    desiredMinimumTransactions < 1
  ) {
    throw new Error(
      `desiredMinimumTransactions must be a positive integer, got ${desiredMinimumTransactions}`,
    )
  }

  const accounts = params.accounts
    .filter(account => account.capacityWei > BigInt(0))
    .sort((a, b) =>
      a.capacityWei === b.capacityWei
        ? a.index - b.index
        : a.capacityWei < b.capacityWei
        ? -1
        : 1,
    )
  const totalCapacity = accounts.reduce(
    (sum, account) => sum + account.capacityWei,
    BigInt(0),
  )
  if (totalCapacity < params.amountWei) {
    throw new Error(
      `Insufficient stamp-account capacity: need ${params.amountWei} wei, have ${totalCapacity} wei`,
    )
  }

  const divisor = BigInt(desiredMinimumTransactions)
  const maximumPreferredCoin =
    (params.amountWei + divisor - BigInt(1)) / divisor
  const selected: SelectedStampAccount[] = []
  let remaining = params.amountWei

  while (remaining > BigInt(0)) {
    const requisite =
      remaining < maximumPreferredCoin ? remaining : maximumPreferredCoin
    const lowerBounds = accounts.filter(
      account => account.capacityWei < requisite,
    )
    const account =
      lowerBounds.length > 0 ? lowerBounds[lowerBounds.length - 1] : accounts[0]
    if (account === undefined) {
      throw new Error('Stamp-account selection exhausted its candidates')
    }
    accounts.splice(
      accounts.findIndex(candidate => candidate.index === account.index),
      1,
    )
    const paymentValueWei =
      account.capacityWei < remaining ? account.capacityWei : remaining
    selected.push({ ...account, paymentValueWei })
    remaining -= paymentValueWei
  }

  return selected
}
