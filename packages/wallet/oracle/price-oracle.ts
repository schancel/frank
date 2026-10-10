import {
  avuHashAt,
  avuPerCoin,
  avuSpotAt,
  type AvuHash,
  type AvuSpot,
  type OracleInputs,
} from "./energy-basket";
import { at, seriesName } from "@frank/price-feeds";
import { mainnetChainIdOfKind } from "../chain/chains-registry";

export type SupportedAsset =
  | "monad"
  | "ecash"
  | "solana"
  | "tempo"
  | "ethereum"
  | "hyperliquid"
  | "bitcoin"
  | "bitcoincash"
  | "dogecoin";

export const ASSET_DECIMALS: Record<SupportedAsset, number> = {
  monad: 18,
  ecash: 2,
  solana: 9,
  tempo: 6,
  ethereum: 18,
  hyperliquid: 18,
  bitcoin: 8,
  bitcoincash: 8,
  dogecoin: 8,
};

/**
 * The feed asset id an asset is priced under: its main network's canonical chain id,
 * whichever network the wallet is on. Undefined for an asset with no main network in the
 * registry; an asset the feed carries no price series for simply has no rate.
 */
export function priceAssetId(asset: SupportedAsset): string | undefined {
  return mainnetChainIdOfKind(asset);
}

/** AVU per whole unit of an asset, only for assets the feed has a price for. */
export type AvuRates = Partial<Record<SupportedAsset, number>>;

export const SUPPORTED_ASSETS = Object.keys(
  ASSET_DECIMALS
) as SupportedAsset[];

/**
 * Everything the app shows about value, computed once from the feed for one time: the
 * AVU rate of each asset, and the two readings behind them. Balances and amounts read
 * `rates`; nothing recomputes per component.
 */
export interface OracleRates {
  /** The time (unix seconds) the rates are for. */
  at: number;
  /** AVU (kWh) per whole coin: price x AVU_hash. Empty without AVU_hash. */
  rates: AvuRates;
  /** The time (unix seconds) of the price each rate was computed from. */
  priceAt: Partial<Record<SupportedAsset, number>>;
  /** The price series of an asset was flagged stale by whoever served it. */
  priceStale: Partial<Record<SupportedAsset, boolean>>;
  avuHash?: AvuHash;
  avuSpot: AvuSpot;
}

/** No feed: no rates. Never a default value. */
export function unavailableOracleRates(at = 0): OracleRates {
  return {
    at,
    rates: {},
    priceAt: {},
    priceStale: {},
    avuSpot: { unavailable: "no-data" },
  };
}

/** The rates at a time, from the feed's series by floor lookup. */
export function computeOracleRates(
  inputs: OracleInputs,
  t: number
): OracleRates {
  const avuHash = avuHashAt(inputs, t);
  const computed: OracleRates = {
    ...unavailableOracleRates(t),
    avuSpot: avuSpotAt(inputs, t),
  };
  if (avuHash) computed.avuHash = avuHash;
  for (const asset of SUPPORTED_ASSETS) {
    const id = priceAssetId(asset);
    const series = id ? inputs.series[seriesName("price", id)] : undefined;
    const price = at(series?.points, t);
    const rate = price ? avuPerCoin(price[1], avuHash) : undefined;
    if (!price || rate === undefined) continue;
    computed.rates[asset] = rate;
    computed.priceAt[asset] = price[0];
    computed.priceStale[asset] = Boolean(series?.stale);
  }
  return computed;
}

/**
 * Converts a raw base-unit integer (wei, satoshis, lamports) to its equivalent in AVU at `rate`.
 * Returns undefined when there is no rate for the asset: an unknown price is not zero.
 */
export function convertRawToAvu(
  rawAmount: bigint | null | undefined,
  asset: SupportedAsset,
  rate: number | undefined
): number | undefined {
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    return undefined;
  }
  if (rawAmount === null || rawAmount === undefined || rawAmount <= 0n) {
    return 0;
  }
  const decimals = ASSET_DECIMALS[asset];
  const scale = 10n ** BigInt(decimals);

  const whole = rawAmount / scale;
  const remainder = rawAmount % scale;
  const nominal = Number(whole) + Number(remainder) / Number(scale);
  return nominal * rate;
}

const AVU_PREFIXES: ReadonlyArray<[number, string]> = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "μ"],
  [1e-9, "n"],
];

/**
 * An AVU figure in the app's compact style: three significant digits and an SI prefix,
 * "1.31 kAVU", "92.5 AVU", "4.2 mAVU". Short enough for a list row. Empty for nothing or
 * for a value that is not a positive number: an unknown value is not "0 AVU".
 */
export function formatAvu(avu: number): string {
  if (!Number.isFinite(avu) || avu <= 0) return "";
  const [scale, prefix] =
    AVU_PREFIXES.find(([threshold]) => avu >= threshold) ??
    AVU_PREFIXES[AVU_PREFIXES.length - 1];
  const scaled = avu / scale;
  if (scaled < 0.001) return "< 0.001 nAVU";
  // toPrecision can round 999.6 up to 1000: Number() drops the exponent and zeros.
  return `${Number(scaled.toPrecision(3))} ${prefix}AVU`;
}
