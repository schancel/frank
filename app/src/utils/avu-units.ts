import type { SupportedAsset } from '@frank/wallet/oracle'
import { compactAmountText } from './chain-amount'

/**
 * The amount of each coin a rate is quoted for: one coin, except eCash, which is quoted
 * per million because one XEC is a tiny fraction of an AVU.
 */
export const UNIT_RATE_ASSET_METRICS: Record<
  SupportedAsset,
  { symbol: string; multiplier: number }
> = {
  monad: { symbol: '1 MON', multiplier: 1 },
  solana: { symbol: '1 SOL', multiplier: 1 },
  ethereum: { symbol: '1 ETH', multiplier: 1 },
  hyperliquid: { symbol: '1 HYPE', multiplier: 1 },
  tempo: { symbol: '1 TUSD', multiplier: 1 },
  ecash: { symbol: '1M XEC', multiplier: 1_000_000 },
  bitcoin: { symbol: '1 BTC', multiplier: 1 },
  bitcoincash: { symbol: '1 BCH', multiplier: 1 },
  dogecoin: { symbol: '1 DOGE', multiplier: 1 },
}

/**
 * An AVU figure in the app's compact amount style (the one formatter every amount on
 * screen goes through): "1.1 kAVU", "92.5 AVU", "187.5 mAVU". Empty for nothing or for a
 * value that is not a positive number: an unknown value is not "0 AVU".
 */
export function formatAvu(avu: number): string {
  if (!Number.isFinite(avu) || avu <= 0) return ''
  // A plain decimal, never an exponent: the compact formatter reads digits. (toFixed
  // itself switches to an exponent from 1e21 up.)
  const digits =
    avu >= 1e15 ? BigInt(Math.round(avu)).toString() : avu.toFixed(18)
  return compactAmountText(`${digits} AVU`)
}
