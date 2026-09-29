import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { MonadStampClient } from '../monad-stamp-client'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import {
  MonadWalletOrphanedAccountError,
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
} from './monad-wallet-bundle'

const FIRST_MNEMONIC =
  'test test test test test test test test test test test junk'
const SECOND_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('Monad wallet persistence bundle', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'monad-wallet-bundle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates and reopens one complete bound bundle', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    const bindingId = first.bindingId
    const addresses = first.pool.records().map(record => record.address)
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.bindingId).toBe(bindingId)
    expect(reopened.pool.records().map(record => record.address)).toEqual(
      addresses,
    )
    await reopened.close()
  })

  it('atomically creates a seed only for an empty root and reopens it', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    const firstAddress = first.pool.deriveNextUnfunded().address
    await first.pool.flush()
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    expect(reopened.pool.getRecord(0)?.address).toBe(firstAddress)
    await reopened.close()
  })

  it('rejects a different seed before opening or mutating component stores', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    first.pool.ensureUnfundedSize(1)
    await first.pool.flush()
    await first.close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
      }),
    ).rejects.toThrow(/seed does not match/i)
  })

  it('refuses to place a manifest over an unbound non-empty root', async () => {
    const foreign = new LevelSubAccountPoolStore(root)
    await foreign.Open()
    foreign.put({
      index: 0,
      address: '0x0000000000000000000000000000000000000001',
      status: 'unfunded',
    })
    await foreign.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      }),
    ).rejects.toThrow(/non-empty untrusted root/i)
  })

  it('rejects a foreign seed-derived row before any network access', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    const bindingId = first.bindingId
    await first.close()

    const store = new LevelSubAccountPoolStore(root, bindingId)
    await store.Open()
    await store.Bind()
    store.put({
      index: 7,
      address: '0x0000000000000000000000000000000000000001',
      status: 'unfunded',
    })
    await store.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      }),
    ).rejects.toThrow(/does not belong to this seed/i)
  })

  it('rejects unexpected durable record fields before mutation', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    const bindingId = first.bindingId
    const record = first.pool.deriveNextUnfunded()
    await first.pool.flush()
    await first.close()

    const store = new LevelSubAccountPoolStore(root, bindingId)
    await store.Open()
    store.put({ ...record, unexpected: 'field' } as never)
    await store.Close()

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
      }),
    ).rejects.toThrow(/unexpected field/i)
  })

  it('does not permit a stamp client to graft components across bundles', () => {
    const first = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    const second = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })

    expect(
      () =>
        new MonadStampClient({
          pool: first.pool,
          leaseManager: first.leaseManager,
          changePool: second.changePool,
          stampAttemptJournal: first.stampAttemptJournal,
          stampPaymentJournal: first.stampPaymentJournal,
          walletState: first,
          provider: {} as never,
          httpClient: {} as never,
          relayBaseUrl: 'https://relay.invalid',
        }),
    ).toThrow(/one persistence bundle/i)
  })

  it('requires the client-owned reconciliation permit before inventory preparation', async () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    const preparation = {
      mainAccountSigner: {} as never,
      provider: {} as never,
      stampValueWei: 1n,
      gasReserveWei: 0n,
    }

    await expect(
      bundle.pool.prepareStampInventory(preparation),
    ).rejects.toThrow(/reconciliation is required/i)

    const client = new MonadStampClient({
      pool: bundle.pool,
      leaseManager: bundle.leaseManager,
      changePool: bundle.changePool,
      stampAttemptJournal: bundle.stampAttemptJournal,
      stampPaymentJournal: bundle.stampPaymentJournal,
      walletState: bundle,
      provider: {} as never,
      httpClient: {} as never,
      relayBaseUrl: 'https://relay.invalid',
    })
    await client.reconcileOrThrow()
    await expect(
      bundle.pool.prepareStampInventory({
        ...preparation,
        stampValueWei: 0n,
      }),
    ).rejects.toThrow(/stampValueWei must be positive/i)
  })

  it('fails closed on an orphaned lease without retiring the recoverable row', () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    bundle.leaseManager.acquireLease()

    expect(() => bundle.assertNoOrphanedLeases()).toThrow(
      MonadWalletOrphanedAccountError,
    )
    expect(bundle.pool.getRecord(0)?.status).toBe('in-use')
  })

  it('does not compact a terminal row while an attempt journal still references it', async () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    bundle.pool.recordFundingTransaction(0, {
      rawTx: '0xfund',
      txHash: '0xfundhash',
      valueWei: '100',
    })
    bundle.pool.recordSpendTransaction(0, {
      rawTx: '0xspend',
      txHash: '0xspendhash',
      valueWei: '60',
    })
    bundle.pool.recordRecoveryDisposition(0, {
      kind: 'dust',
      valueWei: '1',
      thresholdWei: '2',
    })
    bundle.pool.setStatus(0, 'spent')
    await bundle.stampAttemptJournal.put({
      payloadHashHex: 'ab'.repeat(32),
      messageBytes: [1],
      leaseIndices: [0],
    })

    await expect(bundle.compactTerminalAccounts(1)).resolves.toBe(0)
    expect(bundle.pool.getRecord(0)).toBeDefined()

    await bundle.stampAttemptJournal.delete('ab'.repeat(32))
    await expect(bundle.compactTerminalAccounts(1)).resolves.toBe(1)
    expect(bundle.pool.getRecord(0)).toBeUndefined()
    expect(bundle.pool.terminalCheckpoints()[0]).toMatchObject({
      version: 1,
      denominationWei: '60',
    })
  })
})
