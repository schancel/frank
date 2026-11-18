/**
 * Giving up a contract call whose bytes were already handed out (a swap past its deadline): a
 * plain transfer of nothing from the same account to itself at the same nonce, with fees high
 * enough that a node replaces the call with it. Whichever of the two the chain includes takes
 * the nonce; the other can then never land. A cancellation is no proof the call did not land:
 * only the chain says which one did.
 */
import { Transaction } from 'ethers'

/** Gas of a plain transfer to an account with no code (the account itself). */
export const CANCELLATION_GAS = 21_000n

/** The bump a node requires to replace a pending transaction: 10 % on each fee, rounded up. */
const bumped = (fee: bigint): bigint => fee + (fee + 9n) / 10n

/**
 * The unsigned cancellation of `call` (signed, EIP-1559) from `from`, at fees no lower than the
 * replacement bump over the call's own and no lower than the network asks now (`current`).
 * Undefined when that would cost more, at most, than the call itself was allowed to: the
 * account never pays more to give the call up than it agreed to pay for it.
 */
export function cancellationOf(
  call: Transaction,
  from: string,
  current: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
): Transaction | undefined {
  if (call.type !== 2 || call.maxFeePerGas === null || call.maxPriorityFeePerGas === null)
    return undefined
  const maxPriorityFeePerGas = [
    bumped(call.maxPriorityFeePerGas),
    current.maxPriorityFeePerGas,
  ].reduce((a, b) => (a > b ? a : b))
  const maxFeePerGas = [
    bumped(call.maxFeePerGas),
    current.maxFeePerGas,
    maxPriorityFeePerGas,
  ].reduce((a, b) => (a > b ? a : b))
  const cancel = Transaction.from({
    type: 2,
    chainId: call.chainId,
    nonce: call.nonce,
    to: from,
    value: 0n,
    data: '0x',
    gasLimit: CANCELLATION_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  return isCancellationOf(call, cancel, from) ? cancel : undefined
}

/**
 * Whether `cancel` gives up `call` under {@link cancellationOf}'s rule: the same chain and nonce,
 * nothing sent to the sender itself, the replacement bump on both fees, and a maximum fee no
 * higher than the call's.
 */
export function isCancellationOf(
  call: Transaction,
  cancel: Transaction,
  from: string,
): boolean {
  return (
    call.type === 2 &&
    cancel.type === 2 &&
    call.maxFeePerGas !== null &&
    call.maxPriorityFeePerGas !== null &&
    cancel.maxFeePerGas !== null &&
    cancel.maxPriorityFeePerGas !== null &&
    cancel.chainId === call.chainId &&
    cancel.nonce === call.nonce &&
    cancel.to?.toLowerCase() === from.toLowerCase() &&
    cancel.value === 0n &&
    cancel.data === '0x' &&
    cancel.gasLimit === CANCELLATION_GAS &&
    cancel.accessList?.length === 0 &&
    cancel.maxPriorityFeePerGas >= bumped(call.maxPriorityFeePerGas) &&
    cancel.maxFeePerGas >= bumped(call.maxFeePerGas) &&
    cancel.maxFeePerGas >= cancel.maxPriorityFeePerGas &&
    cancel.gasLimit * cancel.maxFeePerGas <= call.gasLimit * call.maxFeePerGas
  )
}
