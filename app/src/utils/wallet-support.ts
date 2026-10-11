import { activeChain } from '@frank/wallet/chain'
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

/** Resolve a presentation alias against the configured canonical runtime network first.
 * A testnet flag alone cannot distinguish public testnet from local regtest.
 * Explicit canonical network IDs always keep their own identity.
 */
export function walletNetworkMetadata(
  wallet: string,
  isTestnet: boolean,
  configuredChainIdentifier = activeChain.chainIdentifier,
): ChainRegistryEntry | undefined {
  const direct = getChainRegistryEntry(wallet)
  if (direct) return direct
  const configured = getChainRegistryEntry(configuredChainIdentifier)
  if (!configured) return undefined
  return wallet === configured.kind
    ? configured
    : getChainRegistryEntry(resolveNetworkId(wallet, isTestnet))
}

/** `wallet` is a wallet-page alias (`bitcoin`, `ecash`, ...) or a canonical chain identifier. */
export function walletSupport(
  wallet: string,
  isTestnet: boolean,
  configuredChainIdentifier = activeChain.chainIdentifier,
): WalletSupport {
  const entry = walletNetworkMetadata(wallet, isTestnet, configuredChainIdentifier)
  return entry?.wallet
    ? { status: 'available', entry }
    : { status: 'unsupported', entry }
}
