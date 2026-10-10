import {
  getChainRegistryEntry,
  resolveNetworkId,
  type ChainRegistryEntry,
} from '@frank/wallet/chain/chains-registry'

/**
 * What the app can do with one wallet row, read from the chain registry's `wallet` setting:
 * - `send`: balance, receive and send.
 * - `receive-only`: balance and receive; Send is not offered.
 * - `unsupported`: nothing. No address is shown, because money sent there could not be seen.
 */
export type WalletSupport =
  | { status: 'send' | 'receive-only'; entry: ChainRegistryEntry }
  | { status: 'unsupported'; entry?: ChainRegistryEntry }

/** `wallet` is a wallet-page alias (`bitcoin`, `ecash`, ...) or a canonical chain identifier. */
export function walletSupport(
  wallet: string,
  isTestnet: boolean,
): WalletSupport {
  const entry = getChainRegistryEntry(resolveNetworkId(wallet, isTestnet))
  if (!entry?.wallet) return { status: 'unsupported', entry }
  return { status: entry.wallet.send ? 'send' : 'receive-only', entry }
}
