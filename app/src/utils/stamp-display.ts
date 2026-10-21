import { getChainRegistryEntry } from '@frank/wallet/chain'
import { ASSET_DECIMALS, type SupportedAsset } from '@frank/wallet/oracle'
import { useSafeOracleStore } from 'src/stores/oracle'
import { formatAvu } from './avu-units'

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

/** What a stamp is worth in AVU, in the two forms the stamp pill shows it. */
export interface StampAvu {
  /** The pill's figure, short enough for a phone composer: "≈ 52.3 mAVU". */
  readonly figure: string
  /** The full line for the hover text, through the one AVU helper: marked "· testnet"
   * for test-network coins and with its age once stale ("≈ 52.3 mAVU · testnet (45 min
   * old)"). */
  readonly line: string
  /** The price or AVU_hash behind it is stale: the pill must say so, compactly. */
  readonly stale: boolean
}

/**
 * The stamp's AVU value, or undefined for a free or unparsed stamp and whenever there is
 * no rate: the pill then shows the coin amount alone, never a made-up value.
 */
export function stampAvu(
  chain: StampChain,
  stampBaseUnits: bigint | undefined,
): StampAvu | undefined {
  if (stampBaseUnits === undefined || stampBaseUnits <= 0n) return undefined
  const asset = pricedAsset(chain)
  if (!asset) return undefined
  const oracle = useSafeOracleStore()
  const figure = formatAvu(oracle.getAvu(asset, stampBaseUnits))
  if (!figure) return undefined
  return {
    figure: `≈ ${figure}`,
    line: oracle.formatAvuAmount(asset, stampBaseUnits),
    stale: oracle.valueStaleAgeMs(asset) !== undefined,
  }
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
