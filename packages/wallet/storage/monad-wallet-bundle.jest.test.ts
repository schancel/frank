import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { Wallet, Transaction } from 'ethers'

import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadSubAccountPool } from '../monad-account-pool'
import { MonadChangePool } from '../monad-change-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { LevelChangePoolStore } from './level-change-pool-store'
import { type OutgoingTopicOperation } from './topic-operation-journal'
import { LevelTopicOperationJournal } from './topic-operation-journal'
import { EvmNativeOperationJournal } from './evm-native-operation-journal'
import { LevelCanonicalStampAttemptJournal } from './stamp-attempt-journal'
import {
  nativeAdmissionJournal,
  type WalletOperationLifetime,
} from '../evm-input-admission'
import {
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
  openExistingPoolMonadTopicOwner,
  assertMonadWalletBundleProvenance,
  MonadWalletPersistenceBundle,
} from './monad-wallet-bundle'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const OTHER_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('MonadWalletPersistenceBundle', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'monad-wallet-bundle-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('createInMemoryMonadWalletBundle', () => {
    it('creates an ephemeral bundle with valid bindingId and keyrings', async () => {
      const bundle = createInMemoryMonadWalletBundle({
        mnemonic: TEST_MNEMONIC,
      })

      expect(bundle.durability).toBe('test-only-ephemeral')
      expect(bundle.bindingId).toMatch(/^[0-9a-f]{64}$/)
      expect(bundle.pool).toBeDefined()
      expect(bundle.changePool).toBeDefined()
      expect(bundle.leaseManager).toBeDefined()

      bundle.assertOpen()
      bundle.assertSemanticallyValid()
      bundle.assertNoOrphanedLeases()

      const compacted = await bundle.compactTerminalAccounts(10)
      expect(compacted).toBe(0)

      await bundle.close()
      expect(() => bundle.assertOpen()).toThrow(
        'Monad wallet bundle is closing or closed',
      )
    })
  })

  describe('openMonadWalletBundle persistence & restart durability', () => {
    it('creates a persistent bundle, flushes state, and restores identical state on reopen', async () => {
      const bundle1 = await openMonadWalletBundle({
        location: tempDir,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })

      expect(bundle1.durability).toBe('persistent')
      const originalBindingId = bundle1.bindingId
      expect(originalBindingId).toMatch(/^[0-9a-f]{64}$/)

      assertMonadWalletBundleProvenance(bundle1)

      // Allocate 3 sub-accounts
      const subAccounts = bundle1.pool.ensureSize(3)
      expect(subAccounts.length).toBe(3)
      expect(subAccounts[0].address).toBe(
        MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(0).address,
      )

      bundle1.assertSemanticallyValid()
      await bundle1.pool.flush()
      await bundle1.close()

      // Provenance is revoked on close
      expect(() => assertMonadWalletBundleProvenance(bundle1)).toThrow(
        'Monad wallet bundle was not produced by the persistent bundle factory',
      )

      // Reopen bundle at same location with same seed
      const bundle2 = await openMonadWalletBundle({
        location: tempDir,
        seed: { mnemonic: TEST_MNEMONIC },
      })

      expect(bundle2.durability).toBe('persistent')
      expect(bundle2.bindingId).toBe(originalBindingId)

      // Records must be preserved
      const restoredRecords = bundle2.pool.records()
      expect(restoredRecords.length).toBe(3)
      expect(restoredRecords[0].address).toBe(subAccounts[0].address)
      expect(restoredRecords[1].address).toBe(subAccounts[1].address)
      expect(restoredRecords[2].address).toBe(subAccounts[2].address)

      bundle2.assertSemanticallyValid()
      await bundle2.close()
    })

    it('rejects reopening an existing wallet when the seed fingerprint does not match', async () => {
      const bundle = await openMonadWalletBundle({
        location: tempDir,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })
      await bundle.close()

      await expect(
        openMonadWalletBundle({
          location: tempDir,
          seed: { mnemonic: OTHER_MNEMONIC },
        }),
      ).rejects.toThrow(
        'Monad wallet seed does not match the existing manifest fingerprint',
      )
    })

    it('supports createSeedIfEmpty and automatically persists seed for subsequent opens', async () => {
      const bundle1 = await openMonadWalletBundle({
        location: tempDir,
        createSeedIfEmpty: true,
      })
      const bindingId = bundle1.bindingId
      const account0 = bundle1.pool.ensureSize(1)[0].address
      await bundle1.pool.flush()
      await bundle1.close()

      // Reopen without supplying explicit seed (reads stored seed)
      const bundle2 = await openMonadWalletBundle({
        location: tempDir,
        createSeedIfEmpty: true,
      })
      expect(bundle2.bindingId).toBe(bindingId)
      expect(bundle2.pool.records()[0].address).toBe(account0)
      await bundle2.close()
    })

    it('rejects invalid creation and restore parameter combinations', async () => {
      await expect(
        openMonadWalletBundle({
          location: tempDir,
          mode: 'restore',
        } as any),
      ).rejects.toThrow('Invalid Monad wallet creation/restore mode')

      await expect(
        openMonadWalletBundle({
          location: tempDir,
          seed: { mnemonic: TEST_MNEMONIC },
          createSeedIfEmpty: true,
        } as any),
      ).rejects.toThrow('Invalid Monad wallet creation/restore mode')
    })
  })

  describe('Manifest validation and corruption defense', () => {
    it('fails closed when the manifest database has an unsupported schema', async () => {
      const bundle = await openMonadWalletBundle({
        location: tempDir,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })
      await bundle.close()

      // Corrupt manifest by writing unexpected schema
      const manifestDb = level(join(tempDir, 'wallet-manifest'))
      await manifestDb.open()
      const raw = await manifestDb.get('manifest')
      const manifest = JSON.parse(raw)
      manifest.schema = 'corrupted-schema'
      await manifestDb.put('manifest', JSON.stringify(manifest))
      await manifestDb.close()

      await expect(
        openMonadWalletBundle({
          location: tempDir,
          seed: { mnemonic: TEST_MNEMONIC },
        }),
      ).rejects.toThrow('Unsupported or corrupt Monad wallet manifest')
    })

    it('fails closed when manifest intents do not match accepted versions', async () => {
      const bundle = await openMonadWalletBundle({
        location: tempDir,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })
      await bundle.close()

      const manifestDb = level(join(tempDir, 'wallet-manifest'))
      await manifestDb.open()
      const raw = await manifestDb.get('manifest')
      const manifest = JSON.parse(raw)
      manifest.intents = ['unknown-intent-v99']
      await manifestDb.put('manifest', JSON.stringify(manifest))
      await manifestDb.close()

      await expect(
        openMonadWalletBundle({
          location: tempDir,
          seed: { mnemonic: TEST_MNEMONIC },
        }),
      ).rejects.toThrow('Unsupported or corrupt Monad wallet manifest')
    })
  })

  describe('runOperation concurrency & admission draining', () => {
    it('serializes operations and drains active admissions before closing', async () => {
      const bundle = createInMemoryMonadWalletBundle({
        mnemonic: TEST_MNEMONIC,
      })

      const executionOrder: number[] = []
      let operation1Finished = false

      const p1 = bundle.runOperation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
        executionOrder.push(1)
        operation1Finished = true
        return 'op1'
      })

      const p2 = bundle.runOperation(async () => {
        executionOrder.push(2)
        return 'op2'
      })

      const closePromise = bundle.close()

      // New operations during or after close are rejected
      await expect(bundle.runOperation(async () => 'op3')).rejects.toThrow(
        'Monad wallet bundle is closing or closed',
      )

      const [r1, r2] = await Promise.all([p1, p2])
      await closePromise

      expect(r1).toBe('op1')
      expect(r2).toBe('op2')
      expect(executionOrder).toEqual([1, 2])
      expect(operation1Finished).toBe(true)
    })
  })

  describe('assertSemanticallyValid crash-safety & invariant enforcement', () => {
    it('rejects corrupted sub-account address mismatch with seed derivation', async () => {
      const bundle = createInMemoryMonadWalletBundle({
        mnemonic: TEST_MNEMONIC,
      })

      bundle.pool.ensureSize(1)
      const record = bundle.pool.records()[0]

      // Corrupt record with mismatched address
      const otherKeyring = MonadHdKeyring.fromMnemonic(OTHER_MNEMONIC)
      bundle.pool.applyPrevalidatedRecoveryRecords([
        {
          ...record,
          address: otherKeyring.deriveSubAccount(record.index).address,
        },
      ])

      expect(() => bundle.assertSemanticallyValid()).toThrow(
        'Sub-account address does not match keyring',
      )
    })

    it('rejects in-use accounts without reservations in assertNoOrphanedLeases', async () => {
      const bundle = createInMemoryMonadWalletBundle({
        mnemonic: TEST_MNEMONIC,
      })

      bundle.pool.ensureSize(1)
      bundle.pool.setStatus(0, 'in-use')

      expect(() => bundle.assertNoOrphanedLeases()).toThrow(
        'Wallet has 1 in-use funding account(s) without a local exact-set attempt: 0',
      )
    })
  })
})

