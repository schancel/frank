import { activeChain } from '@frank/wallet/chain'

export type OwnAddressResult =
  | { address: string; error?: undefined }
  // `error` is set for an unexpected failure (e.g. a wallet handle of the wrong shape) and is
  // undefined when the wallet is simply not set up yet.
  | { address: null; error?: unknown }

/**
 * The current identity's canonical address (the same `formatAddress` form used as the
 * contact/chat store key), or `address: null` when it cannot be determined. Callers use it to
 * refuse adding the user as their own contact, so it fails open rather than blocking every add;
 * unexpected failures are additionally reported through `error` and `console.error`.
 */
export async function resolveOwnAddress(): Promise<OwnAddressResult> {
  try {
    // Loaded lazily: the wallet store opens its persistent UTXO database on import, which the
    // contact store (imported everywhere) must not do as a side effect.
    const { useActiveWallet } = await import('src/composables/useActiveWallet')
    let wallet
    try {
      wallet = await useActiveWallet()
    } catch {
      return { address: null } // wallet not initialized (no seed phrase yet)
    }
    return { address: activeChain.formatAddress(wallet.identity.address) }
  } catch (error) {
    console.error('Could not determine the own address:', error)
    return { address: null, error }
  }
}

export async function getOwnCanonicalAddress(): Promise<string | null> {
  return (await resolveOwnAddress()).address
}

/** Compares any two accepted spellings at the presentation/storage edge. */
export function sameCanonicalAddress(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  if (!first || !second) return false
  try {
    const firstParsed = activeChain.parseAddress(first)
    const secondParsed = activeChain.parseAddress(second)
    return (
      firstParsed !== null &&
      secondParsed !== null &&
      activeChain.formatAddress(firstParsed) ===
        activeChain.formatAddress(secondParsed)
    )
  } catch {
    return false
  }
}

/** True when `address` (any form the chain parses) is the current identity's own address. */
export async function isOwnAddress(address: string): Promise<boolean> {
  const own = await getOwnCanonicalAddress()
  return sameCanonicalAddress(address.trim(), own)
}
