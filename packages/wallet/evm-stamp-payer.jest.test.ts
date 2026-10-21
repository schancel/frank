/**
 * The payer on the wallet's coin list, alone: a stub node that answers balances, nonces, blocks
 * and a fee; the real pool, coin list and coin-list sync. What is asserted is which coins a
 * payment takes, what it reads from the node to take them, and what becomes of each coin when
 * the payment is signed, given up, settled or restored after a restart. The same on real chain
 * software is the parallel-send check.
 */
import { Transaction, Wallet, type Provider } from 'ethers'
import { EvmBlockWatcher } from './evm-block-watcher'
import { EvmStampPayer, InsufficientStampFundsError } from './evm-stamp-payer'
import { MonadSubAccountPool } from './evm-account-pool'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { EvmCoinListSync, type CoinListSource } from './evm-coin-list-sync'
import { MonadHdKeyring } from './secp256k1-hd-keyring'
import { InMemorySubAccountPoolStore } from './storage/sub-account-pool-storage'
import { MemoryRecordStore } from './storage/evm-coin-store'

const GWEI = 10n ** 9n
const MON = 10n ** 18n
/** Monad testnet's shape: charged 102 gwei, cap 202 gwei. */
const CHARGED = 21_000n * 102n * GWEI
const RESERVE = 21_000n * 202n * GWEI
const CHAIN_ID = 10143n
const key = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const main = new Wallet(key(1))
const received = [2, 3, 4].map(n => new Wallet(key(n)))
const at = (wallet: { address: string }) => wallet.address.toLowerCase()
const DESTINATION = new Wallet(key(9)).address

interface Node {
  head: number
  balances: Map<string, bigint>
  nonces: Map<string, number>
  /** Balance an account had at an older block, for the spacing rule; default: what it has. */
  balanceAt?: (account: string, block: number) => bigint
  /** Nonce an account had at an older block; default: what it has. */
  nonceAt?: (account: string, block: number) => number
  pending?: Map<string, number>
  receipts: Map<string, { status: number; blockNumber: number; blockHash: string }>
  calls: string[]
  /** While set, balance reads wait for it. */
  gate?: Promise<void>
}

