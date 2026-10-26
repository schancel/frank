import type { Provider } from "ethers";

/** A block the journal saw a transaction included in: its height and its hash. */
export interface EvmIncludedBlock {
  readonly blockNumber: number;
  readonly blockHash: string;
}

/** Most distinct blocks one `readEvmBlockTimes` call reads. */
export const MAX_BLOCK_TIME_READS = 256;

/**
 * When each of these blocks was made (epoch ms), keyed by block hash. Each block is read by its
 * height (`eth_getBlockByNumber`, without transactions), the read the relay's RPC proxy serves; it
 * refuses `eth_getBlockByHash`, and a refused call fails the whole JSON-RPC batch the provider
 * put it in, with every other read of the wallet in that batch. A block whose hash at that height
 * is not the one given (replaced since), or that cannot be read, is left out. `known` remembers
 * times already read: a block's time never changes.
 */
export async function readEvmBlockTimes(
  provider: Pick<Provider, "getBlock">,
  blocks: readonly EvmIncludedBlock[],
  known: Map<string, number> = new Map()
): Promise<ReadonlyMap<string, number>> {
  const wanted = new Map<string, number>();
  for (const { blockNumber, blockHash } of blocks) {
    const hash = blockHash.toLowerCase();
    if (
      /^0x[0-9a-f]{64}$/.test(hash) &&
      Number.isSafeInteger(blockNumber) &&
      blockNumber >= 0 &&
      !wanted.has(hash)
    )
      wanted.set(hash, blockNumber);
  }
  const reads = [...wanted].slice(0, MAX_BLOCK_TIME_READS);
  const times = new Map<string, number>();
  for (let start = 0; start < reads.length; start += 8) {
    await Promise.all(
      reads.slice(start, start + 8).map(async ([hash, blockNumber]) => {
        const remembered = known.get(hash);
        if (remembered !== undefined) {
          times.set(hash, remembered);
          return;
        }
        try {
          const block = await provider.getBlock(blockNumber);
          if (block?.hash?.toLowerCase() !== hash) return;
          known.set(hash, block.timestamp * 1000);
          times.set(hash, block.timestamp * 1000);
        } catch {
          // Unread: the caller shows the transaction undated.
        }
      })
    );
  }
  return times;
}
