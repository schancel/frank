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
import { MonadSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring } from './secp256k1-hd-keyring'
import { InMemorySubAccountPoolStore } from './storage/sub-account-pool-storage'

const GWEI = 10n ** 9n
const MON = 10n ** 18n
/** Monad testnet's shape: charged 102 gwei, cap 202 gwei. */
const CHARGED = 21_000n * 102n * GWEI
const RESERVE = 21_000n * 202n * GWEI
const key = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const main = new Wallet(key(1))
const coins = [2, 3, 4].map(n => new Wallet(key(n)))

function payer(balances: Record<string, bigint>, options: {
  provider?: Partial<Provider>
  spendSpacingBlocks?: number
  canSelectAccount?: (address: string, nonce: number) => boolean
} = {}) {
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
    ...options.provider,
  } as unknown as Provider
  const pool = {
    records: () => [],
    isSpendReserved: () => false,
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
    spendSpacingBlocks: options.spendSpacingBlocks,
    canSelectAccount: options.canSelectAccount,
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


describe('settling a stamp from its actual receipt', () => {
  async function payment() {
    return main.signTransaction({
      chainId: 10143n, nonce: 0, to: coins[0]!.address, value: MON / 100n,
      gasLimit: 21_000n, maxFeePerGas: 202n * GWEI, maxPriorityFeePerGas: 2n * GWEI,
    })
  }

  it('nonce zero uses the mined block: the next send waits only the remaining spacing', async () => {
    const state = { head: 1001 }
    const { stampPayer, watcher } = payer({ [at(main)]: MON }, {
      spendSpacingBlocks: 3,
      provider: {
        getBlockNumber: async () => state.head,
        getTransactionCount: async (_address, block) => typeof block === 'number' && block < 1000 ? 0 : 1,
        getTransaction: async () => null,
        getTransactionReceipt: async () => ({ status: 1, blockNumber: 1000 }) as never,
      },
    })
    try {
      expect(await stampPayer.observe(await payment())).toMatchObject({ state: 'included' })
      const waits: (number | undefined)[] = []
      const claim = stampPayer.claim({ holder: 'next', stampValueWei: MON / 100n,
        sources: ['main'], onWaiting: blocks => waits.push(blocks) })
      void claim.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(waits).toEqual([1])
      state.head = 1002
      expect((await claim).accounts[0]!.nonce).toBe(1)
    } finally { watcher.stop() }
  })

  it('a reverted receipt stays pending until three confirmations on the canonical block', async () => {
    const state = { head: 1000, hash: 'canonical' }
    const { stampPayer, watcher } = payer({}, { provider: {
      getBlockNumber: async () => state.head,
      getTransactionCount: async () => 1,
      getTransaction: async () => null,
      getTransactionReceipt: async () => ({ status: 0, blockNumber: 1000, blockHash: 'canonical' }) as never,
      getBlock: async () => ({ hash: state.hash }) as never,
    } })
    try {
      const raw = await payment()
      expect(await stampPayer.observe(raw)).toEqual({ state: 'pending', where: 'included' })
      state.head = 1001
      expect(await stampPayer.observe(raw)).toEqual({ state: 'pending', where: 'included' })
      state.head = 1002
      state.hash = 'other-fork'
      expect(await stampPayer.observe(raw)).toEqual({ state: 'pending', where: 'included' })
      state.hash = 'canonical'
      expect(await stampPayer.observe(raw)).toEqual({ state: 'included', reverted: true, block: 1000 })
    } finally { watcher.stop() }
  })
})


describe('reconstructed pool account nonces', () => {
  function recovered() {
    const keyring = MonadHdKeyring.fromMnemonic(
      'test test test test test test test test test test test junk',
    )
    const pool = new MonadSubAccountPool({
      keyring,
      store: new InMemorySubAccountPoolStore(),
    })
    pool.ensureSize(2)
    const provider = {
      getBlockNumber: jest.fn(async () => 1000),
      getTransactionCount: jest.fn(async () => 1),
      getBalance: jest.fn(async () => MON / 50n),
      getFeeData: jest.fn(async () => ({
        gasPrice: 102n * GWEI,
        maxFeePerGas: 202n * GWEI,
        maxPriorityFeePerGas: 2n * GWEI,
      })),
    }
    const watcher = new EvmBlockWatcher({
      provider: provider as unknown as Provider,
      intervalMs: 10,
    })
    const stampPayer = new EvmStampPayer({
      pool,
      provider: provider as unknown as Provider,
      httpClient: {} as never,
      watcher,
      accounts: [],
    })
    return { pool, provider, watcher, stampPayer }
  }
  it('signs the remaining value at nonce one after a recovered available account previously burned at nonce zero', async () => {
    const f = recovered()
    try {
      const claim = await f.stampPayer.claim({
        holder: 'new-message',
        stampValueWei: MON / 100n,
        sources: ['pool'],
      })
      expect(claim.accounts).toHaveLength(1)
      expect(claim.accounts[0]!.nonce).toBe(1)
      const [payment] = await f.stampPayer.sign(
        claim,
        10143n,
        () => main.address,
      )
      expect(Transaction.from(payment!.rawTx).nonce).toBe(1)
      expect(Transaction.from(payment!.rawTx).value).toBe(MON / 100n)
    } finally {
      f.watcher.stop()
      f.stampPayer.release('new-message')
    }
  })
  it('does not construct over a pending nonce and can use another available account', async () => {
    const f = recovered()
    const first = f.pool.records()[0]!.address.toLowerCase()
    f.provider.getTransactionCount.mockImplementation(
      async (address?: unknown, block?: unknown) =>
        String(address).toLowerCase() === first && block === 'pending' ? 2 : 1,
    )
    try {
      const claim = await f.stampPayer.claim({
        holder: 'new-message',
        stampValueWei: MON / 100n,
        sources: ['pool'],
      })
      expect(claim.accounts[0]!.address).not.toBe(first)
      expect(claim.accounts[0]!.nonce).toBe(1)
      expect(f.pool.claimedBy(0)).toBeUndefined()
    } finally {
      f.watcher.stop()
      f.stampPayer.release('new-message')
    }
  })
  it('preserves a restored ambiguous original claim even when the chain nonce advanced', async () => {
    const f = recovered()
    const original = await f.pool
      .getSigner(0, {
        provider: f.provider as unknown as Provider,
        httpClient: {} as never,
      })
      .signFrozenUnsigned({
        from: f.pool.records()[0]!.address.toLowerCase(),
        unsignedSerialized: Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 0,
          to: main.address,
          value: MON / 100n,
          gasLimit: 21000n,
          maxFeePerGas: 202n * GWEI,
          maxPriorityFeePerGas: 2n * GWEI,
        }).unsignedSerialized,
      })
    // This is the public restore boundary the durable outgoing-message owner invokes on reopen.
    f.pool.restoreClaim('original-operation', [0])
    try {
      const claim = await f.stampPayer.claim({
        holder: 'different-message',
        stampValueWei: MON / 100n,
        sources: ['pool'],
      })
      expect(claim.accounts[0]!.index).toBe(1)
      expect(f.pool.claimedBy(0)).toBe('original-operation')
      expect(Transaction.from(original.rawTx).nonce).toBe(0)
    } finally {
      f.watcher.stop()
      f.stampPayer.release('different-message')
      f.pool.releaseClaim('original-operation')
    }
  })
  it('reserves independent recovered accounts exclusively for concurrent construction', async () => {
    const f = recovered()
    try {
      const claims = await Promise.all(
        ['first', 'second'].map(holder =>
          f.stampPayer.claim({
            holder,
            stampValueWei: MON / 100n,
            sources: ['pool'],
          }),
        ),
      )
      expect(
        new Set(claims.map(claim => claim.accounts[0]!.address)).size,
      ).toBe(2)
      expect(claims.map(claim => claim.accounts[0]!.nonce)).toEqual([1, 1])
    } finally {
      f.watcher.stop()
      f.stampPayer.release('first')
      f.stampPayer.release('second')
    }
  })
})

