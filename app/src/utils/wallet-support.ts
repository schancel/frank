import {
  getChainRegistryEntry,
  resolveNetworkId,
  type ChainRegistryEntry,
} from '@frank/wallet/chain/chains-registry'

/**
 * Whether the app has a wallet for one wallet row, read from the chain registry's `wallet`
 * setting. A wallet means balance, receive and send. Without one nothing is offered and no
 * address is shown, because money sent there could not be seen.
 */
export type WalletSupport =
  | { status: 'available'; entry: ChainRegistryEntry }
  | { status: 'unsupported'; entry?: ChainRegistryEntry }

/** `wallet` is a wallet-page alias (`bitcoin`, `ecash`, ...) or a canonical chain identifier. */
export function walletSupport(
  wallet: string,
  isTestnet: boolean,
): WalletSupport {
  const entry = getChainRegistryEntry(resolveNetworkId(wallet, isTestnet))
  return entry?.wallet
    ? { status: 'available', entry }
    : { status: 'unsupported', entry }
}
