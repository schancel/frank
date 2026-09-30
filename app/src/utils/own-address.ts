import { activeChain } from '@frank/wallet/chain'

/**
 * The current identity's canonical address (the same `formatAddress` form used as the
 * contact/chat store key), or null when the wallet is not available. Callers use it to refuse
 * adding the user as their own contact, so an unavailable wallet fails open rather than
 * blocking every add.
 */
export async function getOwnCanonicalAddress(): Promise<string | null> {
  try {
    // Loaded lazily: the wallet store opens its persistent UTXO database on import, which the
    // contact store (imported everywhere) must not do as a side effect.
    const { useActiveWallet } = await import('src/composables/useActiveWallet')
    const wallet = await useActiveWallet()
    return activeChain.formatAddress(wallet.identity.address)
  } catch {
    return null
  }
}

/** True when `address` (any form the chain parses) is the current identity's own address. */
export async function isOwnAddress(address: string): Promise<boolean> {
  const own = await getOwnCanonicalAddress()
  if (own === null) {
    return false
  }
  try {
    const parsed = activeChain.parseAddress(address.trim())
    return parsed !== null && activeChain.formatAddress(parsed) === own
  } catch {
    return false
  }
}
