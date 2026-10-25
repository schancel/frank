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

function isDiscoveryRoute(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const route = value as Record<string, unknown>
  return (
    typeof route.id === 'string' &&
    route.id.length > 0 &&
    typeof route.family === 'string' &&
    ['evm', 'bitcoin', 'solana'].includes(route.family) &&
    typeof route.network === 'string' &&
    ['mainnet', 'testnet', 'regtest'].includes(route.network) &&
    (route.caip2 === null ||
      (typeof route.caip2 === 'string' && route.caip2.length > 0)) &&
    (route.native_chain_id === null ||
      typeof route.native_chain_id === 'string') &&
    Array.isArray(route.capabilities) &&
    route.capabilities.every(capability => typeof capability === 'string')
  )
}

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
      !Array.isArray(value.chains) ||
      !value.chains.every(isDiscoveryRoute)
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

export class RelayOperatorCheckpointUnavailableError extends Error {
  constructor(readonly chainIdentifier: string) {
    super(
      `The relay does not name the operator checkpoint ${chainIdentifier} requires`,
    )
  }
}

export interface RelayOperatorCheckpoint {
  readonly blockNumber: number
  readonly blockHash: string
}

/**
 * The block the relay verified its upstreams against, for a network whose registry row leaves
 * the checkpoint to the operator (`operator-block-checkpoint`, as on a local regtest chain). The
 * caller still checks the RPC route against it. A network with a protocol-pinned checkpoint never
 * takes one from a relay.
 */
export async function requireRelayOperatorCheckpoint(
  relayBaseUrl: string,
  chainIdentifier: string,
): Promise<RelayOperatorCheckpoint> {
  const entry = getChainRegistryEntry(chainIdentifier)
  if (
    !entry?.identityProbes.some(
      probe => probe.kind === 'operator-block-checkpoint',
    )
  )
    throw new Error(
      `${chainIdentifier} has a protocol checkpoint, not an operator one`,
    )
  const route = await relayWalletRoute(relayBaseUrl, chainIdentifier)
  const checkpoint = route.operator_checkpoint
  if (typeof checkpoint !== 'object' || checkpoint === null)
    throw new RelayOperatorCheckpointUnavailableError(chainIdentifier)
  const { block_number: blockNumber, block_hash: blockHash } =
    checkpoint as Record<string, unknown>
  if (
    typeof blockNumber !== 'number' ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 1 ||
    typeof blockHash !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(blockHash)
  )
    throw new RelayOperatorCheckpointUnavailableError(chainIdentifier)
  return { blockNumber, blockHash }
}

/** Read-only discovery before acquiring custody or querying balances. RPC identity probes remain required. */
export async function requireRelayWalletRoute(
  relayBaseUrl: string,
  chainIdentifier: string,
): Promise<void> {
  await relayWalletRoute(relayBaseUrl, chainIdentifier)
}

async function relayWalletRoute(
  relayBaseUrl: string,
  chainIdentifier: string,
): Promise<Readonly<Record<string, unknown>>> {
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
    (route.caip2 !== null && route.caip2 !== entry.caip2) ||
    route.native_chain_id !==
      (entry.nativeChainId === undefined
        ? null
        : String(entry.nativeChainId)) ||
    !Array.isArray(route.capabilities) ||
    route.capabilities.some(
      capability => !entry.allowedProxyCapabilities.includes(capability),
    )
  )
    throw new Error(`Invalid relay wallet route for ${chainIdentifier}`)
  if (!route.capabilities.includes(entry.wallet.indexer))
    throw new RelayWalletRouteUnavailableError(chainIdentifier)
  return route
}
