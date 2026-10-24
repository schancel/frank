import { SubAccountLeaseManager } from './evm-account-lease'
import { HDNodeWallet, Wallet, type Provider } from 'ethers'
import { EvmSpendPool } from './evm-spend-pool'
import { MonadIdentity } from './evm-identity'
import { EvmHdKeyring, EvmChangeKeyring } from './secp256k1-hd-keyring'
import { EvmSubAccountPool } from './evm-account-pool'
import { EvmChangePool } from './evm-change-pool'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EVM_TRANSACTION_SET_SOURCE_ORDER } from './evm-transaction-set-types'
import { EvmLegacyConsolidator } from './chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './chain/evm-transaction-builder'

async function fixture(origin: 'root' | 'change' | 'identity' | 'deterministic', knownChanges = false) {
  const mainAccount = new Wallet('0x' + '01'.repeat(32))
  const identity = MonadIdentity.fromPrivateKeyHex('0x' + '02'.repeat(32))
  const master = HDNodeWallet.fromSeed('0x' + '03'.repeat(32))
  const keyring = new EvmHdKeyring(master)
  const changeKeyring = new EvmChangeKeyring(master)
  const pool = new EvmSubAccountPool({ keyring })
  const changePool = new EvmChangePool({ keyring: changeKeyring })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'owned',
    },
  })
  await journal.Open()
  const spendPool = new EvmSpendPool({
    mainAccount,
    identity,
    keyring,
    changeKeyring,
    pool,
    changePool,
    coinStore: new MemoryRecordStore(),
    nativeJournal: journal,
    isAccountReserved: address => coins.isAccountReserved(address),
    knownChangeSources: () =>
      knownChanges
        ? coins
            .all()
            .filter(
              coin =>
                coin.origin === 'change' &&
                coin.changeIndex !== undefined &&
                coin.state === 'unspent' &&
                !coin.after,
            )
            .flatMap(coin => [
              { index: coin.changeIndex!, address: coin.account },
              { index: coin.changeIndex!, address: coin.account },
            ])
        : [],
  })
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  pool.ensureSize(1)
  pool.setStatus(0, 'available')
  pool.attachSpendReservation(index => coins.isAccountReserved(pool.getRecord(index)!.address) || journal.referencesSpendIndex(index))
  const source = origin === 'root' ? mainAccount
    : origin === 'identity' ? new Wallet(identity.toPrivateKeyHex())
    : origin === 'deterministic' ? new Wallet(keyring.deriveSubAccount(0).privateKey)
    : new Wallet(changeKeyring.deriveChangeAccount(8).privateKey)
  await coins.put({
    account: source.address,
    privateKey: source.privateKey,
    nonce: 0,
    valueWei: 1000000n,
    origin,
    ...(origin === 'change' ? { changeIndex: 8 } : {}),
  })
  const hooks: { beforeChange?: () => void } = {}
  const preparer = new EvmTransactionSetPreparer({
    reserveChange: (_operation, index) => {
      hooks.beforeChange?.()
      const key = changeKeyring.deriveChangeAccount(index)
      return { account: key.address, privateKey: key.privateKey, changeIndex: index }
    },
    coins,
    journal,
    random: () => 0.5,
    deriveChange: index => ({
      account: changeKeyring.deriveChangeAccount(index).address,
      privateKey: changeKeyring.deriveChangeAccount(index).privateKey,
      changeIndex: index,
    }),
    policy: () => ({
      sourceOrder: EVM_TRANSACTION_SET_SOURCE_ORDER,
      gasPriceWei: 1n,
      paymentGasLimit: () => 21000n,
      changeGasLimit: 21000n,
      paymentFeeIsExact: true,
      dustWei: 1000n,
      radix: 2,
      jitterBps: 1500,
      maxChangeOutputs: 16,
      head: 100,
    }),
  })
  const provider = {
    getBlock: jest.fn(async () => ({
      hash: '0x' + 'ab'.repeat(32),
      number: 100,
    })),
    getBalance: jest.fn(async (_address: string) => 1000000n),
    getTransactionCount: jest.fn(async () => 0),
    getFeeData: jest.fn(async () => ({ gasPrice: 1n, maxFeePerGas: 1n })),
    estimateGas: jest.fn(async () => 21000n),
  }
  const prepare = () =>
    preparer.constructTransactionSet({
      operationId: 'shared',
      amountWei: 100000n,
      kdf: () => new Wallet('0x' + '04'.repeat(32)).address,
    })
  return { journal, spendPool, source, identity, coins, provider, prepare, hooks }
}

it.each(['root', 'change'] as const)(
  'shared %s custody does not enter legacy source discovery',
  async origin => {
    const f = await fixture(origin)
    try {
      const before = await f.spendPool.getSources()
      const result = await f.prepare()
      expect(result.otherTransactions.length).toBeGreaterThan(0)
      expect(await f.spendPool.getSources()).toEqual(before)
      expect(f.journal.sourceReferences()).toEqual([])
      expect(f.journal.canSelect(f.source.address.toLowerCase(), 0)).toBe(false)
      expect(f.coins.heldBy('shared').length).toBeGreaterThan(0)
    } finally {
      await f.journal.Close()
    }
  },
)

