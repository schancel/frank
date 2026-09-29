import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Transaction, Wallet, getBytes, hexlify } from 'ethers'
import level from 'level'

import {
  MonadStampClient,
  buildMonadStampCalldata,
  computeMonadStampCommitment,
  computeMonadStampPaymentCommitment,
  encodeMonadStampedMessage,
} from '../monad-stamp-client'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { createMonadStampWalletHandle } from '../monad-wallet-handle'
import { deriveMonadStampChildPublic } from '../monad-stamp-stealth'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import { LevelStampAttemptJournal } from './stamp-attempt-journal'
import { LevelStampPaymentJournal } from './stamp-payment-journal'
import {
  MonadWalletOrphanedAccountError,
  createInMemoryMonadWalletBundle,
  openMonadWalletBundle,
} from './monad-wallet-bundle'

const FIRST_MNEMONIC =
  'test test test test test test test test test test test junk'
const SECOND_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function createLegacyRoot(
  location: string,
  withRecord = true
): Promise<void> {
  const keyring = MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC)
  const sub = new LevelSubAccountPoolStore(location)
  const change = new LevelChangePoolStore(location)
  const attempts = new LevelStampAttemptJournal(location)
  const payments = new LevelStampPaymentJournal(location)
  await sub.Open()
  if (withRecord) {
    sub.put({
      index: 7,
      address: keyring.deriveSubAccount(7).address,
      status: 'unfunded',
    })
  }
  await sub.Close()
  await change.Open()
  await change.Close()
  await attempts.Open()
  await attempts.Close()
  await payments.Open()
  await payments.Close()
}

