import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Wallet, type Provider } from 'ethers'
import { installEvmTransactionSetRuntime } from './evm-transaction-set-runtime'
import { type StoredEvmListCoin, EvmCoinList } from './evm-coin-list'
import { EvmChangePool } from './evm-change-pool'
import { EvmSubAccountPool } from './evm-account-pool'
import { MonadHdKeyring, MonadChangeKeyring } from './secp256k1-hd-keyring'
import { MonadIdentity } from './evm-identity'
import {
  LevelRecordStore,
  MemoryRecordStore,
  type EvmCoin,
} from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'

it('reopens durable inventory, retries a failed startup observation without blocking valid coins, and only polls due accounts and public roots', async () => {
  const mnemonic = 'test test test test test test test test test test test junk'
  const mainAccount = new Wallet('0x' + '11'.repeat(32))
  const identity = MonadIdentity.fromSeed({ mnemonic })
  const changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
  const directory = mkdtempSync(join(tmpdir(), 'frank-runtime-retry-'))
  let store = await LevelRecordStore.open<StoredEvmListCoin>(directory, 'coins')
  let coinList = await EvmCoinList.open(store)
  const changes = Array.from({ length: 20 }, (_, index) =>
    changeKeyring.deriveChangeAccount(index),
  )
  for (let index = 0; index < changes.length; index++)
    await coinList.put({
      account: changes[index].address,
      privateKey: changes[index].privateKey,
      origin: 'change',
      changeIndex: index,
      nonce: 0,
      valueWei: 1000000n,
    })
  await store.close()
  store = await LevelRecordStore.open<StoredEvmListCoin>(directory, 'coins')
  coinList = await EvmCoinList.open(store)
  const balances = new Map([
    ...changes.map(change => [change.address.toLowerCase(), 1000000n] as const),
    [mainAccount.address.toLowerCase(), 1000000n],
    [identity.address.raw.toLowerCase(), 1000000n],
  ])
  let failing: string | undefined = changes[10].address.toLowerCase()
  const provider = {
    getBalance: jest.fn(async (address: string) => {
      if (address.toLowerCase() === failing)
        throw new Error('temporarily unavailable')
      return balances.get(address.toLowerCase()) ?? 0n
    }),
    getTransactionCount: jest.fn(async () => 0),
    getBlockNumber: jest.fn(async () => 100),
    getFeeData: jest.fn(async () => ({ gasPrice: 1n })),
  }
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'runtime-budget',
    },
  })
  await journal.Open()
  const runtime = installEvmTransactionSetRuntime({
    mainAccount,
    identity,
    coinList,
    changeKeyring,
    changePool: new EvmChangePool({ keyring: changeKeyring }),
    pool: new EvmSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic(mnemonic),
    }),
    coinStore: new MemoryRecordStore<EvmCoin>(),
    provider: provider as unknown as Provider,
    journal,
    kind: 'monad',
    knownNoCodeAddress: new Wallet('0x' + '22'.repeat(32)).address,
  })
  const warning = jest
    .spyOn(console, 'warn')
    .mockImplementation(() => undefined)
  try {
    expect(provider.getBalance).not.toHaveBeenCalled()
    await runtime.refresh()
    expect(provider.getBalance).toHaveBeenCalledTimes(22)
    expect(runtime.coinListSync.isDirty(changes[10].address)).toBe(false)
    expect(coinList.latestOf(changes[10].address)?.state).toBe('unspent')
    expect(coinList.latestOf(changes[10].address)?.valueWei).toBe(1000000n)
    failing = undefined
    balances.set(changes[10].address.toLowerCase(), 2000000n)
    provider.getBalance.mockClear()
    await runtime.refresh()
    expect(
      provider.getBalance.mock.calls
        .map(([address]) => address.toLowerCase())
        .sort(),
    ).toEqual(
      [
        mainAccount.address.toLowerCase(),
        identity.address.raw.toLowerCase(),
        changes[10].address.toLowerCase(),
      ].sort(),
    )
    expect(coinList.latestOf(changes[10].address)?.valueWei).toBe(2000000n)
    provider.getBalance.mockClear()
    provider.getTransactionCount.mockClear()
    balances.set(mainAccount.address.toLowerCase(), 2000000n)
    await runtime.refresh()
    expect(
      provider.getBalance.mock.calls
        .map(([address]) => address.toLowerCase())
        .sort(),
    ).toEqual(
      [
        mainAccount.address.toLowerCase(),
        identity.address.raw.toLowerCase(),
      ].sort(),
    )
    expect(coinList.latestOf(mainAccount.address)?.valueWei).toBe(2000000n)
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(4)

    failing = changes[7].address.toLowerCase()
    runtime.coinListSync.markDirty(failing)
    await runtime.refresh()
    expect(runtime.coinListSync.isDirty(failing)).toBe(true)
    provider.getBalance.mockClear()
    failing = undefined
    await runtime.refresh()
    expect(runtime.coinListSync.isDirty(changes[7].address)).toBe(false)
    expect(provider.getBalance).toHaveBeenCalledWith(
      changes[7].address.toLowerCase(),
    )
    expect(provider.getBalance).toHaveBeenCalledTimes(3)
    provider.getBalance.mockClear()
    await runtime.coinListSync.refresh({ all: true })
    expect(provider.getBalance).toHaveBeenCalledTimes(22)
  } finally {
    warning.mockRestore()
    await runtime.stop()
    await journal.Close()
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
