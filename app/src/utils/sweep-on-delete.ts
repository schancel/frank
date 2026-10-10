import type { NativeWalletHandle, ReceivedCoinSweep } from '@frank/wallet/chain'
import { accountSession } from '../accounts/session'
import type { ChatMessage } from '../stores/chats'
import { errorNotify } from './notifications'

/**
 * Deleting a message must not lose money.
 *
 * Money a message brought (its stamp, a stealth payment) sits at one-time accounts that can only
 * be found again through the message. This device's wallet keeps their keys in its coin list, so
 * deleting the message loses nothing here; a wallet restored from the seed on another device would
 * never find them. So before a message is deleted, the wallet is asked, through its one typed
 * operation (`sweepReceivedCoins`), to move what is unspent to its seed-derived main account, and
 * only a message whose answer is `none` or `swept` may be deleted. A sweep that failed or is not
 * in a block yet keeps the message, with the reason.
 */
export interface DeleteClearance {
  /** Messages (by payload digest) that must stay, and why. Every other one may be deleted. */
  kept: Map<string, string>
}

/** Thrown by a delete that left messages in place because their money could not be moved. */
export class MessageFundsNotSweptError extends Error {
  constructor(readonly kept: ReadonlyMap<string, string>) {
    const reasons = [...new Set(kept.values())].join('; ')
    super(
      kept.size === 1
        ? `The message was not deleted: the money it brought could not be moved to your wallet's main account yet (${reasons}).`
        : `${kept.size} messages were not deleted: the money they brought could not be moved to your wallet's main account yet (${reasons}).`,
    )
    this.name = 'MessageFundsNotSweptError'
  }
}

/** A message that can have brought this wallet money: received, with a stamp or a stealth item. */
export function mayHoldCoins(message: ChatMessage): boolean {
  return (
    !message.outbound &&
    !message.payloadDigest.startsWith('pending:') &&
    ((message.stampPayments?.length ?? 0) > 0 ||
      message.items.some(item => item.type === 'stealth'))
  )
}

/**
 * Sweeps what the given messages brought and says which of them must stay. A message that cannot
 * have brought money needs no wallet and is never kept. If the wallet cannot be reached, or does
 * not answer for a message, that message stays.
 */
export async function sweepBeforeDelete(
  messages: readonly ChatMessage[],
  wallet?: NativeWalletHandle,
): Promise<DeleteClearance> {
  const kept = new Map<string, string>()
  const digests = [
    ...new Set(messages.filter(mayHoldCoins).map(m => m.payloadDigest)),
  ]
  if (digests.length === 0) return { kept }
  let answers: Record<string, ReceivedCoinSweep>
  try {
    const owner = wallet ?? (await accountSession.getWallet())
    // A wallet with no coin list holds no received coins: nothing to move.
    if (typeof owner.sweepReceivedCoins !== 'function') return { kept }
    answers = await owner.sweepReceivedCoins({ payloadDigests: digests })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    for (const digest of digests) kept.set(digest, reason)
    return { kept }
  }
  for (const digest of digests) {
    const answer = answers[digest]
    if (answer?.outcome === 'none' || answer?.outcome === 'swept') continue
    kept.set(digest, answer?.reason ?? 'the wallet gave no answer')
  }
  return { kept }
}

/**
 * A payment to a contact that an outgoing message carried, when that message is deleted: the
 * wallet brings it to an end. If no byte of it ever left the device it is released (its signed
 * transfer cancelled, the funds it held free again); if its bytes went to a relay it is finished
 * by the wallet (the contact may broadcast the transfer, so it is never released). Deleting the
 * message never waits on this and never fails for it: the wallet keeps finishing an exposed
 * payment by itself on its ordinary background pass.
 */
export async function settleOutgoingPayments(
  messages: readonly ChatMessage[],
  wallet?: NativeWalletHandle,
): Promise<void> {
  const keys = messages.flatMap(message =>
    message.outbound
      ? message.items.flatMap(item =>
          item.type === 'stealth' && item.ephemeralPubKey
            ? [item.ephemeralPubKey]
            : [],
        )
      : [],
  )
  if (keys.length === 0) return
  try {
    const owner = wallet ?? (await accountSession.getWallet())
    if (typeof owner.settleContactPayment !== 'function') return
    for (const key of keys) await owner.settleContactPayment(key)
  } catch (error) {
    console.warn('could not settle a payment of a deleted message', error)
  }
}

/**
 * A message whose payment the wallet released keeps the bubble and loses the signed transfer:
 * the stealth items stay (amount, memo) with no transaction in them. Such an item cannot be
 * encoded, so the message can never be sent again, by a retry or otherwise; the only copies of a
 * released transfer are then ones that never existed outside this device.
 */
export function stripReleasedPayments(message: ChatMessage): void {
  message.items = message.items.map(item =>
    item.type === 'stealth' ? { ...item, transactions: [] } : item,
  )
}

/** Shows why a delete left messages in place. The wallet's own reason goes to the console (it can
 * be a node's wording); the user gets the app's sentence. */
export function notifyDeleteFailure(error: unknown): void {
  errorNotify(
    error,
    error instanceof MessageFundsNotSweptError
      ? { fallbackKey: 'notifications.messagesKeptForFunds' }
      : {},
  )
}
