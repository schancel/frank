/** Observed 24-hour mining receipts and upstream estimated hashrate, never difficulty. */
import { ORACLE_ENDPOINTS } from './config'

export interface MiningStats {
  /** Blockchair chain name, e.g. "bitcoin-cash". */
  chain: string
  /** Whole coins newly issued in the observed 24-hour block set. */
  subsidyCoins24h: number
  /** Actual fees in the same block set; undefined means unavailable, never zero. */
  feeCoins24h?: number
  /** Upstream observed-work estimate, hashes/second over 24 hours. */
  hashrate24h: number
  /** Provider block-time endpoint of the trailing observation, Unix seconds. */
  observationEnd: number
  firstBlock: number
  lastBlock: number
  /** Whole coins in existence; times the oracle's price it is the market capitalisation. */
  circulatingCoins: number
  fetchedAt: number
}

export const BLOCKCHAIR_API_BASE = ORACLE_ENDPOINTS.blockchair.stats

/**
 * A block is found, on average, once per `difficulty x 2^32` hashes on chains that keep
 * Bitcoin's proof-of-work rule: difficulty 1 is the target 0x00000000ffff..., which one
 * hash in 2^32 meets. Litecoin and Dogecoin define difficulty the same way over scrypt.
 */
export const HASHES_PER_DIFFICULTY = 2 ** 32

export interface MinedChain {
  /** Base units per whole coin; only used for actual observed receipt amounts. */
  decimals: number
}
export const MINED_CHAINS: Record<string, MinedChain> = {
  'bitcoin': { decimals: 8 },
  'bitcoin-cash': { decimals: 8 },
  'ecash': { decimals: 2 },
  'litecoin': { decimals: 8 },
  'dogecoin': { decimals: 8 },
  'monero': { decimals: 12 },
}

export async function fetchMiningStats(
  chain: string,
  options: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<MiningStats | null> {
  const facts = MINED_CHAINS[chain]
  if (!facts) return null
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
    const unit = 10 ** facts.decimals
    const blocks = stats?.blocks_24h
    const lastBlock = stats?.best_block_height
    const observationEnd = utcTimestamp(stats?.best_block_time)
    const hashrate24h = positive(stats?.hashrate_24h)
    const circulatingCoins = positive(stats?.circulation)
    const issuance = positive(stats?.inflation_24h)
    if (
      !Number.isSafeInteger(blocks) ||
      blocks <= 0 ||
      !Number.isSafeInteger(lastBlock) ||
      lastBlock < blocks - 1 ||
      issuance === undefined ||
      observationEnd === undefined ||
      hashrate24h === undefined ||
      circulatingCoins === undefined
    )
      return null
    const firstBlock = lastBlock - blocks + 1
    // An aggregate over an immutable height range, not rounded average fee x tx count.
    // Verify issuance/count against the stats snapshot: missing or mismatched observations
    // are unavailable, never silently subsidy-only or fee-free.
    const query = new URLSearchParams({
      a: 'sum(fee_total),sum(generation),count()',
      q: `id(${firstBlock}..${lastBlock})`,
    })
    // Subsidy/work remain observed even when the optional exact fee source fails.
    let feeCoins24h: number | undefined
    try {
      const aggregateResponse = await fetchFn(
        `${BLOCKCHAIR_API_BASE}/${chain}/blocks?${query}`,
        { signal: controller.signal, headers: { Accept: 'application/json' } },
      )
      if (aggregateResponse.ok) {
        const rows = (await aggregateResponse.json())?.data
        if (Array.isArray(rows) && rows.length === 1) {
          const row = rows[0]
          const generation = positive(row?.['sum(generation)'])
          const fees = nonnegative(row?.['sum(fee_total)'])
          if (
            generation === issuance &&
            fees !== undefined &&
            row?.['count()'] === blocks
          )
            feeCoins24h = fees / unit
        }
      }
    } catch {
      // Transport, decoding and timeout failures do not turn absent fees into zero.
    }
    return {
      chain,
      subsidyCoins24h: issuance / unit,
      ...(feeCoins24h === undefined ? {} : { feeCoins24h }),
      hashrate24h,
      observationEnd,
      firstBlock,
      lastBlock,
      circulatingCoins: circulatingCoins / unit,
      fetchedAt: Date.now(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Reject coercions such as null, empty strings and booleans as observations. */
function nonnegative(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value))
    return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
function positive(value: unknown): number | undefined {
  const n = nonnegative(value)
  return n !== undefined && n > 0 ? n : undefined
}

/** Blockchair dates are UTC; reject malformed dates rather than using fetch time. */
function utcTimestamp(value: unknown): number | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
  )
    return undefined
  const iso = `${value.replace(' ', 'T')}Z`
  const milliseconds = Date.parse(iso)
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== iso.replace('Z', '.000Z')
  )
    return undefined
  return milliseconds / 1000
}
