import { calculateAvuRate } from "./energy-basket";
import { PriceFeedsClient } from "@frank/price-feeds";

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
  /** The same prices in AVU: price divided by the dollar value of one AVU. */
  rates: AvuRates;
  /** When each asset's price was fetched (Unix ms). An old time means a stale price. */
  fetchedAt: Partial<Record<SupportedAsset, number>>;
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
  };
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

/**
 * Fetches the market price of every asset in ASSET_FEED_SYMBOLS across the configured
 * providers (Chainlink, Pyth, Coinbase, Kraken, CoinGecko, Binance) and states each in AVU.
 *
 * AVU is a unit of account, not a coin: one AVU is the fixed dollar amount
 * POW_BASELINE_DOLLARS_PER_KWH (energy-basket.ts), so an asset's rate is its fetched price
 * divided by that one number and any two assets compare through it.
 *
 * Nothing is substituted. An asset whose price did not come back is absent from the
 * snapshot. If the fetch fails the snapshot is the unavailable one.
 */
export async function fetchOracleSnapshot(
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs = 4000,
  client?: PriceFeedsClient
): Promise<OracleSnapshot> {
  if (typeof fetchFn !== "function" && !client) {
    return unavailableOracleSnapshot();
  }

  try {
    const feedsClient =
      client ||
      new PriceFeedsClient({
        fetchFn,
        timeoutMs,
        defaultStrategy: "median",
      });

    const assets = Object.entries(ASSET_FEED_SYMBOLS) as Array<
      [SupportedAsset, string]
    >;
    const sampled = await feedsClient.getSnapshot(
      assets.map(([, symbol]) => symbol)
    );

    const snapshot = unavailableOracleSnapshot();
    for (const [asset, symbol] of assets) {
      const price = sampled[symbol]?.price;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        snapshot.prices[asset] = price;
        snapshot.rates[asset] = calculateAvuRate(price);
        snapshot.fetchedAt[asset] = snapshot.timestamp;
      }
    }
    return snapshot;
  } catch {
    return unavailableOracleSnapshot();
  }
}

/**
 * Dollars of newly issued coin per kWh of mining, from dollars issued per hash and the
 * energy one hash is taken to cost. The joules-per-hash figure is an assumption about the
 * mining fleet, not a measurement; callers must say which one they used.
 */
export function miningDollarsPerKwh(
  usdPerHash: number,
  joulesPerHash: number
): number | undefined {
  if (!(usdPerHash > 0) || !(joulesPerHash > 0)) return undefined;
  return (usdPerHash / joulesPerHash) * 3.6e6;
}
