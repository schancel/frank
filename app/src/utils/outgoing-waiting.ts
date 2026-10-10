import { reactive } from 'vue'

/**
 * The outgoing messages (by store key) whose send is, right now, waiting for the account's
 * previous payment to be seen on chain before it can pay its own stamp. The chat store marks
 * them from the wallet's `waiting-for-payment` stage; the sending bubble shows it. This session's
 * memory only: it describes a send in flight, not the message.
 */
export const sendsWaitingForPreviousPayment = reactive(new Set<string>())

/** The outgoing messages whose send is queued because the chain's node cannot be reached:
 * nothing is claimed or signed for them, and they go on by themselves when it answers. */
export const sendsWaitingForChain = reactive(new Set<string>())

/** A send that is still waiting (for the chain, for an earlier payment, for its coin's block)
 * can be cancelled: nothing was signed for it. By the message's store key. */
const waitingSendAborts = new Map<string, AbortController>()

/** Registers a send as cancellable and returns its signal and the function that ends that. */
export function cancellableSend(id: string): {
  signal: AbortSignal
  done: () => void
} {
  const controller = new AbortController()
  waitingSendAborts.set(id, controller)
  return {
    signal: controller.signal,
    done: () => {
      if (waitingSendAborts.get(id) === controller) waitingSendAborts.delete(id)
      sendsWaitingForPreviousPayment.delete(id)
      sendsWaitingForChain.delete(id)
    },
  }
}

/** Cancels the waiting send of this message, if it has one. A send that has already signed
 * its payment is not affected. */
export function cancelWaitingSend(id: string): void {
  waitingSendAborts.get(id)?.abort()
}

/** The send of this message has ended, however: it is no longer cancellable or waiting. */
export function endWaitingSend(id: string): void {
  waitingSendAborts.delete(id)
  sendsWaitingForPreviousPayment.delete(id)
  sendsWaitingForChain.delete(id)
}
