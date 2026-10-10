/**
 * The payer's choice of coins, alone: a stub node that answers balances, nonces and a fee, and
 * a stub of the pool's claims. What is asserted is which coins are claimed and what each signed
 * transfer pays; the same on real chain software is the parallel-send check's phase w.
 */
import { Transaction, Wallet, type Provider } from 'ethers'
import { EvmBlockWatcher } from './evm-block-watcher'
import {
  EvmStampPayer,
  InsufficientStampFundsError,
} from './evm-stamp-payer'
import type { MonadSubAccountPool } from './monad-account-pool'

const GWEI = 10n ** 9n
const MON = 10n ** 18n
/** Monad testnet's shape: charged 102 gwei, cap 202 gwei. */
const CHARGED = 21_000n * 102n * GWEI
const RESERVE = 21_000n * 202n * GWEI
const key = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const main = new Wallet(key(1))
const coins = [2, 3, 4].map(n => new Wallet(key(n)))

function payer(balances: Record<string, bigint>) {
  const held = new Map<string, string>()
  const provider = {
    getBlockNumber: async () => 1000,
    getTransactionCount: async () => 0,
    getBalance: async (address: string) => balances[address.toLowerCase()] ?? 0n,
    getFeeData: async () => ({
      gasPrice: 102n * GWEI,
      maxFeePerGas: 202n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    }),
  } as unknown as Provider
  const pool = {
    accountClaimedBy: (address: string) => held.get(address.toLowerCase()),
    accountGeneration: () => 0,
    claimAccount: (holder: string, address: string) =>
      held.has(address.toLowerCase())
        ? false
        : (held.set(address.toLowerCase(), holder), true),
    releaseAccountClaim: (holder: string, address: string) => {
      if (held.get(address.toLowerCase()) === holder)
        held.delete(address.toLowerCase())
    },
    // The stub wakes nobody: a waiter looks again at the block watcher's next look.
    accountReleased: () => new Promise<void>(() => undefined),
    releaseClaim: (holder: string) => {
      for (const [address, by] of held) if (by === holder) held.delete(address)
    },
  } as unknown as MonadSubAccountPool
  const watcher = new EvmBlockWatcher({ provider, intervalMs: 10 })
  const stampPayer = new EvmStampPayer({
    pool,
    provider,
    httpClient: {} as never,
    watcher,
    accounts: [
      { source: 'main', address: main.address, privateKey: () => main.privateKey },
    ],
    // As the wallet lists them: the largest first.
    coins: () =>
      coins
        .filter(coin => (balances[coin.address.toLowerCase()] ?? 0n) > 0n)
        .sort((a, b) =>
          balances[a.address.toLowerCase()]! > balances[b.address.toLowerCase()]!
            ? -1
            : 1,
        )
        .map(coin => ({ address: coin.address, privateKey: () => coin.privateKey })),
  })
  return { stampPayer, held, watcher }
}
const at = (wallet: Wallet) => wallet.address.toLowerCase()
const sources = ['main', 'identity', 'coin'] as const

describe('which coins pay a stamp', () => {
  // Seen in Chrome on testnet: 0.08 MON in the wallet (0.012 at the main address, 0.05 in
  // received payments) and "There are not enough funds to send this message".
  it('no one coin covers it: several pay it together, the largest first, each a part worth its transfer; the parts add up to the stamp', async () => {
    const { stampPayer, held, watcher } = payer({
      [at(main)]: MON / 100n, // 0.01
      [at(coins[0]!)]: (3n * MON) / 100n, // 0.03
      [at(coins[1]!)]: (2n * MON) / 100n, // 0.02
    })
    const stamp = (4n * MON) / 100n
    const claim = await stampPayer.claim({
      holder: 'message',
      stampValueWei: stamp,
      sources,
    })
    watcher.stop()
    expect(claim.accounts.map(account => account.address)).toEqual([
      at(coins[0]!),
      at(coins[1]!),
    ])
    // The first gives all it can after its own fee; the second the rest.
    expect(claim.accounts[0]!.paymentValueWei).toBe((3n * MON) / 100n - RESERVE)
    expect(
      claim.accounts.reduce((sum, account) => sum + account.paymentValueWei, 0n),
    ).toBe(stamp)
    for (const account of claim.accounts)
      expect(account.paymentValueWei).toBeGreaterThanOrEqual(CHARGED)
    // Both are claimed for this message; the main account is not touched.
    expect([...held.keys()].sort()).toEqual([at(coins[0]!), at(coins[1]!)].sort())
    // One signed transfer per coin, each from its own key to its own destination.
    const destinations = [new Wallet(key(8)).address, new Wallet(key(9)).address]
    const signed = (
      await stampPayer.sign(claim, 10143n, index => destinations[index]!)
    ).map(payment => Transaction.from(payment.rawTx))
    expect(signed.map(tx => tx.from!.toLowerCase())).toEqual([
      at(coins[0]!),
      at(coins[1]!),
    ])
    expect(signed.map(tx => tx.to)).toEqual(destinations)
    expect(signed.reduce((sum, tx) => sum + tx.value, 0n)).toBe(stamp)
    expect(signed.every(tx => tx.type === 2 && tx.gasLimit === 21_000n)).toBe(true)
  })

  it('one coin that covers the stamp pays it alone, in one transfer, as before', async () => {
    const { stampPayer, watcher } = payer({
      [at(main)]: MON / 1000n,
      [at(coins[0]!)]: (3n * MON) / 100n,
      [at(coins[1]!)]: (2n * MON) / 100n,
    })
    const claim = await stampPayer.claim({
      holder: 'message',
      stampValueWei: MON / 100n,
      sources,
    })
    watcher.stop()
    expect(claim.accounts).toHaveLength(1)
    expect(claim.accounts[0]).toMatchObject({
      address: at(coins[0]!),
      paymentValueWei: MON / 100n,
    })
  })

  it('coins that do not cover it together are refused, and nothing stays claimed; a coin that cannot pay its own fee is never an input', async () => {
    const { stampPayer, held, watcher } = payer({
      [at(main)]: MON / 100n,
      [at(coins[0]!)]: (2n * MON) / 100n,
      // Holds less than a transfer costs: moving it would cost more than it is.
      [at(coins[1]!)]: CHARGED,
    })
    await expect(
      stampPayer.claim({
        holder: 'message',
        stampValueWei: (4n * MON) / 100n,
        sources,
      }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(held.size).toBe(0)
    // What the two usable coins can pay after their fees is paid by the two of them.
    const reachable = MON / 100n + (2n * MON) / 100n - 2n * RESERVE
    const claim = await stampPayer.claim({
      holder: 'next',
      stampValueWei: reachable,
      sources,
    })
    watcher.stop()
    expect(claim.accounts.map(account => account.address).sort()).toEqual(
      [at(main), at(coins[0]!)].sort(),
    )
  })

  it('a coin another payment holds is not taken: the send waits for it instead of failing or signing a second transfer from it', async () => {
    const { stampPayer, held, watcher } = payer({
      [at(coins[0]!)]: (3n * MON) / 100n,
      [at(coins[1]!)]: (2n * MON) / 100n,
    })
    held.set(at(coins[0]!), 'an earlier message')
    let waited = 0
    const claim = stampPayer.claim({
      holder: 'message',
      stampValueWei: (4n * MON) / 100n,
      sources,
      onWaiting: () => waited++,
    })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(waited).toBeGreaterThan(0)
    expect(held.get(at(coins[1]!))).toBeUndefined()
    held.delete(at(coins[0]!))
    const made = await claim
    watcher.stop()
    expect(made.accounts).toHaveLength(2)
  })
})
