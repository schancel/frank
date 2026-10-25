import { discoverSeedBranch } from './evm-seed-discovery'

/** The walk itself: which indices it reads and where it stops. Chain state is a table here;
 * the anvil suite (`chain/evm-seed-restore.anvil.jest.test.ts`) runs it against a real node. */
function chainOf(state: Record<number, { nonce?: number; balance?: bigint }>) {
  const address = (index: number) =>
    '0x' + index.toString(16).padStart(40, '0')
  const byAddress = new Map(
    Object.entries(state).map(([index, value]) => [
      address(Number(index)),
      value,
    ]),
  )
  const read: number[] = []
  const provider = {
    getTransactionCount: async (account: string) => {
      read.push(parseInt(account, 16))
      return byAddress.get(account)?.nonce ?? 0
    },
    getBalance: async (account: string) => byAddress.get(account)?.balance ?? 0n,
  }
  return { address, provider: provider as never, read }
}

describe('seed branch discovery', () => {
  it('finds funded and drained accounts across gaps shorter than the window, then stops', async () => {
    const chain = chainOf({
      0: { nonce: 1 }, // drained: spent everything it held
      1: { balance: 5n },
      7: { balance: 1n }, // after a run of six indices a failed build kept
      30: { balance: 9n }, // beyond the window: not found
    })
    const found = await discoverSeedBranch({
      provider: chain.provider,
      addressOf: chain.address,
      isKnown: () => false,
      highWater: 0,
      gap: 20,
      readsAtOnce: 4,
    })
    expect(found.map(f => [f.index, f.nonce, f.balanceWei])).toEqual([
      [0, 1, 0n],
      [1, 0, 5n],
      [7, 0, 1n],
    ])
    // It read through index 7 + 20 unused, and no further than the window it was reading.
    expect(Math.max(...chain.read)).toBeLessThan(7 + 20 + 4)
    expect(Math.max(...chain.read)).toBeGreaterThanOrEqual(7 + 20)
  })

  it('reads every unknown index below the high-water mark and skips the ones it owns', async () => {
    const chain = chainOf({ 20: { balance: 2n }, 37: { balance: 3n }, 41: { balance: 4n } })
    const found = await discoverSeedBranch({
      provider: chain.provider,
      addressOf: chain.address,
      isKnown: index => index < 10,
      highWater: 35,
      gap: 3,
    })
    // 20 lies after a run of ten unused indices, longer than the gap, but below the mark.
    expect(found.map(f => f.index)).toEqual([20, 37])
    expect(chain.read.some(index => index < 10)).toBe(false)
    expect(Math.min(...chain.read)).toBe(10)
  })

  it('propagates a failed read: an incomplete walk is never reported as complete', async () => {
    const chain = chainOf({})
    const provider = {
      ...(chain.provider as object),
      getTransactionCount: async () => {
        throw new Error('node unavailable')
      },
    }
    await expect(
      discoverSeedBranch({
        provider: provider as never,
        addressOf: chain.address,
        isKnown: () => false,
        highWater: 0,
      }),
    ).rejects.toThrow('node unavailable')
  })
})
