/** Canonical configuration and RPC identity checks shared by new and reused EVM owners. */
import {
  getChainRegistryEntry,
  type EvmChainConfig,
  type EvmChainWalletHandle,
} from '@frank/wallet/chain'

interface OperatorCheckpoint {
  readonly blockNumber: number
  readonly blockHash: string
}

export function validateEvmWalletConfiguration(
  config: EvmChainConfig,
  checkpoint?: OperatorCheckpoint,
) {
  const entry = getChainRegistryEntry(config.networkId)
  if (
    !entry ||
    entry.family !== 'evm' ||
    !entry.wallet ||
    entry.id !== config.chainIdentifier ||
    entry.id !== config.rpcChain ||
    entry.networkTag !== config.networkTag ||
    entry.nativeChainId === undefined ||
    BigInt(entry.nativeChainId) !== BigInt(config.chainId)
  )
    throw new Error('Unsupported or inconsistent EVM wallet configuration')
  if (
    entry.identityProbes.some(
      probe => probe.kind === 'operator-block-checkpoint',
    ) &&
    (!checkpoint ||
      !Number.isSafeInteger(checkpoint.blockNumber) ||
      checkpoint.blockNumber < 0 ||
      !/^0x[0-9a-fA-F]{64}$/.test(checkpoint.blockHash))
  )
    throw new Error('EVM operator checkpoint is required')
  return entry
}

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

export async function verifyEvmWalletRpcIdentity(
  config: EvmChainConfig,
  provider: Pick<EvmChainWalletHandle['provider'], 'getNetwork' | 'getBlock'>,
  checkpoint: OperatorCheckpoint | undefined,
  requireCurrent: () => void,
): Promise<void> {
  const entry = validateEvmWalletConfiguration(config, checkpoint)
  requireCurrent()
  // The EVM provider checks its expected numeric ID against eth_chainId on first use.
  const chainId = (await provider.getNetwork()).chainId
  requireCurrent()
  if (
    entry.nativeChainId === undefined ||
    BigInt(chainId) !== BigInt(entry.nativeChainId)
  )
    throw new Error('EVM RPC chain identity mismatch')
  for (const probe of entry.identityProbes) {
    if (probe.capability !== 'json-rpc') continue
    if (probe.kind === 'evm-chain-id') {
      if (BigInt(probe.expected) !== BigInt(chainId))
        throw new Error('EVM RPC chain identity mismatch')
    } else if (
      probe.kind === 'block-hash' ||
      probe.kind === 'operator-block-checkpoint'
    ) {
      if (probe.kind === 'operator-block-checkpoint' && !checkpoint)
        throw new Error('EVM operator checkpoint is required')
      const expectedCheckpoint =
        probe.kind === 'block-hash'
          ? { blockNumber: probe.height, blockHash: probe.expected }
          : checkpoint
      if (!expectedCheckpoint)
        throw new Error('EVM operator checkpoint is required')
      const block = await provider.getBlock(expectedCheckpoint.blockNumber)
      requireCurrent()
      if (
        !block ||
        block.number !== expectedCheckpoint.blockNumber ||
        block.hash?.toLowerCase() !== expectedCheckpoint.blockHash.toLowerCase()
      )
        throw new Error('EVM RPC checkpoint mismatch')
    } else throw new Error('Unsupported EVM identity probe')
  }
}