async function setup(
  options: {
    poolRows?: number
    spendSpacingBlocks?: number
    reserveBalanceWei?: bigint
    canSelectAccount?: (address: string, nonce: number) => boolean
    accountHeld?: (address: string) => boolean
    store?: MemoryRecordStore<StoredEvmListCoin>
    pool?: MonadSubAccountPool
    node?: Node
  } = {},
) {
  const node: Node = options.node ?? {
    head: 1000,
    balances: new Map(),
    nonces: new Map(),
    receipts: new Map(),
    calls: [],
  }
  const provider = {
    getBlockNumber: async () => (node.calls.push('block'), node.head),
    getTransactionCount: async (address: string, tag: number | string) => {
      node.calls.push(`count:${address.toLowerCase()}:${tag}`)
      const account = address.toLowerCase()
      const now = node.nonces.get(account) ?? 0
      if (tag === 'pending') return node.pending?.get(account) ?? now
      if (typeof tag === 'number') return node.nonceAt?.(account, tag) ?? now
      return now
    },
    getBalance: async (address: string, tag?: number | string) => {
      node.calls.push(`balance:${address.toLowerCase()}`)
      await node.gate
      const account = address.toLowerCase()
      const now = node.balances.get(account) ?? 0n
      if (typeof tag === 'number') return node.balanceAt?.(account, tag) ?? now
      return now
    },
    getFeeData: async () => ({
      gasPrice: 102n * GWEI,
      maxFeePerGas: 202n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    }),
    getTransactionReceipt: async (hash: string) => {
      node.calls.push(`receipt:${hash}`)
      return node.receipts.get(hash) ?? null
    },
    getTransaction: async () => null,
    getBlock: async (n: number) => ({ hash: `0xblock${n}` }),
  } as unknown as Provider
  const keyring = MonadHdKeyring.fromMnemonic(
    'test test test test test test test test test test test junk',
  )
  const pool =
    options.pool ??
    new MonadSubAccountPool({ keyring, store: new InMemorySubAccountPoolStore() })
  if (options.poolRows !== undefined) pool.ensureSize(options.poolRows)
  const store = options.store ?? new MemoryRecordStore<StoredEvmListCoin>()
  const list = await EvmCoinList.open(store)
  const watcher = new EvmBlockWatcher({ provider, intervalMs: 10 })
  const sync = new EvmCoinListSync({
    list,
    provider,
    watcher,
    ...(options.spendSpacingBlocks === undefined
      ? {}
      : { spendSpacingBlocks: options.spendSpacingBlocks }),
    sources: () => {
      const sources: CoinListSource[] = [
        { account: at(main), origin: 'root', privateKey: () => main.privateKey },
        ...received.map(coin => ({
          account: at(coin),
          origin: 'stealth' as const,
          privateKey: () => coin.privateKey,
        })),
      ]
      for (const row of pool.records())
        if (row.status === 'available' || list.latestOf(row.address) !== undefined)
          sources.push({
            account: row.address.toLowerCase(),
            origin: 'deterministic',
            privateKey: () => pool.privateKeyOf(row.index),
          })
      return sources
    },
  })
  const payer = new EvmStampPayer({
    pool,
    coins: list,
    sync,
    provider,
    httpClient: {} as never,
    watcher,
    ...(options.spendSpacingBlocks === undefined
      ? {}
      : { spendSpacingBlocks: options.spendSpacingBlocks }),
    ...(options.reserveBalanceWei === undefined
      ? {}
      : { reserveBalanceWei: options.reserveBalanceWei }),
    ...(options.canSelectAccount ? { canSelectAccount: options.canSelectAccount } : {}),
    ...(options.accountHeld
      ? {
          accountHeld: options.accountHeld,
          heldRefusal: () => new Error('held for a contact payment'),
        }
      : {}),
  })
  return { node, pool, store, list, sync, payer, watcher }
}

type Setup = Awaited<ReturnType<typeof setup>>
const stop: Setup[] = []
async function make(options: Parameters<typeof setup>[0] = {}) {
  const made = await setup(options)
  stop.push(made)
  return made
}
afterEach(() => {
  for (const made of stop.splice(0)) made.watcher.stop()
})

/** Signs the claim to one destination and records the signed payments on their coins. */
async function signAndRecord(f: Setup, claim: Awaited<ReturnType<EvmStampPayer['claim']>>) {
  const signed = await f.payer.sign(claim, CHAIN_ID, () => DESTINATION)
  await f.payer.recordSigned(claim.holder, signed)
  return signed
}

/** The chain mines `rawTx` at `block`: the account's nonce moves on and its balance falls. */
function mine(node: Node, rawTx: string, block: number) {
  const tx = Transaction.from(rawTx)
  const from = tx.from!.toLowerCase()
  node.nonces.set(from, tx.nonce + 1)
  node.balances.set(
    from,
    (node.balances.get(from) ?? 0n) - tx.value - 21_000n * 102n * GWEI,
  )
  node.receipts.set(tx.hash!, {
    status: 1,
    blockNumber: block,
    blockHash: `0xblock${block}`,
  })
}

