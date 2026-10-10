import {
  AVU_HASH_BASKET,
  HASHING_EFFICIENCY,
  avuPerCoin,
  computeAvuHash,
  type AvuHash,
  type PriceReading,
} from "./energy-basket";
import {
  PriceFeedsClient,
  fetchMiningStats,
  type MiningStats,
} from "@frank/price-feeds";

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
 * The market each asset's price is fetched under. An asset absent from this table has no
 * price source, so it has no rate and nothing shows an AVU value for it. There are no
 * stand-in prices: a number is always one a provider returned.
 *
 * `monad` is priced as mainnet MON. Tempo's test dollar is absent: no provider prices it,
 * and "one dollar" would be a peg assumption, not a price.
 */
export const ASSET_FEED_SYMBOLS: Partial<Record<SupportedAsset, string>> = {
  monad: "MON",
  ethereum: "ETH",
  solana: "SOL",
  ecash: "XEC",
  hyperliquid: "HYPE",
  bitcoin: "BTC",
  bitcoincash: "BCH",
  dogecoin: "DOGE",
};

/** AVU per whole unit of an asset, only for assets whose price was fetched. */
export type AvuRates = Partial<Record<SupportedAsset, number>>;

/** US dollars per whole unit of an asset, only for assets whose price was fetched. */
export type UsdPrices = Partial<Record<SupportedAsset, number>>;

export interface OracleSnapshot {
  epoch: string;
  /** When the fetch that produced this snapshot finished. */
  timestamp: number;
  /** Fetched market prices. */
  prices: UsdPrices;
  /** The same prices in AVU (kWh per coin): price times AVU_hash. Empty without AVU_hash. */
  rates: AvuRates;
  /** When each asset's price was fetched (Unix ms). An old time means a stale price. */
  fetchedAt: Partial<Record<SupportedAsset, number>>;
  /**
   * How many providers' prices each asset's price is the median of. One means the price
   * rests on a single source.
   */
  priceSources: Partial<Record<SupportedAsset, number>>;
  /** Fetched chain statistics of the mined coins in the basket, by Blockchair chain name. */
  mining: Record<string, MiningStats>;
  /** kWh per dollar read off mining. Absent when no basket entry has all its inputs. */
  avuHash?: AvuHash;
}

export interface SwapParityResult {
  parityPercent: number;
  status: "fair" | "premium" | "discount" | "warning";
  sendAvu: number;
  receiveAvu: number;
}

/** What is known when nothing has been fetched, or a fetch failed: no prices at all. */
export function unavailableOracleSnapshot(): OracleSnapshot {
  return {
    epoch: "pow-energy-standard-v1",
    timestamp: Date.now(),
    prices: {},
    rates: {},
    fetchedAt: {},
    priceSources: {},
    mining: {},
  };
}

/** The Blockchair chains of every basket entry that has an efficiency series to compute with. */
export const AVU_HASH_CHAINS: readonly string[] = AVU_HASH_BASKET.filter(
  (entry) => HASHING_EFFICIENCY[entry.algorithm]
).flatMap((entry) => entry.chains.map((chain) => chain.chain));

/**
 * Computes AVU_hash from the snapshot's prices and chain statistics and restates every
 * price in AVU with it. Whatever `rates` and `avuHash` held before is discarded: they are
 * only ever derived from the prices and statistics beside them.
 */
