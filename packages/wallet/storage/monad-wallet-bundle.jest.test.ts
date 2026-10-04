import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { Wallet, Transaction } from 'ethers'

import { MonadHdKeyring } from '../monad-hd-keyring'
import { MonadChangeKeyring } from '../monad-change-keyring'
import {
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
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
      bundle = await openMonadWalletBundle({ location, seed: { mnemonic: TEST_MNEMONIC }, mode: 'create' })
      bundle.pool.ensureSize(4)
      const formats = [undefined, 'protobuf', 'cbor'] as const
      const rows = formats.map((writeFormat, index) => ({
        version: 1 as const, kind: 'post' as const, requestBytes: [255, index],
        ...(writeFormat ? { writeFormat } : {}), leaseIndex: index,
        senderAddress: bundle!.pool.getRecord(index)!.address, rawTx: 'old signed authority',
        txHash: '0x' + index.toString(16).padStart(64, '0'), valueWei: '7', direction: 'up' as const,
        payloadHashHex: 'ab'.repeat(32),
      }))
      for (const row of rows) {
        bundle.leaseManager.acquireForIndex(row.leaseIndex)
        await bundle.topicOperationJournal.put(row)
      }
      await bundle.pool.flush()
      const prior = JSON.stringify(bundle.topicOperationJournal.getAll())
      await bundle.close()
      bundle = await openMonadWalletBundle({ location, seed: { mnemonic: TEST_MNEMONIC } })
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(() => bundle!.assertNoOrphanedLeases()).not.toThrow()
      // All three historical formats pin their indices even when already terminal.
      for (let index = 0; index < 4; index++) {
        const key = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC).deriveSubAccount(index)
        const signer = new Wallet(key.privateKey)
        const fields = { chainId: 10143n, value: 7n, nonce: 0, gasLimit: 21000n, gasPrice: 1n }
        const fundingRaw = await signer.signTransaction({ ...fields, to: key.address })
        const spendRaw = await signer.signTransaction({ ...fields, to: '0x000000000000000000000000000000000000dEaD', nonce: 1 })
        bundle.pool.recordFundingTransaction(index, { rawTx: fundingRaw, txHash: Transaction.from(fundingRaw).hash!, valueWei: '7' })
        bundle.pool.recordSpendTransaction(index, { rawTx: spendRaw, txHash: Transaction.from(spendRaw).hash!, valueWei: '7' })
        bundle.pool.recordRecoveryDisposition(index, { kind: 'none', valueWei: '0' })
        bundle.pool.setStatus(index, 'retired')
      }
      await bundle.pool.flush()
      expect(await bundle.compactTerminalAccounts(8)).toBe(1)
      expect(bundle.pool.getRecord(3)).toBeUndefined()
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(bundle.pool.records().map(r => r.status)).toEqual(['retired', 'retired', 'retired'])
      await bundle.close()
      bundle = await openMonadWalletBundle({ location, seed: { mnemonic: TEST_MNEMONIC } })
      expect(JSON.stringify(bundle.topicOperationJournal.getAll())).toBe(prior)
      expect(bundle.pool.records().map(r => r.status)).toEqual(['retired', 'retired', 'retired'])
    } finally { await bundle?.close(); rmSync(location, { recursive: true, force: true }) }
  })
})
