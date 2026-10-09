import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transaction, Wallet, type Provider } from 'ethers'
import level from 'level'
import {
  createEvmInputAdmission,
  nativeAdmissionJournal,
  type WalletOperationLifetime,
} from './evm-input-admission'
import {
  EvmNativeOperationJournal,
  type EvmNativePlan,
  type EvmNativeSource,
} from './storage/evm-native-operation-journal'
import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadChangeKeyring } from './monad-change-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { MonadChangePool } from './monad-change-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'
import { InMemoryTopicOperationJournal } from './storage/topic-operation-journal'
import { validateMonadWalletState } from './storage/monad-wallet-state-validator'
import { EvmLegacyConsolidator } from './chain/evm-legacy-consolidator'
import { NativeEvmTransactionBuilder } from './chain/evm-transaction-builder'

const mnemonic = 'test test test test test test test test test test test junk'
function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function nativeExecutor(
  f: Awaited<ReturnType<typeof fixture>>,
  outcomes: readonly (
    | 'success'
    | 'missing'
    | 'pending'
    | 'revert'
    | 'mismatched'
  )[],
) {
  const blockHash = '0x' + 'ab'.repeat(32)
  const history = f.journal
    .list()
    .flatMap(r => r.members)
    .filter(m => m.signed !== null)
    .map((m, i) => ({
      tx: Transaction.from(m.signed!.rawTransaction),
      outcome: outcomes[i]!,
    }))
  const source = f.plan().members[0]!.source
  const provider = {
    getBlock: jest.fn(async () => ({ hash: blockHash, number: 10 })),
    getBalance: jest.fn(async (address: string) =>
      address.toLowerCase() === source.address ? 1000000n : 0n,
    ),
    getTransactionCount: jest.fn(async () => 1),
    getFeeData: jest.fn(async () => ({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    })),
    getTransaction: jest.fn(async (hash: string) => {
      const known = history.find(h => h.tx.hash === hash)
      return !known || known.outcome === 'missing'
        ? null
        : Object.assign(Transaction.from(known.tx.serialized), {
            blockHash,
            blockNumber: 10,
            index: 0,
          })
    }),
    getTransactionReceipt: jest.fn(async (hash: string) => {
      const known = history.find(h => h.tx.hash === hash)
      if (!known || known.outcome === 'missing' || known.outcome === 'pending')
        return null
      return {
        hash: known.outcome === 'mismatched' ? '0x' + 'cd'.repeat(32) : hash,
        from: known.tx.from,
        to: known.tx.to,
        blockHash,
        blockNumber: 10,
        index: 0,
        status: known.outcome === 'revert' ? 0 : 1,
        gasUsed: 21000n,
        gasPrice: 1n,
      }
    }),
    broadcastTransaction: jest.fn(async (raw: string) => ({
      hash: Transaction.from(raw).hash,
    })),
  }
  const sign = jest.fn(async (ref: EvmNativeSource, unsigned: string) => {
    if (ref.kind !== 'spend') throw new Error('Fixture has only spend custody')
    return new Wallet(
      f.keyring.deriveSubAccount(ref.index).privateKey,
    ).signTransaction(Transaction.from(unsigned))
  })
  const executor = new EvmLegacyConsolidator({
    journal: f.journal,
    inputAdmission: f.admission,
    provider: provider as unknown as Provider,
    transactionBuilder: new NativeEvmTransactionBuilder(),
    getSources: async () => [source],
    sign,
  })
  return { executor, provider, sign }
}
async function fixture(
  location: string,
  network = 'monad-testnet',
  nativeChainId = '10143',
) {
  const keyring = MonadHdKeyring.fromMnemonic(mnemonic),
    changeKeyring = MonadChangeKeyring.fromMnemonic(mnemonic)
  await mkdir(location, { recursive: true })
  const poolStore = new LevelSubAccountPoolStore(location)
  await poolStore.Open()
  const pool = new MonadSubAccountPool({
    keyring,
    store: poolStore,
  })
  pool.ensureSize(3)
  const change = new MonadChangePool({
    keyring: changeKeyring,
    store: new InMemoryChangePoolStore(),
  })
  const binding = {
    chainIdentifier: network,
    nativeChainId,
    publicTuple: JSON.stringify({
      mainAddress: keyring.deriveSubAccount(0).address.toLowerCase(),
    }),
  }
  await mkdir(location, { recursive: true })
  const journal = new EvmNativeOperationJournal({ location, binding })
  await journal.Open()
  const active = new Set<WalletOperationLifetime>()
  const topic = new InMemoryTopicOperationJournal()
  const admission = createEvmInputAdmission({
    binding,
    native: journal,
    pool,
    change,
    topic,
    leases: new SubAccountLeaseManager(pool),
    validate: () =>
      validateMonadWalletState({
        pool,
        changePool: change,
        subKeyring: keyring,
        changeKeyring,
      }),
    assertLifetime: token => {
      if (!active.has(token)) throw new Error('foreign lifetime')
    },
  })
  const lifetime = Object.freeze({ walletBindingId: location })
  active.add(lifetime)
  const epoch = () => {
    const snapshot = admission.inspect(lifetime)
    if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
    return snapshot.epoch
  }
  const plan = (index = 0, nonce = 0): EvmNativePlan => ({
    kind: 'native',
    recipient: '0x' + '12'.repeat(20),
    intendedValueWei: '32',
    members: [
      {
        source: {
          kind: 'spend',
          index,
          address: keyring.deriveSubAccount(index).address.toLowerCase(),
        },
        dependencies: [],
        unsignedTransaction: Transaction.from({
          type: 2,
          chainId: BigInt(nativeChainId),
          nonce,
          to: '0x' + '12'.repeat(20),
          value: 32n,
          gasLimit: 21000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        }).unsignedSerialized,
      },
    ],
  })
  return {
    admission,
    journal,
    active,
    lifetime,
    epoch,
    plan,
    pool,
    topic,
    keyring,
    poolStore,
    close: async () => {
      active.clear()
      await journal.Close()
      await poolStore.Close()
    },
  }
}

