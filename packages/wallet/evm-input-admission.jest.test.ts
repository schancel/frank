import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SigningKey, Transaction, Wallet, type Provider } from 'ethers'
import level from 'level'
import {
  createEvmInputAdmission,
  captureNativeInputSelection,
  canonicalAdmissionPool,
  nativeAdmissionJournal,
  poolSpendAdmission,
  EvmInputAdmissionError,
  type WalletOperationLifetime,
} from './evm-input-admission'
import {
  EvmNativeOperationJournal,
  type EvmNativeObservation,
  type EvmNativePlan,
  type EvmNativeSource,
} from './storage/evm-native-operation-journal'
import { MonadHdKeyring } from './secp256k1-hd-keyring'
import { MonadChangeKeyring } from './secp256k1-hd-keyring'
import {
  MonadSubAccountPool,
  SubAccountSpendRefusedError,
} from './evm-account-pool'
import { MonadChangePool } from './evm-change-pool'
import { SubAccountLeaseManager } from './evm-account-lease'
import { LevelSubAccountPoolStore } from './storage/level-sub-account-pool-store'
import { InMemoryChangePoolStore } from './storage/change-pool-storage'
import { InMemoryTopicOperationJournal } from './storage/topic-operation-journal'
import { validateMonadWalletState } from './storage/evm-wallet-state-validator'
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
    // What a node answers for a plain transfer to an account without code.
    estimateGas: jest.fn(async () => 21000n),
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
    mainSource: source,
    ownedSource: address =>
      address.toLowerCase() === source.address ? source : undefined,
    sign,
  })
  let payments = 0
  /** One native payment from the fixture's source account: planned at the account's current
   * nonce through the real admission, then signed (`signIndependentPayment`). */
  const pay = (
    params: { recipient: { raw: string }; value: bigint },
    lifetime: WalletOperationLifetime,
  ) =>
    executor.signIndependentPayment(
      {
        kind: 'native',
        recipient: params.recipient,
        members: [{ sourceAddress: source.address, value: params.value }],
        preparationId: `stealth-payment:fixture-${++payments}`,
        maxNativeFeeWei: 10n ** 18n,
      },
      lifetime,
    )
  return { executor, provider, sign, pay }
}
async function fixture(
  location: string,
  network = 'monad-testnet',
  nativeChainId = '10143',
  // Hand-built canonical owners for the hold-rule tests; absent everywhere else.
  canonicalOwners: Partial<
    Pick<
      Parameters<typeof createEvmInputAdmission>[0],
      'canonical' | 'retained' | 'canonicalBinding'
    >
  > = {},
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
  const leases = new SubAccountLeaseManager(pool)
  // A test may make the whole-state validation fail from a chosen moment (hand-built faults).
  const faults: { validate?: () => void } = {}
  const admission = createEvmInputAdmission({
    binding,
    ...canonicalOwners,
    native: journal,
    pool,
    change,
    topic,
    leases,
    validate: () => {
      faults.validate?.()
      validateMonadWalletState({
        pool,
        changePool: change,
        subKeyring: keyring,
        changeKeyring,
      })
    },
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
    leases,
    journal,
    active,
    lifetime,
    epoch,
    plan,
    pool,
    topic,
    keyring,
    poolStore,
    faults,
    binding,
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
  it('rechecks live claims without recovering an unchanged signature on every projection', async () => {
    const f = await fixture(location)
    const recovery = jest.spyOn(SigningKey, 'recoverPublicKey')
    try {
      const plan = f.plan()
      const row = await f.journal.prepare(plan)
      const raw = await new Wallet(f.keyring.deriveSubAccount(0).privateKey)
        .signTransaction(Transaction.from(plan.members[0]!.unsignedTransaction))
      await f.journal.checkpointSigned(row.operationId, 0, raw)
      expect(f.admission.inspect(f.lifetime).status).toBe('ready')
      recovery.mockClear()
      for (let i = 0; i < 20; i++)
        expect(f.admission.inspect(f.lifetime).status).toBe('ready')
      expect(recovery).not.toHaveBeenCalled()
      // Reusing transaction facts must not reuse the owner's validation result.
      f.faults.validate = () => { throw new Error('changed durable owner') }
      expect(f.admission.inspect(f.lifetime).status).toBe('unavailable')
    } finally {
      recovery.mockRestore()
      await f.close()
    }
  })

  it.each(['sender', 'chain', 'bytes'] as const)('refuses changed %s after warming transaction facts', async field => {
    const f = await fixture(location)
    let read: jest.SpyInstance | undefined
    try {
      const plan = f.plan()
      const row = await f.journal.prepare(plan)
      const signer = new Wallet(f.keyring.deriveSubAccount(0).privateKey)
      const raw = await signer.signTransaction(Transaction.from(plan.members[0]!.unsignedTransaction))
      await f.journal.checkpointSigned(row.operationId, 0, raw)
      expect(f.admission.inspect(f.lifetime).status).toBe('ready')
      const changed = f.journal.list()
      const member = changed[0]!.members[0]!
      if (field === 'sender') member.source.address = '0x' + 'ab'.repeat(20)
      if (field === 'bytes') member.signed!.rawTransaction = '0x00'
      if (field === 'chain') {
        const tx = Transaction.from(member.unsignedTransaction)
        tx.chainId += 1n
        member.signed!.rawTransaction = await signer.signTransaction(tx)
      }
      read = jest.spyOn(f.journal, 'list').mockReturnValue(changed)
      expect(f.admission.inspect(f.lifetime)).toMatchObject({ status: 'unavailable', reason: 'invalid-provenance' })
    } finally {
      read?.mockRestore()
      await f.close()
    }
  })

  it('refreshes the original preparation and rejects completion after its admission lifetime expires', async () => {
    const f = await fixture(location)
    try {
      const preparationId = 'stealth-payment:admission-recovery'
      const row = await f.journal.prepare({ ...f.plan(), preparationId })
      const access = nativeAdmissionJournal(f.admission, f.lifetime)
      expect(await access.refreshPreparation(preparationId)).toEqual(row)
      const entered = barrier(),
        release = barrier()
      const refresh = f.journal.refreshPreparation.bind(f.journal)
      jest
        .spyOn(f.journal, 'refreshPreparation')
        .mockImplementation(async id => {
          entered.resolve()
          await release.promise
          return refresh(id)
        })
      const pending = access.refreshPreparation(preparationId)
      const rejected = expect(pending).rejects.toThrow('foreign lifetime')
      await entered.promise
      f.active.clear()
      release.resolve()
      await rejected
      expect(f.journal.list()).toEqual([row])
    } finally {
      await f.close()
    }
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
  it('a topic lease index cannot stand in for a different signed source', async () => {
    const f = await fixture(location)
    try {
      const raw = await new Wallet(
        f.keyring.deriveSubAccount(1).privateKey,
      ).signTransaction(
        Transaction.from(f.plan(1).members[0]!.unsignedTransaction),
      )
      await f.topic.put({
        version: 2,
        kind: 'post',
        requestBytes: [255],
        writeFormat: 'forum-cbor',
        transactionSetOperationId: 'missing-set',
        funders: [f.plan(1).members[0]!.source.address.toLowerCase()],
        rawTransactions: [raw],
        transactionSetHash: Transaction.from(raw).hash!,
        intendedValueWei: '32',
        valueWei: '32',
        direction: 'up',
        payloadHashHex: 'ab'.repeat(32),
      })
      expect(f.admission.inspect(f.lifetime)).toEqual({
        status: 'unavailable',
        reason: 'invalid-provenance',
        held: 'binding',
      })
      expect(f.journal.list()).toEqual([])
      expect(f.topic.getAll()[0]!.rawTransactions).toEqual([raw])
    } finally {
      await f.close()
    }
  })
  it.each(
    (['release', 'setStatus'] as const).flatMap(transition =>
      (['success', 'write-failed', 'expired'] as const).map(
        mode => [transition, mode] as const,
      ),
    ),
  )(
    'canonical %s resolves only after a successful live commit: %s',
    async (transition, mode) => {
      const f = await fixture(location)
      const row = await f.admission.prepareNative(
        f.lifetime,
        f.epoch(),
        f.plan(),
      )
      const raw = await new Wallet(
        f.keyring.deriveSubAccount(0).privateKey,
      ).signTransaction(Transaction.from(row.members[0]!.unsignedTransaction))
      await nativeAdmissionJournal(f.admission, f.lifetime).checkpointSigned(
        row.operationId,
        0,
        raw,
      )
      const transitions = canonicalAdmissionPool(f.admission, f.lifetime)
      const handle = await transitions.acquire(0)
      await transitions.recordSpend(0, {
        rawTx: raw,
        txHash: Transaction.from(raw).hash!,
        valueWei: '32',
      })
      const entered = barrier(),
        release = barrier(),
        original = f.pool.flush.bind(f.pool)
      const flush = jest.spyOn(f.pool, 'flush').mockImplementation(async () => {
        entered.resolve()
        await release.promise
        await original()
        if (mode === 'write-failed') throw new Error('commit response lost')
        if (mode === 'expired') f.active.clear()
      })
      const outcome = (
        transition === 'release'
          ? transitions.release(handle, 'confirmed')
          : transitions.setStatus(0, 'spent')
      ).then(
        () => 'success',
        error => String(error),
      )
      try {
        await entered.promise
        release.resolve()
        const result = await outcome
        if (mode === 'success') expect(result).toBe('success')
        else
          expect(result).toContain(
            mode === 'expired' ? 'foreign lifetime' : 'commit response lost',
          )
        expect(f.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(raw)
      } finally {
        release.resolve()
        await outcome
        flush.mockRestore()
        await f.close()
      }
    },
  )
  it('selection excludes a live legacy lease before constructing another payment', async () => {
    const f = await fixture(location)
    try {
      f.pool.setStatus(0, 'available')
      const lease = f.leases.acquireForIndex(0)
      const writer = nativeAdmissionJournal(f.admission, f.lifetime)
      const held = f.plan().members[0]!.source.address
      const free = f.plan(1).members[0]!.source.address
      // Chain balance alone does not permit borrowing another operation's input.
      expect(captureNativeInputSelection(f.admission, f.lifetime)(held, 0)).toBe(false)
      const selection = captureNativeInputSelection(f.admission, f.lifetime)
      expect(selection(free, 0)).toBe(true)
      f.pool.setStatus(1, 'available')
      const laterLease = f.leases.acquireForIndex(1)
      // A snapshot is advisory: a claim made after selection still wins at admission.
      await expect(writer.prepare(f.plan(1))).rejects.toThrow('conflicting-authorization')
      expect(f.leases.isCurrentLease(laterLease)).toBe(true)
      f.leases.releaseLease(laterLease, 'unused')
      await writer.prepare(f.plan(1))
      expect(f.leases.isCurrentLease(lease)).toBe(true)
      f.leases.releaseLease(lease, 'unused')
      expect(captureNativeInputSelection(f.admission, f.lifetime)(held, 0)).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('an independent current lease holds its own source without blocking a disjoint unsigned claim', async () => {
    const f = await fixture(location)
    try {
      f.pool.setStatus(0, 'available')
      f.leases.acquireForIndex(0)
      const snapshot = f.admission.inspect(f.lifetime)
      expect(snapshot.status).toBe('ready')
      if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
      expect(snapshot.obligations.map(row => row.provenance.kind)).toEqual([
        'live-lease',
      ])
      await expect(
        f.admission.prepareNative(f.lifetime, snapshot.epoch, f.plan()),
      ).rejects.toThrow('conflicting-authorization')
      await f.admission.prepareNative(f.lifetime, snapshot.epoch, f.plan(1))
      expect(f.journal.list()[0]!.members[0]!.source).toEqual(
        f.plan(1).members[0]!.source,
      )
    } finally {
      await f.close()
    }
  })
  it('a current lease is not hidden by a historical included native member at the same index', async () => {
    const f = await fixture(location)
    try {
      const row = await f.admission.prepareNative(
        f.lifetime,
        f.epoch(),
        f.plan(),
      )
      const raw = await new Wallet(
        f.keyring.deriveSubAccount(0).privateKey,
      ).signTransaction(Transaction.from(row.members[0]!.unsignedTransaction))
      const writer = nativeAdmissionJournal(f.admission, f.lifetime)
      await writer.checkpointSigned(row.operationId, 0, raw)
      await writer.recordObservation(
        writer.beginCapture(row.operationId, 0),
        {
          state: 'included-success',
          transactionHash: Transaction.from(raw).hash!,
          blockHash: '0x' + 'ab'.repeat(32),
          blockNumber: 10,
          transactionIndex: 0,
          feeWei: '21000',
        },
        null,
      )
      f.pool.setStatus(0, 'available')
      const priorEpoch = f.epoch()
      const lease = f.leases.acquireForIndex(0)
      const executor = nativeExecutor(f, ['success'])
      await expect(
        executor.pay(
          { recipient: { raw: f.plan().recipient }, value: 32n },
          f.lifetime,
        ),
      ).rejects.toThrow('conflicting-authorization')
      await expect(
        f.admission.prepareNative(f.lifetime, priorEpoch, f.plan(0, 1)),
      ).rejects.toThrow('conflicting-authorization')
      await expect(
        f.admission.authorizeNativeSigning(f.lifetime, row.operationId),
      ).rejects.toThrow('conflicting-authorization')
      expect(executor.sign).not.toHaveBeenCalled()
      f.leases.releaseLease(lease, 'unused')
      expect(f.admission.inspect(f.lifetime).status).toBe('ready')
      await expect(
        f.admission.prepareNative(f.lifetime, f.epoch(), f.plan(0, 0)),
      ).rejects.toThrow('conflicting-authorization')
      await executor.pay(
        { recipient: { raw: f.plan().recipient }, value: 32n },
        f.lifetime,
      )
      expect(executor.sign).toHaveBeenCalledTimes(1)
      expect(Transaction.from(executor.sign.mock.calls[0]![1]).nonce).toBe(1)
      expect(f.journal.list()).toHaveLength(2)
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
      await execution.pay(
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
  // Not here any more: a direct member the node does not know at all, whose nonce another
  // transaction consumed, can never land. It has failed for good and frees its account (see
  // `nativeMemberSuperseded`, and the composition test of a native send whose nonce was
  // consumed). A pending one, and every dependent hold, is kept as before.
  it.each([
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
          execution.pay(
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

// Stage 1 of #1235: the admission operation that records "pool account X was spent by
// transaction T". Every test here fails on main 72631f36 for the same reason unless it says
// otherwise: `poolSpendAdmission` does not exist there, and nothing else writes the record.
describe('pool spend admission (#1235 Stage 1)', () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>
  type State = EvmNativeObservation['state'] | 'signed' | 'unsigned'
  const blockHash = '0x' + 'ab'.repeat(32)
  let location: string
  let open: Fixture[]
  beforeEach(async () => {
    location = await mkdtemp(join(tmpdir(), 'frank-pool-spend-admission-'))
    open = []
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    for (const f of open) await f.close().catch(() => undefined)
    await rm(location, { recursive: true, force: true })
  })
  const start = async (...args: Parameters<typeof fixture>) => {
    const f = await fixture(...args)
    open.push(f)
    // The fixture's own rows are durable before any write is counted or failed.
    await f.pool.flush()
    return f
  }
  const reopen = async (f: Fixture, dir = location) => {
    await f.close()
    return start(dir)
  }
  const addressOf = (f: Fixture, index: number) =>
    f.keyring.deriveSubAccount(index).address.toLowerCase()
  /** Signed bytes from pool key `index`; the defaults are the fixture plan's own transfer. */
  const signFrom = (
    f: Fixture,
    index: number,
    fields: Record<string, unknown> = {},
    key = f.keyring.deriveSubAccount(index).privateKey,
  ) => {
    const tx = Transaction.from({
      type: 2,
      chainId: 10143n,
      nonce: 0,
      to: '0x' + '12'.repeat(20),
      value: 32n,
      gasLimit: 21000n,
      ...(fields.type === 0 || fields.type === 1
        ? { gasPrice: 2n }
        : { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      ...fields,
    })
    tx.signature = new SigningKey(key).sign(tx.unsignedHash)
    return tx.serialized
  }
  const observe = async (
    f: Fixture,
    operationId: string,
    state: EvmNativeObservation['state'],
    memberIndex = 0,
  ) => {
    const writer = nativeAdmissionJournal(f.admission, f.lifetime)
    const hash =
      f.journal.get(operationId).members[memberIndex]!.signed!.transactionHash
    await writer.recordObservation(
      writer.beginCapture(operationId, memberIndex),
      state === 'included-success' || state === 'included-revert'
        ? {
            state,
            transactionHash: hash,
            blockHash,
            blockNumber: 10,
            transactionIndex: 0,
            feeWei: '21000',
          }
        : { state },
      null,
    )
  }
  /** A one-member native operation from pool row `index`, taken through the REAL admission
   * journal (prepare, sign, expose, observe) as far as `state`. */
  const member = async (
    f: Fixture,
    index = 0,
    nonce = 0,
    state: State = 'included-success',
    plan = f.plan(index, nonce),
    key = f.keyring.deriveSubAccount(index).privateKey,
  ) => {
    const row = await f.admission.prepareNative(f.lifetime, f.epoch(), plan)
    const id = row.operationId
    if (state === 'unsigned') return { id, raw: '' }
    const raw = await new Wallet(key).signTransaction(
      Transaction.from(row.members[0]!.unsignedTransaction),
    )
    const writer = nativeAdmissionJournal(f.admission, f.lifetime)
    await writer.checkpointSigned(id, 0, raw)
    if (state === 'signed') return { id, raw }
    await writer.markExposed(id, 0)
    await observe(f, id, state)
    return { id, raw }
  }
  const spend = (f: Fixture) => poolSpendAdmission(f.admission, f.lifetime)
  /** Caller B with this device's own journal member: the member's signed bytes, for its row. */
  const applyOwn = (f: Fixture, operationId: string, memberIndex = 0) => {
    const member = f.journal.get(operationId).members[memberIndex]!
    if (member.source.kind !== 'spend' || !member.signed)
      throw new Error('Fixture member is not a signed pool spend')
    return spend(f).applySpend(
      member.signed.rawTransaction,
      f.binding.chainIdentifier,
      { index: member.source.index, address: member.source.address },
    )
  }
  const obligations = (f: Fixture) => {
    const snapshot = f.admission.inspect(f.lifetime)
    if (snapshot.status !== 'ready') throw new Error(snapshot.reason)
    return JSON.parse(JSON.stringify(snapshot.obligations)) as Array<{
      provenance: { kind: string; role?: string }
    }>
  }
  const kinds = (f: Fixture) => obligations(f).map(c => c.provenance.kind)
  const writes = () => jest.spyOn(LevelSubAccountPoolStore.prototype, 'putMany')
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      value => ({ resolved: value }),
      (error: unknown) => error,
    )
  const database = (f: Fixture) =>
    (
      f.poolStore as unknown as {
        db: { batch: (...args: unknown[]) => Promise<unknown> }
      }
    ).db

  // Contract test 11. Unlike the Stage A test above ("a native journal-derived pool checkpoint
  // remains one authorization"), nothing here hand-writes the row.
  it('an included member\'s own bytes are written as the row checkpoint and spent by the real writer; after a real reopen it is one authorization and the next payment signs once at the next nonce', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    const putMany = writes()
    expect(await applyOwn(f, id)).toEqual({
      kind: 'committed',
      poolIndex: 0,
    })
    expect(putMany).toHaveBeenCalledTimes(1)
    const tx = Transaction.from(raw)
    expect(f.pool.getRecord(0)).toEqual({
      index: 0,
      address: f.keyring.deriveSubAccount(0).address,
      status: 'spent',
      lifecycle: { spend: { rawTx: raw, txHash: tx.hash, valueWei: '32' } },
    })
    expect(kinds(f)).toEqual(['native', 'pool-retained'])
    const reopened = await reopen(f)
    expect(kinds(reopened)).toEqual(['native', 'pool-retained'])
    expect(reopened.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(raw)
    expect(reopened.pool.getRecord(0)?.status).toBe('spent')
    expect(reopened.journal.get(id).members[0]!.signed?.rawTransaction).toBe(
      raw,
    )
    const execution = nativeExecutor(reopened, ['success', 'missing'])
    await execution.pay(
      { recipient: { raw: reopened.plan().recipient }, value: 32n },
      reopened.lifetime,
    )
    expect(execution.sign).toHaveBeenCalledTimes(1)
    expect(Transaction.from(execution.sign.mock.calls[0]![1]).nonce).toBe(1)
  })

  // Contract test 21.
  it('repeating the apply, also across a real reopen, writes once in total and leaves the obligations identical', async () => {
    const f = await start(location)
    const { id } = await member(f)
    const putMany = writes()
    expect((await applyOwn(f, id)).kind).toBe('committed')
    const first = obligations(f)
    expect(await applyOwn(f, id)).toEqual({
      kind: 'already-applied',
      poolIndex: 0,
    })
    expect(obligations(f)).toEqual(first)
    const committed = putMany.mock.calls.length
    const reopened = await reopen(f)
    putMany.mockClear()
    expect((await applyOwn(reopened, id)).kind).toBe(
      'already-applied',
    )
    expect(obligations(reopened)).toEqual(first)
    expect(committed).toBe(1)
    expect(putMany).not.toHaveBeenCalled()
  })

  // Contract test 25.
  it('recording the spend signs and broadcasts nothing, and changes no admission answer: the same pair stays refused, a disjoint one admitted', async () => {
    const f = await start(location)
    const { id } = await member(f)
    await expect(
      f.admission.prepareNative(f.lifetime, f.epoch(), f.plan()),
    ).rejects.toThrow('conflicting-authorization')
    await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan(1))
    const sign = jest.spyOn(SigningKey.prototype, 'sign')
    expect((await applyOwn(f, id)).kind).toBe('committed')
    expect(sign).not.toHaveBeenCalled()
    await expect(
      f.admission.prepareNative(f.lifetime, f.epoch(), f.plan()),
    ).rejects.toThrow('conflicting-authorization')
    await f.admission.prepareNative(f.lifetime, f.epoch(), f.plan(2))
    expect(f.journal.list()).toHaveLength(3)
  })


  it('a stale or foreign lifetime cannot apply, and an uncertain admission applies nothing', async () => {
    const f = await start(location)
    const { raw } = await member(f)
    const putMany = writes()
    expect(() =>
      poolSpendAdmission(
        f.admission,
        Object.freeze({ walletBindingId: location }),
      ),
    ).toThrow('foreign lifetime')
    const held = spend(f)
    f.active.delete(f.lifetime)
    await expect(held.applySpend(raw, 'monad-testnet')).rejects.toThrow(
      'foreign lifetime',
    )
    f.active.add(f.lifetime)
    // An earlier pool write of another owner fails: the session is uncertain.
    jest.spyOn(f.pool, 'flush').mockRejectedValueOnce(new Error('write lost'))
    await expect(
      canonicalAdmissionPool(f.admission, f.lifetime).setStatus(2, 'in-use'),
    ).rejects.toThrow('write lost')
    putMany.mockClear()
    await expect(held.applySpend(raw, 'monad-testnet')).rejects.toThrow(
      'uncertain-owner',
    )
    expect(putMany).not.toHaveBeenCalled()
    expect(f.pool.getRecord(0)?.status).not.toBe('spent')
  })



  // Contract test 13, with the item's canonical identifier.
  it.each([
    ['a transaction signed for another chain ID', { chainId: 1n }, undefined],
    ['a legacy transaction with chain ID 0', { type: 0, chainId: 0n }, undefined],
    ['another canonical chain', {}, 'ethereum-sepolia'],
    ['a family name instead of a chain', {}, 'evm'],
    ['a prefix of the chain identifier', {}, 'monad'],
    ['the identifier in another case', {}, 'Monad-Testnet'],
    ['an empty identifier', {}, ''],
    ['no identifier', {}, undefined as unknown as string],
  ])('applySpend refuses %s: nothing written, admission still ready', async (label, fields, chainIdentifier) => {
    const f = await start(location)
    const raw = signFrom(f, 0, fields)
    expect(Transaction.from(raw).from!.toLowerCase()).toBe(addressOf(f, 0))
    const putMany = writes()
    const before = f.pool.records()
    for (const expected of [
      undefined,
      { index: 0, address: addressOf(f, 0) },
    ]) {
      const error = await refusal(
        spend(f).applySpend(
          raw,
          label === 'no identifier'
            ? (undefined as unknown as string)
            : chainIdentifier ?? 'monad-testnet',
          expected,
        ),
      )
      expect(error).toBeInstanceOf(EvmInputAdmissionError)
      expect(error).toMatchObject({ reason: 'invalid-provenance' })
    }
    expect(putMany).not.toHaveBeenCalled()
    expect(f.pool.records()).toEqual(before)
    expect(f.admission.inspect(f.lifetime).status).toBe('ready')
  })


  // Contract test 14.
  it.each([
    [
      'type 3 (blob)',
      {
        type: 3,
        maxFeePerBlobGas: 1n,
        blobVersionedHashes: ['0x01' + '00'.repeat(31)],
      },
    ],
    [
      'type 4 (authorization list)',
      {
        type: 4,
        authorizationList: [
          {
            address: '0x' + '34'.repeat(20),
            nonce: 0n,
            chainId: 10143n,
            signature: new SigningKey('0x' + '35'.repeat(32)).sign(
              '0x' + '36'.repeat(32),
            ),
          },
        ],
      },
    ],
  ])('applySpend refuses %s bytes with the writer typed refusal, nothing written', async (_label, fields) => {
    const f = await start(location)
    const raw = signFrom(f, 0, fields)
    expect(Transaction.from(raw).type).toBe(fields.type)
    expect(Transaction.from(raw).from!.toLowerCase()).toBe(addressOf(f, 0))
    const putMany = writes()
    const error = await refusal(spend(f).applySpend(raw, 'monad-testnet'))
    expect(error).toBeInstanceOf(SubAccountSpendRefusedError)
    expect(error).toMatchObject({ code: 'invalid-transaction', index: 0 })
    expect(putMany).not.toHaveBeenCalled()
    expect(f.admission.inspect(f.lifetime).status).toBe('ready')
  })

  it.each([
    ['bytes that do not parse', '0x1234'],
    ['unsigned bytes', 'UNSIGNED'],
    ['a value that is not a string', { toString: () => '0x00' }],
  ])('applySpend refuses %s as invalid provenance, never an untyped throw', async (_label, bytes) => {
    const f = await start(location)
    const raw =
      bytes === 'UNSIGNED'
        ? Transaction.from(signFrom(f, 0)).unsignedSerialized
        : bytes
    const putMany = writes()
    const error = await refusal(
      spend(f).applySpend(raw as string, 'monad-testnet'),
    )
    expect(error).toMatchObject({ reason: 'invalid-provenance' })
    expect(putMany).not.toHaveBeenCalled()
  })

  // Caller B with no journal member (contract test 26, at the admission).
  it('applySpend with no journal member commits a transaction a pool key signed as pool:<index>:spend; another key is no-pool-row; a wrong expected row is refused', async () => {
    const f = await start(location)
    const raw = signFrom(f, 1, { nonce: 4 })
    const putMany = writes()
    expect(
      await spend(f).applySpend(
        signFrom(f, 0, {}, '0x' + '21'.repeat(32)),
        'monad-testnet',
      ),
    ).toEqual({ kind: 'no-pool-row' })
    await expect(
      spend(f).applySpend(raw, 'monad-testnet', {
        index: 0,
        address: addressOf(f, 0),
      }),
    ).rejects.toMatchObject({ reason: 'invalid-provenance' })
    await expect(
      spend(f).applySpend(raw, 'monad-testnet', {
        index: 1,
        address: 'not an address',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-provenance' })
    expect(putMany).not.toHaveBeenCalled()
    expect(await spend(f).applySpend(raw, 'monad-testnet')).toEqual({
      kind: 'committed',
      poolIndex: 1,
    })
    expect(putMany).toHaveBeenCalledTimes(1)
    expect(obligations(f).map(c => c.provenance)).toEqual([
      { kind: 'pool-retained', poolIndex: 1, role: 'spend' },
    ])
    expect(await spend(f).applySpend(raw, 'monad-testnet')).toEqual({
      kind: 'already-applied',
      poolIndex: 1,
    })
    // Other bytes for the same nonce are the writer's `held`.
    await expect(
      spend(f).applySpend(
        signFrom(f, 1, { nonce: 4, value: 33n }),
        'monad-testnet',
      ),
    ).rejects.toMatchObject({ code: 'held', index: 1 })
    // A later nonce of the spent account (its change paying on, through the coin list) changes
    // nothing on the row: the row records the spend that retired it.
    expect(
      await spend(f).applySpend(signFrom(f, 1, { nonce: 5 }), 'monad-testnet'),
    ).toEqual({ kind: 'already-applied', poolIndex: 1 })
    expect(putMany).toHaveBeenCalledTimes(1)
    const reopened = await reopen(f)
    expect(kinds(reopened)).toEqual(['pool-retained'])
    expect(reopened.pool.getRecord(1)?.lifecycle?.spend?.rawTx).toBe(raw)
  })

  // Contract test 27 at the admission: the local journal governs caller B.
  it.each(['pending', 'missing', 'included-revert', 'signed'] as const)(
    'the local journal governs: a complete transaction for a member that is %s is held, also with other bytes for the same pair',
    async state => {
      const f = await start(location)
      const { raw } = await member(f, 0, 0, state)
      const putMany = writes()
      for (const bytes of [raw, signFrom(f, 0, { value: 33n })]) {
        const error = await refusal(
          spend(f).applySpend(bytes, 'monad-testnet'),
        )
        expect(error).toMatchObject({ reason: 'conflicting-authorization' })
      }
      expect(putMany).not.toHaveBeenCalled()
      expect(f.pool.getRecord(0)?.status).not.toBe('spent')
      expect(kinds(f)).toEqual(['native'])
    },
  )


  // Contract test 12. HAND-BUILT, every case: the canonical owners are test doubles handed to the
  // admission, and for `live-lease` and `pool-funding` the writer's classification is forced,
  // because in production those rows are `in-use` or `funding` and are refused at step 3.
  it.each([
    'canonical pre-sign intent',
    'cleaned-up canonical attempt',
    'live-lease',
    'pool-funding',
  ] as const)(
    'hand-built hold rule: a %s claim on the row refuses the spend with nothing written and the projection unchanged',
    async owner => {
      const probe = MonadHdKeyring.fromMnemonic(mnemonic)
      const row1 = probe.deriveSubAccount(1).address.toLowerCase()
      const canonicalBytes = (() => {
        const tx = Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 0,
          to: '0x' + '12'.repeat(20),
          value: 32n,
          gasLimit: 21000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })
        tx.signature = new SigningKey(
          probe.deriveSubAccount(1).privateKey,
        ).sign(tx.unsignedHash)
        return tx
      })()
      const prepared = {
        walletBindingId: 'hand-built-binding',
        network: 'monad-testnet',
        chainId: '10143',
        accountId: probe.deriveSubAccount(0).address.toLowerCase(),
      }
      const intents =
        owner === 'canonical pre-sign intent'
          ? [
              {
                attemptRef: 'intent-1',
                prepared,
                members: [
                  {
                    reservation: { id: 'r', index: 1 },
                    from: row1,
                    unsignedSerialized: canonicalBytes.unsignedSerialized,
                    rawTx: null,
                  },
                ],
              },
            ]
          : []
      const attempts =
        owner === 'cleaned-up canonical attempt'
          ? [
              {
                attemptRef: 'attempt-1',
                prepared,
                request: {
                  parts: {
                    transactions: [
                      Uint8Array.from(
                        Buffer.from(canonicalBytes.serialized.slice(2), 'hex'),
                      ),
                    ],
                  },
                },
                reservations: [{ id: 'r', index: 1 }],
                cleanupComplete: true,
              },
            ]
          : []
      const journalDouble = {
        getIntents: () => intents,
        getAll: () => attempts,
      } as never
      const f = await start(location, 'monad-testnet', '10143', {
        canonical: journalDouble,
        retained: journalDouble,
        canonicalBinding: { id: 'hand-built-binding', tuple: '' },
      })
      if (owner === 'live-lease') f.leases.acquireForIndex(1)
      if (owner === 'pool-funding') {
        const funding = Transaction.from({
          type: 2,
          chainId: 10143n,
          nonce: 9,
          to: row1,
          value: 1n,
          gasLimit: 21000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })
        funding.signature = new SigningKey('0x' + '21'.repeat(32)).sign(
          funding.unsignedHash,
        )
        f.poolStore.put({
          index: 1,
          address: f.keyring.deriveSubAccount(1).address,
          status: 'funding',
          fundingAttempt: { rawTx: funding.serialized, txHash: funding.hash! },
        })
      }
      await f.pool.flush()
      if (owner === 'live-lease' || owner === 'pool-funding') {
        // Unforced, the writer itself refuses the row: the hold rule is the second fence.
        await expect(
          spend(f).applySpend(signFrom(f, 1, { nonce: 5 }), 'monad-testnet'),
        ).rejects.toMatchObject({ code: 'held', index: 1 })
        jest.spyOn(f.pool, 'classifySpendOutcome').mockReturnValue('committed')
      }
      const before = obligations(f)
      expect(
        before.some(
          c =>
            c.provenance.kind ===
            (owner === 'canonical pre-sign intent'
              ? 'canonical-intent'
              : owner === 'cleaned-up canonical attempt'
              ? 'canonical-attempt'
              : owner),
        ),
      ).toBe(true)
      const rows = f.pool.records()
      const putMany = writes()
      // Another nonce than the owner's transaction: only the hold rule can refuse this.
      const error = await refusal(
        spend(f).applySpend(signFrom(f, 1, { nonce: 5 }), 'monad-testnet'),
      )
      expect(error).toBeInstanceOf(EvmInputAdmissionError)
      expect(error).toMatchObject({ reason: 'conflicting-authorization' })
      expect(putMany).not.toHaveBeenCalled()
      expect(f.pool.records()).toEqual(rows)
      expect(obligations(f)).toEqual(before)
      if (owner === 'canonical pre-sign intent')
        expect(
          (await f.admission.authorizeCanonicalSigning(f.lifetime, 'intent-1'))
            .attemptRef,
        ).toBe('intent-1')
      // A row no owner claims still commits beside it.
      jest.restoreAllMocks()
      expect(
        await spend(f).applySpend(signFrom(f, 2, { nonce: 5 }), 'monad-testnet'),
      ).toEqual({ kind: 'committed', poolIndex: 2 })
    },
  )

  // Contract test 17: the candidate check is stricter than the projection, in the safe direction.
  it('an included member is held while a later pending member holds the same address, applies once that member resolves, and the later member then changes nothing', async () => {
    const f = await start(location)
    const first = await member(f, 0, 0)
    const second = await member(f, 0, 1, 'pending')
    // The projection itself accepts this state.
    expect(kinds(f)).toEqual(['native', 'native'])
    const putMany = writes()
    await expect(applyOwn(f, first.id)).rejects.toMatchObject({
      reason: 'conflicting-authorization',
    })
    expect(putMany).not.toHaveBeenCalled()
    expect(f.pool.getRecord(0)?.status).not.toBe('spent')
    expect(kinds(f)).toEqual(['native', 'native'])
    await observe(f, second.id, 'included-success')
    expect(await applyOwn(f, first.id)).toEqual({
      kind: 'committed',
      poolIndex: 0,
    })
    expect(await applyOwn(f, second.id)).toEqual({
      kind: 'already-applied',
      poolIndex: 0,
    })
    expect(putMany).toHaveBeenCalledTimes(1)
    expect(f.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(first.raw)
    expect(kinds(f)).toEqual(['native', 'native', 'pool-retained'])
    expect(kinds(await reopen(f))).toEqual(['native', 'native', 'pool-retained'])
  })

  // Contract test 18: the residual variant.
  it('native then native from one row: the second prepare is admitted and included, its apply writes nothing, and the first checkpoint is kept across reopen', async () => {
    const f = await start(location)
    const first = await member(f, 0, 0)
    expect((await applyOwn(f, first.id)).kind).toBe('committed')
    const second = await member(f, 0, 1)
    const putMany = writes()
    expect(await applyOwn(f, second.id)).toEqual({
      kind: 'already-applied',
      poolIndex: 0,
    })
    expect(putMany).not.toHaveBeenCalled()
    expect(f.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(first.raw)
    const reopened = await reopen(f)
    expect(kinds(reopened)).toEqual(['native', 'native', 'pool-retained'])
    expect(reopened.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(first.raw)
  })

  // Contract test 22, first half: the write is lost.
  it('a lost write rejects and leaves the session uncertain; after a real reopen the row is untouched and a new apply commits', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    const batch = jest
      .spyOn(database(f), 'batch')
      .mockRejectedValue(new Error('pool write lost'))
    await expect(applyOwn(f, id)).rejects.toThrow('pool write lost')
    expect(batch).toHaveBeenCalledTimes(1)
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      status: 'unavailable',
      reason: 'uncertain-owner',
    })
    await expect(
      f.admission.authorizeNativeSigning(f.lifetime, id),
    ).rejects.toThrow('uncertain-owner')
    // Keep the write lost through close; a healthy close explicitly retries queued writes.
    await expect(f.close()).rejects.toThrow('pool write lost')
    batch.mockRestore()
    const reopened = await start(location)
    expect(reopened.pool.getRecord(0)?.status).not.toBe('spent')
    expect(reopened.pool.getRecord(0)?.lifecycle?.spend).toBeUndefined()
    expect(kinds(reopened)).toEqual(['native'])
    expect((await applyOwn(reopened, id)).kind).toBe('committed')
    expect(reopened.pool.getRecord(0)?.lifecycle?.spend?.rawTx).toBe(raw)
  })

  it('a healthy close retries a lost write exactly, and reopen recognizes the original member as applied', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    const batch = jest.spyOn(database(f), 'batch')
      .mockRejectedValueOnce(new Error('pool write lost'))
    await expect(applyOwn(f, id)).rejects.toThrow('pool write lost')
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      status: 'unavailable', reason: 'uncertain-owner',
    })
    const reopened = await reopen(f)
    expect(batch).toHaveBeenCalledTimes(2)
    expect(batch.mock.calls[1]).toEqual(batch.mock.calls[0])
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'spent', lifecycle: { spend: { rawTx: raw } },
    })
    expect(reopened.journal.get(id).members[0]!.signed?.rawTransaction).toBe(raw)
    const putMany = writes()
    expect(await applyOwn(reopened, id)).toEqual({
      kind: 'already-applied', poolIndex: 0,
    })
    expect(putMany).not.toHaveBeenCalled()
  })

  // Contract test 22, second half: the write landed and the caller saw an error.
  it('a write that landed while an error was reported leaves the session uncertain; after a real reopen the row is the committed one and the apply is a no-op', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    const db = database(f)
    const original = db.batch.bind(db)
    const batch = jest.spyOn(db, 'batch').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new Error('lost local commit response')
    })
    await expect(applyOwn(f, id)).rejects.toThrow(
      'lost local commit response',
    )
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      reason: 'uncertain-owner',
    })
    batch.mockRestore()
    const reopened = await reopen(f)
    const putMany = writes()
    expect(kinds(reopened)).toEqual(['native', 'pool-retained'])
    expect(await applyOwn(reopened, id)).toEqual({
      kind: 'already-applied',
      poolIndex: 0,
    })
    expect(putMany).not.toHaveBeenCalled()
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: raw } },
    })
  })

  // Contract test 15. HAND-BUILT: nothing was found that passes the checks before the write and
  // fails the projection after it, so the failure is injected into the whole-state validation.
  it('hand-built: when the projection throws after the commit the call rejects, the session signs nothing more, and after a real reopen the row is the valid committed row', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    f.faults.validate = () => {
      if (f.pool.getRecord(0)?.status === 'spent')
        throw new Error('hand-built projection fault')
    }
    await expect(applyOwn(f, id)).rejects.toThrow(
      'hand-built projection fault',
    )
    f.faults.validate = undefined
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      status: 'unavailable',
      reason: 'uncertain-owner',
    })
    await expect(
      f.admission.authorizeNativeSigning(f.lifetime, id),
    ).rejects.toThrow('uncertain-owner')
    await expect(
      f.admission.prepareNative(f.lifetime, {} as never, f.plan(1)),
    ).rejects.toThrow('uncertain-owner')
    const reopened = await reopen(f)
    expect(kinds(reopened)).toEqual(['native', 'pool-retained'])
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: raw } },
    })
    expect((await applyOwn(reopened, id)).kind).toBe(
      'already-applied',
    )
  })

  // Contract test 23: pins the rule that nothing is awaited between the put and the flush call.
  it('does not resolve before its own write is durable, even when another caller flushes the pool meanwhile', async () => {
    const f = await start(location)
    const { id } = await member(f)
    const db = database(f)
    const original = db.batch.bind(db)
    const entered = barrier(),
      release = barrier()
    jest.spyOn(db, 'batch').mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      return original(...args)
    })
    let settled = false
    const applying = applyOwn(f, id)
      .finally(() => {
        settled = true
      })
    await entered.promise
    // Both callers owe the same in-flight write a durable acknowledgment.
    let otherSettled = false
    const otherFlush = f.pool.flush().finally(() => { otherSettled = true })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(otherSettled).toBe(false)
    } finally {
      release.resolve()
    }
    expect((await applying).kind).toBe('committed')
    await otherFlush
    expect(otherSettled).toBe(true)
  })

  // Contract test 24.
  it('two applies of one member give one commit and one no-op; racing a canonical lease of the same row, exactly one wins', async () => {
    const f = await start(location)
    const { id } = await member(f)
    const putMany = writes()
    const both = await Promise.all([
      applyOwn(f, id),
      applyOwn(f, id),
    ])
    expect(both.map(result => result.kind)).toEqual([
      'committed',
      'already-applied',
    ])
    expect(putMany).toHaveBeenCalledTimes(1)
    for (const [offset, order] of (['apply first', 'lease first'] as const).entries()) {
      const index = offset + 1
      const other = await member(f, index)
      f.pool.setStatus(index, 'available')
      const apply = () => applyOwn(f, other.id)
      const lease = () =>
        canonicalAdmissionPool(f.admission, f.lifetime).acquire(index)
      const raced = await Promise.allSettled(
        order === 'apply first' ? [apply(), lease()] : [lease(), apply()],
      )
      expect(raced.map(result => result.status)).toEqual([
        'fulfilled',
        'rejected',
      ])
      expect(f.pool.getRecord(index)?.status).toBe(
        order === 'apply first' ? 'spent' : 'in-use',
      )
    }
  })
  // ---------------------------------------------------------------------------------------
  // #1235 Stage C, the review follow-ups to Stage 1. Each test names what it reproduces on main
  // e8d87c2d, or says it is a pin.
  // ---------------------------------------------------------------------------------------

  // Pin. The fixture's rows are the legacy `available` marker; production derives its rows
  // `unfunded` (`ensureUnfundedSize`), and one of those becomes a native source when it is funded
  // from outside the pool's own funding path. Stage 1 had no test from that status.
  it('pin: an unfunded row goes to spent with the member checkpoint in one write, and reopens as one authorization', async () => {
    const f = await start(location)
    f.pool.ensureUnfundedSize(4)
    await f.pool.flush()
    const unfunded = {
      index: 3,
      address: f.keyring.deriveSubAccount(3).address,
      status: 'unfunded',
    }
    expect(f.pool.getRecord(3)).toEqual(unfunded)
    const { id, raw } = await member(f, 3)
    const putMany = writes()
    expect(await applyOwn(f, id)).toEqual({
      kind: 'committed',
      poolIndex: 3,
    })
    expect(putMany).toHaveBeenCalledTimes(1)
    const spent = {
      ...unfunded,
      status: 'spent',
      lifecycle: {
        spend: { rawTx: raw, txHash: Transaction.from(raw).hash, valueWei: '32' },
      },
    }
    expect(putMany.mock.calls[0]![0]).toEqual([spent])
    const reopened = await reopen(f)
    expect(kinds(reopened)).toEqual(['native', 'pool-retained'])
    expect(reopened.pool.getRecord(3)).toEqual(spent)
    expect(await applyOwn(reopened, id)).toEqual({
      kind: 'already-applied',
      poolIndex: 3,
    })
  })


  // On main e8d87c2d the throw skips the flush and the fault: the call rejects, the admission
  // stays `ready`, and the session goes on signing over a put nobody flushed.
  it('a writer that fails after its put leaves the session uncertain: nothing signs until a real reopen, where the row is valid either way', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    const other = await member(f, 1, 0, 'unsigned')
    const put = jest.spyOn(f.poolStore, 'put')
    // The pool updates its derived account view after the put; that view fails.
    jest.spyOn(f.pool.capacityCache, 'delete').mockImplementation(() => {
      if (put.mock.calls.length > 0)
        throw new Error('fixture: account view failed after the put')
      return false
    })
    await expect(applyOwn(f, id)).rejects.toThrow(
      'fixture: account view failed after the put',
    )
    // What was put is exactly what a successful apply puts.
    expect(put.mock.calls.map(([row]) => row)).toEqual([
      {
        index: 0,
        address: f.keyring.deriveSubAccount(0).address,
        status: 'spent',
        lifecycle: {
          spend: { rawTx: raw, txHash: Transaction.from(raw).hash, valueWei: '32' },
        },
      },
    ])
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      status: 'unavailable',
      reason: 'uncertain-owner',
    })
    await expect(
      f.admission.authorizeNativeSigning(f.lifetime, other.id),
    ).rejects.toThrow('uncertain-owner')
    await expect(applyOwn(f, id)).rejects.toThrow('uncertain-owner')
    const reopened = await reopen(f)
    expect(reopened.admission.inspect(reopened.lifetime).status).toBe('ready')
    const result = await applyOwn(reopened, id)
    expect(['committed', 'already-applied']).toContain(result.kind)
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: raw } },
    })
    expect(kinds(reopened)).toEqual(['native', 'native', 'pool-retained'])
  })

  // Pin: a typed refusal from the writer's own decision still faults nothing.
  it('pin: a refusal before the put (the row is held by another transaction) does not fault the session', async () => {
    const f = await start(location)
    const first = await member(f, 0, 0)
    await applyOwn(f, first.id)
    // The same nonce with other bytes: the row is held by the transaction that spent it.
    const rawTx = signFrom(f, 0, { value: 33n })
    const putMany = writes()
    await expect(
      spend(f).applySpend(rawTx, 'monad-testnet'),
    ).rejects.toBeInstanceOf(SubAccountSpendRefusedError)
    expect(putMany).not.toHaveBeenCalled()
    expect(f.admission.inspect(f.lifetime).status).toBe('ready')
  })

  // Pin (contract 3.5: a committed row is not undone when a later observation regresses).
  it('pin: a member that regresses after its commit keeps its row spent and the admission ready, in the session and after a real reopen', async () => {
    const f = await start(location)
    const { id, raw } = await member(f)
    expect((await applyOwn(f, id)).kind).toBe('committed')
    const putMany = writes()
    await observe(f, id, 'pending')
    expect(f.journal.get(id).members[0]!.observation.state).toBe('pending')
    const check = async (current: Fixture) => {
      expect(current.admission.inspect(current.lifetime).status).toBe('ready')
      expect(kinds(current)).toEqual(['native', 'pool-retained'])
      expect(current.pool.getRecord(0)).toMatchObject({
        status: 'spent',
        lifecycle: { spend: { rawTx: raw } },
      })
      // The row already records these bytes: applying them again writes nothing.
      expect(await applyOwn(current, id)).toEqual({
        kind: 'already-applied',
        poolIndex: 0,
      })
      // The pair is still claimed: the same pair cannot be planned again.
      await expect(
        current.admission.prepareNative(
          current.lifetime,
          current.epoch(),
          current.plan(),
        ),
      ).rejects.toThrow('conflicting-authorization')
    }
    await check(f)
    await check(await reopen(f))
    expect(putMany).not.toHaveBeenCalled()
  })

  // On main e8d87c2d classification answers `needs-apply` for the leased row.
  it('hand-built: a native member whose row is in-use under a live lease is not-eligible and cannot be applied; released unused, it applies', async () => {
    const f = await start(location)
    // Hand-built: the row is made `available` so a lease can be taken after the member exists.
    f.pool.setStatus(0, 'available')
    await f.pool.flush()
    const { id, raw } = await member(f)
    const leases = canonicalAdmissionPool(f.admission, f.lifetime)
    const lease = await leases.acquire(0)
    expect(f.pool.getRecord(0)?.status).toBe('in-use')
    // An included member and a live lease on one account: the projection itself conflicts.
    expect(f.admission.inspect(f.lifetime)).toMatchObject({
      reason: 'conflicting-authorization',
    })
    const putMany = writes()
    const error = await refusal(applyOwn(f, id))
    // The pool's own decision comes first: the row is held.
    expect(error).toBeInstanceOf(SubAccountSpendRefusedError)
    expect(error).toMatchObject({ code: 'held', index: 0 })
    expect(putMany).not.toHaveBeenCalled()
    expect(f.pool.getRecord(0)?.lifecycle?.spend).toBeUndefined()
    await leases.release(lease, 'unused')
    expect(f.pool.getRecord(0)?.status).toBe('available')
    expect(f.admission.inspect(f.lifetime).status).toBe('ready')
    expect(await applyOwn(f, id)).toEqual({
      kind: 'committed',
      poolIndex: 0,
    })
    expect(f.pool.getRecord(0)).toMatchObject({
      status: 'spent',
      lifecycle: { spend: { rawTx: raw } },
    })
  })
})
