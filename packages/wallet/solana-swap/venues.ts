/**
 * Reads the Solana `dex` entries of a network's row in the chain registry. The entries, and
 * where each address came from, are in ../chain/solana-dex-entries.ts.
 *
 * A network has a swap when its row lists an enabled entry; nothing else decides it.
 */
import { PublicKey } from '@solana/web3.js'

import { PROTOCOL_CHAINS } from '../chain/chains-registry'
import {
  MAX_PLATFORM_FEE_BPS,
  SOLANA_DEX_ADAPTERS,
  type SolanaDexEntry,
} from '../chain/solana-dex-entries'

export * from '../chain/solana-dex-entries'

/** A Solana `dex` entry. */
export type SolanaSwapVenue = SolanaDexEntry

/** One signature's base fee: no transaction costs less. */
const LEAST_NETWORK_FEE_LAMPORTS = 5000

/**
 * Refuses an entry with no usable limit on the network fee, or whose interface fee is malformed
 * or above the bound.
 */
export function validateSolanaSwapVenue<T extends SolanaSwapVenue>(
  venue: T,
): T {
  if (
    !Number.isSafeInteger(venue.maxNetworkFeeLamports) ||
    venue.maxNetworkFeeLamports < LEAST_NETWORK_FEE_LAMPORTS
  ) {
    throw new Error(
      `Swap venue ${venue.id}: the most it may pay in network fees must be a whole number of lamports, at least ${LEAST_NETWORK_FEE_LAMPORTS}`,
    )
  }
  const fee = venue.interfaceFee
  if (fee !== undefined) {
    if (
      !Number.isInteger(fee.bps) ||
      fee.bps < 1 ||
      fee.bps > MAX_PLATFORM_FEE_BPS
    ) {
      throw new Error(
        `Swap venue ${venue.id}: platform fee must be 1..${MAX_PLATFORM_FEE_BPS} basis points`,
      )
    }
    try {
      new PublicKey(fee.recipient)
    } catch {
      throw new Error(
        `Swap venue ${venue.id}: platform fee recipient is not an address`,
      )
    }
  }
  return venue
}

const isSolanaDexEntry = (entry: {
  adapter: string
}): entry is SolanaDexEntry => SOLANA_DEX_ADAPTERS.includes(entry.adapter)

/** Every listed exchange of a network, enabled or not (for checks and tooling). */
export function listSolanaDexEntries(
  chainIdentifier: string,
): readonly SolanaSwapVenue[] {
  const row = Object.prototype.hasOwnProperty.call(
    PROTOCOL_CHAINS,
    chainIdentifier,
  )
    ? PROTOCOL_CHAINS[chainIdentifier]
    : undefined
  return row?.family === 'solana'
    ? (row.dex ?? []).filter(isSolanaDexEntry).map(validateSolanaSwapVenue)
    : []
}

/** The exchanges offered on a network, default first; empty when it has no swap. */
export function getSolanaSwapVenues(
  chainIdentifier: string,
): readonly SolanaSwapVenue[] {
  return listSolanaDexEntries(chainIdentifier).filter(venue => venue.enabled)
}

/** One offered exchange of a network: the named one, or the default when no id is given. */
export function getSolanaSwapVenue(
  chainIdentifier: string,
  venueId?: string,
): SolanaSwapVenue | undefined {
  const venues = getSolanaSwapVenues(chainIdentifier)
  return venueId === undefined
    ? venues[0]
    : venues.find(venue => venue.id === venueId)
}
