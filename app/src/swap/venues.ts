/**
 * The swap venues of a wallet, for the shell. Composition: each chain family contributes its
 * own list here, and the shell sees only `SwapVenuePresentation`.
 */
import {
  getChainRegistryEntry,
  resolveNetworkId,
} from '@frank/wallet/chain/chains-registry'
import type { Component } from 'vue'
import { nativeSendChainIdentifier } from 'src/utils/native-transfer'
import { solanaSwapVenuePresentations } from 'src/composables/useSolanaSwap'
import { evmSwapVenues } from './evm-swap-session'
import type { SwapVenuePresentation } from './venue-presentation'

/** The panel of each chain family, and within EVM of each adapter. The shell supplies them. */
export interface SwapPanels {
  readonly evm: { readonly [adapter: string]: Component | undefined }
  readonly solana: Component
}

function evmVenues(
  chainIdentifier: string | undefined,
  walletId: string,
  panels: SwapPanels['evm'],
): SwapVenuePresentation[] {
  if (!chainIdentifier) return []
  return evmSwapVenues(chainIdentifier).flatMap(venue => {
    const panel = panels[venue.adapter]
    // An entry whose adapter has no panel here cannot be offered.
    if (!panel) return []
    return [
      {
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
        panel,
        panelProps: { chainIdentifier, walletId, venueId: venue.id },
      },
    ]
  })
}

/** In order; the first is the one the form opens on. Empty: this wallet has no swap. */
export function swapVenuesForWallet(
  walletId: string,
  isTestnet: boolean,
  panels: SwapPanels,
): SwapVenuePresentation[] {
  const family = getChainRegistryEntry(
    resolveNetworkId(walletId, isTestnet),
  )?.family
  if (family === 'evm')
    return evmVenues(
      nativeSendChainIdentifier(walletId, isTestnet),
      walletId,
      panels.evm,
    )
  if (family === 'solana')
    return solanaSwapVenuePresentations(
      resolveNetworkId(walletId, isTestnet),
      walletId,
    ).map(venue => ({ ...venue, panel: panels.solana }))
  return []
}
