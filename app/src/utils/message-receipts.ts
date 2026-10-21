import type { NativeWalletHandle } from '@frank/wallet/chain'
import { accountSession } from '../accounts/session'
import { peekOpenedEvmWallets } from '../accounts/evm-wallets'
import type { ChainAmount } from '../stores/chats-domain'

/** The account's wallets that are open now, one per canonical chain. Opens nothing. */
function openWallets(): NativeWalletHandle[] {
  const byChain = new Map<string, NativeWalletHandle>()
  const primary = accountSession.peekWallet()
  if (primary) byChain.set(primary.chainIdentifier, primary)
  for (const { wallet } of peekOpenedEvmWallets())
    if (!byChain.has(wallet.chainIdentifier))
      byChain.set(wallet.chainIdentifier, wallet)
  return [...byChain.values()]
}

/**
 * What the open wallets saw arrive on chain for a message's content payments (stealth
 * transfers), matched by the message's payloadDigest, each on its wallet's canonical chain.
 * From what each wallet last read: no request is made. A payment only claimed adds nothing; a
 * wallet that cannot tell (closed, or a chain without this check) adds nothing either.
 */
export function verifiedMessageReceipts(payloadDigest: string): ChainAmount[] {
  let wallets: NativeWalletHandle[]
  try {
    wallets = openWallets()
  } catch {
    // No session to ask: nothing verified.
    return []
  }
  const receipts: ChainAmount[] = []
  for (const wallet of wallets) {
    try {
      const received =
        wallet.getMessagePayment?.(payloadDigest).contentReceivedWei ?? 0n
      if (received > 0n)
        receipts.push({
          chainIdentifier: wallet.chainIdentifier,
          baseUnits: received,
        })
    } catch {
      // A wallet that cannot answer now verified nothing.
    }
  }
  return receipts
}
