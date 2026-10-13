import { activeChain } from '@frank/wallet/chain'
import { listEvmSwapVenues } from '@frank/wallet/chain/dex-deployments'
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

/** Pure configured metadata: listing choices never opens custody or contacts an RPC.
 * Unknown balances stay absent until a financial owner's unsigned quote observes them. */
export async function configuredStealthAssets(): Promise<{
  options: StealthAssetOption[]
  unavailable: readonly { chainIdentifier: string; error: unknown }[]
}> {
  const configured = activeChain.chainIdentifier
  const isTestnet = activeChain.isTestnet ?? false
  const options: StealthAssetOption[] = []
  const unavailable: { chainIdentifier: string; error: unknown }[] = []
  const seen = new Set<string>()
  for (const wallet of WALLET_CONFIGS) {
    if (!wallet.enabled) continue
    const entry = walletNetworkMetadata(wallet.id, isTestnet, configured)
    if (!entry?.wallet || seen.has(entry.id)) continue
    seen.add(entry.id)
    try {
      const decimals = entry.nativeDecimals
      // Networks without a native asset require their own configured fee-asset capability.
      if (decimals === null) continue
      const native = { kind: 'native' } as const
      options.push({
        key: stealthAssetKey(entry.id, native),
        chainIdentifier: entry.id,
        asset: native,
        label: `${entry.name} · ${entry.unit}`,
        unit: entry.unit,
        decimals,
        nativeUnit: entry.unit,
        nativeDecimals: decimals,
      })
      if (entry.family !== 'evm') continue
      const contracts = new Set<string>()
      for (const venue of listEvmSwapVenues(entry.id)) {
        for (const token of venue.tokens) {
          if (!token.address || contracts.has(token.address.toLowerCase()))
            continue
          contracts.add(token.address.toLowerCase())
          const asset = {
            kind: 'erc20',
            contractAddress: token.address.toLowerCase(),
          } as const
          options.push({
            key: stealthAssetKey(entry.id, asset),
            chainIdentifier: entry.id,
            asset,
            label: `${entry.name} · ${token.symbol}`,
            unit: token.symbol,
            decimals: token.decimals,
            nativeUnit: entry.unit,
            nativeDecimals: decimals,
          })
        }
      }
    } catch (error) {
      unavailable.push({ chainIdentifier: entry.id, error })
    }
  }
  return { options, unavailable }
}