it.each(['root', 'change'] as const)(
  'legacy planning excludes a shared %s nonce but permits a disjoint legacy source',
  async origin => {
    const f = await fixture(origin)
    try {
      await f.prepare()
      const source: EvmNativeSource =
        origin === 'root'
          ? { kind: 'main', address: f.source.address.toLowerCase() }
          : {
              kind: 'change',
              address: f.source.address.toLowerCase(),
              index: 8,
            }
      expect(f.spendPool.resolveSource(source).address).toBe(f.source.address)
      const other = {
        kind: 'identity' as const,
        address: f.identity.address.raw.toLowerCase(),
        identityPublicKey: f.spendPool.identityPublicKey,
      }
      let available: EvmNativeSource[] = [source]
      const executor = new EvmLegacyConsolidator({
        journal: f.journal,
        provider: f.provider as unknown as Provider,
        transactionBuilder: new NativeEvmTransactionBuilder(),
        getSources: async () => available,
        sign: async () => {
          throw new Error('A fee quote cannot sign')
        },
      })
      const recipient = { raw: new Wallet('0x' + '05'.repeat(32)).address }
      await expect(
        executor.estimateLegacyFee(recipient, 100000n),
      ).rejects.toThrow('Insufficient native funds')
      available = [source, other]
      await expect(
        executor.estimateLegacyFee(recipient, 100000n),
      ).resolves.toMatchObject({ inputCount: 1 })
      expect(f.provider.estimateGas).toHaveBeenCalledWith(
        expect.objectContaining({ from: other.address }),
      )
      expect(
        new Set(f.provider.getBalance.mock.calls.map(args => args[0])),
      ).toEqual(new Set([source.address, other.address]))
      expect(f.journal.canSelect(source.address, 0)).toBe(false)
    } finally {
      await f.journal.Close()
    }
  },
)

it('discovers indexed inventory change without new legacy records, deduplicates it, and excludes a reserved shared source', async () => {
  const f = await fixture('change', true)
  try {
    const refs = await f.spendPool.getSources()
    expect(
      refs.filter(ref => ref.address === f.source.address.toLowerCase()),
    ).toEqual([
      { kind: 'change', index: 8, address: f.source.address.toLowerCase() },
    ])
    expect(
      f.spendPool.resolveSource(
        refs.find(ref => ref.address === f.source.address.toLowerCase())!,
      ).address,
    ).toBe(f.source.address)
    expect(f.provider.getBalance).not.toHaveBeenCalled()
    await f.prepare()
    expect(
      (await f.spendPool.getSources()).some(
        ref => ref.address === f.source.address.toLowerCase(),
      ),
    ).toBe(false)
    expect(f.journal.canSelect(f.source.address.toLowerCase(), 0)).toBe(false)
    expect(f.coins.heldBy('shared').length).toBeGreaterThan(0)
  } finally {
    await f.journal.Close()
  }
})

it.each(['root', 'change', 'identity', 'deterministic'] as const)('a legacy claim cannot take a %s account during shared signing', async origin => {
  const f = await fixture(origin)
  const source: EvmNativeSource = origin === 'root'
    ? { kind: 'main', address: f.source.address.toLowerCase() }
    : origin === 'identity' ? { kind: 'identity', address: f.source.address.toLowerCase(), identityPublicKey: f.spendPool.identityPublicKey }
    : origin === 'deterministic' ? { kind: 'spend', address: f.source.address.toLowerCase(), index: 0 }
    : { kind: 'change', address: f.source.address.toLowerCase(), index: 8 }
  const other: EvmNativeSource = { kind: 'change', address: f.spendPool.changeKeyring.deriveChangeAccount(9).address.toLowerCase(), index: 9 }
  let checked = false
  f.hooks.beforeChange = () => {
    if (!checked) {
      checked = true
      // Real construction has reserved the input but has not journaled its signed set.
      expect(f.coins.isAccountReserved(source.address)).toBe(true)
      expect(f.journal.list()).toHaveLength(0)
      expect(f.spendPool.sourceHeld(source, 'native-other')).toBe(true)
      expect(() => f.spendPool.claimSources([source], 'native-other')).toThrow('reserved')
      expect(f.coins.heldBy('shared').some(coin => coin.account === source.address)).toBe(true)
      if (origin === 'deterministic')
        expect(() => new SubAccountLeaseManager(f.spendPool.pool).acquireForIndex(0)).toThrow('held')
      const release = f.spendPool.claimSources([other], 'native-other')
      release()
    }
  }
  try {
    await f.prepare()
    expect(checked).toBe(true)
  } finally { await f.journal.Close() }
})
