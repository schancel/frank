import { SubAccountLeaseManager } from './evm-account-lease'
import { HDNodeWallet, Wallet } from 'ethers'
import { EvmNativeSources } from './evm-native-sources'
import { MonadIdentity } from './evm-identity'
import { EvmHdKeyring, EvmChangeKeyring } from './secp256k1-hd-keyring'
import { EvmSubAccountPool } from './evm-account-pool'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'
import {
  EvmNativeOperationJournal,
  type EvmNativeSource,
} from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import {
  EVM_TRANSACTION_SET_SOURCE_ORDER,
  EvmTransactionSetInsufficientFundsError,
} from './evm-transaction-set-types'

async function fixture(origin: 'root' | 'change' | 'identity' | 'deterministic') {
  const mainAccount = new Wallet('0x' + '01'.repeat(32))
  const identity = MonadIdentity.fromPrivateKeyHex('0x' + '02'.repeat(32))
  const master = HDNodeWallet.fromSeed('0x' + '03'.repeat(32))
  const keyring = new EvmHdKeyring(master)
  const changeKeyring = new EvmChangeKeyring(master)
  const pool = new EvmSubAccountPool({ keyring })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'owned',
    },
  })
  await journal.Open()
  const nativeSources = new EvmNativeSources({
    mainAccount,
    identity,
    keyring,
    changeKeyring,
    pool,
    coinStore: new MemoryRecordStore(),
    isAccountReserved: address => coins.isAccountReserved(address),
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
  return { journal, nativeSources, preparer, source, identity, coins, provider, prepare, hooks }
}

it.each(['root', 'change'] as const)(
  'a coin-list transaction set holds a shared %s coin in the coin list, not as a journal source reference',
  async origin => {
    const f = await fixture(origin)
    try {
      const result = await f.prepare()
      expect(result.otherTransactions.length).toBeGreaterThan(0)
      expect(f.journal.sourceReferences()).toEqual([])
      expect(f.journal.canSelect(f.source.address.toLowerCase(), 0)).toBe(false)
      expect(f.coins.heldBy('shared').length).toBeGreaterThan(0)
    } finally {
      await f.journal.Close()
    }
  },
)

it.each(['root', 'change'] as const)(
  'a second Send quote passes over the %s coin an earlier operation holds and spends a disjoint coin',
  async origin => {
    const f = await fixture(origin)
    try {
      await f.prepare()
      const recipient = new Wallet('0x' + '05'.repeat(32)).address
      // Only the held coin exists: nothing is left to quote.
      await expect(
        f.preparer.quoteLegacyTransactionSet({ destination: recipient, amountWei: 100000n }),
      ).rejects.toBeInstanceOf(EvmTransactionSetInsufficientFundsError)
      const identityWallet = new Wallet(f.identity.toPrivateKeyHex())
      await f.coins.put({
        account: identityWallet.address,
        privateKey: identityWallet.privateKey,
        nonce: 0,
        valueWei: 1000000n,
        origin: 'identity',
      })
      const quote = await f.preparer.quoteLegacyTransactionSet({
        destination: recipient,
        amountWei: 100000n,
      })
      expect(quote.inputCount).toBe(1)
      const second = await f.preparer.constructTransactionSet({
        operationId: 'second',
        amountWei: 100000n,
        kdf: () => recipient,
      })
      expect(
        new Set(
          [...second.bundle, ...second.otherTransactions]
            .filter(tx => tx.predecessor === undefined)
            .map(tx => tx.sourceAccount.toLowerCase()),
        ),
      ).toEqual(new Set([identityWallet.address.toLowerCase()]))
      // A quote reads only the coin list, never a chain balance.
      expect(f.provider.getBalance).not.toHaveBeenCalled()
      expect(f.journal.canSelect(f.source.address.toLowerCase(), 0)).toBe(false)
    } finally {
      await f.journal.Close()
    }
  },
)

it('resolves an indexed change source to its own key and refuses a source of another identity', async () => {
  const f = await fixture('change')
  try {
    const address = f.source.address.toLowerCase()
    expect(
      f.nativeSources.resolveSource({ kind: 'change', index: 8, address }).address,
    ).toBe(f.source.address)
    expect(() =>
      f.nativeSources.resolveSource({ kind: 'change', index: 9, address }),
    ).toThrow()
    expect(() =>
      f.nativeSources.resolveSource({
        kind: 'identity',
        address: f.identity.address.raw.toLowerCase(),
        identityPublicKey: '02' + '00'.repeat(32),
      }),
    ).toThrow('another identity')
  } finally {
    await f.journal.Close()
  }
})

it.each(['root', 'change', 'identity', 'deterministic'] as const)('a legacy claim cannot take a %s account during shared signing', async origin => {
  const f = await fixture(origin)
  const source: EvmNativeSource = origin === 'root'
    ? { kind: 'main', address: f.source.address.toLowerCase() }
    : origin === 'identity' ? { kind: 'identity', address: f.source.address.toLowerCase(), identityPublicKey: f.nativeSources.identityPublicKey }
    : origin === 'deterministic' ? { kind: 'spend', address: f.source.address.toLowerCase(), index: 0 }
    : { kind: 'change', address: f.source.address.toLowerCase(), index: 8 }
  const other: EvmNativeSource = { kind: 'change', address: f.nativeSources.changeKeyring.deriveChangeAccount(9).address.toLowerCase(), index: 9 }
  let checked = false
  f.hooks.beforeChange = () => {
    if (!checked) {
      checked = true
      // Real construction has reserved the input but has not journaled its signed set.
      expect(f.coins.isAccountReserved(source.address)).toBe(true)
      expect(f.journal.list()).toHaveLength(0)
      expect(f.nativeSources.sourceHeld(source, 'native-other')).toBe(true)
      expect(() => f.nativeSources.claimSources([source], 'native-other')).toThrow('reserved')
      expect(f.coins.heldBy('shared').some(coin => coin.account === source.address)).toBe(true)
      if (origin === 'deterministic')
        expect(() => new SubAccountLeaseManager(f.nativeSources.pool).acquireForIndex(0)).toThrow('held')
      const release = f.nativeSources.claimSources([other], 'native-other')
      release()
    }
  }
  try {
    await f.prepare()
    expect(checked).toBe(true)
  } finally { await f.journal.Close() }
})
