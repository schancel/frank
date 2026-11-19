/**
 * Reads the `dex` list of a network's row in the chain registry (`chains-registry.ts`). The
 * entries themselves, and where each address came from, are in `dex-entries.ts`.
 *
 * A network has a swap when its row lists an enabled entry. Nothing else decides it: there is
 * no network-name condition anywhere in the swap code.
 */
import { PROTOCOL_CHAINS } from './chains-registry'
import {
  assertInterfaceFee,
  EVM_DEX_CARRIES_INTERFACE_FEE,
  resolveConfiguredInterfaceFee,
  type EvmDexEntry,
  type UniswapV4Deployment,
} from './dex-entries'
import { SOLANA_DEX_ADAPTERS } from './solana-dex-entries'

export * from './dex-entries'

/** A Solana entry is told apart by its adapter; everything else on an EVM row is an EVM entry. */
const isEvmDexEntry = (venue: { adapter: string }): venue is EvmDexEntry =>
  !SOLANA_DEX_ADAPTERS.includes(venue.adapter)

for (const [chainIdentifier, entry] of Object.entries(PROTOCOL_CHAINS)) {
  const dex = entry.dex ?? []
  // Each chain family lists only its own kind of entry.
  if (dex.length && entry.family !== 'evm' && entry.family !== 'solana')
    throw new Error(
      `${chainIdentifier} lists dex entries but has no swap family`,
    )
  if (dex.some(venue => isEvmDexEntry(venue) !== (entry.family === 'evm')))
    throw new Error(
      `${chainIdentifier} lists a dex entry of another chain family`,
    )
  if (new Set(dex.map(venue => venue.id)).size !== dex.length)
    throw new Error('Dex ids must be unique within a chain')
  // A Solana entry's fee is checked where Solana addresses are understood (solana-swap).
  for (const venue of dex) {
    if (!isEvmDexEntry(venue)) continue
    if (!Object.prototype.hasOwnProperty.call(EVM_DEX_CARRIES_INTERFACE_FEE, venue.adapter))
      throw new Error(`${chainIdentifier} lists an unknown EVM dex adapter`)
    if (venue.interfaceFee) {
      if (!EVM_DEX_CARRIES_INTERFACE_FEE[venue.adapter])
        throw new Error(`${venue.adapter} cannot carry an interface fee`)
      assertInterfaceFee(venue.interfaceFee)
    }
  }
}

/**
 * The enabled EVM dex entries of a canonical chain identifier, in order, whatever fee policy is
 * configured. Their tokens are the chain's configured ERC-20 assets. Empty when none.
 */
export function listEnabledEvmDexEntries(
  chainIdentifier: string,
): readonly EvmDexEntry[] {
  const entry = Object.prototype.hasOwnProperty.call(
    PROTOCOL_CHAINS,
    chainIdentifier,
  )
    ? PROTOCOL_CHAINS[chainIdentifier]
    : undefined
  return (entry?.dex ?? []).filter(isEvmDexEntry).filter(venue => venue.enabled)
}

/**
 * The dex entries a swap can be made on, in order: the enabled ones, each with any configured
 * interface fee. While a fee is configured, an entry whose adapter cannot carry one is left out.
 */
export function listEvmSwapVenues(
  chainIdentifier: string,
): readonly EvmDexEntry[] {
  const configuredFee = resolveConfiguredInterfaceFee('evm')
  return listEnabledEvmDexEntries(chainIdentifier)
    .filter(
      venue =>
        configuredFee === undefined ||
        EVM_DEX_CARRIES_INTERFACE_FEE[venue.adapter],
    )
    .map(venue =>
      venue.interfaceFee === undefined && configuredFee !== undefined
        ? // Only an adapter that carries a fee is still listed here.
          (Object.freeze({ ...venue, interfaceFee: configuredFee }) as EvmDexEntry)
        : venue,
    )
}

/**
 * One enabled dex of a chain: the named one, or the chain's first when none is named. Undefined
 * for a chain with none or a name it does not have: there is no default chain and no fallback.
 */
export function getEvmDexDeployment(
  chainIdentifier: string,
  venueId?: string,
): EvmDexEntry | undefined {
  const venues = listEvmSwapVenues(chainIdentifier)
  return venueId === undefined
    ? venues[0]
    : venues.find(venue => venue.id === venueId)
}

/** One enabled Uniswap v4 dex of a chain, as `getEvmDexDeployment` finds it; else undefined. */
export function getUniswapV4Deployment(
  chainIdentifier: string,
  venueId?: string,
): UniswapV4Deployment | undefined {
  const venue = getEvmDexDeployment(chainIdentifier, venueId)
  return venue?.adapter === 'uniswap-v4' ? venue : undefined
}

export function listEvmDexDeploymentChains(): string[] {
  return Object.keys(PROTOCOL_CHAINS).filter(
    chainIdentifier => listEvmSwapVenues(chainIdentifier).length > 0,
  )
}
