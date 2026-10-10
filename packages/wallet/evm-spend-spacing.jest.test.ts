/**
 * The spacing a chain demands between two transfers from one account (Monad's reserve-balance
 * delay of 3 blocks). Unit test against a stub node that only counts blocks and nonces; the
 * rule itself was seen on Monad testnet (see `EvmChainConfig.spendSpacingBlocks`).
 */
import type { Provider } from 'ethers'
import { EvmBlockWatcher } from './evm-block-watcher'
import { EvmStampPayer, waitForSpendSpacing } from './evm-stamp-payer'
import type { MonadSubAccountPool } from './monad-account-pool'

/** A node at block `head` where the account's transactions were mined in `minedAt` blocks. */
function node(state: { head: number; minedAt: number[]; inMempool?: number }) {
  const reads: string[] = []
  const provider = {
    getBlockNumber: async () => {
      return state.head
    },
    getTransactionCount: async (_address: string, block: number | 'pending') => {
      reads.push(`count@${block}`)
      return block === 'pending'
        ? state.minedAt.length + (state.inMempool ?? 0)
        : state.minedAt.filter(mined => mined <= block).length
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

  it('waits while the node still holds an unmined transaction of the account, however old its last mined one', async () => {
    // A funding transfer whose receipt wait ran out, or a transfer other code signed with the
    // same key: it will be mined inside the window, and signing behind it stacks a nonce.
    const state = { head: 100, minedAt: [50], inMempool: 1 }
    const { provider } = node(state)
    let done = false
    const waiting = waitForSpendSpacing(provider, ADDRESS, 3).then(() => (done = true))
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(done).toBe(false)
    // It is mined at 101: the mempool is empty, and now the three blocks count from there.
    state.inMempool = 0
    state.minedAt.push(101)
    state.head = 101
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(done).toBe(false)
    state.head = 104
    await waiting
    expect(done).toBe(true)
  })
})

/**
 * The payer's own use of the rule, for the main account's coin: the chain reverts only a
 * transfer that takes its account below the reserve (measured on Monad: from 10.5 MON, two
 * transfers of 0.1 MON in ONE block both succeeded; from 5 MON the second one reverted).
 */
describe('a stamp paid from the main account right after its last transaction', () => {
  const MON = 10n ** 18n
  /** The account's last transaction was mined in the head block. Blocks advance on request. */
  function payer(balanceWei: bigint) {
    const state = { head: 100 }
    const provider = {
      getBlockNumber: async () => state.head,
      getTransactionCount: async (_address: string, block: number | 'pending') =>
        block === 'pending' || block >= 100 ? 1 : 0,
      getBalance: async () => balanceWei,
      getFeeData: async () => ({
        gasPrice: 102n * 10n ** 9n,
        maxFeePerGas: 202n * 10n ** 9n,
        maxPriorityFeePerGas: 2n * 10n ** 9n,
      }),
    } as unknown as Provider
    let claimed: string | undefined
    const pool = {
      accountClaimedBy: () => claimed,
      accountGeneration: () => 0,
      claimAccount: (holder: string) => ((claimed = holder), true),
      releaseAccountClaim: () => (claimed = undefined),
      releaseClaim: () => (claimed = undefined),
    } as unknown as MonadSubAccountPool
    const watcher = new EvmBlockWatcher({ provider, intervalMs: 20 })
    const waits: (number | undefined)[] = []
    const claim = new EvmStampPayer({
      pool,
      provider,
      httpClient: {} as never,
      watcher,
      spendSpacingBlocks: 3,
      reserveBalanceWei: 10n * MON,
      accounts: [{ source: 'main', address: ADDRESS, privateKey: () => '' }],
    }).claim({
      holder: 'message',
      stampValueWei: MON / 10n,
      sources: ['main'],
      onWaiting: blocks => waits.push(blocks),
    })
    return { state, claim, waits, watcher }
  }

  it('from an account that stays at or above the reserve: signed at once, at the next nonce, no wait', async () => {
    const { claim, waits, watcher } = payer(50n * MON)
    const made = await claim
    watcher.stop()
    expect(made.accounts).toEqual([
      expect.objectContaining({ source: 'main', nonce: 1 }),
    ])
    expect(waits).toEqual([])
  })

  it('from an account the payment takes below the reserve: waits the three blocks, says how many remain, then signs', async () => {
    const { state, claim, waits, watcher } = payer(5n * MON)
    let done = false
    void claim.then(() => (done = true))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(done).toBe(false)
    expect(waits).toEqual([3])
    state.head = 103
    const made = await claim
    watcher.stop()
    expect(made.accounts[0]).toEqual(expect.objectContaining({ nonce: 1 }))
  })
})
