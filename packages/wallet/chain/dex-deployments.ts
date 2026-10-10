/**
 * Reads the `dex` list of a network's row in the chain registry (`chains-registry.ts`). The
 * entries themselves, and where each address came from, are in `dex-entries.ts`.
 *
 * A network has a swap when its row lists an enabled entry. Nothing else decides it: there is
 * no network-name condition anywhere in the swap code.
 */
import { PROTOCOL_CHAINS } from './chains-registry'
import { assertInterfaceFee, type UniswapV4Deployment } from './dex-entries'

export * from './dex-entries'

for (const [chainIdentifier, entry] of Object.entries(PROTOCOL_CHAINS)) {
  const dex = entry.dex ?? []
  if (dex.length && entry.family !== 'evm')
    throw new Error(`${chainIdentifier} lists EVM dex entries but is not EVM`)
  if (new Set(dex.map(venue => venue.id)).size !== dex.length)
    throw new Error('Dex ids must be unique within a chain')
  for (const venue of dex)
    if (venue.interfaceFee) assertInterfaceFee(venue.interfaceFee)
}

/** The enabled dex entries of a canonical chain identifier, in order. Empty when none. */
export function listEvmSwapVenues(
  chainIdentifier: string,
): readonly UniswapV4Deployment[] {
  const entry = Object.prototype.hasOwnProperty.call(
    PROTOCOL_CHAINS,
    chainIdentifier,
  )
    ? PROTOCOL_CHAINS[chainIdentifier]
    : undefined
  return (entry?.dex ?? []).filter(venue => venue.enabled)
}

/**
 * One enabled dex of a chain: the named one, or the chain's first when none is named. Undefined
 * for a chain with none or a name it does not have: there is no default chain and no fallback.
 */
export function getEvmDexDeployment(
  chainIdentifier: string,
  venueId?: string,
): UniswapV4Deployment | undefined {
  const venues = listEvmSwapVenues(chainIdentifier)
  return venueId === undefined
    ? venues[0]
    : venues.find(venue => venue.id === venueId)
}

export function listEvmDexDeploymentChains(): string[] {
  return Object.keys(PROTOCOL_CHAINS).filter(
    chainIdentifier => listEvmSwapVenues(chainIdentifier).length > 0,
  )
}
