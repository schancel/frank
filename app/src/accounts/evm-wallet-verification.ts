/** Canonical configuration and RPC identity checks shared by new and reused EVM owners. */
import { getChainRegistryEntry, type EvmChainConfig } from '@frank/wallet/chain'

export {
  validateEvmWalletConfiguration,
  verifyEvmWalletRpcIdentity,
} from '@frank/wallet/chain/evm-rpc-identity'

/** The operator's configured subset must include the exact network before custody is opened. */
export async function verifyEvmRelayRoute(
  config: EvmChainConfig,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<void> {
  const entry = getChainRegistryEntry(config.networkId)
  if (
    !entry ||
    entry.family !== 'evm' ||
    entry.id !== config.chainIdentifier ||
    entry.id !== config.rpcChain ||
    entry.nativeChainId === undefined ||
    BigInt(entry.nativeChainId) !== BigInt(config.chainId)
  )
    throw new Error('Unsupported or inconsistent EVM relay configuration')
  let document: unknown
  try {
    const response = await request(
      `${config.relayBaseUrl.replace(/\/+$/, '')}/chains`,
      { cache: 'no-store', signal },
    )
    if (!response.ok) throw new Error('relay discovery failed')
    document = await response.json()
  } catch {
    throw new Error(`EVM relay route unavailable for ${entry.id}`)
  }
  if (
    typeof document !== 'object' ||
    document === null ||
    !('schema_version' in document) ||
    document.schema_version !== 1 ||
    !('chains' in document) ||
    !Array.isArray(document.chains)
  )
    throw new Error(`Invalid EVM relay discovery for ${entry.id}`)
  const route = document.chains.find(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      value.id === entry.id,
  ) as Record<string, unknown> | undefined
  if (
    !route ||
    route.family !== entry.family ||
    route.network !== entry.network ||
    route.caip2 !== entry.caip2 ||
    route.native_chain_id !== String(entry.nativeChainId) ||
    !Array.isArray(route.capabilities) ||
    !route.capabilities.includes('json-rpc')
  )
    throw new Error(`EVM relay route unavailable for ${entry.id}`)
}