describe('which coins pay a stamp', () => {
  it('no one coin covers it: several pay it together, each a part worth its transfer; the parts add up to the stamp', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON / 100n)
    f.node.balances.set(at(received[0]!), (3n * MON) / 100n)
    f.node.balances.set(at(received[1]!), (2n * MON) / 100n)
    const stamp = (4n * MON) / 100n
    const claim = await f.payer.claim({ holder: 'message', stampValueWei: stamp })
    // The Stamp wallet's rule: spread over the coins, none paying more than it holds after its
    // own fee.
    expect(claim.accounts.length).toBeGreaterThanOrEqual(2)
    for (const account of claim.accounts)
      expect(account.paymentValueWei).toBeLessThanOrEqual(
        f.node.balances.get(account.address)! - RESERVE,
      )
    expect(claim.accounts.reduce((sum, a) => sum + a.paymentValueWei, 0n)).toBe(stamp)
    for (const account of claim.accounts)
      expect(account.paymentValueWei).toBeGreaterThanOrEqual(CHARGED)
    // Taken in the list and mirrored in the pool's claims.
    const taken = claim.accounts.map(account => account.address)
    expect(f.list.heldBy('message').map(coin => coin.account).sort()).toEqual(
      [...taken].sort(),
    )
    for (const account of taken) expect(f.pool.accountClaimedBy(account)).toBe('message')
    // One signed transfer per coin, each from the key the coin carries.
    const signed = await f.payer.sign(claim, CHAIN_ID, () => DESTINATION)
    expect(signed.map(p => Transaction.from(p.rawTx).from!.toLowerCase())).toEqual(taken)
  })

  it('coins that do not cover it together are refused, and nothing stays taken', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON / 100n)
    f.node.balances.set(at(received[0]!), RESERVE) // cannot pay its own fee: never an input
    await expect(
      f.payer.claim({ holder: 'message', stampValueWei: MON }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(f.list.heldBy('message')).toEqual([])
    expect(f.pool.accountClaimedBy(at(main))).toBeUndefined()
  })

  it('two payments built at the same moment take different coins; once the list knows the coins, a payment reads nothing from the node to take them', async () => {
    const f = await make({ poolRows: 4 })
    for (const row of f.pool.records()) f.node.balances.set(row.address.toLowerCase(), MON / 50n)
    await f.sync.refresh()
    f.node.calls.length = 0
    const [a, b] = await Promise.all([
      f.payer.claim({ holder: 'a', stampValueWei: MON / 100n, sources: ['pool'] }),
      f.payer.claim({ holder: 'b', stampValueWei: MON / 100n, sources: ['pool'] }),
    ])
    const accounts = [...a.accounts, ...b.accounts].map(account => account.address)
    expect(new Set(accounts).size).toBe(accounts.length)
    expect(f.node.calls.filter(call => !call.startsWith('block'))).toEqual([])
  })

  it('two wallets of two chains keep separate lists: a coin of one is never a coin of the other', async () => {
    const one = await make()
    const two = await make()
    one.node.balances.set(at(main), MON)
    await expect(
      two.payer.claim({ holder: 'm', stampValueWei: MON / 100n }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    const claim = await one.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    expect(claim.accounts.map(a => a.address)).toEqual([at(main)])
    expect(two.list.all()).toEqual([])
  })
})

