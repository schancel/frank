/**
 * The swap venues of a wallet, for the shell. Composition: each chain family contributes its
 * own list here, and the shell sees only `SwapVenuePresentation`.
 */
import {
  getChainRegistryEntry,
  resolveNetworkId,
} from '@frank/wallet/chain/chains-registry'
import EvmSwapPanel from 'src/components/wallet/EvmSwapPanel.vue'
import SolanaSwapPanel from 'src/components/wallet/SolanaSwapPanel.vue'
import { nativeSendChainIdentifier } from 'src/utils/native-transfer'
import { evmSwapVenues } from './evm-swap-session'
import type { SwapVenuePresentation } from './venue-presentation'

function evmVenues(
  chainIdentifier: string | undefined,
  walletId: string,
): SwapVenuePresentation[] {
  if (!chainIdentifier) return []
  return evmSwapVenues(chainIdentifier).map(venue => ({
    id: venue.id,
    label: venue.displayName,
    // The contracts are the protocol's; say so when someone else runs this deployment.
    ...(venue.officialUniswapDeployment
      ? {}
      : {
          note: {
            key: 'swap.venueNote',
            params: { maintainer: venue.maintainer },
          },
        }),
    panel: EvmSwapPanel,
    panelProps: { chainIdentifier, walletId, venueId: venue.id },
  }))
}

/** In order; the first is the one the form opens on. Empty: this wallet has no swap. */
export function swapVenuesForWallet(
  walletId: string,
  isTestnet: boolean,
): SwapVenuePresentation[] {
  const family = getChainRegistryEntry(
    resolveNetworkId(walletId, isTestnet),
  )?.family
  if (family === 'evm')
    return evmVenues(nativeSendChainIdentifier(walletId, isTestnet), walletId)
  // The Solana family lists its own venues here; until it does, its one panel names itself.
  if (family === 'solana')
    return [{ id: 'solana', label: '', panel: SolanaSwapPanel, panelProps: {} }]
  return []
}
