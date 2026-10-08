import {
  computeEnergyBasketIndex,
  calculateAvuRate,
  POW_BASELINE_DOLLARS_PER_KWH,
  AVU_PER_DOLLAR,
  AVU_ENERGY_ANCHOR_NOMINAL,
} from "./energy-basket";

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
 * Baseline anchor spot rates (in nominal base units, e.g. USD) at epoch genesis.
 * Used for offline cold-start fallback when external oracle network is unreachable.
 */
export const DEFAULT_ANCHOR_SPOT_PRICES: Record<SupportedAsset, number> = {
  monad: 3.5, // $3.50
  ecash: 0.000035, // $0.000035 (1,000,000 XEC = $35)
  solana: 150.0, // $150.00
  tempo: 1.0, // $1.00 (stablecoin)
  ethereum: 2600.0, // $2,600.00
  hyperliquid: 40.0, // $40.00
  bitcoin: 65000.0, // $65,000.00
  bitcoincash: 350.0, // $350.00
  dogecoin: 0.15, // $0.15
};

/**
 * Default AVU exchange rates derived from baseline anchor prices:
 * 1 AVU = 1 kWh energy equivalent ≈ $0.084 nominal PoW baseline (11.90476 AVU / $).
 */
export const DEFAULT_AVU_RATES: Record<SupportedAsset, number> = {
  monad: DEFAULT_ANCHOR_SPOT_PRICES.monad * AVU_PER_DOLLAR, // ~41.67 AVU
  ecash: DEFAULT_ANCHOR_SPOT_PRICES.ecash * AVU_PER_DOLLAR, // ~0.0004167 AVU
  solana: DEFAULT_ANCHOR_SPOT_PRICES.solana * AVU_PER_DOLLAR, // ~1,785.71 AVU
  tempo: DEFAULT_ANCHOR_SPOT_PRICES.tempo * AVU_PER_DOLLAR, // ~11.90 AVU
  ethereum: DEFAULT_ANCHOR_SPOT_PRICES.ethereum * AVU_PER_DOLLAR, // ~30,952.38 AVU
  hyperliquid: DEFAULT_ANCHOR_SPOT_PRICES.hyperliquid * AVU_PER_DOLLAR, // ~476.19 AVU
  bitcoin: DEFAULT_ANCHOR_SPOT_PRICES.bitcoin * AVU_PER_DOLLAR, // ~773,809.52 AVU
  bitcoincash: DEFAULT_ANCHOR_SPOT_PRICES.bitcoincash * AVU_PER_DOLLAR, // ~4,166.67 AVU
  dogecoin: DEFAULT_ANCHOR_SPOT_PRICES.dogecoin * AVU_PER_DOLLAR, // ~1.79 AVU
};

export interface OracleSnapshot {
  epoch: string;
  timestamp: number;
  basketIndex: number;
  rates: Record<SupportedAsset, number>;
}

export interface SwapParityResult {
  parityPercent: number;
  status: "fair" | "premium" | "discount" | "warning";
  sendAvu: number;
  receiveAvu: number;
}

export function getDefaultOracleSnapshot(): OracleSnapshot {
  return {
    epoch: "pow-energy-standard-v1",
    timestamp: Date.now(),
    basketIndex: 1.0,
    rates: { ...DEFAULT_AVU_RATES },
  };
}

/**
 * Converts a raw base-unit integer (wei, satoshis, lamports) to its equivalent in AVU.
 */
export function convertRawToAvu(
  rawAmount: bigint | null | undefined,
  asset: SupportedAsset,
  customRate?: number
): number {
  if (rawAmount === null || rawAmount === undefined || rawAmount <= 0n) {
    return 0;
  }
  const rate = customRate ?? DEFAULT_AVU_RATES[asset];
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
 * Evaluates the economic parity of an atomic swap offer relative to current energy basket AVU rates.
 */
export function calculateSwapParity(
  sendRaw: bigint,
  sendAsset: SupportedAsset,
  receiveRaw: bigint,
  receiveAsset: SupportedAsset,
  rates: Record<SupportedAsset, number> = DEFAULT_AVU_RATES
): SwapParityResult {
  const sendAvu = convertRawToAvu(sendRaw, sendAsset, rates[sendAsset]);
  const receiveAvu = convertRawToAvu(
    receiveRaw,
    receiveAsset,
    rates[receiveAsset]
  );

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
 * Pyth Network public price feed IDs (32-byte hex strings).
 */
export const PYTH_FEED_IDS = {
  // Commodities
  gold: "0x765d2ba906da5188bb6811c0f9d250760786520b41259398f6912f7166396344",
  brent: "0x27f547c8702b80053e1a74288b832b8519cf2d815777a164f0b2fbe8eb2eb471",
  // Crypto
  solana: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  ethereum:
    "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

export const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,ecash&vs_currencies=usd";

/**
 * Asynchronously fetches public price feeds from Pyth Hermes and computes
 * an updated OracleSnapshot. Returns a default snapshot on error or timeout.
 */
import { PriceFeedsClient } from "@frank/price-feeds";

/**
 * Asynchronously fetches public price feeds across multi-provider consensus (Chainlink,
 * Pyth, Coinbase, Kraken, CoinGecko, Binance) and computes an updated OracleSnapshot.
 * Returns a default snapshot on error or timeout.
 */
export async function fetchOracleSnapshot(
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs = 4000,
  client?: PriceFeedsClient
): Promise<OracleSnapshot> {
  const defaultSnapshot = getDefaultOracleSnapshot();
  if (typeof fetchFn !== "function") {
    return defaultSnapshot;
  }

  try {
    const feedsClient =
      client ||
      new PriceFeedsClient({
        fetchFn,
        timeoutMs,
        defaultStrategy: "median",
      });

    const snapshot = await feedsClient.getSnapshot([
      "ETH",
      "SOL",
      "XEC",
      "GOLD",
      "BRENT",
    ]);

    const goldSpot = snapshot.GOLD?.price || 2650.0;
    const brentSpot = snapshot.BRENT?.price || 75.0;
    const solSpot = snapshot.SOL?.price || 150.0;
    const ethSpot = snapshot.ETH?.price || 2600.0;
    const ecashSpot = snapshot.XEC?.price || DEFAULT_ANCHOR_SPOT_PRICES.ecash;

    const basketIndex = computeEnergyBasketIndex({
      gold: goldSpot,
      brentCrude: brentSpot,
    });

    const rates: Record<SupportedAsset, number> = {
      monad: calculateAvuRate(DEFAULT_ANCHOR_SPOT_PRICES.monad, basketIndex),
      ecash: calculateAvuRate(ecashSpot, basketIndex),
      solana: calculateAvuRate(solSpot, basketIndex),
      tempo: calculateAvuRate(1.0, basketIndex),
      ethereum: calculateAvuRate(ethSpot, basketIndex),
      hyperliquid: calculateAvuRate(
        DEFAULT_ANCHOR_SPOT_PRICES.hyperliquid,
        basketIndex
      ),
      bitcoin: calculateAvuRate(
        DEFAULT_ANCHOR_SPOT_PRICES.bitcoin,
        basketIndex
      ),
      bitcoincash: calculateAvuRate(
        DEFAULT_ANCHOR_SPOT_PRICES.bitcoincash,
        basketIndex
      ),
      dogecoin: calculateAvuRate(
        DEFAULT_ANCHOR_SPOT_PRICES.dogecoin,
        basketIndex
      ),
    };

    return {
      epoch: "pow-energy-standard-v1",
      timestamp: Date.now(),
      basketIndex,
      rates,
    };
  } catch {
    return defaultSnapshot;
  }
}
