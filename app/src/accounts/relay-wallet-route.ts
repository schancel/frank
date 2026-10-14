/** Operator wallet routes are a subset of protocol capabilities, never network identity. */
import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'

export class RelayWalletRouteUnavailableError extends Error {
  constructor(readonly chainIdentifier: string) {
    super(`Wallet route not configured by relay for ${chainIdentifier}`)
  }
}

const discoveries = new Map<
  string,
  { expires: number; document: Promise<unknown[]> }
>()
const DISCOVERY_TTL_MS = 15000
const DISCOVERY_TIMEOUT_MS = 10000

async function routes(relay: string): Promise<unknown[]> {
  const cached = discoveries.get(relay)
  if (cached && cached.expires > Date.now()) return cached.document
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const document = (async () => {
    const response = await fetch(`${relay}/chains`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Relay wallet discovery failed')
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schema_version' in value) ||
      value.schema_version !== 1 ||
      !('chains' in value) ||
      !Array.isArray(value.chains)
    )
      throw new Error('Invalid relay wallet discovery')
    return value.chains
  })().finally(() => clearTimeout(timeout))
  const entry = { expires: Date.now() + DISCOVERY_TTL_MS, document }
  discoveries.set(relay, entry)
  // Failed discovery is retried on the next poll; it never asserts a route is absent.
  document.catch(() => {
    if (discoveries.get(relay) === entry) discoveries.delete(relay)
  })
  return document
}

/** Read-only discovery before acquiring custody or querying balances. RPC identity probes remain required. */
export async function requireRelayWalletRoute(
  relayBaseUrl: string,
  chainIdentifier: string,
): Promise<void> {
  const entry = getChainRegistryEntry(chainIdentifier)
  if (!entry?.wallet || entry.id !== chainIdentifier)
    throw new Error(`Unsupported wallet network ${chainIdentifier}`)
  const advertised = await routes(relayBaseUrl.replace(/\/+$/, ''))
  const matches = advertised.filter(
    (route): route is Record<string, unknown> =>
      typeof route === 'object' &&
      route !== null &&
      'id' in route &&
      route.id === chainIdentifier,
  )
  if (matches.length === 0)
    throw new RelayWalletRouteUnavailableError(chainIdentifier)
  const route = matches[0]
  if (
    matches.length !== 1 ||
    route.family !== entry.family ||
    route.network !== entry.network ||
    route.caip2 !== entry.caip2 ||
    route.native_chain_id !== (entry.nativeChainId ?? null) ||
    !Array.isArray(route.capabilities) ||
    route.capabilities.some(
      capability => !entry.allowedProxyCapabilities.includes(capability),
    )
  )
    throw new Error(`Invalid relay wallet route for ${chainIdentifier}`)
  if (!route.capabilities.includes(entry.wallet.indexer))
    throw new RelayWalletRouteUnavailableError(chainIdentifier)
}
