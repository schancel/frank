/**
 * What proof-of-work miners are paid per unit of hashing, from each chain's own
 * published statistics (Blockchair's public /stats endpoint).
 *
 * Fetched per chain: the coins newly issued in the last 24 hours, the average hashrate
 * over the same 24 hours, and the market price. Nothing is assumed about block reward,
 * block time or halvings: the issuance is what the chain actually minted. Transaction
 * fees are not included, and issuance is the whole block subsidy, including any part
 * a chain's rules send to someone other than the miner.
 */

export interface MiningStats {
  /** Blockchair chain name, e.g. "bitcoin-cash". */
  chain: string
  /** US dollars of new coins issued per second, averaged over the last 24 hours. */
  issuanceUsdPerSecond: number
  /** Average hashes per second over the last 24 hours. */
  hashrateHps: number
  /** US dollars of new coins issued per hash computed. */
  usdPerHash: number
  fetchedAt: number
}

export const BLOCKCHAIR_API_BASE = 'https://api.blockchair.com'

/** Base units per coin, needed to read Blockchair's issuance figure. */
export const BLOCKCHAIR_CHAIN_DECIMALS: Record<string, number> = {
  bitcoin: 8,
  'bitcoin-cash': 8,
  ecash: 2,
}

export async function fetchMiningStats(
  chain: string,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<MiningStats | null> {
  const decimals = BLOCKCHAIR_CHAIN_DECIMALS[chain]
  if (decimals === undefined) return null
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000)
  try {
    const response = await fetchFn(`${BLOCKCHAIR_API_BASE}/${chain}/stats`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    const stats = (await response.json())?.data
    const issued24h = Number(stats?.inflation_24h)
    const hashrateHps = Number(stats?.hashrate_24h)
    const priceUsd = Number(stats?.market_price_usd)
    if (!(issued24h > 0) || !(hashrateHps > 0) || !(priceUsd > 0)) return null
    const issuanceUsdPerSecond =
      ((issued24h / 10 ** decimals) * priceUsd) / 86_400
    return {
      chain,
      issuanceUsdPerSecond,
      hashrateHps,
      usdPerHash: issuanceUsdPerSecond / hashrateHps,
      fetchedAt: Date.now(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
