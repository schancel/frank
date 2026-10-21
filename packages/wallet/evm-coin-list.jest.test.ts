/**
 * The coin list alone: one flat list of `[account, nonce]` coins, each with its key, value and
 * state. Selection is synchronous; what survives a restart is what was written before anything
 * could be broadcast.
 */
import { Wallet } from 'ethers'
import {
  EvmCoinList,
  EvmCoinListError,
  coinKey,
  type StoredEvmListCoin,
} from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'

const GWEI = 10n ** 9n
const MON = 10n ** 18n
const FEE = 21_000n * 202n * GWEI
const key = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const accounts = [1, 2, 3, 4, 5].map(n => new Wallet(key(n)))
const at = (w: Wallet) => w.address.toLowerCase()

async function listWith(
  values: readonly bigint[],
  store = new MemoryRecordStore<StoredEvmListCoin>(),
) {
  const list = await EvmCoinList.open(store)
  for (const [i, valueWei] of values.entries())
    await list.put({
      account: accounts[i]!.address,
      nonce: 0,
      privateKey: accounts[i]!.privateKey,
      valueWei,
      origin: 'deterministic',
    })
  return { list, store }
}

describe('the coin list', () => {
  it('two payments built at the same moment never take the same coin', async () => {
    const { list } = await listWith([MON / 10n, MON / 10n, MON / 10n])
    const [a, b] = await Promise.all(
      ['first', 'second'].map(async holder =>
        list.select({ holder, amountWei: MON / 20n, feeReserveWei: FEE }),
      ),
    )
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a![0]!.coin.account).not.toBe(b![0]!.coin.account)
    expect(list.heldBy('first').map(c => c.state)).toEqual(['spend_pending'])
    // A third and fourth: one more coin is free, then none.
    expect(
      list.select({ holder: 'third', amountWei: MON / 20n, feeReserveWei: FEE }),
    ).toHaveLength(1)
    expect(
      list.select({ holder: 'fourth', amountWei: MON / 20n, feeReserveWei: FEE }),
    ).toBeUndefined()
    expect(list.heldBy('fourth')).toEqual([])
  })

  it('a payment is split over coins as the stamp wallet split it, each part leaving its fee', async () => {
    const { list } = await listWith([MON / 100n, MON / 2n, MON / 5n])
    // Like the stamp wallet: a payment is spread over at least two coins when it can be.
    const one = list.select({ holder: 'one', amountWei: MON / 10n, feeReserveWei: FEE })!
    expect(one).toHaveLength(2)
    expect(one.reduce((s, p) => s + p.paymentValueWei, 0n)).toBe(MON / 10n)
    list.abandon('one')
    const several = list.select({
      holder: 'several',
      amountWei: (MON * 6n) / 10n,
      feeReserveWei: FEE,
    })!
    expect(several.length).toBeGreaterThan(1)
    expect(new Set(several.map(p => p.coin.account)).size).toBe(several.length)
    expect(several.reduce((s, p) => s + p.paymentValueWei, 0n)).toBe(
      (MON * 6n) / 10n,
    )
    for (const part of several)
      expect(part.paymentValueWei + FEE).toBeLessThanOrEqual(part.coin.valueWei)
  })

  it('a split with a part below the minimum is not made: one coin covers it whole, or nothing is taken', async () => {
    const { list } = await listWith([MON / 2n, FEE + 10n])
    const parts = list.select({
      holder: 'h',
      amountWei: MON / 4n,
      feeReserveWei: FEE,
      minPartWei: 1000n,
    })!
    expect(parts.map(p => p.coin.account)).toEqual([at(accounts[0]!)])
  })

  it('coins not spendable yet at the head the caller knows are not taken', async () => {
    const list = await EvmCoinList.open(new MemoryRecordStore())
    await list.put({
      account: accounts[0]!.address,
      nonce: 3,
      privateKey: accounts[0]!.privateKey,
      valueWei: MON,
      origin: 'root',
      spendableFromBlock: 104,
    })
    expect(
      list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE, head: 103 }),
    ).toBeUndefined()
    expect(
      list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE, head: 104 }),
    ).toHaveLength(1)
  })

  it('an abandoned build gives its coins back; a signed one that may have left the wallet never', async () => {
    const { list } = await listWith([MON / 10n, MON / 10n])
    const parts = list.select({ holder: 'h', amountWei: (MON * 15n) / 100n, feeReserveWei: FEE })!
    expect(parts).toHaveLength(2)
    await list.recordSigned('h', parts[0]!.coin, '0xsigned')
    list.abandon('h')
    expect(list.get(parts[0]!.coin.account, 0)!.state).toBe('pending_receipt')
    expect(list.get(parts[1]!.coin.account, 0)!.state).toBe('unspent')
    expect(
      list.select({ holder: 'other', amountWei: MON / 20n, feeReserveWei: FEE })!
        .map(p => p.coin.account),
    ).toEqual([parts[1]!.coin.account])
  })

  it('restart: a coin with a transaction out is still held; a build cut off is free again', async () => {
    const { list, store } = await listWith([MON / 10n, MON / 10n])
    const sent = list.select({ holder: 'sent', amountWei: MON / 20n, feeReserveWei: FEE })!
    list.select({ holder: 'cut-off', amountWei: MON / 20n, feeReserveWei: FEE })
    await list.recordSigned('sent', sent[0]!.coin, '0xsigned')
    const reopened = await EvmCoinList.open(store)
    const states = Object.fromEntries(
      reopened.all().map(c => [c.account, c.state]),
    )
    expect(states[sent[0]!.coin.account]).toBe('pending_receipt')
    expect(reopened.get(sent[0]!.coin.account, 0)!.spendingTx).toBe('0xsigned')
    expect(Object.values(states).sort()).toEqual(['pending_receipt', 'unspent'])
    // Only the unspent one can be taken after the restart.
    expect(
      reopened.select({ holder: 'x', amountWei: MON / 20n, feeReserveWei: FEE }),
    ).toHaveLength(1)
    expect(
      reopened.select({ holder: 'y', amountWei: MON / 20n, feeReserveWei: FEE }),
    ).toBeUndefined()
  })

  it('a mined spend makes the coin spent and adds the account\'s next coin; settling again changes nothing', async () => {
    const { list, store } = await listWith([MON])
    const [part] = list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE })!
    await list.recordSigned('h', part!.coin, '0xsigned')
    const settle = () =>
      list.recordMined(part!.coin, {
        block: 200,
        successor: { valueWei: MON - MON / 10n - FEE, spendableFromBlock: 203 },
      })
    await settle()
    await settle()
    const account = part!.coin.account
    expect(list.get(account, 0)!.state).toBe('spent')
    expect(list.get(account, 1)).toMatchObject({
      state: 'unspent',
      valueWei: MON - MON / 10n - FEE,
      spendableFromBlock: 203,
      privateKey: accounts[0]!.privateKey,
    })
    const reopened = await EvmCoinList.open(store)
    expect(reopened.latestOf(account)!.nonce).toBe(1)
    expect(await reopened.prune(201)).toBe(1)
    expect(reopened.get(account, 0)).toBeUndefined()
  })

  it('a coin spent elsewhere leaves the list; sync puts the account back at its new nonce', async () => {
    const { list } = await listWith([MON])
    const [part] = list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE })!
    await list.recordGone(part!.coin)
    expect(list.all()).toEqual([])
    await list.put({
      account: accounts[0]!.address,
      nonce: 2,
      privateKey: accounts[0]!.privateKey,
      valueWei: MON / 3n,
      origin: 'deterministic',
    })
    expect(list.latestOf(accounts[0]!.address)!.nonce).toBe(2)
  })

  it('a coin another device of the account spent (its sent mailbox shows the transaction) is spent here; a held coin is left to its own settlement', async () => {
    const { list, store } = await listWith([MON / 10n, MON / 10n])
    const source = (i: number, nonce: number) => ({
      account: accounts[i]!.address,
      nonce,
      privateKey: accounts[i]!.privateKey,
      origin: 'deterministic' as const,
    })
    // Known and unspent: spent, with that transaction, and never selected again.
    expect(await list.recordSpentElsewhere(source(0, 0), '0xaa')).toBe(true)
    expect(list.get(at(accounts[0]!), 0)).toMatchObject({
      state: 'spent',
      spendingTx: '0xaa',
    })
    expect(await list.recordSpentElsewhere(source(0, 0), '0xaa')).toBe(false)
    // Held by this device: its own settlement decides.
    list.select({ holder: 'mine', amountWei: MON / 20n, feeReserveWei: FEE })
    expect(await list.recordSpentElsewhere(source(1, 0), '0xbb')).toBe(false)
    expect(list.get(at(accounts[1]!), 0)?.state).toBe('spend_pending')
    // Not known yet: recorded spent, so a read from before it cannot list the old nonce.
    expect(await list.recordSpentElsewhere(source(2, 3), '0xcc')).toBe(true)
    expect(list.latestOf(at(accounts[2]!))).toMatchObject({ nonce: 3, state: 'spent' })
    // Already past that nonce: nothing changes.
    expect(await list.recordSpentElsewhere(source(2, 1), '0xdd')).toBe(false)
    // It survives a restart.
    const reopened = await EvmCoinList.open(store)
    expect(reopened.get(at(accounts[0]!), 0)?.state).toBe('spent')
    expect(reopened.get(at(accounts[2]!), 3)?.state).toBe('spent')
  })

  it('sync never overwrites a held coin or moves an account back, and replaces an older unspent coin', async () => {
    const { list } = await listWith([MON])
    const account = accounts[0]!
    const [part] = list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE })!
    await expect(
      list.put({ account: account.address, nonce: 0, privateKey: account.privateKey, valueWei: 1n, origin: 'deterministic' }),
    ).rejects.toBeInstanceOf(EvmCoinListError)
    list.abandon('h')
    await list.put({ account: account.address, nonce: 1, privateKey: account.privateKey, valueWei: MON / 2n, origin: 'deterministic' })
    expect(list.all().map(c => coinKey(c.account, c.nonce))).toEqual([
      coinKey(part!.coin.account, 1),
    ])
    await expect(
      list.put({ account: account.address, nonce: 0, privateKey: account.privateKey, valueWei: MON, origin: 'deterministic' }),
    ).rejects.toBeInstanceOf(EvmCoinListError)
  })

  it('refuses a coin with another account\'s key, and a stored one too', async () => {
    const list = await EvmCoinList.open(new MemoryRecordStore())
    await expect(
      list.put({ account: accounts[0]!.address, nonce: 0, privateKey: accounts[1]!.privateKey, valueWei: 1n, origin: 'root' }),
    ).rejects.toBeInstanceOf(EvmCoinListError)
    const store = new MemoryRecordStore<StoredEvmListCoin>()
    await store.put('x', {
      account: at(accounts[0]!),
      nonce: 0,
      privateKey: accounts[1]!.privateKey,
      valueWei: '1',
      origin: 'root',
      state: 'unspent',
    })
    await expect(EvmCoinList.open(store)).rejects.toBeInstanceOf(EvmCoinListError)
  })

  it('two wallets (two chains) keep separate lists: a coin of one is never selected by the other', async () => {
    const monad = await listWith([MON])
    const sepolia = await EvmCoinList.open(new MemoryRecordStore())
    expect(
      sepolia.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE }),
    ).toBeUndefined()
    expect(
      monad.list.select({ holder: 'h', amountWei: MON / 10n, feeReserveWei: FEE }),
    ).toHaveLength(1)
  })
})
