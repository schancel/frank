/**
 * The one place that says where every run-time input of the price and AVU oracle is
 * fetched from, and how often.
 *
 * These are the endpoints of the temporary direct adapter (temporary-direct-feed.ts); they
 * go when the relay serves the oracle feed. Electricity prices are not here: they are
 * bundled files (src/historical), never fetched while the app runs.
 */

/**
 * How long a fetched series is served from the local cache before it is fetched again.
 * A series is only fetched at all while something on screen is showing it.
 */
export const ORACLE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Chain statistics (difficulty, issuance, supply) move slowly and come from one free
 * public API, so they are fetched once an hour: 6 chains x 24 = 144 requests a day per
 * open app, where every ten minutes would be 864.
 */
export const CHAIN_STATS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Two providers that differ by more than this share of the lower price do not make a
 * price: with only two answers there is no telling which one is wrong, and their middle
 * would be half the error. Three or more answers are settled by the median.
 */
export const MAX_TWO_SOURCE_SPREAD_PCT = 10;

export const ORACLE_ENDPOINTS = {
  /** Chainlink price feeds are contracts read with eth_call on Arbitrum One. */
  chainlink: { arbitrumRpc: "https://arb1.arbitrum.io/rpc" },
  pyth: { latestPrice: "https://hermes.pyth.network/v2/updates/price/latest" },
  coinbase: { spotPrice: "https://api.coinbase.com/v2/prices" },
  kraken: { ticker: "https://api.kraken.com/0/public/Ticker" },
  coingecko: { simplePrice: "https://api.coingecko.com/api/v3/simple/price" },
  binance: {
    ticker: "https://api.binance.com/api/v3/ticker/price",
    /** Asked only when binance.com does not answer. */
    tickerUs: "https://api.binance.us/api/v3/ticker/price",
  },
  /** Chain statistics (difficulty, issuance, supply): `${stats}/<chain>/stats`. */
  blockchair: { stats: "https://api.blockchair.com" },
} as const;
