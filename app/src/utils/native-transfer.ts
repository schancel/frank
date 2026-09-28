import { ActiveChain, ChainAddress } from '@frank/wallet/chain'

export interface ParsedNativeTransfer {
  recipient: ChainAddress
  value: bigint
}

/** Parses the two user-controlled fields before any signer or RPC client is invoked. */
export function parseNativeTransferInput(
  chain: ActiveChain,
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
