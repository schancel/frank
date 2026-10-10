import type { SupportedAsset } from '@frank/wallet/oracle'

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