// Historical topic authority is a reference even when no runtime supports its request bytes.
describe('Forum retention-only journal obligations', () => {
  it('preserves old rows through actual reopen, orphan checking and terminal compaction', async () => {
    const location = mkdtempSync(join(tmpdir(), 'forum-retained-bundle-'))
    let bundle: MonadWalletPersistenceBundle | undefined
    try {
      bundle = await openMonadWalletBundle({
        location,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })
      bundle.pool.ensureSize(4)
      const formats = [undefined, 'protobuf', 'cbor'] as const
      const rows = formats.map((writeFormat, index) => ({
        version: 1 as const,
        kind: 'post' as const,
        requestBytes: [255, index],
        ...(writeFormat ? { writeFormat } : {}),
        leaseIndex: index,
        senderAddress: bundle!.pool.getRecord(index)!.address,
        rawTx: 'old signed authority',
        txHash: '0x' + index.toString(16).padStart(64, '0'),
        valueWei: '7',
        direction: 'up' as const,
        payloadHashHex: 'ab'.repeat(32),
      }))
      for (const row of rows) {
        bundle.leaseManager.acquireForIndex(row.leaseIndex)
        await bundle.topicOperationJournal.put(row)
      }
      await bundle.pool.flush()
      const prior = JSON.stringify(bundle.topicOperationJournal.getAll())
      await bundle.close()
      bundle = await openMonadWalletBundle({
        location,
        seed: { mnemonic: TEST_MNEMONIC },
      })
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(() => bundle!.assertNoOrphanedLeases()).not.toThrow()
      // All three historical formats pin their indices even when already terminal.
      for (let index = 0; index < 4; index++) {
        const key =
          MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(index)
        const signer = new Wallet(key.privateKey)
        const fields = {
          chainId: 10143n,
          value: 7n,
          nonce: 0,
          gasLimit: 21000n,
          gasPrice: 1n,
        }
        const fundingRaw = await signer.signTransaction({
          ...fields,
          to: key.address,
        })
        const spendRaw = await signer.signTransaction({
          ...fields,
          to: '0x000000000000000000000000000000000000dEaD',
          nonce: 1,
        })
        bundle.pool.recordFundingTransaction(index, {
          rawTx: fundingRaw,
          txHash: Transaction.from(fundingRaw).hash!,
          valueWei: '7',
        })
        bundle.pool.recordSpendTransaction(index, {
          rawTx: spendRaw,
          txHash: Transaction.from(spendRaw).hash!,
          valueWei: '7',
        })
        bundle.pool.recordRecoveryDisposition(index, {
          kind: 'none',
          valueWei: '0',
        })
        bundle.pool.setStatus(index, 'retired')
      }
      await bundle.pool.flush()
      expect(await bundle.compactTerminalAccounts(8)).toBe(1)
      expect(bundle.pool.getRecord(3)).toBeUndefined()
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(bundle.pool.records().map(r => r.status)).toEqual([
        'retired',
        'retired',
        'retired',
      ])
      await bundle.close()
      bundle = await openMonadWalletBundle({
        location,
        seed: { mnemonic: TEST_MNEMONIC },
      })
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(bundle.pool.records().map(r => r.status)).toEqual([
        'retired',
        'retired',
        'retired',
      ])
    } finally {
      await bundle?.close()
      rmSync(location, { recursive: true, force: true })
    }
  })
})

