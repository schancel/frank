/**
 * The smallest stake a game takes, and the smallest price a shop or raffle asks: never less than
 * TWICE the payment floor (`chain/payment-floor.ts`: ten times what the chain charges to move a
 * coin, the wallet's `minimumStamp`). The floor moves with the gas price between a bet and its
 * refund or payout; at twice the floor an amount taken now can still be paid back after the fee
 * has risen by anything short of doubling.
 *
 * One rule for both sides of a game: the bot states and enforces it (`packages/bot`, `money.ts`
 * `tableMinimumWei`), and the app's game cards offer no stake below it, from the same floor read
 * from their own wallet.
 */

/** How many payment floors the smallest stake is worth. */
export const STAKE_FLOOR_MULTIPLE = 2n

/** The smallest nonzero stake at `paymentFloorWei`, or what was configured if that is more.
 * Zero only when the floor is not known (zero) and nothing was configured. */
export function stakeMinimumWei(
  paymentFloorWei: bigint,
  configuredWei: bigint = 0n,
): bigint {
  if (paymentFloorWei < 0n) throw new RangeError('Payment floor must be nonnegative')
  const minimum = STAKE_FLOOR_MULTIPLE * paymentFloorWei
  return minimum > configuredWei ? minimum : configuredWei
}

/** Whether a stake is one a game may take: free (zero), or at least the minimum. */
export function stakeAllowed(stakeWei: bigint, minimumWei: bigint): boolean {
  return stakeWei === 0n || stakeWei >= minimumWei
}
