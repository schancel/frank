/**
 * Explorer routing keyed by Frank's chain-and-network identifier.
 *
 * Keep this mapping explicit: inferring a network from an RPC URL can silently
 * produce links for the wrong chain when an operator changes providers.
 */
export const DEFAULT_NETWORK_TAG = 'MONT'

const transactionExplorerBases: Readonly<Record<string, string>> = {
  MONT: 'https://testnet.monadscan.com/tx/',
}

export function transactionExplorerUrl(
  txId: string,
  networkTag = DEFAULT_NETWORK_TAG,
): string {
  const baseUrl = transactionExplorerBases[networkTag]
  if (!baseUrl) {
    throw new Error(
      `No transaction explorer configured for NetworkTag ${networkTag}`,
    )
  }
  return `${baseUrl}${encodeURIComponent(txId)}`
}