describe('derived EVM input admission', () => {
  let location: string
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-input-admission-'))
  })
  afterEach(async () => {
    await rm(location, { recursive: true, force: true })
  })
  it('nested_lifetime_token_still_serializes_mutation', async () => {
    const f = await fixture(location)
    try {
      const epoch = f.epoch()
      const result = await Promise.allSettled([
        f.admission.prepareNative(f.lifetime, epoch, f.plan()),
        f.admission.prepareNative(f.lifetime, epoch, f.plan()),
      ])
      expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      expect(f.journal.list()).toHaveLength(1)
      await f.admission.prepareNative(f.lifetime, epoch, f.plan(1))
      expect(f.journal.list()).toHaveLength(2)
    } finally {
      await f.close()
    }
  })
  it('stale_epoch_and_foreign_generation_cannot_claim across real Level reopen', async () => {
    const f = await fixture(location)
    const epoch = f.epoch(),
      old = f.lifetime
    await f.admission.prepareNative(old, epoch, f.plan())
    await f.close()
    const reopened = await fixture(location)
    try {
      expect(() => reopened.admission.inspect(old)).toThrow('foreign lifetime')
      await expect(
        reopened.admission.prepareNative(
          reopened.lifetime,
          epoch,
          reopened.plan(1),
        ),
      ).rejects.toThrow('stale-epoch')
      await expect(
        reopened.admission.prepareNative(
          reopened.lifetime,
          reopened.epoch(),
          reopened.plan(),
        ),
      ).rejects.toThrow('conflicting-authorization')
      expect(reopened.journal.list()).toHaveLength(1)
    } finally {
      await reopened.close()
    }
  })
  it('delayed_unsigned_commit_is_not_selectable and publication follows the actual commit', async () => {
    const f = await fixture(location)
    const db = (
      f.journal as unknown as {
        database: { batch: (...args: unknown[]) => Promise<void> }
      }
    ).database
    const original = db.batch.bind(db),
      entered = barrier(),
      release = barrier()
    const spy = jest.spyOn(db, 'batch').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    try {
      const epoch = f.epoch()
      const first = f.admission.prepareNative(f.lifetime, epoch, f.plan())
      await entered.promise
      let secondFinished = false
      const second = f.admission
        .prepareNative(f.lifetime, epoch, f.plan())
        .then(
          value => {
            secondFinished = true
            return value
          },
          error => {
            secondFinished = true
            throw error
          },
        )
      const secondResult = expect(second).rejects.toThrow(
        'conflicting-authorization',
      )
      await Promise.resolve()
      expect(secondFinished).toBe(false)
      expect(f.journal.list()).toHaveLength(0)
      release.resolve()
      await first
      await secondResult
      expect(f.journal.list()).toHaveLength(1)
    } finally {
      release.resolve()
      spy.mockRestore()
      await f.close()
    }
  })
  it('an uncertain committed write prevents any later signature capability until reopen', async () => {
    const f = await fixture(location)
    const db = (
      f.journal as unknown as {
        database: { batch: (...args: unknown[]) => Promise<void> }
      }
    ).database
    const original = db.batch.bind(db)
    const spy = jest.spyOn(db, 'batch').mockImplementation(async (...args) => {
      await original(...args)
      throw new Error('lost local commit response')
    })
    await expect(
      f.admission.prepareNative(f.lifetime, f.epoch(), f.plan()),
    ).rejects.toThrow('lost local commit response')
    expect(f.admission.inspect(f.lifetime).status).toBe('unavailable')
    spy.mockRestore()
    await f.close()
    const reopened = await fixture(location)
    try {
      expect(reopened.journal.list()).toHaveLength(1)
      const row = reopened.journal.list()[0]!
      expect(
        await reopened.admission.authorizeNativeSigning(
          reopened.lifetime,
          row.operationId,
        ),
      ).toEqual(row)
    } finally {
      await reopened.close()
    }
  })
  it('foreign chain epochs are rejected; the same address and nonce remain isolated', async () => {
    const a = await fixture(join(location, 'a')),
      b = await fixture(join(location, 'b'), 'ethereum-sepolia', '11155111')
    try {
      await a.admission.prepareNative(a.lifetime, a.epoch(), a.plan())
      await expect(
        b.admission.prepareNative(b.lifetime, a.epoch(), b.plan()),
      ).rejects.toThrow('stale-epoch')
      await b.admission.prepareNative(b.lifetime, b.epoch(), b.plan())
      expect(b.journal.list()).toHaveLength(1)
    } finally {
      await a.close()
      await b.close()
    }
  })
  it('a retained native dependency keeps leader value private across a foreign nonce advance', async () => {
    const f = await fixture(location)
    try {
      const plan = f.plan(0)
      plan.kind = 'legacy'
      const fanIn = Transaction.from(plan.members[0]!.unsignedTransaction)
      fanIn.to = f.plan(1).members[0]!.source.address
      plan.members[0]!.unsignedTransaction = fanIn.unsignedSerialized
      plan.members.push({ ...f.plan(1).members[0]!, dependencies: [0] })
      await f.admission.prepareNative(f.lifetime, f.epoch(), plan)
      await expect(
        f.admission.prepareNative(f.lifetime, f.epoch(), f.plan(1, 1)),
      ).rejects.toThrow('conflicting-authorization')
      await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan(2))
      expect(f.journal.list()).toHaveLength(2)
    } finally {
      await f.close()
    }
  })
  it('unsigned cancellation preserves provenance and releases only its own pair', async () => {
    const f = await fixture(location)
    try {
      const row = await f.admission.prepareNative(
        f.lifetime,
        f.epoch(),
        f.plan(),
      )
      await nativeAdmissionJournal(f.admission, f.lifetime).cancelUnsigned(
        row.operationId,
      )
      await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan())
      expect(f.journal.sourceReferences()).toHaveLength(2)
    } finally {
      await f.close()
    }
  })
  it('a native journal-derived pool checkpoint remains one authorization after real Level reopen', async () => {
    const f = await fixture(location)
    const row = await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan())
    const raw = await new Wallet(
      f.keyring.deriveSubAccount(0).privateKey,
    ).signTransaction(Transaction.from(row.members[0]!.unsignedTransaction))
    const writer = nativeAdmissionJournal(f.admission, f.lifetime)
    const signed = await writer.checkpointSigned(row.operationId, 0, raw)
    const hash = signed.members[0]!.signed!.transactionHash
    await writer.markExposed(row.operationId, 0)
    await writer.recordObservation(
      writer.beginCapture(row.operationId, 0),
      {
        state: 'included-success',
        transactionHash: hash,
        blockHash: '0x' + 'ab'.repeat(32),
        blockNumber: 10,
        transactionIndex: 0,
        feeWei: '21000',
      },
      null,
    )
    f.pool.setStatus(0, 'in-use')
    // This is the existing owner checkpoint shape; no remote sync item supplies authority.
    f.pool.recordSpendTransaction(0, {
      rawTx: raw,
      txHash: hash,
      valueWei: '32',
    })
    f.pool.setStatus(0, 'spent')
    await f.close()
    const reopened = await fixture(location)
    try {
      const snapshot = reopened.admission.inspect(reopened.lifetime)
      expect(snapshot.status).toBe('ready')
      if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
      expect(snapshot.obligations.map(c => c.provenance.kind)).toEqual([
        'native',
        'pool-retained',
      ])
      expect(reopened.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(raw)
      expect(
        reopened.journal.get(row.operationId).members[0]!.signed
          ?.rawTransaction,
      ).toBe(raw)
      await reopened.admission.prepareNative(
        reopened.lifetime,
        snapshot.epoch,
        reopened.plan(1),
      )
      await expect(
        reopened.admission.prepareNative(
          reopened.lifetime,
          reopened.epoch(),
          reopened.plan(),
        ),
      ).rejects.toThrow('conflicting-authorization')
      // Use the actual executor to refresh exact inclusion and the current nonce/balance;
      // the projection itself cannot grant next-nonce financial eligibility.
      const execution = nativeExecutor(reopened, ['success', 'missing'])
      await execution.executor.sendNative(
        { recipient: { raw: reopened.plan().recipient }, value: 32n },
        reopened.lifetime,
      )
      expect(execution.provider.getTransactionCount).toHaveBeenCalledWith(
        row.members[0]!.source.address,
        10,
      )
      expect(execution.sign).toHaveBeenCalledTimes(1)
      expect(Transaction.from(execution.sign.mock.calls[0]![1]).nonce).toBe(1)
      expect(
        reopened.journal.get(row.operationId).members[0]!.signed
          ?.rawTransaction,
      ).toBe(raw)
    } finally {
      await reopened.close()
    }
  })
  it.each([
    ['direct', 'missing'],
    ['direct', 'pending'],
    ['dependent', 'missing'],
    ['dependent', 'revert'],
    ['dependent', 'mismatched'],
  ] as const)(
    'actual native selection preserves a %s %s hold after foreign nonce advancement',
    async (kind, outcome) => {
      const f = await fixture(location)
      try {
        const plan = f.plan()
        if (kind === 'dependent') {
          plan.kind = 'legacy'
          const fanIn = f.plan(1).members[0]!
          const tx = Transaction.from(fanIn.unsignedTransaction)
          tx.to = plan.members[0]!.source.address
          fanIn.unsignedTransaction = tx.unsignedSerialized
          plan.members[0]!.dependencies = [0]
          plan.members.unshift(fanIn)
        }
        const original = await f.admission.prepareNative(
          f.lifetime,
          f.epoch(),
          plan,
        )
        const writer = nativeAdmissionJournal(f.admission, f.lifetime)
        for (const [index, member] of original.members.entries()) {
          if (member.source.kind !== 'spend')
            throw new Error('Invalid fixture custody')
          await writer.checkpointSigned(
            original.operationId,
            index,
            await new Wallet(
              f.keyring.deriveSubAccount(member.source.index).privateKey,
            ).signTransaction(Transaction.from(member.unsignedTransaction)),
          )
        }
        const exact = f.journal
          .get(original.operationId)
          .members.map(m => m.signed)
        const execution = nativeExecutor(
          f,
          kind === 'dependent' ? ['success', outcome] : [outcome],
        )
        await expect(
          execution.executor.sendNative(
            { recipient: { raw: plan.recipient }, value: 32n },
            f.lifetime,
          ),
        ).rejects.toThrow()
        expect(execution.provider.getTransactionCount).toHaveBeenCalled()
        expect(execution.sign).not.toHaveBeenCalled()
        expect(execution.provider.broadcastTransaction).not.toHaveBeenCalled()
        expect(f.journal.list()).toHaveLength(1)
        expect(
          f.journal.get(original.operationId).members.map(m => m.signed),
        ).toEqual(exact)
      } finally {
        await f.close()
      }
    },
  )
  it('independently authorized native rows with identical signed bytes fail reopen without rewriting evidence', async () => {
    const f = await fixture(location)
    const row = await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan())
    const raw = await new Wallet(
      f.keyring.deriveSubAccount(0).privateKey,
    ).signTransaction(Transaction.from(row.members[0]!.unsignedTransaction))
    const signed = await nativeAdmissionJournal(
      f.admission,
      f.lifetime,
    ).checkpointSigned(row.operationId, 0, raw)
    const binding = f.journal.binding
    await f.close()
    // Represent conflicting independently persisted authority, not a second checkpoint copy.
    const dbPath = join(location, 'evm-native-operations-v1')
    const db = level(dbPath)
    const second = { ...signed, operationId: 'evm-native-v1:0000000000000002' }
    const manifest = JSON.parse(String(await db.get('manifest')))
    await db.batch([
      {
        type: 'put',
        key: `operation:${second.operationId}`,
        value: JSON.stringify(second),
      },
      {
        type: 'put',
        key: 'manifest',
        value: JSON.stringify({ ...manifest, nextSequence: 3 }),
      },
    ])
    const before = []
    for await (const [key, value] of db.iterator())
      before.push([String(key), String(value)])
    await db.close()
    const reopened = new EvmNativeOperationJournal({ location, binding })
    await expect(reopened.Open()).rejects.toThrow('conflict')
    const check = level(dbPath),
      after = []
    try {
      for await (const [key, value] of check.iterator())
        after.push([String(key), String(value)])
      expect(after).toEqual(before)
    } finally {
      await check.close()
    }
  })
})
