import { Wallet } from 'ethers'
import { installEvmWalletCoinList } from './evm-wallet-coin-list'
import { EvmCoinList } from './evm-coin-list'
import { EvmBlockWatcher } from './evm-block-watcher'
import { EvmChangePool } from './evm-change-pool'
import { EvmSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring, MonadChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './evm-identity'
import { MemoryRecordStore, type EvmCoin } from './storage/evm-coin-store'

const mnemonic = 'test test test test test test test test test test test junk'
it('registers root, identity, deterministic, received and change sources without a mailbox coordinator and keeps change ordering after refresh', async () => {
  const mainAccount = new Wallet('0x' + '11'.repeat(32))
  const identity = MonadIdentity.fromSeed({ mnemonic })
  const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
  const changePool = new EvmChangePool({ keyring: changeKeyring })
  const change = changeKeyring.deriveChangeAccount(7)
  changePool.applyRecoveredAccounts([
    { index: 7, address: change.address, nonce: 0, balanceWei: '1000000' },
  ])
  const pool = new EvmSubAccountPool({
    keyring: MonadHdKeyring.fromMnemonic(mnemonic),
    mainAccountAddress: mainAccount.address,
  })
  const legacy = pool.ensureUnfundedSize(3)
  pool.setStatus(0, 'available')
  pool.restoreTerminalEvidence({ ...legacy[1]!, status: 'spent' })
  pool.restoreTerminalEvidence({ ...legacy[2]!, status: 'retired' })
  const received = [2, 3, 4].map(
    index => new Wallet('0x' + index.toString(16).padStart(64, '0')),
  )
  const coinStore = new MemoryRecordStore<EvmCoin>()
  for (const [index, account] of received.entries())
    await coinStore.put(account.address.toLowerCase(), {
      address: account.address,
      privateKey: account.privateKey,
      state: (['unspent', 'pending', 'failed'] as const)[index],
      origin: index === 2 ? 'stamp' : 'stealth',
    } as EvmCoin)
  const coinList = await EvmCoinList.open(new MemoryRecordStore())
  const provider = {
    getBalance: jest.fn(async () => 1000000n),
    getTransactionCount: jest.fn(async () => 0),
  }
  const watcher = { current: async () => 100 } as EvmBlockWatcher
  const sync = installEvmWalletCoinList({
    mainAccount,
    identity,
    pool,
    changePool,
    changeKeyring,
    coinStore,
    coinList,
    provider: provider as never,
    watcher,
  })
  expect(provider.getBalance).not.toHaveBeenCalled()
  await sync.refresh()
  expect(new Set(coinList.all().map(coin => coin.origin))).toEqual(
    new Set(['root', 'identity', 'deterministic', 'stealth', 'stamp', 'change']),
  )
  expect(received.map(account => coinList.latestOf(account.address)?.valueWei)).toEqual([
    1000000n, 1000000n, 1000000n,
  ])
  expect(legacy.map(record => coinList.latestOf(record.address)?.valueWei)).toEqual([
    1000000n, 1000000n, 1000000n,
  ])
  const count = coinList.all().length
  await sync.refresh({ all: true })
  expect(coinList.all()).toHaveLength(count)
  expect(legacy.map(record => coinList.latestOf(record.address)?.valueWei)).toEqual([
    1000000n, 1000000n, 1000000n,
  ])
  expect(coinList.latestOf(change.address)?.changeIndex).toBe(7)
  expect(sync.keyOf(change.address)).toBe(change.privateKey)
})
