import { reactive } from 'vue'
import {
  activeChain,
  type DirectMessagePaymentSummary,
  type WalletHandle,
} from '@frank/wallet/chain'

/**
 * What the chain has shown of the payment of each recently sent paid message, by the message's
 * payload digest, in one word (`DirectMessagePaymentSummary`): what the sent bubble shows beside
 * its amount. A view of the wallet's own record (`paymentSummaryOf`), refreshed by the outgoing
 * tick; nothing here is saved, and nothing decides anything from it.
 */
export const outgoingPaymentSummaries = reactive(
  new Map<string, DirectMessagePaymentSummary>(),
)

/** How many blocks a send still has to wait before its coin may be spent (the chain's spacing
 * after the account's last transaction), by the message's store key, as the wallet last said. */
export const sendsWaitingBlocks = reactive(new Map<string, number>())

const FINAL = new Set<DirectMessagePaymentSummary>([
  'paid',
  'repaid',
  'failed',
  'unsent',
])
/** Messages older than this whose payment was never looked up are not looked up. */
export const PAYMENT_SUMMARY_WINDOW_MS = 60 * 60 * 1000

interface SentMessage {
  outbound: boolean
  status: string
  payloadDigest: string
  serverTime: number
  stampValueWei?: bigint
  delivery?: { attemptDigest?: string }
}

/**
 * Reads the wallet's word for each paid message sent in the last hour (and each one already
 * tracked that is not final). Returns how many are not final yet. Never throws: a wallet that
 * cannot answer changes nothing.
 */
export function refreshOutgoingPaymentSummaries(
  wallet: WalletHandle,
  messages: Iterable<SentMessage>,
  now = Date.now(),
): number {
  let open = 0
  for (const message of messages) {
    if (!message.outbound || (message.stampValueWei ?? 0n) <= 0n) continue
    const digest = message.delivery?.attemptDigest ?? message.payloadDigest
    if (digest.startsWith('pending:')) continue
    const known = outgoingPaymentSummaries.get(digest)
    if (known !== undefined && FINAL.has(known)) continue
    if (
      known === undefined &&
      now - message.serverTime > PAYMENT_SUMMARY_WINDOW_MS
    )
      continue
    let summary: DirectMessagePaymentSummary | undefined
    try {
      summary = activeChain.directMessages.paymentSummaryOf?.({
        wallet,
        payloadDigest: digest,
      })
    } catch {
      continue
    }
    if (summary === undefined) continue
    outgoingPaymentSummaries.set(digest, summary)
    if (!FINAL.has(summary)) open++
  }
  return open
}
