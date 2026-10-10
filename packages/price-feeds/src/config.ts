/**
 * The one place that says where every run-time input of the price and AVU oracle is
 * fetched from, and how often.
 *
 * Electricity prices are not here: they are bundled files (src/historical), never fetched
 * while the app runs.
 */

/**
 * How long a fetched series is served from the local cache before it is fetched again.
 * A series is only fetched at all while something on screen is showing it.
 */
export const ORACLE_REFRESH_INTERVAL_MS = 10 * 60 * 1000

export const ORACLE_ENDPOINTS = {
  /** Chainlink price feeds are contracts read with eth_call on Arbitrum One. */
  chainlink: { arbitrumRpc: 'https://arb1.arbitrum.io/rpc' },
  pyth: { latestPrice: 'https://hermes.pyth.network/v2/updates/price/latest' },
  coinbase: {
    spotPrice: 'https://api.coinbase.com/v2/prices',
    candles: 'https://api.exchange.coinbase.com/products',
  },
  kraken: {
    ticker: 'https://api.kraken.com/0/public/Ticker',
    ohlc: 'https://api.kraken.com/0/public/OHLC',
  },
  coingecko: {
    simplePrice: 'https://api.coingecko.com/api/v3/simple/price',
    coins: 'https://api.coingecko.com/api/v3/coins',
  },
  binance: {
    ticker: 'https://api.binance.com/api/v3/ticker/price',
    /** Asked only when binance.com does not answer. */
    tickerUs: 'https://api.binance.us/api/v3/ticker/price',
    klinesUs: 'https://api.binance.us/api/v3/klines',
  },
  /** Chain statistics (difficulty, issuance, supply): `${stats}/<chain>/stats`. */
  blockchair: { stats: 'https://api.blockchair.com' },
} as const