describe('Monad wallet persistence bundle', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'monad-wallet-bundle-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates and reopens one complete bound bundle', async () => {
    await createLegacyRoot(root, false)
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    first.pool.ensureUnfundedSize(2)
    await first.pool.flush()
    const bindingId = first.bindingId
    const addresses = first.pool.records().map((record) => record.address)
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.bindingId).toBe(bindingId)
    expect(reopened.pool.records().map((record) => record.address)).toEqual(
      addresses
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

  it('fails an empty supplied-seed restore on relay outage without creating databases', async () => {
    const provider = {
      getTransactionCount: jest.fn(),
      getBalance: jest.fn(),
    }
    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: FIRST_MNEMONIC },
        recovery: {
          provider: provider as never,
          assertRelayAvailable: async () => {
            throw new Error('relay unavailable')
          },
          recoverSenderEvidence: async () => undefined,
        },
      })
    ).rejects.toThrow(/relay unavailable/)
    expect(provider.getTransactionCount).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)
    expect(existsSync(join(root, 'sub-account-pool'))).toBe(false)
  })

  it('restores a used sender as a terminal checkpoint and never initializes index zero', async () => {
    const keyring = MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC)
    const sender = keyring.deriveSubAccount(0)
    const fundingSigner = Wallet.createRandom()
    const fundingRaw = await fundingSigner.signTransaction({
      to: sender.address,
      value: 100n,
      nonce: 0,
      gasLimit: 21_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const spendRaw = await new Wallet(sender.privateKey).signTransaction({
      to: Wallet.createRandom().address,
      value: 60n,
      nonce: 0,
      gasLimit: 21_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const provider = {
      getTransactionCount: jest.fn(async (address: string) =>
        address === sender.address ? 1 : 0
      ),
      getBalance: jest.fn(async () => 0n),
    }
    const restored = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      recovery: {
        provider: provider as never,
        assertRelayAvailable: async () => undefined,
        recoverSenderEvidence: async (index, address) => ({
          index,
          address,
          status: 'spent',
          lifecycle: {
            funding: {
              rawTx: fundingRaw,
              txHash: Transaction.from(fundingRaw).hash as string,
              valueWei: '100',
            },
            spend: {
              rawTx: spendRaw,
              txHash: Transaction.from(spendRaw).hash as string,
              valueWei: '60',
            },
            recovery: { kind: 'dust', valueWei: '1', thresholdWei: '2' },
          },
        }),
      },
    })
    expect(restored.pool.getRecord(0)).toBeUndefined()
    expect(restored.pool.terminalCheckpoints()).toHaveLength(1)
    expect(restored.pool.deriveNextUnfunded().index).toBe(1)
    expect(restored.changePool.nextUnusedIndex()).toBe(1)
    await restored.close()
  })

  it('adopts a complete valid legacy root and persists its inferred high-water mark', async () => {
    await createLegacyRoot(root)

    const migrated = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(migrated.pool.nextUnusedIndex()).toBe(8)
    expect(migrated.pool.deriveNextUnfunded().index).toBe(8)
    await migrated.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(reopened.pool.nextUnusedIndex()).toBe(9)
    await reopened.close()
  })

  it('leaves a legacy root unbound when the supplied seed is wrong', async () => {
    await createLegacyRoot(root)

    await expect(
      openMonadWalletBundle({
        location: root,
        seed: { mnemonic: SECOND_MNEMONIC },
      })
    ).rejects.toThrow(/does not belong to this seed/i)
    expect(existsSync(join(root, 'wallet-manifest'))).toBe(false)

    const legacy = new LevelSubAccountPoolStore(root)
    await legacy.Open()
    expect(legacy.getByIndex(7)?.address).toBe(
      MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(7).address
    )
    await legacy.Close()
  })

  it.each([
    'validated',
    'marker',
    'sub-account-pool',
    'change-pool',
    'outgoing-stamp-attempts',
    'stamp-payment-journal',
    'manifest',
  ] as const)('resumes a migration interrupted after %s', async (phase) => {
    const crashRoot = join(root, phase)
    mkdirSync(crashRoot, { mode: 0o700 })
    await createLegacyRoot(crashRoot)
    await expect(
      openMonadWalletBundle({
        location: crashRoot,
        seed: { mnemonic: FIRST_MNEMONIC },
        onMigrationPhase: (reached) => {
          if (reached === phase) throw new Error(`crash:${phase}`)
        },
      })
    ).rejects.toThrow(`crash:${phase}`)

    const resumed = await openMonadWalletBundle({
      location: crashRoot,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    expect(resumed.pool.nextUnusedIndex()).toBe(8)
    await resumed.close()
  })

  it('keeps exclusive ownership for the lifetime of a Node bundle', async () => {
    const first = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow()
    first.pool.deriveNextUnfunded()
    await first.pool.flush()
    await first.close()

    const successor = await openMonadWalletBundle({
      location: root,
      createSeedIfEmpty: true,
    })
    expect(successor.pool.nextUnusedIndex()).toBe(1)
    await successor.close()
  })

  it('rejects insecure or symlinked roots before touching their targets', async () => {
    chmodSync(root, 0o777)
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/0700/)
    chmodSync(root, 0o700)

    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o700 })
    symlinkSync(target, join(root, 'sub-account-pool'))
    await expect(
      openMonadWalletBundle({ location: root, createSeedIfEmpty: true })
    ).rejects.toThrow(/real directory|unexpected entry/)
    expect(existsSync(join(target, 'CURRENT'))).toBe(false)
  })

  it('rejects a different seed before opening or mutating component stores', async () => {
    await createLegacyRoot(root, false)
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
      })
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
      })
    ).rejects.toThrow(/non-empty untrusted root/i)
  })

  it('rejects a foreign seed-derived row before any network access', async () => {
    await createLegacyRoot(root, false)
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
      })
    ).rejects.toThrow(/does not belong to this seed/i)
  })

  it('rejects unexpected durable record fields before mutation', async () => {
    await createLegacyRoot(root, false)
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
      })
    ).rejects.toThrow(/unexpected field/i)
  })

  it('does not permit a stamp client to graft components across bundles', () => {
    const first = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    const second = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })

    expect(() =>
      MonadStampClient.unsafeCreateForTests({
        pool: first.pool,
        leaseManager: first.leaseManager,
        changePool: second.changePool,
        stampAttemptJournal: first.stampAttemptJournal,
        stampPaymentJournal: first.stampPaymentJournal,
        walletState: first,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/one persistence bundle/i)
  })

  it('rejects loose or ephemeral production stamped-send composition', () => {
    const first = createInMemoryMonadWalletBundle({ mnemonic: FIRST_MNEMONIC })
    const second = createInMemoryMonadWalletBundle({
      mnemonic: SECOND_MNEMONIC,
    })
    expect(
      () =>
        new MonadStampClient({
          pool: first.pool,
          leaseManager: first.leaseManager,
          changePool: second.changePool,
          stampAttemptJournal: second.stampAttemptJournal,
          provider: {} as never,
          httpClient: {} as never,
          relayBaseUrl: 'https://relay.invalid',
        } as never)
    ).toThrow(/factory-produced complete wallet handle/i)
    expect(() =>
      createMonadStampWalletHandle({
        walletState: first,
        provider: {} as never,
        httpClient: {} as never,
        relayBaseUrl: 'https://relay.invalid',
      })
    ).toThrow(/durable complete wallet bundle/i)
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
      bundle.pool.prepareStampInventory(preparation)
    ).rejects.toThrow(/reconciliation is required/i)

    const client = MonadStampClient.unsafeCreateForTests({
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
      })
    ).rejects.toThrow(/stampValueWei must be positive/i)
  })

  it('fails closed on an orphaned lease without retiring the recoverable row', () => {
    const bundle = createInMemoryMonadWalletBundle({
      mnemonic: FIRST_MNEMONIC,
    })
    bundle.pool.ensureSize(1)
    bundle.leaseManager.acquireLease()

    expect(() => bundle.assertNoOrphanedLeases()).toThrow(
      MonadWalletOrphanedAccountError
    )
    expect(bundle.pool.getRecord(0)?.status).toBe('in-use')
  })

  it('leaves a row-without-journal untouched when restore relay evidence is unavailable', async () => {
    await createLegacyRoot(root, false)
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    first.pool.ensureSize(1)
    first.leaseManager.acquireLease()
    await first.pool.flush()
    await first.close()

    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      recovery: {
        provider: {} as never,
        assertRelayAvailable: async () => {
          throw new Error('relay unavailable')
        },
        recoverSenderEvidence: async () => undefined,
      },
    })
    await expect(reopened.reconcileRestoreState()).rejects.toThrow(
      /relay unavailable/
    )
    expect(reopened.pool.getRecord(0)?.status).toBe('in-use')
    expect(reopened.stampAttemptJournal.getAll()).toEqual([])
    await reopened.close()
  })

  it('reconstructs a journal-without-row from its validated exact signed bytes', async () => {
    await createLegacyRoot(root, false)
    const first = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
    })
    first.pool.ensureSize(1)
    first.leaseManager.acquireLease()
    const payload = new TextEncoder().encode('recover exact attempt')
    const payloadHash = computeMonadStampCommitment(payload)
    const recipient = Wallet.createRandom().signingKey.compressedPublicKey
    const destination = deriveMonadStampChildPublic({
      payloadHash,
      recipientPublicKey: getBytes(recipient),
      paymentIndex: 0,
    }).address
    const sender =
      MonadHdKeyring.fromMnemonic(FIRST_MNEMONIC).deriveSubAccount(0)
    const rawTx = await new Wallet(sender.privateKey).signTransaction({
      to: destination,
      value: 5n,
      data: buildMonadStampCalldata(
        computeMonadStampPaymentCommitment(payloadHash, 0)
      ),
      nonce: 0,
      gasLimit: 50_000n,
      gasPrice: 1n,
      chainId: 1,
    })
    const payloadHashHex = hexlify(payloadHash).slice(2)
    await first.stampAttemptJournal.put({
      payloadHashHex,
      messageBytes: Array.from(
        encodeMonadStampedMessage({
          stampPayments: [{ childIndex: 0, rawTx: getBytes(rawTx) }],
          encryptedPayload: payload,
          payloadHash,
        })
      ),
      leaseIndices: [0],
      recipientPublicKeyHex: recipient,
    })
    first.pool.recordSpendTransaction(0, {
      rawTx,
      txHash: Transaction.from(rawTx).hash as string,
      valueWei: '5',
    })
    await first.pool.flush()
    await first.close()

    const rawPool = level(join(root, 'sub-account-pool'))
    await rawPool.del('0')
    await rawPool.close()
    const reopened = await openMonadWalletBundle({
      location: root,
      seed: { mnemonic: FIRST_MNEMONIC },
      recovery: {
        provider: {} as never,
        assertRelayAvailable: async () => undefined,
        recoverSenderEvidence: async () => undefined,
      },
    })
    await reopened.repairAttemptSpendLifecycles()
    expect(reopened.pool.getRecord(0)).toMatchObject({
      status: 'in-use',
      lifecycle: {
        spend: {
          rawTx,
          txHash: Transaction.from(rawTx).hash,
          valueWei: '5',
        },
      },
    })
    await reopened.close()
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
      recipientPublicKeyHex: `02${'11'.repeat(32)}`,
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