describe('what holds a coin, and what lets it go', () => {
  it('a payment let go before anything signed left the wallet frees only its own coins (not the holder\'s others)', async () => {
    const f = await make()
    f.node.balances.set(at(received[0]!), MON / 10n)
    f.node.balances.set(at(received[1]!), MON / 20n)
    const first = await f.payer.claim({ holder: 'm', stampValueWei: MON / 20n })
    await signAndRecord(f, first)
    f.node.balances.set(at(main), MON)
    const second = await f.payer.claim({
      holder: 'm',
      stampValueWei: MON / 50n,
      sources: ['main'],
    })
    await f.payer.release(second)
    expect(f.list.heldBy('m').map(coin => coin.account).sort()).toEqual(
      first.accounts.map(a => a.address).sort(),
    )
    for (const a of first.accounts)
      expect(f.pool.accountClaimedBy(a.address)).toBe('m')
    for (const a of second.accounts)
      expect(f.pool.accountClaimedBy(a.address)).toBeUndefined()
  })

  it('a signed payment\'s coin is not given back by releasePayment: only the chain frees it', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    await signAndRecord(f, claim)
    f.payer.releasePayment('m', claim.accounts[0]!)
    expect(f.list.get(at(main), 0)?.state).toBe('pending_receipt')
    await expect(
      f.payer.claim({
        holder: 'other',
        stampValueWei: MON / 100n,
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow()
  })

  it('an account a contact payment holds is refused at once, not waited for', async () => {
    const f = await make({ accountHeld: address => address.toLowerCase() === at(main) })
    f.node.balances.set(at(main), MON)
    await expect(
      f.payer.claim({ holder: 'm', stampValueWei: MON / 100n }),
    ).rejects.toThrow('held for a contact payment')
  })

  it('a coin whose nonce the native journal reserves is not taken from any source (main included), and its account is read again', async () => {
    let reserved = true
    const f = await make({
      canSelectAccount: (address, nonce) =>
        !(reserved && address.toLowerCase() === at(main) && nonce === 0),
    })
    f.node.balances.set(at(main), MON)
    await expect(
      f.payer.claim({ holder: 'm', stampValueWei: MON / 100n }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(f.sync.isDirty(at(main))).toBe(true)
    // The native operation lands: the account is read again at its next nonce.
    reserved = false
    f.node.nonces.set(at(main), 1)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    expect(claim.accounts[0]).toMatchObject({ address: at(main), nonce: 1 })
  })

  it('a sub-account another payment holds is not waited for: it never comes back', async () => {
    const f = await make({ poolRows: 1 })
    const row = f.pool.records()[0]!
    f.node.balances.set(row.address.toLowerCase(), MON / 50n)
    await f.payer.claim({ holder: 'a', stampValueWei: MON / 100n, sources: ['pool'] })
    await expect(
      f.payer.claim({ holder: 'b', stampValueWei: MON / 100n, sources: ['pool'] }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
  })
})

describe('settlement: the chain decides', () => {
  it('a mined payment spends its coin and the account\'s next coin is listed at the next nonce; a payment waiting for the account then takes it', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const first = await f.payer.claim({ holder: 'one', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, first)
    const waits: (number | undefined)[] = []
    const second = f.payer.claim({
      holder: 'two',
      stampValueWei: MON / 100n,
      onWaiting: blocks => waits.push(blocks),
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(waits).toEqual([undefined])
    mine(f.node, signed!.rawTx, 1001)
    const seen = await f.payer.observe(signed!.rawTx)
    expect(seen).toEqual({ state: 'included', reverted: false, block: 1001 })
    await f.payer.recordSpent('one', signed!, 1001)
    f.payer.releasePayment('one', signed!)
    const made = await second
    expect(made.accounts[0]).toMatchObject({ address: at(main), nonce: 1 })
    expect(f.list.get(at(main), 0)?.state).toBe('spent')
    expect(f.list.get(at(main), 1)?.valueWei).toBe(f.node.balances.get(at(main)))
  })

  it('a payment is called replaced only when, read again after the nonce, it still has no receipt', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, claim)
    const hash = Transaction.from(signed!.rawTx).hash!
    f.node.nonces.set(at(main), 1)
    // The receipt shows up between the parallel reads and the second look.
    let looks = 0
    const receipts = f.node.receipts
    f.node.receipts = new Map()
    const get = receipts.get.bind(receipts)
    f.node.receipts.get = ((h: string) =>
      h === hash && ++looks > 1
        ? { status: 1, blockNumber: 1001, blockHash: '0xblock1001' }
        : get(h)) as typeof receipts.get
    expect(await f.payer.observe(signed!.rawTx)).toEqual({
      state: 'pending',
      where: 'included',
    })
    // Nothing ever shows it: replaced, and the coin leaves the list to be read again.
    f.node.receipts = new Map()
    expect(await f.payer.observe(signed!.rawTx)).toEqual({ state: 'replaced' })
    await f.payer.recordFailed('m', signed!)
    expect(f.list.get(at(main), 0)).toBeUndefined()
    expect(f.sync.isDirty(at(main))).toBe(true)
  })

  it('below the chain\'s reserve, the next coin of an account that just sent waits out the spacing and says how many blocks', async () => {
    const f = await make({ spendSpacingBlocks: 3, reserveBalanceWei: 10n * MON })
    f.node.balances.set(at(main), MON)
    const first = await f.payer.claim({ holder: 'one', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, first)
    mine(f.node, signed!.rawTx, 1001)
    f.node.head = 1001
    await f.payer.recordSpent('one', signed!, 1001)
    f.payer.releasePayment('one', signed!)
    expect(f.list.get(at(main), 1)?.spendableFromBlock).toBe(1003)
    const waits: (number | undefined)[] = []
    const second = f.payer.claim({
      holder: 'two',
      stampValueWei: MON / 100n,
      onWaiting: blocks => waits.push(blocks),
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(waits).toContain(2)
    f.node.head = 1003
    const made = await second
    expect(made.accounts[0]).toMatchObject({ address: at(main), nonce: 1 })
  })

  it('at or above the reserve, the same coin is taken at once', async () => {
    const f = await make({ spendSpacingBlocks: 3, reserveBalanceWei: MON })
    f.node.balances.set(at(main), 50n * MON)
    const first = await f.payer.claim({ holder: 'one', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, first)
    mine(f.node, signed!.rawTx, 1001)
    f.node.head = 1001
    await f.payer.recordSpent('one', signed!, 1001)
    f.payer.releasePayment('one', signed!)
    const made = await f.payer.claim({ holder: 'two', stampValueWei: MON / 100n })
    expect(made.accounts[0]).toMatchObject({ address: at(main), nonce: 1 })
  })

  it('funds that just arrived are listed with the block from which they may be spent', async () => {
    const f = await make({ spendSpacingBlocks: 3 })
    f.node.balances.set(at(main), MON)
    f.node.balanceAt = () => 0n
    await f.sync.refresh()
    expect(f.list.get(at(main), 0)?.spendableFromBlock).toBe(1004)
  })
})

describe('what the list may be out of date about', () => {
  it('a deposit to an account the list already holds a coin of is found when the list does not cover a payment', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON / 100n)
    await f.sync.refresh()
    expect(f.list.get(at(main), 0)?.valueWei).toBe(MON / 100n)
    f.node.balances.set(at(main), MON) // nothing announced it
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 2n })
    expect(claim.accounts).toEqual([
      expect.objectContaining({ address: at(main), nonce: 0, paymentValueWei: MON / 2n }),
    ])
    // A quote that finds too little reads again too.
    f.node.balances.set(at(received[0]!), 3n * MON)
    expect((await f.payer.quote({ stampValueWei: 2n * MON })).status).toBe('available')
  })

  it('a read that a later mark overtook does not clear the mark, and lists nothing', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    let open!: () => void
    f.node.gate = new Promise<void>(resolve => (open = resolve))
    f.sync.markDirty(at(main))
    const reading = f.sync.refresh()
    await new Promise(resolve => setTimeout(resolve, 20))
    // Something spends from main while the read is out (an unjournalled transfer, say).
    f.sync.markDirty(at(main))
    open()
    f.node.gate = undefined
    await reading
    expect(f.sync.isDirty(at(main))).toBe(true)
    expect(f.list.get(at(main), 0)).toBeUndefined()
  })

  it('an account waiting to be read again (another spender just let it go; its transfer is still in the mempool) is read again until known, not refused as "no funds"', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    await f.sync.refresh()
    // A funding pass sent from main and let the account go: its transfer is not in a block yet,
    // so a read leaves the account waiting to be read again.
    f.node.pending = new Map([[at(main), 1]])
    f.sync.markDirty(at(main))
    const claiming = f.payer.claim({ holder: 'm', stampValueWei: MON / 2n })
    let settled = false
    void claiming.then(
      () => (settled = true),
      () => (settled = true),
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    // The transfer is mined: main is at nonce 1 with what is left.
    f.node.pending = undefined
    f.node.nonces.set(at(main), 1)
    f.node.balances.set(at(main), (MON * 9n) / 10n)
    f.node.head += 1
    const claim = await claiming
    expect(claim.accounts).toEqual([
      expect.objectContaining({ address: at(main), nonce: 1, paymentValueWei: MON / 2n }),
    ])
  })

  it('an account that stays waiting to be read again is given up after a bounded number of looks; one read to hold too little is refused at once', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    await f.sync.refresh()
    f.node.pending = new Map([[at(main), 1]])
    f.sync.markDirty(at(main))
    await expect(
      f.payer.claim({ holder: 'm', stampValueWei: MON / 2n }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(f.list.all().filter(coin => coin.holder === 'm')).toEqual([])

    // Read again, the account holds too little: refused without waiting.
    f.node.pending = undefined
    f.node.nonces.set(at(main), 1)
    f.node.balances.set(at(main), MON / 100n)
    f.sync.markDirty(at(main))
    const reads = f.node.calls.length
    await expect(
      f.payer.claim({ holder: 'n', stampValueWei: MON / 2n }),
    ).rejects.toBeInstanceOf(InsufficientStampFundsError)
    expect(
      f.node.calls.slice(reads).filter(call => call === `balance:${at(main)}`).length,
    ).toBeLessThanOrEqual(3)
  })

  it('the next coin of a mined payment is what the account held at the block that included it, not what a lagging node says now', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, claim)
    mine(f.node, signed!.rawTx, 1001)
    const after = f.node.balances.get(at(main))!
    // A replica behind block 1001 still says the balance before the payment.
    f.node.balances.set(at(main), MON)
    f.node.balanceAt = (account, block) =>
      account === at(main) && block >= 1001 ? after : MON
    await f.payer.recordSpent('m', signed!, 1001)
    expect(f.list.get(at(main), 1)?.valueWei).toBe(after)
  })
})

describe('settlement on a node that keeps only recent state', () => {
  it('a payment settled after the included block\'s state was pruned is spent with no guessed successor; the sync lists what the account holds', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, claim)
    mine(f.node, signed!.rawTx, 1001)
    f.node.head = 1500
    f.node.balanceAt = () => {
      throw new Error('missing trie node')
    }
    await f.payer.recordSpent('m', signed!, 1001)
    expect(f.list.get(at(main), 0)?.state).toBe('spent')
    expect(f.list.get(at(main), 1)).toBeUndefined()
    expect(f.sync.isDirty(at(main))).toBe(true)
    // The sync's read (at the head, not the old block) gives the account's coin.
    f.node.balanceAt = undefined
    await f.sync.refresh()
    expect(f.list.get(at(main), 1)?.valueWei).toBe(f.node.balances.get(at(main)))
  })

  it('a failed read at the included block while the node does not yet show the nonce consumed settles nothing', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    const claim = await f.payer.claim({ holder: 'm', stampValueWei: MON / 100n })
    const [signed] = await signAndRecord(f, claim)
    f.node.balanceAt = () => {
      throw new Error('header not found')
    }
    await expect(f.payer.recordSpent('m', signed!, 1001)).rejects.toThrow(
      'header not found',
    )
    expect(f.list.get(at(main), 0)?.state).toBe('pending_receipt')
  })
})

describe('restart and repeated sync', () => {
  it('a coin whose write fails while it is restored stays held, and the open fails rather than freeing it', async () => {
    const store = new MemoryRecordStore<StoredEvmListCoin>()
    const node: Node = {
      head: 1000,
      balances: new Map([[at(main), MON]]),
      nonces: new Map(),
      receipts: new Map(),
      calls: [],
    }
    const before = await make({ store, node })
    const claim = await before.payer.claim({ holder: 'kept', stampValueWei: MON / 100n })
    const [stored] = await signAndRecord(before, claim)
    before.watcher.stop()
    // The coin's row is lost (as after a store reset) and every write fails.
    await store.delete(`${at(main)}:0`)
    const after = await make({ store, node })
    store.put = async () => {
      throw new Error('disk full')
    }
    await expect(after.payer.restore('kept', [stored!])).rejects.toThrow('disk full')
    expect(after.list.get(at(main), 0)).toMatchObject({
      state: 'pending_receipt',
      holder: 'kept',
    })
    await after.payer.finishRestore().catch(() => undefined)
    expect(after.list.get(at(main), 0)?.state).toBe('pending_receipt')
  })

  it('after a restart, a stored payment\'s coin is held again; a signed coin no record names is free', async () => {
    const store = new MemoryRecordStore<StoredEvmListCoin>()
    const node: Node = {
      head: 1000,
      balances: new Map([
        [at(main), MON],
        [at(received[0]!), MON],
      ]),
      nonces: new Map(),
      receipts: new Map(),
      calls: [],
    }
    const before = await make({ store, node })
    const kept = await before.payer.claim({
      holder: 'kept',
      stampValueWei: MON / 100n,
      sources: ['main'],
    })
    const [stored] = await signAndRecord(before, kept)
    const lost = await before.payer.claim({
      holder: 'lost',
      stampValueWei: MON / 100n,
      sources: ['coin'],
    })
    await signAndRecord(before, lost) // its record was never written
    before.watcher.stop()

    const after = await make({ store, node })
    const contested = await after.payer.restore('kept', [stored!])
    expect(contested).toEqual([])
    await after.payer.finishRestore()
    expect(after.list.get(at(main), 0)).toMatchObject({
      state: 'pending_receipt',
      holder: 'kept',
      spendingTx: stored!.rawTx,
    })
    expect(after.pool.accountClaimedBy(at(main))).toBe('kept')
    expect(after.list.get(at(received[0]!), 0)?.state).toBe('unspent')
    // A second stored message naming the same coin does not stop the open: it is reported.
    expect(await after.payer.restore('other', [stored!])).toEqual([at(main)])
  })

  it('reading the chain again changes nothing that did not change, and skips an account with a transaction still in the mempool', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON)
    await f.sync.refresh()
    const once = f.list.all()
    f.sync.markDirty(at(main))
    await f.sync.refresh()
    expect(f.list.all()).toEqual(once)
    f.node.pending = new Map([[at(main), 1]])
    f.sync.markDirty(at(main))
    await f.sync.refresh()
    expect(f.sync.isDirty(at(main))).toBe(true)
    expect(f.list.all()).toEqual(once)
  })
})

