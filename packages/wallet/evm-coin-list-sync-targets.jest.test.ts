import { Wallet } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { EvmCoinListSync } from './evm-coin-list-sync'
import { MemoryRecordStore } from './storage/evm-coin-store'
import type { EvmBlockWatcher } from './evm-block-watcher'

it('observes only requested owned funding targets and queues concurrent targeted refreshes', async () => {
  const accounts = [1, 2, 3].map(
    index => new Wallet('0x' + index.toString(16).padStart(64, '0')),
  )
  const list = await EvmCoinList.open(new MemoryRecordStore())
  let release!: (balance: bigint) => void
  const held = new Promise<bigint>(resolve => {
    release = resolve
  })
  let blockFirst = false
  const provider = {
    getTransactionCount: jest.fn(async () => 0),
    getBalance: jest.fn(async (address: string) =>
      blockFirst && address === accounts[0]!.address.toLowerCase()
        ? held
        : 1_000_000n,
    ),
  }
  const sync = new EvmCoinListSync({
    list,
    provider: provider as never,
    watcher: { current: async () => 100 } as EvmBlockWatcher,
    sources: () =>
      accounts.map(account => ({
        account: account.address,
        origin: 'deterministic',
        privateKey: () => account.privateKey,
      })),
  })
  await sync.refreshAccounts([accounts[1]!.address])
  expect(provider.getBalance.mock.calls.map(([address]) => address)).toEqual([
    accounts[1]!.address.toLowerCase(),
  ])
  expect(list.latestOf(accounts[0]!.address)).toBeUndefined()
  expect(list.latestOf(accounts[2]!.address)).toBeUndefined()
  blockFirst = true
  const first = sync.refreshAccounts([accounts[0]!.address])
  const second = sync.refreshAccounts([accounts[1]!.address])
  release(1_000_000n)
  await Promise.all([first, second])
  expect(provider.getBalance.mock.calls.map(([address]) => address)).toEqual([
    accounts[1]!.address.toLowerCase(),
    accounts[0]!.address.toLowerCase(),
    accounts[1]!.address.toLowerCase(),
  ])
  expect(list.latestOf(accounts[0]!.address)?.state).toBe('unspent')
  expect(sync.isDirty(accounts[1]!.address)).toBe(false)
  expect(list.latestOf(accounts[2]!.address)).toBeUndefined()
  await sync.stop()
})

it('invalidates an empty observation after a deposit, dirty mark, or failed refresh', async () => {
  const account = new Wallet('0x' + '44'.repeat(32))
  const list = await EvmCoinList.open(new MemoryRecordStore())
  let balance = 0n
  const readBalance = jest.fn(async () => balance)
  const sync = new EvmCoinListSync({
    list,
    provider: {
      getBalance: readBalance,
      getTransactionCount: async () => 0,
    } as never,
    watcher: { current: async () => 100 } as EvmBlockWatcher,
    sources: () => [
      {
        account: account.address,
        origin: 'deterministic',
        privateKey: () => account.privateKey,
      },
    ],
  })
  expect(sync.hasObservedEmpty(account.address)).toBe(false)
  await sync.refreshAccounts([account.address])
  expect(sync.hasObservedEmpty(account.address)).toBe(true)
  expect(list.latestOf(account.address)).toBeUndefined()
  balance = 1_000_000n
  await sync.refresh({ all: true })
  expect(sync.hasObservedEmpty(account.address)).toBe(false)
  expect(list.latestOf(account.address)?.valueWei).toBe(balance)
  sync.markDirty(account.address)
  readBalance.mockRejectedValue(new Error('offline'))
  const warning = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined)
  try {
    await sync.refreshAccounts([account.address])
    expect(sync.hasObservedEmpty(account.address)).toBe(false)
    expect(sync.isDirty(account.address)).toBe(true)
  } finally {
    warning.mockRestore()
    await sync.stop()
  }
})
