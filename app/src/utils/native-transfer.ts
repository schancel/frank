import {
  activeChain,
  getChainRegistryEntry,
  resolveNetworkId,
  type NativeAssetChain,
  type ChainAddress,
} from '@frank/wallet/chain'

/**
 * The canonical chain a wallet row can send on, or undefined when Send is not offered there.
 * Decided by the registry's wallet setting, not by a list of names. Wallet-page aliases are
 * resolved here once; Send's route carries only canonical identifiers.
 */
export function nativeSendChainIdentifier(
  wallet: string,
  isTestnet: boolean,
): string | undefined {
  const entry = getChainRegistryEntry(resolveNetworkId(wallet, isTestnet))
  if (!entry?.wallet?.send) return undefined
  // The only EVM wallet the app builds is the active chain's.
  if (entry.family === 'evm' && entry.id !== activeChain.chainIdentifier)
    return undefined
  return entry.id
}

export interface ParsedNativeTransfer {
  recipient: ChainAddress
  value: bigint
}

/** Parses the two user-controlled fields before any signer or RPC client is invoked. */
export function parseNativeTransferInput(
  chain: NativeAssetChain,
  address: string,
  amount: string,
): ParsedNativeTransfer | undefined {
  const recipient = chain.parseAddress(address.trim())
  if (!recipient) return undefined

  try {
    const value = chain.fromDisplayAmount(amount.trim())
    return value > 0n ? { recipient, value } : undefined
  } catch {
    return undefined
  }
}
