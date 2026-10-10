/**
 * The chain facts the AVU_hash formula needs for one proof-of-work chain, read from the
 * chain's own published statistics (Blockchair's public /stats endpoint):
 *
 *   - coins per block: the coins newly minted in the last 24 hours divided by the blocks
 *     found in the same 24 hours. This is what the chain actually issued, so a halving is
 *     followed without a schedule being kept here. It is the whole subsidy, including any
 *     part a chain's rules send to someone other than the miner, and excludes fees.
 *   - hashes per block: the expected number of hashes to find a block at the current
 *     difficulty.
 *   - coins in existence, for the market capitalisation the basket is weighted by.
 *
 * No price is read here: prices come from the price oracle.
 */

export interface MiningStats {
  /** Blockchair chain name, e.g. "bitcoin-cash". */
  chain: string
  /** Whole coins minted per block, averaged over the last 24 hours of blocks. */
  subsidyCoinsPerBlock: number
  /** The chain's current difficulty. */
  difficulty: number
  /** Expected hashes to find one block at that difficulty. */
  hashesPerBlock: number
  /** Whole coins in existence; times the oracle's price it is the market capitalisation. */
  circulatingCoins: number
  fetchedAt: number
}

export const BLOCKCHAIR_API_BASE = 'https://api.blockchair.com'

/**
 * A block is found, on average, once per `difficulty x 2^32` hashes on chains that keep
 * Bitcoin's proof-of-work rule: difficulty 1 is the target 0x00000000ffff..., which one
 * hash in 2^32 meets. Litecoin and Dogecoin define difficulty the same way over scrypt.
 */
export const HASHES_PER_DIFFICULTY = 2 ** 32

export interface MinedChain {
  /** Base units per coin are 10^decimals, needed to read Blockchair's coin amounts. */
  decimals: number
  /** Expected hashes per block for each unit of difficulty. */
  hashesPerDifficulty: number
  /**
   * Coins per block where Blockchair publishes no issuance for the chain and the consensus
   * rule is a constant.
   */
  fixedSubsidyCoinsPerBlock?: number
}

export const MINED_CHAINS: Record<string, MinedChain> = {
  bitcoin: { decimals: 8, hashesPerDifficulty: HASHES_PER_DIFFICULTY },
  'bitcoin-cash': { decimals: 8, hashesPerDifficulty: HASHES_PER_DIFFICULTY },
  ecash: { decimals: 2, hashesPerDifficulty: HASHES_PER_DIFFICULTY },
  litecoin: { decimals: 8, hashesPerDifficulty: HASHES_PER_DIFFICULTY },
  dogecoin: { decimals: 8, hashesPerDifficulty: HASHES_PER_DIFFICULTY },
  // Monero's difficulty is itself the expected number of hashes per block. Its subsidy is
  // the tail emission: FINAL_SUBSIDY_PER_MINUTE = 3e11 atomic units a minute over
  // DIFFICULTY_TARGET_V2 = 120-second blocks, with COIN = 1e12, is 0.6 XMR a block
  // (monero-project/monero src/cryptonote_config.h, read 2026-10-09). The tail applies
  // once the main emission curve pays less than that, which it has since the supply
  // passed 2^64 - 1 atomic units less 0.6 XMR x 2^19 (get_block_reward,
  // src/cryptonote_basic/cryptonote_basic_impl.cpp).
  monero: {
    decimals: 12,
    hashesPerDifficulty: 1,
    fixedSubsidyCoinsPerBlock: 0.6,
  },
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
    const subsidyCoinsPerBlock =
      facts.fixedSubsidyCoinsPerBlock ??
      Number(stats?.inflation_24h) / unit / Number(stats?.blocks_24h)
    const difficulty = Number(stats?.difficulty)
    const circulatingCoins = Number(stats?.circulation) / unit
    if (
      !(subsidyCoinsPerBlock > 0) ||
      !Number.isFinite(subsidyCoinsPerBlock) ||
      !(difficulty > 0) ||
      !(circulatingCoins > 0)
    ) {
      return null
    }
    return {
      chain,
      subsidyCoinsPerBlock,
      difficulty,
      hashesPerBlock: difficulty * facts.hashesPerDifficulty,
      circulatingCoins,
      fetchedAt: Date.now(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
