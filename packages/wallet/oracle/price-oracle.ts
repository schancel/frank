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
  type MiningStats,
  type PriceProviderId,
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

/** One asset's price as one fetch returned it. */
export interface FetchedPrice {
  /** The median across the providers that answered, in US dollars. */
  usd: number;
  /** How many providers' prices that median is of, after outliers are set aside. */
  sources: number;
  /** What each provider that answered returned, in US dollars. */
  providers: Partial<Record<PriceProviderId, number>>;
}

/** The prices one fetch returned. An asset whose price did not come back is absent. */
export interface FetchedPrices {
  /** When the fetch finished (Unix ms). */
  timestamp: number;
  prices: Partial<Record<SupportedAsset, FetchedPrice>>;
}

export interface FetchPricesOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  client?: PriceFeedsClient;
}

/**
 * Fetches the market price of every asset in ASSET_FEED_SYMBOLS across the configured
 * providers (Chainlink, Pyth, Coinbase, Kraken, CoinGecko, Binance): each provider's own
 * answer and their median.
 *
 * Nothing is substituted: an asset no provider answered for is absent, and a fetch that
 * fails altogether returns no prices. Chain statistics are fetched separately
 * (fetchMiningStats); AVU_hash is computed from both by rateOracleSnapshot.
 */
export async function fetchPrices(
  options: FetchPricesOptions = {}
): Promise<FetchedPrices> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const fetched: FetchedPrices = { timestamp: Date.now(), prices: {} };
  if (typeof fetchFn !== "function" && !options.client) return fetched;

  try {
    const feedsClient =
      options.client ||
      new PriceFeedsClient({
        fetchFn,
        timeoutMs: options.timeoutMs ?? 4000,
        defaultStrategy: "median",
      });
    const assets = Object.entries(ASSET_FEED_SYMBOLS) as Array<
      [SupportedAsset, string]
    >;
    const sampled = await feedsClient.getSnapshot(
      assets.map(([, symbol]) => symbol)
    );
    fetched.timestamp = Date.now();
    for (const [asset, symbol] of assets) {
      const result = sampled[symbol];
      const usd = result?.price;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
        continue;
      }
      const providers: FetchedPrice["providers"] = {};
      for (const sample of result.samples ?? []) {
        providers[sample.provider] = sample.price;
      }
      fetched.prices[asset] = { usd, sources: result.sampleCount, providers };
    }
  } catch {
    // No prices: the caller keeps what it last fetched.
  }
  return fetched;
}
