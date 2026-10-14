import type { StealthPaymentAsset } from '@frank/wallet/stealth-payment'
import { activeChain } from '@frank/wallet/chain'
import {
  resolveChainAdapter,
  type ChainSupportedAssetDescriptor,
} from '@frank/wallet/chain/chain-adapter'
import {
  PROTOCOL_CHAINS,
  getChainRegistryEntry,
  type ChainRegistryEntry,
} from '@frank/wallet/chain/chains-registry'
import { WALLET_CONFIGS } from '../utils/wallet-configs'
import { walletNetworkMetadata } from '../utils/wallet-support'
import { stealthAssetKey, type StealthAssetOption } from './options'

/** Uses the configured native adapter's own denomination, never a ticker-based table. */
export function nativeDecimals(
  fromDisplayAmount: (amount: string) => bigint,
): number {
  const one = fromDisplayAmount('1').toString()
  if (!/^10*$/.test(one)) throw new Error('Invalid native asset denomination')
  return one.length - 1
}

export interface ConfiguredStealthAssetsContext {
  readonly activeBalance?: bigint | null
  readonly getBalance?: (
    chainIdentifier: string,
    asset: StealthPaymentAsset,
  ) => bigint | undefined
}

/** Pure configured metadata: listing choices never opens custody or contacts an RPC.
 * Unknown balances stay absent until a financial owner's unsigned quote observes them. */
export async function configuredStealthAssets(
  context?: ConfiguredStealthAssetsContext,
): Promise<{
  options: StealthAssetOption[]
  unavailable: readonly { chainIdentifier: string; error: unknown }[]
}> {
  const configured = activeChain.chainIdentifier
  const isTestnet = activeChain.isTestnet ?? false
  const options: StealthAssetOption[] = []
  const unavailable: { chainIdentifier: string; error: unknown }[] = []
  const seen = new Set<string>()

  const configuredEntry = getChainRegistryEntry(configured)
  const chainEntries: ChainRegistryEntry[] = []
  for (const wallet of WALLET_CONFIGS) {
    if (!wallet.enabled) continue
    const entry = walletNetworkMetadata(wallet.id, isTestnet, configured)
    if (entry?.wallet && !seen.has(entry.id)) {
      seen.add(entry.id)
      chainEntries.push(entry)
    }
  }
  for (const entry of Object.values(PROTOCOL_CHAINS)) {
    if (!entry.wallet || seen.has(entry.id)) continue
    if (configuredEntry && entry.kind === configuredEntry.kind) {
      if (entry.id !== configured) continue
    } else if (entry.isTestnet !== isTestnet) {
      continue
    }
    seen.add(entry.id)
    chainEntries.push(entry)
  }

  for (const entry of chainEntries) {
    try {
      const adapter = resolveChainAdapter(entry.id, entry)
      const descriptors: readonly ChainSupportedAssetDescriptor[] = adapter
        ? adapter.getSupportedAssets()
        : entry.nativeDecimals !== null
        ? [
            {
              asset: { kind: 'native' },
              label: `${entry.unit} (${entry.name})`,
              unit: entry.unit,
              decimals: entry.nativeDecimals,
              nativeUnit: entry.unit,
              nativeDecimals: entry.nativeDecimals,
            },
          ]
        : []
      for (const desc of descriptors) {
        const balance =
          context?.getBalance?.(entry.id, desc.asset) ??
          (desc.asset.kind === 'native' &&
          entry.id === configured &&
          context?.activeBalance !== undefined &&
          context.activeBalance !== null
            ? context.activeBalance
            : undefined)
        options.push({
          key: stealthAssetKey(entry.id, desc.asset),
          chainIdentifier: entry.id,
          asset: desc.asset,
          label: desc.label,
          unit: desc.unit,
          decimals: desc.decimals,
          nativeUnit: desc.nativeUnit,
          nativeDecimals: desc.nativeDecimals,
          ...(balance !== undefined ? { balanceAtomic: balance } : {}),
        })
      }
    } catch (error) {
      unavailable.push({ chainIdentifier: entry.id, error })
    }
  }
  return { options, unavailable }
}
