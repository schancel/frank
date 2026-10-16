import { getChainRegistryEntry } from '@frank/wallet/chain/chains-registry'
import { verifyEvmWalletRpcIdentity } from './evm-wallet-verification'
import type { EvmChainConfig } from '@frank/wallet/chain/evm-chain-config'

const entry = getChainRegistryEntry('monad-regtest')!
const config = {
  networkId: entry.id,
  chainIdentifier: entry.id,
  rpcChain: entry.id,
  chainId: Number(entry.nativeChainId),
  networkTag: entry.networkTag,
} as EvmChainConfig
const checkpoint = { blockNumber: 37, blockHash: '0x' + 'ab'.repeat(32) }

it('refuses a genesis operator checkpoint before requesting RPC', async () => {
  const provider = {
    send: jest.fn(),
    getNetwork: async () => ({ chainId: BigInt(entry.nativeChainId!) }),
    getBlock: async () => ({ number: 0, hash: checkpoint.blockHash }),
  }
  await expect(
    verifyEvmWalletRpcIdentity(
      config,
      provider,
      { ...checkpoint, blockNumber: 0 },
      () => undefined,
    ),
  ).rejects.toThrow(/operator checkpoint/)
  expect(provider.send).not.toHaveBeenCalled()
})

it('observes an upstream native ID change despite a previously cached successful network', async () => {
  let nativeId = '0x' + BigInt(entry.nativeChainId!).toString(16)
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(entry.nativeChainId!) }),
    getBlock: async () => ({ number: 37, hash: checkpoint.blockHash }),
    send: jest.fn(async (method: string) =>
      method === 'eth_chainId'
        ? nativeId
        : { number: '0x25', hash: checkpoint.blockHash },
    ),
  }
  await verifyEvmWalletRpcIdentity(
    config,
    provider,
    checkpoint,
    () => undefined,
  )
  nativeId = '0x1'
  await expect(
    verifyEvmWalletRpcIdentity(config, provider, checkpoint, () => undefined),
  ).rejects.toThrow(/chain identity mismatch/)
})