describe('read-only stamp affordability', () => {
  it('quotes what the free coins can pay, without taking anything; held coins are not counted', async () => {
    const f = await make()
    f.node.balances.set(at(main), MON / 10n)
    f.node.balances.set(at(received[0]!), MON / 10n)
    const quote = await f.payer.quote({ stampValueWei: MON / 20n })
    expect(quote).toMatchObject({ status: 'available', maximumFeeWei: RESERVE })
    expect(f.list.all().every(coin => coin.state === 'unspent')).toBe(true)
    await f.payer.claim({ holder: 'm', stampValueWei: MON / 20n })
    const after = await f.payer.quote({ stampValueWei: MON / 20n })
    expect(after.capacityWei).toBe(MON / 10n - RESERVE)
    expect(
      (await f.payer.quote({ stampValueWei: MON / 5n })).status,
    ).toBe('insufficient')
  })

  it('throttles repeated insufficient quotes but a real payment discovers a new deposit immediately', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000)
    try {
      const f = await make()
      expect((await f.payer.quote({ stampValueWei: MON })).status).toBe('insufficient')
      const reads = f.node.calls.filter(call => call.startsWith('count:')).length
      await f.payer.quote({ stampValueWei: MON })
      expect(f.node.calls.filter(call => call.startsWith('count:'))).toHaveLength(reads)
      f.node.balances.set(at(main), 2n * MON)
      const claim = await f.payer.claim({ holder: 'deposit', stampValueWei: MON })
      expect(claim.accounts[0]).toMatchObject({ address: at(main), nonce: 0 })
      const readsBeforeExpiry = f.node.calls.filter(call => call.startsWith('count:')).length
      now.mockReturnValue(15_000)
      await f.payer.quote({ stampValueWei: 10n * MON })
      expect(f.node.calls.filter(call => call.startsWith('count:')).length).toBeGreaterThan(readsBeforeExpiry)
    } finally {
      now.mockRestore()
    }
  })

  it('a free message costs nothing and reads nothing', async () => {
    const f = await make()
    expect(await f.payer.quote({ stampValueWei: 0n })).toMatchObject({
      status: 'available',
      maximumFeeWei: 0n,
    })
    expect(f.node.calls).toEqual([])
  })
})