describe('existing-pool private topic owner', () => {
  const keyrings = () => ({
    subKeyring: MonadHdKeyring.fromMnemonic(TEST_MNEMONIC),
    changeKeyring: MonadChangeKeyring.fromMnemonic(TEST_MNEMONIC),
  })
  function existingPools() {
    const keys = keyrings()
    const pool = new MonadSubAccountPool({ keyring: keys.subKeyring })
    const changePool = new MonadChangePool({ keyring: keys.changeKeyring })
    const leaseManager = new SubAccountLeaseManager(pool)
    return { ...keys, pool, changePool, leaseManager }
  }
  const readyParams = () => ({
    ...existingPools(),
    stampReferencesLeaseIndex: () => false,
    assertEnclosingAdmission: () => undefined,
    nativeBinding: {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: JSON.stringify({
        mainAddress: keyrings()
          .subKeyring.deriveSubAccount(0)
          .address.toLowerCase(),
      }),
    },
  })
  function barrier() {
    let resolve!: () => void
    const promise = new Promise<void>(done => {
      resolve = done
    })
    return { promise, resolve }
  }
  it.each([
    ['topic', LevelTopicOperationJournal.prototype],
    ['native', EvmNativeOperationJournal.prototype],
    ['canonical', LevelCanonicalStampAttemptJournal.prototype],
  ] as const)(
    'all_projections_ready_before_publication waits for the real %s owner and releases failed opens',
    async (_name, prototype) => {
      const location = mkdtempSync(join(tmpdir(), 'admission-publication-'))
      const params = { ...readyParams(), location }
      const entered = barrier(),
        release = barrier()
      const original = prototype.Open
      let published = false,
        owner: MonadWalletPersistenceBundle | undefined
      const spy = jest
        .spyOn(prototype, 'Open')
        .mockImplementationOnce(async function (this: typeof prototype) {
          entered.resolve()
          await release.promise
          return original.call(this)
        })
      const opening = openExistingPoolMonadTopicOwner(params).then(value => {
        published = true
        owner = value
        return value
      })
      try {
        await entered.promise
        expect(published).toBe(false)
        release.resolve()
        await opening
        await owner!.runLifetime(async lifetime => {
          expect(owner!.inputAdmission.inspect(lifetime).status).toBe('ready')
        })
        await owner!.close()
        spy.mockRejectedValueOnce(new Error('owner open interrupted'))
        await expect(openExistingPoolMonadTopicOwner(params)).rejects.toThrow(
          'owner open interrupted',
        )
        spy.mockRestore()
        owner = await openExistingPoolMonadTopicOwner(params)
        await owner.runLifetime(async lifetime => {
          expect(owner!.inputAdmission.inspect(lifetime).status).toBe('ready')
        })
      } finally {
        release.resolve()
        await opening.catch(() => undefined)
        spy.mockRestore()
        await owner?.close()
        rmSync(location, { recursive: true, force: true })
      }
    },
  )
  it('invalid existing pool or change provenance cannot publish financial admission', async () => {
    for (const component of ['pool', 'change'] as const) {
      const params = readyParams()
      const spy =
        component === 'pool'
          ? jest.spyOn(params.pool, 'records').mockImplementation(() => {
              throw new Error('invalid pool owner')
            })
          : jest.spyOn(params.changePool, 'records').mockImplementation(() => {
              throw new Error('invalid change owner')
            })
      await expect(openExistingPoolMonadTopicOwner(params)).rejects.toThrow(
        `invalid ${component} owner`,
      )
      spy.mockRestore()
      const recovered = await openExistingPoolMonadTopicOwner(params)
      await recovered.close()
    }
  })
  it('a real rejected canonical open preserves its bytes and releases only the failed bundle handles', async () => {
    const location = mkdtempSync(join(tmpdir(), 'admission-corrupt-owner-'))
    const params = { ...readyParams(), location }
    const path = join(location, 'canonical-stamp-attempts-v1')
    const database = level(path)
    const original = '{"unsupported":"retained fixture evidence"}'
    await database.put('unknown-retained-row', original)
    await database.close()
    try {
      for (let n = 0; n < 2; n++) {
        await expect(openExistingPoolMonadTopicOwner(params)).rejects.toThrow(
          'corrupt',
        )
        const check = level(path)
        try {
          const rows = []
          for await (const [key, value] of check.iterator())
            rows.push([String(key), String(value)])
          expect(rows).toEqual([['unknown-retained-row', original]])
        } finally {
          await check.close()
        }
      }
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  })
  it('a rejected canonical database close never becomes a successful repeated cleanup', async () => {
    const location = mkdtempSync(join(tmpdir(), 'admission-close-failure-'))
    const journal = new LevelCanonicalStampAttemptJournal(location)
    await journal.Open()
    const database = (
      journal as unknown as { database: { close(): Promise<void> } }
    ).database
    const spy = jest
      .spyOn(database, 'close')
      .mockRejectedValueOnce(new Error('close acknowledgement lost'))
    try {
      await expect(journal.Close()).rejects.toThrow(
        'close acknowledgement lost',
      )
      await expect(journal.Close()).rejects.toThrow('closed')
      expect(() => journal.getAll()).toThrow('closed')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      await database.close()
      rmSync(location, { recursive: true, force: true })
    }
  })
  it('close drains an admitted lifetime but old tokens and writer completions cannot affect the reopened owner', async () => {
    const params = readyParams(),
      owner = await openExistingPoolMonadTopicOwner(params)
    const entered = barrier(),
      release = barrier()
    let old!: WalletOperationLifetime,
      writer!: ReturnType<typeof nativeAdmissionJournal>
    const operation = owner.runLifetime(async lifetime => {
      old = lifetime
      writer = nativeAdmissionJournal(owner.inputAdmission, lifetime)
      entered.resolve()
      await release.promise
      expect(owner.inputAdmission.inspect(lifetime).status).toBe('ready')
    })
    await entered.promise
    let closed = false
    const closing = owner.close().then(() => {
      closed = true
    })
    await expect(owner.runLifetime(async () => undefined)).rejects.toThrow(
      'closing or closed',
    )
    expect(closed).toBe(false)
    release.resolve()
    await operation
    await closing
    const next = await openExistingPoolMonadTopicOwner(params)
    try {
      expect(() => next.inputAdmission.inspect(old)).toThrow(
        'Expired or foreign',
      )
      expect(() =>
        writer.cancelUnsigned('evm-native-v1:0000000000000001'),
      ).toThrow('Expired or foreign')
      expect(next.nativeJournal!.list()).toEqual([])
    } finally {
      await next.close()
    }
  })
  it('preserves pool, lease and role identities, refuses competing owners, and guards enclosing admission', async () => {
    const original = existingPools()
    original.pool.ensureSize(1)
    let enclosed = false
    const attachPool = jest.spyOn(original.pool, 'attachWalletOperationGate')
    const attachChange = jest.spyOn(
      original.changePool,
      'attachWalletOperationGate',
    )
    const params = {
      ...original,
      stampReferencesLeaseIndex: () => false,
      assertEnclosingAdmission: () => {
        if (!enclosed) throw Error('outside wallet queue')
      },
    }
    const owner = await openExistingPoolMonadTopicOwner(params)
    try {
      expect(owner.pool).toBe(original.pool)
      expect(owner.changePool).toBe(original.changePool)
      expect(owner.leaseManager).toBe(original.leaseManager)
      expect(attachPool).not.toHaveBeenCalled()
      expect(attachChange).not.toHaveBeenCalled()
      expect(original.pool.getRecord(0)!.address).toBe(
        original.subKeyring.deriveSubAccount(0).address,
      )
      owner.assertSemanticallyValid()
      await expect(owner.runOperation(async () => undefined)).rejects.toThrow(
        'outside wallet queue',
      )
      await expect(openExistingPoolMonadTopicOwner(params)).rejects.toThrow(
        'already has an owner',
      )
      enclosed = true
      await owner.runOperation(async admission => {
        await owner.runOperation(async () => undefined, admission)
      })
      // No shared pool gate was attached: close must not change normal DM pool admission.
      await owner.close()
      original.pool.ensureUnfundedSize(2)
      expect(original.pool.records()).toHaveLength(2)
      const next = await openExistingPoolMonadTopicOwner(params)
      await next.close()
    } finally {
      await owner.close()
    }
  })
  it('also refuses pools owned by a real original bundle without touching that owner', async () => {
    const original = createInMemoryMonadWalletBundle({
      mnemonic: TEST_MNEMONIC,
    })
    try {
      await expect(
        openExistingPoolMonadTopicOwner({
          ...keyrings(),
          pool: original.pool,
          changePool: original.changePool,
          leaseManager: original.leaseManager,
          stampReferencesLeaseIndex: () => false,
          assertEnclosingAdmission: () => {},
        }),
      ).rejects.toThrow('already has an owner')
      original.assertOpen()
      await original.runOperation(async () => undefined)
    } finally {
      await original.close()
    }
  })
  it('close rejects new admissions and drains a complete admitted journal operation once', async () => {
    const location = mkdtempSync(join(tmpdir(), 'topic-owner-drain-'))
    const original = existingPools()
    original.pool.ensureSize(1)
    const owner = await openExistingPoolMonadTopicOwner({
      location,
      ...original,
      stampReferencesLeaseIndex: () => false,
      assertEnclosingAdmission: () => {},
    })
    let started!: () => void, finish!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    const paused = new Promise<void>(resolve => {
      finish = resolve
    })
    const row: OutgoingTopicOperation = {
      version: 1,
      kind: 'post',
      requestBytes: [255],
      leaseIndex: 0,
      senderAddress: original.pool.getRecord(0)!.address,
      rawTx: 'retained',
      txHash: '0x' + 'ab'.repeat(32),
      valueWei: '7',
      direction: 'up',
      payloadHashHex: 'cd'.repeat(32),
    }
    const operation = owner.runOperation(async () => {
      started()
      await paused
      await owner.topicOperationJournal.put(row)
    })
    await entered
    let closed = false
    const ownerClose = owner.close()
    const close = ownerClose.then(() => {
      closed = true
    })
    expect(owner.close()).toBe(ownerClose)
    await expect(owner.runOperation(async () => undefined)).rejects.toThrow(
      'closing or closed',
    )
    expect(closed).toBe(false)
    finish()
    await operation
    await close
    expect(owner.topicOperationJournal.getAll()).toEqual([row])
    await expect(owner.topicOperationJournal.put(row)).rejects.toThrow(
      'journal is closed',
    )
    const next = await openExistingPoolMonadTopicOwner({
      location,
      ...original,
      stampReferencesLeaseIndex: () => false,
      assertEnclosingAdmission: () => {},
    })
    try {
      expect(next.topicOperationJournal.getAll()).toEqual([row])
    } finally {
      await next.close()
      rmSync(location, { recursive: true, force: true })
    }
  })
  it('opens the existing Level namespace without header/root rewrites and preserves topic plus stamp references', async () => {
    const location = mkdtempSync(join(tmpdir(), 'existing-topic-owner-'))
    let owner: MonadWalletPersistenceBundle | undefined
    let store: LevelSubAccountPoolStore | undefined,
      changeStore: LevelChangePoolStore | undefined
    const stamp = new Set([3])
    const readNamespace = async () => {
      const database = level(join(location, 'wallet-manifest'))
      try {
        const entries: Array<[string, string]> = []
        for await (const entry of database.iterator({}) as any)
          entries.push(entry)
        return entries
      } finally {
        await database.close()
      }
    }
    try {
      const old = await openMonadWalletBundle({
        location,
        seed: { mnemonic: TEST_MNEMONIC },
        mode: 'create',
      })
      old.pool.ensureSize(5)
      const rows: OutgoingTopicOperation[] = [
        undefined,
        'protobuf',
        'cbor',
      ].map((format, index) => ({
        version: 1,
        kind: 'post',
        requestBytes: [255, index],
        ...(format ? { writeFormat: format as 'protobuf' | 'cbor' } : {}),
        leaseIndex: index,
        senderAddress: old.pool.getRecord(index)!.address,
        rawTx: 'retained old authority',
        txHash: '0x' + String(index).padStart(64, '0'),
        valueWei: '7',
        direction: 'up',
        payloadHashHex: 'ab'.repeat(32),
      }))
      for (const row of rows) {
        old.pool.setStatus(row.leaseIndex, 'in-use')
        await old.topicOperationJournal.put(row)
      }
      old.pool.setStatus(3, 'in-use')
      await old.pool.flush()
      const records = old.pool.records(),
        highWater = old.pool.nextUnusedIndex()
      await old.close()
      const prior = await readNamespace()
      store = new LevelSubAccountPoolStore(location)
      changeStore = new LevelChangePoolStore(location)
      await store.Open()
      await changeStore.Open()
      const keys = keyrings()
      const pool = new MonadSubAccountPool({ keyring: keys.subKeyring, store })
      const changePool = new MonadChangePool({
        keyring: keys.changeKeyring,
        store: changeStore,
      })
      const leaseManager = new SubAccountLeaseManager(pool)
      const params = {
        location,
        ...keys,
        pool,
        changePool,
        leaseManager,
        stampReferencesLeaseIndex: (index: number) => stamp.has(index),
        assertEnclosingAdmission: () => {},
      }
      owner = await openExistingPoolMonadTopicOwner(params)
      expect(pool.records()).toEqual(records)
      expect(pool.nextUnusedIndex()).toBe(highWater)
      expect(owner.topicOperationJournal.getAll()).toEqual(rows)
      expect(() => owner!.assertNoOrphanedLeases()).not.toThrow()
      await expect(
        openExistingPoolMonadTopicOwner({ ...params, ...existingPools() }),
      ).rejects.toThrow('manifest already has an owner')
      await expect(
        openMonadWalletBundle({ location, seed: { mnemonic: TEST_MNEMONIC } }),
      ).rejects.toThrow('manifest already has an owner')
      owner.assertOpen()
      for (let index = 0; index < 5; index++) {
        const signer = new Wallet(
          keys.subKeyring.deriveSubAccount(index).privateKey,
        )
        const fundingRaw = await signer.signTransaction({
          chainId: 10143n,
          to: signer.address,
          value: 7n,
          nonce: 0,
          gasLimit: 21000n,
          gasPrice: 1n,
        })
        const spendRaw = await signer.signTransaction({
          chainId: 10143n,
          to: '0x000000000000000000000000000000000000dEaD',
          value: 7n,
          nonce: 1,
          gasLimit: 21000n,
          gasPrice: 1n,
        })
        pool.recordFundingTransaction(index, {
          rawTx: fundingRaw,
          txHash: Transaction.from(fundingRaw).hash!,
          valueWei: '7',
        })
        pool.recordSpendTransaction(index, {
          rawTx: spendRaw,
          txHash: Transaction.from(spendRaw).hash!,
          valueWei: '7',
        })
        pool.recordRecoveryDisposition(index, { kind: 'none', valueWei: '0' })
        pool.setStatus(index, 'retired')
      }
      await pool.flush()
      expect(await owner.compactTerminalAccounts(8)).toBe(1)
      expect(pool.getRecord(4)).toBeUndefined()
      expect(pool.nextUnusedIndex()).toBe(highWater)
      expect(owner.topicOperationJournal.getAll()).toEqual(rows)
      await owner.close()
      expect(await readNamespace()).toEqual(prior)
      owner = await openExistingPoolMonadTopicOwner(params)
      expect(owner.topicOperationJournal.getAll()).toEqual(rows)
    } finally {
      await owner?.close()
      await changeStore?.Close()
      await store?.Close()
      rmSync(location, { recursive: true, force: true })
    }
  })
})
