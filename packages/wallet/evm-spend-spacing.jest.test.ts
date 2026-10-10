/**
 * The spacing a chain demands between two transfers from one account (Monad's reserve-balance
 * delay of 3 blocks). Unit test against a stub node that only counts blocks and nonces; the
 * rule itself was seen on Monad testnet (see `EvmChainConfig.spendSpacingBlocks`).
 */
import type { Provider } from 'ethers'
import { waitForSpendSpacing } from './evm-stamp-payer'

/** A node at block `head` where the account's transactions were mined in `minedAt` blocks. */
function node(state: { head: number; minedAt: number[] }) {
  const reads: string[] = []
  const provider = {
    getBlockNumber: async () => {
      return state.head
    },
    getTransactionCount: async (_address: string, block: number) => {
      reads.push(`count@${block}`)
      return state.minedAt.filter(mined => mined <= block).length
    },
  } as unknown as Provider
  return { provider, reads }
}
const ADDRESS = '0x' + 'aa'.repeat(20)

describe('waitForSpendSpacing', () => {
  it('returns at once, with no request, when the chain has no spacing rule', async () => {
    const { provider, reads } = node({ head: 100, minedAt: [100] })
    await waitForSpendSpacing(provider, ADDRESS, 0)
    await waitForSpendSpacing(provider, ADDRESS, undefined)
    expect(reads).toEqual([])
  })

  it('returns at once when the account sent nothing in the last three blocks', async () => {
    const { provider } = node({ head: 100, minedAt: [90, 97] })
    await expect(waitForSpendSpacing(provider, ADDRESS, 3)).resolves.toBeUndefined()
  })

  it('waits while the account has a transaction in the last three blocks, and no longer', async () => {
    const state = { head: 100, minedAt: [99] }
    const { provider } = node(state)
    let done = false
    const waiting = waitForSpendSpacing(provider, ADDRESS, 3).then(() => (done = true))
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(done).toBe(false)
    state.head = 101 // blocks 99..101 still hold it
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(done).toBe(false)
    state.head = 102 // nothing in 100..102
    await waiting
    expect(done).toBe(true)
  })
})
