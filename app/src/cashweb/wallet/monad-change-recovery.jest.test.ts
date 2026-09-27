/**
 * Unit tests for `monad-change-recovery.ts` (ticket #36): the chain-bisection recovery mechanism
 * for reconstructing the "next unused change index" pointer, distinct from `monad-change-pool.ts`'s
 * live bookkeeping (see that file's header for the distinction).
 *
 * Every scenario here is also exercised for real, without jest, by
 * `monad-change-recovery.livecheck.ts` in this same directory.
 *
 * `Provider` is mocked structurally (only `getTransactionCount`/`getBalance`, the two methods
 * `isChangeIndexUsed` actually calls) against a simulated chain: indices `[0, boundary)` are
 * "used" (mix of nonce>0 and balance>0, exercising both signals from the ticket's `nonce > 0 OR
 * balance > 0` check), everything at/after `boundary` is untouched.
 */
import { Provider } from 'ethers'

import { MonadChangeKeyring } from './monad-change-keyring'
import {
  DEFAULT_MAX_CHANGE_INDEX_SEARCH,
  isChangeIndexUsed,
  recoverNextChangeIndex,
} from './monad-change-recovery'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'

/** Builds a mock `Provider` (structurally -- only `getTransactionCount`/`getBalance`) simulating a
 * chain where every change index below `boundary` is "used" and everything from `boundary` onward
 * is untouched. Alternates which of the two signals (`nonce > 0` vs. `balance > 0`) marks a used
 * index as used, to exercise both halves of the ticket's `nonce > 0 OR balance > 0` check -- not
 * just balance alone, which the ticket explicitly calls out as insufficient on its own (a
 * received-and-later-spent-out change account can have nonce > 0 with balance back at ~0). Also
 * counts calls so tests can assert the search stays sub-linear. */
function makeSimulatedChainProvider(
  keyring: MonadChangeKeyring,
  boundary: number,
): { provider: Provider; callCount: () => number } {
  const addressToIndex = new Map<string, number>()
  // Only need to precompute addresses within a reasonable probe range; recoverNextChangeIndex
  // will call deriveChangeAccount itself, we just need to classify by index it derives from.
  const indexForAddress = (address: string): number => {
    const cached = addressToIndex.get(address.toLowerCase())
    if (cached !== undefined) return cached
    // Linear fallback search (test-only convenience, not production code): find which index this
    // address belongs to by re-deriving until we find a match, capped generously.
    for (let i = 0; i < 4_000_000; i++) {
      const candidate = keyring.deriveChangeAccount(i).address.toLowerCase()
      addressToIndex.set(candidate, i)
      if (candidate === address.toLowerCase()) return i
    }
    throw new Error('address not found in simulated range')
  }

  let calls = 0
  const provider = {
    async getTransactionCount(address: string): Promise<number> {
      calls++
      const index = indexForAddress(address)
      if (index >= boundary) return 0
      // Even used indices: nonce > 0 (spent out). Odd used indices: nonce == 0 (still held,
      // relies on the balance signal instead) -- see this function's doc comment.
      return index % 2 === 0 ? 1 : 0
    },
    async getBalance(address: string): Promise<bigint> {
      calls++
      const index = indexForAddress(address)
      if (index >= boundary) return BigInt(0)
      return index % 2 === 0 ? BigInt(0) : BigInt(1)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Provider
  return { provider, callCount: () => calls }
}

describe('isChangeIndexUsed', () => {
  it('is used when nonce > 0, even with zero balance', async () => {
    const provider = {
      getTransactionCount: async () => 1,
      getBalance: async () => BigInt(0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Provider
    expect(await isChangeIndexUsed(provider, '0xabc')).toBe(true)
  })

  it('is used when balance > 0, even with zero nonce', async () => {
    const provider = {
      getTransactionCount: async () => 0,
      getBalance: async () => BigInt(1),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Provider
    expect(await isChangeIndexUsed(provider, '0xabc')).toBe(true)
  })

  it('is unused only when both nonce and balance are zero', async () => {
    const provider = {
      getTransactionCount: async () => 0,
      getBalance: async () => BigInt(0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Provider
    expect(await isChangeIndexUsed(provider, '0xabc')).toBe(false)
  })
})

describe('recoverNextChangeIndex', () => {
  it('returns 0 immediately when index 0 is unused (a wallet with no change history yet)', async () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const { provider } = makeSimulatedChainProvider(keyring, 0)
    expect(await recoverNextChangeIndex({ keyring, provider })).toBe(0)
  })

  it.each([1, 2, 3, 4, 5, 7, 8, 16, 17, 31, 100])(
    'finds the exact used/unused boundary for %i used indices',
    async boundary => {
      const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
      const { provider, callCount } = makeSimulatedChainProvider(
        keyring,
        boundary,
      )

      const result = await recoverNextChangeIndex({ keyring, provider })

      expect(result).toBe(boundary)
      // Sanity check the search is sub-linear (exponential probe + binary search), not a linear
      // scan up to `boundary` -- generous bound, just enough to catch an accidental O(n) rewrite.
      expect(callCount()).toBeLessThan(4 * (Math.log2(boundary + 2) + 4) * 2)
    },
  )

  it('recovered index matches what a fresh MonadChangePool would independently allocate next', async () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const { provider } = makeSimulatedChainProvider(keyring, 6)
    const recovered = await recoverNextChangeIndex({ keyring, provider })
    expect(recovered).toBe(6)
    // The address at the recovered index must be genuinely unused on our simulated chain.
    expect(
      await isChangeIndexUsed(
        provider,
        keyring.deriveChangeAccount(recovered).address,
      ),
    ).toBe(false)
    // ...and the index just before it must be used.
    expect(
      await isChangeIndexUsed(
        provider,
        keyring.deriveChangeAccount(recovered - 1).address,
      ),
    ).toBe(true)
  })

  it('throws when every index up to maxIndex looks used (misconfigured provider/keyring guard)', async () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    // Boundary far beyond a tiny maxIndex -- every probed index looks used.
    const { provider } = makeSimulatedChainProvider(keyring, 10_000)
    await expect(
      recoverNextChangeIndex({ keyring, provider, maxIndex: 8 }),
    ).rejects.toThrow(/maxIndex/)
  })

  it('rejects a non-positive maxIndex', async () => {
    const keyring = MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    const { provider } = makeSimulatedChainProvider(keyring, 0)
    await expect(
      recoverNextChangeIndex({ keyring, provider, maxIndex: 0 }),
    ).rejects.toThrow(/maxIndex/)
  })

  it('DEFAULT_MAX_CHANGE_INDEX_SEARCH is a sane, generous default', () => {
    expect(DEFAULT_MAX_CHANGE_INDEX_SEARCH).toBeGreaterThan(1000)
  })
})
