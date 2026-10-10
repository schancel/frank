import { reactive } from 'vue'

/**
 * The outgoing messages (by store key) whose send is, right now, waiting for the account's
 * previous payment to be seen on chain before it can pay its own stamp. The chat store marks
 * them from the wallet's `waiting-for-payment` stage; the sending bubble shows it. This session's
 * memory only: it describes a send in flight, not the message.
 */
export const sendsWaitingForPreviousPayment = reactive(new Set<string>())
