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
