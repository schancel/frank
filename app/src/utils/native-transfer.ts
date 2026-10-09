import {
  activeChain,
  getChainRegistryEntry,
  resolveNetworkId,
  type NativeAssetChain,
  type ChainAddress,
} from '@frank/wallet/chain'

/** Resolve wallet-page aliases once; Send's route carries only canonical identifiers. */
export function nativeSendChainIdentifier(
  wallet: string,
  isTestnet: boolean,
): string | undefined {
  const id = resolveNetworkId(wallet, isTestnet)
  if (!getChainRegistryEntry(id)) return undefined
  return id === activeChain.chainIdentifier ||
    id === 'solana-devnet' ||
    id === 'solana-mainnet'
    ? id
    : undefined
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
