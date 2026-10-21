import type { NativeWalletHandle } from '@frank/wallet/chain'
import { accountSession } from '../accounts/session'
import { peekOpenedEvmWallets } from '../accounts/evm-wallets'
import type {
  ChainAmount,
  VerifiedMessageReceipts,
} from '../stores/chats-domain'

/** The account's wallets that are open now, one per canonical chain. Opens nothing. */
function openWallets(): NativeWalletHandle[] {
  const byChain = new Map<string, NativeWalletHandle>()
  const primary = accountSession.peekWallet()
  if (primary) byChain.set(primary.chainIdentifier, primary)
  for (const { wallet } of peekOpenedEvmWallets())
    if (!byChain.has(wallet.chainIdentifier))
      byChain.set(wallet.chainIdentifier, wallet)
  return Array.from(byChain.values())
}

/** A message digest as the wallet keys its coins: bare lower-case hex. */
const digestKey = (payloadDigest: string) =>
  payloadDigest.replace(/^0x/, '').toLowerCase()

/**
 * A reader of what the open wallets saw arrive on chain for a message's content payments
 * (stealth transfers), matched by the message's payloadDigest, each on its wallet's canonical
 * chain. Each wallet's coins are read once, here, from memory: no request is made, and looking
 * up any number of messages afterwards costs nothing more. A payment only claimed adds nothing;
 * a wallet that cannot tell (closed, or a chain without this list) adds nothing either. Take a
 * new reader to see newer wallet state.
 */
export function verifiedReceiptsReader(): VerifiedMessageReceipts {
  let wallets: NativeWalletHandle[]
  try {
    wallets = openWallets()
  } catch {
    // No session to ask: nothing verified.
    return () => []
  }
  const byDigest = new Map<string, ChainAmount[]>()
  for (const wallet of wallets) {
    const received = new Map<string, bigint>()
    try {
      for (const payment of wallet.getReceivedPayments?.() ?? []) {
        // As the wallet's own message summary counts content: shown arriving, or in part.
        if (payment.origin !== 'stealth' || !payment.payloadDigest) continue
        if (payment.status !== 'received' && payment.partial !== true) continue
        const amount = payment.receivedAmountWei ?? 0n
        if (amount <= 0n) continue
        const key = digestKey(payment.payloadDigest)
        received.set(key, (received.get(key) ?? 0n) + amount)
      }
    } catch {
      // A wallet that cannot answer now verified nothing.
      continue
    }
    for (const [key, baseUnits] of Array.from(received)) {
      const list = byDigest.get(key) ?? []
      list.push({ chainIdentifier: wallet.chainIdentifier, baseUnits })
      byDigest.set(key, list)
    }
  }
  return payloadDigest => byDigest.get(digestKey(payloadDigest)) ?? []
}