export function rateOracleSnapshot(snapshot: OracleSnapshot): OracleSnapshot {
  const readings: Record<string, PriceReading> = {};
  const assets = Object.entries(ASSET_FEED_SYMBOLS) as Array<
    [SupportedAsset, string]
  >;
  for (const [asset, symbol] of assets) {
    const usd = snapshot.prices[asset];
    const fetchedAt = snapshot.fetchedAt[asset];
    if (usd !== undefined && fetchedAt !== undefined) {
      readings[symbol] = { usd, fetchedAt };
    }
  }
  const avuHash = computeAvuHash(readings, snapshot.mining);
  const rates: AvuRates = {};
  for (const [asset] of assets) {
    const rate = avuPerCoin(snapshot.prices[asset] ?? 0, avuHash);
    if (rate !== undefined) rates[asset] = rate;
  }
  const rated: OracleSnapshot = { ...snapshot, rates };
  if (avuHash) rated.avuHash = avuHash;
  else delete rated.avuHash;
  return rated;
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

/**
 * Formats an AVU numeric value for human display in the UI.
 */
export function formatAvu(avu: number): string {
  if (!Number.isFinite(avu) || avu <= 0) {
    return "0 AVU";
  }
  if (avu < 0.01) {
    return "< 0.01 AVU";
  }
  if (avu >= 1000) {
    return `${avu.toLocaleString("en-US", { maximumFractionDigits: 1 })} AVU`;
  }
  return `${avu.toFixed(2)} AVU`;
}

/**
 * Evaluates the economic parity of an atomic swap offer at the given AVU rates. Undefined when
 * either asset has no rate: parity against an unknown price cannot be stated.
 */
export function calculateSwapParity(
  sendRaw: bigint,
  sendAsset: SupportedAsset,
  receiveRaw: bigint,
  receiveAsset: SupportedAsset,
  rates: AvuRates
): SwapParityResult | undefined {
  const sendAvu = convertRawToAvu(sendRaw, sendAsset, rates[sendAsset]);
  const receiveAvu = convertRawToAvu(
    receiveRaw,
    receiveAsset,
    rates[receiveAsset]
  );
  if (sendAvu === undefined || receiveAvu === undefined) return undefined;

  if (sendAvu <= 0) {
    return { parityPercent: 0, status: "fair", sendAvu: 0, receiveAvu };
  }

  const parityPercent = ((receiveAvu - sendAvu) / sendAvu) * 100;
  let status: "fair" | "premium" | "discount" | "warning" = "fair";

  if (parityPercent < -20) {
    status = "warning";
  } else if (parityPercent < -5) {
    status = "discount";
  } else if (parityPercent > 5) {
    status = "premium";
  }

  return { parityPercent, status, sendAvu, receiveAvu };
}

export interface FetchOracleOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  client?: PriceFeedsClient;
  /** Chain statistics still fresh enough to reuse; these chains are not refetched. */
  knownMining?: Record<string, MiningStats>;
  /** Reads one chain's statistics. The seam tests stub. */
  fetchStats?: (chain: string) => Promise<MiningStats | null>;
}

/**
 * Fetches the market price of every asset in ASSET_FEED_SYMBOLS across the configured
 * providers (Chainlink, Pyth, Coinbase, Kraken, CoinGecko, Binance) and the chain
 * statistics of the mined coins in the basket, computes AVU_hash from them
 * (energy-basket.ts) and states each price in AVU: price times AVU_hash, kWh per coin.
 *
 * Nothing is substituted. An asset whose price did not come back is absent from the
 * snapshot. Without AVU_hash no asset has an AVU rate. If the price fetch fails the
 * snapshot is the unavailable one.
 */
export async function fetchOracleSnapshot(
  options: FetchOracleOptions = {}
): Promise<OracleSnapshot> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4000;
  if (typeof fetchFn !== "function" && !options.client) {
    return unavailableOracleSnapshot();
  }

  try {
    const feedsClient =
      options.client ||
      new PriceFeedsClient({
        fetchFn,
        timeoutMs,
        defaultStrategy: "median",
      });
    const fetchStats =
      options.fetchStats ??
      ((chain: string) => fetchMiningStats(chain, { fetchFn }));
    const knownMining = options.knownMining ?? {};

    const assets = Object.entries(ASSET_FEED_SYMBOLS) as Array<
      [SupportedAsset, string]
    >;
    const [sampled, stats] = await Promise.all([
      feedsClient.getSnapshot(assets.map(([, symbol]) => symbol)),
      Promise.all(
        AVU_HASH_CHAINS.filter((chain) => !knownMining[chain]).map((chain) =>
          fetchStats(chain).catch(() => null)
        )
      ),
    ]);

    const snapshot = unavailableOracleSnapshot();
    for (const [asset, symbol] of assets) {
      const price = sampled[symbol]?.price;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        snapshot.prices[asset] = price;
        snapshot.fetchedAt[asset] = snapshot.timestamp;
        snapshot.priceSources[asset] = sampled[symbol].sampleCount;
      }
    }
    snapshot.mining = { ...knownMining };
    for (const chainStats of stats) {
      if (chainStats) snapshot.mining[chainStats.chain] = chainStats;
    }
    return rateOracleSnapshot(snapshot);
  } catch {
    return unavailableOracleSnapshot();
  }
}
