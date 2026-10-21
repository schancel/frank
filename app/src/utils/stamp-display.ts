import { getChainRegistryEntry } from '@frank/wallet/chain'
import { ASSET_DECIMALS, type SupportedAsset } from '@frank/wallet/oracle'
import { useSafeOracleStore } from 'src/stores/oracle'

/** The chain a stamp is paid on: what the composer's stamp pill needs to know of it. */
export interface StampChain {
  readonly chainIdentifier: string
  fromDisplayAmount(amount: string): bigint
}

/**
 * The oracle asset that prices a chain's native amounts, from the canonical registry
 * entry (as stamp pricing does). Undefined when the chain's base unit is not that asset's
 * (an amount there could not be valued correctly).
 */
function pricedAsset(chain: StampChain): SupportedAsset | undefined {
  const asset = getChainRegistryEntry(chain.chainIdentifier)?.kind
  if (!asset) return undefined
  try {
    return chain.fromDisplayAmount('1') === 10n ** BigInt(ASSET_DECIMALS[asset])
      ? asset
      : undefined
  } catch {
    return undefined
  }
}

/**
 * What a stamp is worth in AVU, through the one AVU formatter: "≈ 52.3 mAVU", marked
 * "· testnet" for test-network coins and with its age once stale. Empty for a free or
 * unparsed stamp and whenever there is no rate: the pill then shows the coin amount alone.
 */
export function formatStampAvu(
  chain: StampChain,
  stampBaseUnits: bigint | undefined,
): string {
  if (stampBaseUnits === undefined || stampBaseUnits <= 0n) return ''
  const asset = pricedAsset(chain)
  return asset
    ? useSafeOracleStore().formatAvuAmount(asset, stampBaseUnits)
    : ''
}

/**
 * The chosen stamp as a multiple of the default stamp, to four decimals: "2", "≈1.0511"
 * ("≈" when rounded). Empty when either side is missing or the stamp is free.
 */
export function stampMultiplierText(
  selected: bigint | undefined,
  reference: bigint | undefined,
): string {
  if (
    selected === undefined ||
    selected === 0n ||
    reference === undefined ||
    reference <= 0n
  )
    return ''
  const scaled = (selected * 10000n + reference / 2n) / reference
  const whole = scaled / 10000n
  const fraction = (scaled % 10000n)
    .toString()
    .padStart(4, '0')
    .replace(/0+$/, '')
  const approximate = (selected * 10000n) % reference !== 0n
  return `${approximate ? '≈' : ''}${whole}${fraction ? '.' + fraction : ''}`
}
