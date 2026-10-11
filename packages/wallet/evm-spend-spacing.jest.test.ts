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

  it('below the reserve: cannot offer at b+1, can offer at b+2 for earliest inclusion b+3', async () => {
    const { state, claim, waits, watcher } = payer(5n * MON)
    let done = false
    void claim.then(() => (done = true))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(done).toBe(false)
    expect(waits).toEqual([2])
    state.head = 101
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(done).toBe(false)
    state.head = 102
    const made = await claim
    watcher.stop()
    expect(made.accounts[0]).toEqual(expect.objectContaining({ nonce: 1 }))
  })
})

/**
 * Money that has just arrived. Measured on a local Monad chain: a transfer offered 2 blocks
 * after its account was funded was refused by the node, at 3 blocks sometimes, from 4 blocks
 * never, and the refused bytes stayed refused. The payer signs only against the balance the
 * account already had `spacing + 1` blocks ago.
 */
describe('a stamp paid from an account whose funds have just arrived', () => {
  it('waits until the funds are four blocks old, says how many blocks, then signs; funds that were there all along are not waited for', async () => {
    const state = { head: 100, fundedAt: 100 }
    const asked: (number | undefined)[] = []
    const provider = {
      getBlockNumber: async () => state.head,
      // The account has never sent.
      getTransactionCount: async () => 0,
      getBalance: async (_address: string, block?: number) => {
        asked.push(block)
        return block !== undefined && block < state.fundedAt ? 0n : 10n ** 17n
      },
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
    const payer = new EvmStampPayer({
      pool,
      provider,
      httpClient: {} as never,
      watcher,
      spendSpacingBlocks: 3,
      accounts: [{ source: 'main', address: ADDRESS, privateKey: () => '' }],
    })
    const waits: (number | undefined)[] = []
    let done = false
    const claim = payer
      .claim({
        holder: 'first',
        stampValueWei: 10n ** 15n,
        sources: ['main'],
        onWaiting: blocks => waits.push(blocks),
      })
      .then(made => ((done = true), made))
    state.head = 103
    await new Promise(resolve => setTimeout(resolve, 250))
    // Block 99 (103 - 4) does not show the money yet.
    expect(done).toBe(false)
    expect(waits).toEqual([4])
    state.head = 104
    expect((await claim).accounts[0]).toEqual(
      expect.objectContaining({ source: 'main', nonce: 0 }),
    )
    expect(asked).toContain(100)
    // Later, the same money is old: no wait.
    claimed = undefined
    state.head = 200
    waits.length = 0
    await payer.claim({
      holder: 'second',
      stampValueWei: 10n ** 15n,
      sources: ['main'],
      onWaiting: blocks => waits.push(blocks),
    })
    watcher.stop()
    expect(waits).toEqual([])
  })
})

