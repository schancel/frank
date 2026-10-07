import { Address } from 'ecash-lib/dist/address/address'
import { ChronikClient } from 'chronik-client'
import { formatBaseUnit } from './base-unit'
import { canonicalEcashNetworkId, EcashNetworkId } from '../ecash-wallet'

export type ChronikUtxoItem = {
  sats?: bigint | number | string
  value?: bigint | number | string
}

export interface FetchEcashBalanceOptions {
  /** The eCash cashaddress (e.g. `ectest:q...` or `ecash:q...`). */
  address: string
  /** Explicit network ID override. If omitted, derived from address prefix. */
  networkId?: EcashNetworkId
  /** Relay base URL to route via the relay's Chronik reverse proxy (`/chain-rpc/<networkId>/chronik`). */
  relayBaseUrl?: string
  /** Direct Chronik endpoints override. */
  chronikUrls?: string[]
  /** Test seam to inject a mock ChronikClient. */
  client?: {
    script: (
      type: string,
      hash: string,
    ) => {
      utxos: () => Promise<
        | { utxos?: ReadonlyArray<ChronikUtxoItem> }
        | ReadonlyArray<{ utxos?: ReadonlyArray<ChronikUtxoItem> }>
      >
    }
  }
}

export interface EcashBalanceResult {
  sats: bigint
  formatted: string
  unit: string
  networkId: 'xec-mainnet' | 'xec-testnet'
}

export const DEFAULT_CHRONIK_UPSTREAMS: Record<
  'xec-mainnet' | 'xec-testnet',
  string
> = {
  'xec-mainnet': 'https://chronik.fabien.cash',
  'xec-testnet': 'https://chronik-testnet.fabien.cash',
}

/**
 * Resolves failover Chronik URLs for eCash queries.
 * Places the local/configured relay reverse proxy first, followed by public upstream indexer fallback.
 */
export function getEcashChronikUrls(params: {
  networkId: 'xec-mainnet' | 'xec-testnet'
  relayBaseUrl?: string
  chronikUrls?: string[]
}): string[] {
  if (params.chronikUrls && params.chronikUrls.length > 0) {
    return params.chronikUrls
  }
  const upstream = DEFAULT_CHRONIK_UPSTREAMS[params.networkId]
  if (params.relayBaseUrl) {
    const cleanRelay = params.relayBaseUrl.replace(/\/+$/, '')
    return [`${cleanRelay}/chain-rpc/${params.networkId}/chronik`, upstream]
  }
  return [upstream]
}

/**
 * Public, read-only eCash balance fetcher by address.
 * Does not require private keys, HD wallet derivation, or wallet state changes.
 */
export async function fetchEcashBalance(
  options: FetchEcashBalanceOptions,
): Promise<EcashBalanceResult> {
  const parsed = Address.fromCashAddress(options.address.toLowerCase())
  const networkId = options.networkId
    ? canonicalEcashNetworkId(options.networkId)
    : parsed.prefix === 'ectest'
    ? 'xec-testnet'
    : 'xec-mainnet'

  const chronikUrls = getEcashChronikUrls({
    networkId,
    relayBaseUrl: options.relayBaseUrl,
    chronikUrls: options.chronikUrls,
  })

  const chronik =
    options.client ??
    new ChronikClient(chronikUrls[0] ?? DEFAULT_CHRONIK_UPSTREAMS[networkId])

  const res = await chronik.script(parsed.type, parsed.hash).utxos()
  const utxoList: ReadonlyArray<ChronikUtxoItem> = Array.isArray(res)
    ? res.flatMap(
        (group: { utxos?: ReadonlyArray<ChronikUtxoItem> }) =>
          group.utxos ?? [],
      )
    : (res as { utxos?: ReadonlyArray<ChronikUtxoItem> }).utxos ?? []

  const sats = utxoList.reduce((acc: bigint, u: ChronikUtxoItem) => {
    if (u.sats !== undefined) {
      return acc + BigInt(u.sats)
    }
    if (u.value !== undefined) {
      return acc + BigInt(u.value)
    }
    return acc
  }, 0n)

  const unit = networkId === 'xec-testnet' ? 'tXEC' : 'XEC'
  const formatted = `${formatBaseUnit(sats, 2)} ${unit}`

  return {
    sats,
    formatted,
    unit,
    networkId,
  }
}