describe('read-only stamp affordability', () => {
  it('quotes the actual fragmented plan and maximum native fees, without claiming', async () => {
    const { stampPayer, held, watcher } = payer({
      [at(main)]: MON / 100n,
      [at(coins[0]!)]: (3n * MON) / 100n,
      [at(coins[1]!)]: (2n * MON) / 100n,
    })
    const stampValueWei = (4n * MON) / 100n
    const quote = await stampPayer.quote({ stampValueWei })
    expect(quote).toEqual({
      status: 'available',
      stampValueWei,
      maximumFeeWei: RESERVE * 2n,
      capacityWei: (6n * MON) / 100n - RESERVE * 3n,
    })
    expect(held.size).toBe(0)
    const claim = await stampPayer.claim({
      holder: 'actual-send',
      stampValueWei,
      sources,
    })
    expect(claim.accounts).toHaveLength(2)
    expect(
      claim.accounts.reduce((total, coin) => total + coin.paymentValueWei, 0n),
    ).toBe(stampValueWei)
    stampPayer.release('actual-send')
    watcher.stop()
  })

  it('excludes held and quoted financial sources despite a large aggregate balance', async () => {
    const { stampPayer, held, watcher } = payer({
      [at(main)]: MON,
      [at(coins[0]!)]: MON,
    })
    held.set(at(main), 'earlier-message')
    const quote = await stampPayer.quote({
      stampValueWei: MON / 100n,
      excludedAddresses: [coins[0]!.address],
    })
    expect(quote).toEqual({
      status: 'insufficient',
      stampValueWei: MON / 100n,
      capacityWei: 0n,
    })
    expect(held).toEqual(new Map([[at(main), 'earlier-message']]))
    watcher.stop()
  })

  it('refuses a fallback plan exceeding the canonical transport payment count', async () => {
    const accounts = Array.from({ length: 65 }, (_, i) => new Wallet(key(i + 10)))
    const provider = {
      getBlockNumber: async () => 1000,
      getTransactionCount: async () => 0,
      getBalance: async () => RESERVE + CHARGED,
      getFeeData: async () => ({ gasPrice: 102n * GWEI, maxFeePerGas: 202n * GWEI }),
    } as unknown as Provider
    const pool = new MonadSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic('test test test test test test test test test test test junk'),
      store: new InMemorySubAccountPoolStore(),
    })
    const stampPayer = new EvmStampPayer({ pool, provider, httpClient: {} as never,
      accounts: [], coins: () => accounts.map(account => ({ address: account.address,
        privateKey: () => { throw new Error('Quote must never request signing material') } })),
    })
    expect(await stampPayer.quote({ stampValueWei: CHARGED * 65n, maxPayments: 64 })).toEqual({
      status: 'insufficient', stampValueWei: CHARGED * 65n, capacityWei: CHARGED * 64n,
    })
    expect(await stampPayer.quote({ stampValueWei: CHARGED * 64n, maxPayments: 64 })).toEqual({
      status: 'available', stampValueWei: CHARGED * 64n, capacityWei: CHARGED * 64n,
      maximumFeeWei: RESERVE * 64n,
    })
    expect(accounts.some(account => pool.accountClaimedBy(account.address) !== undefined)).toBe(false)
    stampPayer.watcher.stop()
  })

  it('excludes the current nonce reserved by the native operation owner', async () => {
    const eligible = jest.fn(() => false)
    const { stampPayer, held, watcher } = payer({ [at(main)]: MON }, {
      canSelectAccount: eligible,
    })
    expect(await stampPayer.quote({ stampValueWei: MON / 100n })).toEqual({
      status: 'insufficient', stampValueWei: MON / 100n, capacityWei: 0n,
    })
    expect(eligible).toHaveBeenCalledWith(at(main), 0)
    expect(held.size).toBe(0)
    watcher.stop()
  })

  it('rechecks a claim taken during network reads', async () => {
    let block!: () => void
    const gate = new Promise<void>(resolve => {
      block = resolve
    })
    let started!: () => void
    const reading = new Promise<void>(resolve => {
      started = resolve
    })
    const { stampPayer, held, watcher } = payer(
      { [at(main)]: MON },
      {
        provider: {
          getBalance: async () => {
            started()
            await gate
            return MON
          },
        },
      },
    )
    const quote = stampPayer.quote({ stampValueWei: MON / 100n })
    await reading
    held.set(at(main), 'concurrent-send')
    block()
    expect((await quote).status).toBe('insufficient')
    expect(held.get(at(main))).toBe('concurrent-send')
    watcher.stop()
  })

  it('free messages cost zero without node reads; node failures remain observable', async () => {
    const read = jest.fn(async () => {
      throw new Error('offline')
    })
    const { stampPayer, held, watcher } = payer(
      {},
      {
        provider: { getFeeData: read, getBlockNumber: read },
      },
    )
    expect(await stampPayer.quote({ stampValueWei: 0n })).toEqual({
      status: 'available',
      stampValueWei: 0n,
      capacityWei: 0n,
      maximumFeeWei: 0n,
    })
    expect(read).not.toHaveBeenCalled()
    await expect(stampPayer.quote({ stampValueWei: 1n })).rejects.toThrow(
      'The chain could not be read',
    )
    expect(held.size).toBe(0)
    watcher.stop()
  })

  it('excludes a pending nonce and immature funds without waiting', async () => {
    const { stampPayer, held, watcher } = payer(
      { [at(main)]: MON },
      {
        spendSpacingBlocks: 3,
        provider: {
          getBalance: async (_address, block) =>
            block === undefined ? MON : 0n,
        },
      },
    )
    expect((await stampPayer.quote({ stampValueWei: MON / 100n })).status).toBe(
      'insufficient',
    )
    expect(held.size).toBe(0)
    watcher.stop()
    const pending = payer(
      { [at(main)]: MON },
      {
        provider: {
          getTransactionCount: async (_address, block) =>
            block === 'pending' ? 1 : 0,
        },
      },
    )
    expect(
      (await pending.stampPayer.quote({ stampValueWei: MON / 100n })).status,
    ).toBe('insufficient')
    pending.watcher.stop()
  })

  it('tolerates load-balanced RPC replica block skew and pruned historical block tags without throwing UNKNOWN_ERROR', async () => {
    const blockNotFound = Object.assign(
      new Error('Block requested not found'),
      { code: 'UNKNOWN_ERROR' },
    )
    const { stampPayer, watcher } = payer(
      { [at(main)]: MON },
      {
        spendSpacingBlocks: 3,
        provider: {
          getTransactionCount: async (_address, block) => {
            if (typeof block === 'number') throw blockNotFound
            return 0
          },
          getBalance: async (_address, block) => {
            if (typeof block === 'number') throw blockNotFound
            return MON
          },
        },
      },
    )
    const quote = await stampPayer.quote({ stampValueWei: MON / 100n })
    expect(quote).toEqual({
      status: 'available',
      stampValueWei: MON / 100n,
      maximumFeeWei: RESERVE,
      capacityWei: MON - RESERVE,
    })
    const claim = await stampPayer.claim({
      holder: 'skewed-replica',
      stampValueWei: MON / 100n,
      sources: ['main'],
    })
    expect(claim.accounts).toHaveLength(1)
    stampPayer.release('skewed-replica')
    watcher.stop()
  })

  it('retries transient -32007 upstream RPC rate-limit errors and skips nonce reads on empty accounts during quote', async () => {
    let mainBalanceAttempts = 0
    const txCountAddresses: string[] = []
    const { stampPayer, watcher } = payer(
      { [at(main)]: MON, [at(coins[0])]: 0n },
      {
        spendSpacingBlocks: 3,
        provider: {
          getBalance: async (address, block) => {
            if (address.toLowerCase() === at(main).toLowerCase() && block === undefined) {
              mainBalanceAttempts += 1
              if (mainBalanceAttempts === 1) {
                throw Object.assign(
                  new Error('could not coalesce error (error={ "code": -32007, "message": "upstream RPC error" })'),
                  { code: 'UNKNOWN_ERROR', error: { code: -32007, message: 'upstream RPC error' } },
                )
              }
              return MON
            }
            return address.toLowerCase() === at(main).toLowerCase() ? MON : 0n
          },
          getTransactionCount: async (address) => {
            txCountAddresses.push(address.toLowerCase())
            return 0
          },
        },
      },
    )
    const quote = await stampPayer.quote({ stampValueWei: MON / 100n })
    expect(quote.status).toBe('available')
    expect(mainBalanceAttempts).toBe(2)
    expect(txCountAddresses).toContain(at(main).toLowerCase())
    expect(txCountAddresses).not.toContain(at(coins[0]).toLowerCase())
    watcher.stop()
  })
})

