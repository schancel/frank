/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import {
  Transaction,
  type Provider,
  getAddress,
  hexlify,
  keccak256,
  randomBytes,
  toUtf8Bytes,
} from 'ethers'

import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadChangePool } from '../monad-change-pool'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadHdKeyring } from '../monad-hd-keyring'
import { decodeMonadStampedMessage } from '../monad-stamp-client'
import { recoverNextChangeIndex } from '../monad-change-recovery'
import { recoverNextSubAccountIndex } from '../monad-sub-account-recovery'
import { InMemoryChangePoolStore } from './change-pool-storage'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import {
  InMemoryStampAttemptJournal,
  LevelStampAttemptJournal,
  type StampAttemptJournal,
} from './stamp-attempt-journal'
import {
  InMemoryStampPaymentJournal,
  LevelStampPaymentJournal,
  type StampPaymentJournal,
} from './stamp-payment-journal'
import {
  InMemorySubAccountPoolStore,
  type SubAccountRecord,
} from './sub-account-pool-storage'
import { validateMonadWalletState } from './monad-wallet-state-validator'
import {
  acquireBrowserWalletRootLease,
  acquireNodeWalletRootLease,
  existingWalletComponents,
  prepareSecureWalletRoot,
} from './wallet-root-guard'

const MANIFEST_KEY = 'manifest'
const SEED_KEY = 'seed'
const MIGRATION_KEY = 'migration'
const MANIFEST_SCHEMA = 'frank-monad-wallet-state'
const MANIFEST_VERSION = 1

interface MonadWalletManifest {
  schema: typeof MANIFEST_SCHEMA
  version: typeof MANIFEST_VERSION
  bindingId: string
  seedFingerprint: string
  intents: readonly [
    'sub-account-pool-v2',
    'change-pool-v2',
    'stamp-attempt-journal-v1',
    'stamp-payment-journal-v1'
  ]
}

interface PersistedSeed {
  version: 1
  mnemonic: string
  passphrase: string
}

interface WalletMigrationMarker {
  version: 1
  bindingId: string
  seedFingerprint: string
  completedComponents: number
  persistedSeed?: PersistedSeed
  restoreMode?: true
}

export class MonadWalletOrphanedAccountError extends Error {
  readonly indices: number[]

  constructor(indices: number[]) {
    super(
      `Wallet has ${
        indices.length
      } in-use funding account(s) without a local exact-set attempt: ${indices.join(
        ', '
      )}`
    )
    this.indices = indices
  }
}

export interface MonadWalletPersistenceBundle {
  readonly durability: 'persistent' | 'test-only-ephemeral'
  readonly bindingId: string
  readonly pool: MonadSubAccountPool
  readonly leaseManager: SubAccountLeaseManager
  readonly changePool: MonadChangePool
  readonly stampAttemptJournal: StampAttemptJournal
  readonly stampPaymentJournal: StampPaymentJournal
  assertSemanticallyValid(): void
  repairAttemptSpendLifecycles(): Promise<void>
  reconcileRestoreState(): Promise<void>
  assertNoOrphanedLeases(): void
  compactTerminalAccounts(limit: number): Promise<number>
  close(): Promise<void>
}

type MigrationPhase =
  | 'validated'
  | 'marker'
  | 'sub-account-pool'
  | 'change-pool'
  | 'outgoing-stamp-attempts'
  | 'stamp-payment-journal'
  | 'manifest'

type OpenMonadWalletBundleTestHooks = {
  /** Deterministic crash-injection seam. Production callers must not supply it. */
  onMigrationPhase?: (phase: MigrationPhase) => void | Promise<void>
}

export interface MonadSeedRestoreSource {
  provider: Provider
  /** Must prove the configured relay is reachable. A rejection aborts before durable writes. */
  assertRelayAvailable(): Promise<void>
  /** Returns complete terminal evidence for a used sender index. Missing evidence is ambiguous and
   * therefore aborts the restore without initializing the root. */
  recoverSenderEvidence(
    index: number,
    address: string
  ): Promise<SubAccountRecord | undefined>
  maxIndex?: number
}

export type OpenMonadWalletBundleParams = (
  | {
      location: string
      seed: { mnemonic: string; passphrase?: string }
      createSeedIfEmpty?: false
      mode?: 'restore'
      recovery?: MonadSeedRestoreSource
    }
  | {
      location: string
      seed?: undefined
      createSeedIfEmpty: true
      mode?: 'create'
      recovery?: undefined
    }
) &
  OpenMonadWalletBundleTestHooks

function seedFingerprint(
  subKeyring: MonadHdKeyring,
  changeKeyring: MonadChangeKeyring
): string {
  const intent = JSON.stringify({
    schema: MANIFEST_SCHEMA,
    subAccountZero: subKeyring.deriveSubAccount(0).address.toLowerCase(),
    changeAccountZero: changeKeyring
      .deriveChangeAccount(0)
      .address.toLowerCase(),
  })
  return keccak256(toUtf8Bytes(intent))
}

function newBindingId(): string {
  return hexlify(randomBytes(32)).slice(2)
}

function parseManifest(value: string): MonadWalletManifest {
  const parsed = JSON.parse(value) as Partial<MonadWalletManifest>
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'schema',
          'version',
          'bindingId',
          'seedFingerprint',
          'intents',
        ].includes(key)
    ) ||
    parsed.schema !== MANIFEST_SCHEMA ||
    parsed.version !== MANIFEST_VERSION ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(parsed.seedFingerprint) ||
    !Array.isArray(parsed.intents) ||
    parsed.intents.join('|') !==
      'sub-account-pool-v2|change-pool-v2|stamp-attempt-journal-v1|stamp-payment-journal-v1'
  ) {
    throw new Error('Unsupported or corrupt Monad wallet manifest')
  }
  return parsed as MonadWalletManifest
}

function parseSeed(value: string): PersistedSeed {
  const parsed = JSON.parse(value) as Partial<PersistedSeed>
  if (
    Object.keys(parsed).some(
      (key) => !['version', 'mnemonic', 'passphrase'].includes(key)
    ) ||
    parsed.version !== 1 ||
    typeof parsed.mnemonic !== 'string' ||
    typeof parsed.passphrase !== 'string'
  ) {
    throw new Error('Invalid persisted Monad wallet seed record')
  }
  // Parsing is the validation boundary; the phrase itself is never included in an error.
  MonadHdKeyring.fromMnemonic(parsed.mnemonic, parsed.passphrase)
  return parsed as PersistedSeed
}

function parseMigration(value: string): WalletMigrationMarker {
  const parsed = JSON.parse(value) as Partial<WalletMigrationMarker>
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'version',
          'bindingId',
          'seedFingerprint',
          'completedComponents',
          'persistedSeed',
          'restoreMode',
        ].includes(key)
    ) ||
    parsed.version !== 1 ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(parsed.seedFingerprint) ||
    !Number.isSafeInteger(parsed.completedComponents) ||
    (parsed.completedComponents as number) < 0 ||
    (parsed.completedComponents as number) > 4 ||
    (parsed.restoreMode !== undefined && parsed.restoreMode !== true)
  ) {
    throw new Error('Invalid wallet migration marker')
  }
  if (parsed.persistedSeed !== undefined) {
    parseSeed(JSON.stringify(parsed.persistedSeed))
  }
  return parsed as WalletMigrationMarker
}

function assertHex(value: unknown, bytes: number, label: string): void {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(value)
  ) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertOnlyKeys(
  value: object,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`Invalid ${label}: unexpected field ${unexpected[0]}`)
  }
}

function validateLifecycle(value: unknown, label: string): void {
  if (value === undefined) return
  if (value === null || typeof value !== 'object') {
    throw new Error(`Invalid ${label} lifecycle`)
  }
  assertOnlyKeys(value, ['funding', 'spend', 'recovery'], `${label} lifecycle`)
  const lifecycle = value as Record<string, unknown>
  for (const transactionName of ['funding', 'spend']) {
    const transaction = lifecycle[transactionName]
    if (transaction === undefined) continue
    if (transaction === null || typeof transaction !== 'object') {
      throw new Error(`Invalid ${label} ${transactionName} transaction`)
    }
    assertOnlyKeys(
      transaction,
      ['rawTx', 'txHash', 'valueWei'],
      `${label} ${transactionName} transaction`
    )
    const fields = transaction as Record<string, unknown>
    if (
      typeof fields.rawTx !== 'string' ||
      typeof fields.txHash !== 'string' ||
      typeof fields.valueWei !== 'string' ||
      !/^\d+$/.test(fields.valueWei)
    ) {
      throw new Error(`Invalid ${label} ${transactionName} transaction`)
    }
  }
  const recovery = lifecycle.recovery
  if (recovery !== undefined) {
    if (recovery === null || typeof recovery !== 'object') {
      throw new Error(`Invalid ${label} recovery disposition`)
    }
    const disposition = recovery as Record<string, unknown>
    const allowed =
      disposition.kind === 'change'
        ? ['kind', 'changeIndex', 'address', 'txHash', 'valueWei']
        : disposition.kind === 'dust'
        ? ['kind', 'valueWei', 'thresholdWei']
        : ['kind', 'valueWei']
    assertOnlyKeys(recovery, allowed, `${label} recovery disposition`)
    if (!['change', 'dust', 'none'].includes(String(disposition.kind))) {
      throw new Error(`Invalid ${label} recovery disposition`)
    }
    if (disposition.kind === 'change') {
      if (
        typeof disposition.changeIndex !== 'number' ||
        !Number.isSafeInteger(disposition.changeIndex) ||
        disposition.changeIndex < 0 ||
        typeof disposition.address !== 'string' ||
        typeof disposition.txHash !== 'string' ||
        typeof disposition.valueWei !== 'string' ||
        !/^\d+$/.test(disposition.valueWei)
      ) {
        throw new Error(`Invalid ${label} recovery disposition`)
      }
      getAddress(disposition.address)
    } else if (disposition.kind === 'dust') {
      if (
        typeof disposition.valueWei !== 'string' ||
        !/^\d+$/.test(disposition.valueWei) ||
        typeof disposition.thresholdWei !== 'string' ||
        !/^\d+$/.test(disposition.thresholdWei)
      ) {
        throw new Error(`Invalid ${label} recovery disposition`)
      }
    } else if (disposition.valueWei !== '0') {
      throw new Error(`Invalid ${label} recovery disposition`)
    }
  }
}

function validateLoadedState(params: {
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  attemptJournal: StampAttemptJournal
  paymentJournal: StampPaymentJournal
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  allowMissingAttemptRows?: boolean
}): void {
  let highestSubAccountIndex = -1
  for (const record of params.pool.records()) {
    assertOnlyKeys(
      record,
      ['index', 'address', 'status', 'fundingAttempt', 'lifecycle'],
      'stored sub-account record'
    )
    validateLifecycle(record.lifecycle, `sub-account ${record.index}`)
    highestSubAccountIndex = Math.max(highestSubAccountIndex, record.index)
    if (!Number.isSafeInteger(record.index) || record.index < 0) {
      throw new Error('Invalid stored sub-account index')
    }
    if (
      getAddress(record.address) !==
      params.subKeyring.deriveSubAccount(record.index).address
    ) {
      throw new Error(
        `Stored sub-account ${record.index} does not belong to this seed`
      )
    }
    if (
      ![
        'unfunded',
        'funding',
        'available',
        'in-use',
        'spent',
        'retired',
      ].includes(record.status) ||
      (record.status === 'funding' && record.fundingAttempt === undefined) ||
      (record.status !== 'funding' && record.fundingAttempt !== undefined)
    ) {
      throw new Error(`Invalid stored sub-account ${record.index} schema`)
    }
    if (record.fundingAttempt !== undefined) {
      assertOnlyKeys(
        record.fundingAttempt,
        ['rawTx', 'txHash'],
        `sub-account ${record.index} funding attempt`
      )
      if (
        typeof record.fundingAttempt.rawTx !== 'string' ||
        typeof record.fundingAttempt.txHash !== 'string'
      ) {
        throw new Error(`Invalid stored sub-account ${record.index} schema`)
      }
    }
  }
  for (const checkpoint of params.pool.terminalCheckpoints()) {
    assertOnlyKeys(
      checkpoint,
      [
        'version',
        'index',
        'address',
        'status',
        'denominationWei',
        'lifecycle',
        'compactedAt',
      ],
      'terminal sub-account checkpoint'
    )
    validateLifecycle(checkpoint.lifecycle, `checkpoint ${checkpoint.index}`)
    highestSubAccountIndex = Math.max(highestSubAccountIndex, checkpoint.index)
    if (
      checkpoint.version !== 1 ||
      !/^\d+$/.test(checkpoint.denominationWei) ||
      getAddress(checkpoint.address) !==
        params.subKeyring.deriveSubAccount(checkpoint.index).address
    ) {
      throw new Error(
        `Invalid terminal checkpoint for sub-account ${checkpoint.index}`
      )
    }
  }
  if (params.pool.nextUnusedIndex() <= highestSubAccountIndex) {
    throw new Error('Stored sub-account high-water mark would reuse an index')
  }
  let highestChangeIndex = -1
  for (const record of params.changePool.records()) {
    assertOnlyKeys(
      record,
      [
        'index',
        'address',
        'sourceBurnIndex',
        'sourceBurnAddress',
        'sweptValueWei',
        'txHash',
        'createdAt',
      ],
      'stored change record'
    )
    highestChangeIndex = Math.max(highestChangeIndex, record.index)
    if (
      !Number.isSafeInteger(record.index) ||
      record.index < 0 ||
      getAddress(record.address) !==
        params.changeKeyring.deriveChangeAccount(record.index).address ||
      getAddress(record.sourceBurnAddress) !==
        params.subKeyring.deriveSubAccount(record.sourceBurnIndex).address ||
      !/^\d+$/.test(record.sweptValueWei)
    ) {
      throw new Error(`Invalid stored change record ${record.index}`)
    }
    assertHex(record.txHash, 32, 'stored change transaction hash')
  }
  if (params.changePool.nextUnusedIndex() <= highestChangeIndex) {
    throw new Error('Stored change high-water mark would reuse an index')
  }
  for (const attempt of params.attemptJournal.getAll()) {
    assertOnlyKeys(
      attempt,
      [
        'payloadHashHex',
        'messageBytes',
        'leaseIndices',
        'recipientPublicKeyHex',
      ],
      'stamp-attempt journal record'
    )
    assertHex(attempt.payloadHashHex, 32, 'stamp-attempt payload hash')
    if (
      !Array.isArray(attempt.messageBytes) ||
      attempt.messageBytes.some(
        (value) => !Number.isInteger(value) || value < 0 || value > 255
      ) ||
      !Array.isArray(attempt.leaseIndices) ||
      typeof attempt.recipientPublicKeyHex !== 'string' ||
      new Set(attempt.leaseIndices).size !== attempt.leaseIndices.length ||
      attempt.leaseIndices.some(
        (index) => !Number.isSafeInteger(index) || index < 0
      )
    ) {
      throw new Error('Invalid stamp-attempt journal record')
    }
    assertHex(
      attempt.recipientPublicKeyHex,
      33,
      'stamp-attempt recipient public key'
    )
    for (const index of attempt.leaseIndices) {
      if (
        params.pool.getRecord(index) === undefined &&
        !params.allowMissingAttemptRows
      ) {
        throw new Error(`Stamp attempt references missing sub-account ${index}`)
      }
    }
  }
  for (const payment of params.paymentJournal.getAll()) {
    assertOnlyKeys(
      payment,
      [
        'payloadHashHex',
        'childIndex',
        'txHash',
        'address',
        'valueWei',
        'status',
        'sweepTxHash',
        'sweepRawTx',
        'sweepValueWei',
        'sweepDestinationAddress',
      ],
      'stamp-payment recovery record'
    )
    assertHex(payment.payloadHashHex, 32, 'stamp-payment payload hash')
    assertHex(payment.txHash, 32, 'stamp-payment transaction hash')
    if (
      !Number.isSafeInteger(payment.childIndex) ||
      payment.childIndex < 0 ||
      !/^\d+$/.test(payment.valueWei) ||
      !['discovered', 'sweep-pending', 'swept'].includes(payment.status)
    ) {
      throw new Error('Invalid stamp-payment recovery record')
    }
    getAddress(payment.address)
    if (
      payment.status === 'sweep-pending' &&
      (payment.sweepTxHash === undefined ||
        payment.sweepRawTx === undefined ||
        payment.sweepValueWei === undefined ||
        payment.sweepDestinationAddress === undefined)
    ) {
      throw new Error('Invalid pending stamp-payment recovery record')
    }
  }
}

function makeBundle(params: {
  durability: MonadWalletPersistenceBundle['durability']
  bindingId: string
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  attemptJournal: StampAttemptJournal
  paymentJournal: StampPaymentJournal
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  recoverySource?: MonadSeedRestoreSource
  close: () => Promise<void>
}): MonadWalletPersistenceBundle {
  const leaseManager = new SubAccountLeaseManager(params.pool)
  const assertNoOrphanedLeases = (): void => {
    const referenced = new Set(
      params.attemptJournal.getAll().flatMap((attempt) => attempt.leaseIndices)
    )
    const orphaned = params.pool
      .records()
      .filter(
        (record) => record.status === 'in-use' && !referenced.has(record.index)
      )
      .map((record) => record.index)
    if (orphaned.length > 0) throw new MonadWalletOrphanedAccountError(orphaned)
  }
  return {
    durability: params.durability,
    bindingId: params.bindingId,
    pool: params.pool,
    leaseManager,
    changePool: params.changePool,
    stampAttemptJournal: params.attemptJournal,
    stampPaymentJournal: params.paymentJournal,
    assertSemanticallyValid: () =>
      validateMonadWalletState({
        pool: params.pool,
        changePool: params.changePool,
        attemptJournal: params.attemptJournal,
        paymentJournal: params.paymentJournal,
        subKeyring: params.subKeyring,
        changeKeyring: params.changeKeyring,
      }),
    async repairAttemptSpendLifecycles(): Promise<void> {
      validateMonadWalletState({
        pool: params.pool,
        changePool: params.changePool,
        attemptJournal: params.attemptJournal,
        paymentJournal: params.paymentJournal,
        subKeyring: params.subKeyring,
        changeKeyring: params.changeKeyring,
        allowMissingAttemptSpend: true,
        allowMissingAttemptRows: true,
      })
      for (const attempt of params.attemptJournal.getAll()) {
        const message = decodeMonadStampedMessage(
          Uint8Array.from(attempt.messageBytes)
        )
        for (const [offset, index] of attempt.leaseIndices.entries()) {
          const record =
            params.pool.getRecord(index) ??
            params.pool.restoreJournaledInUse(index)
          const payment = message.stampPayments[offset]
          if (record?.lifecycle?.spend !== undefined || payment === undefined) {
            continue
          }
          const transaction = Transaction.from(hexlify(payment.rawTx))
          params.pool.recordSpendTransaction(index, {
            rawTx: hexlify(payment.rawTx),
            txHash: transaction.hash as string,
            valueWei: transaction.value.toString(),
          })
        }
      }
      await params.pool.flush()
      this.assertSemanticallyValid()
    },
    async reconcileRestoreState(): Promise<void> {
      await this.repairAttemptSpendLifecycles()
      const referenced = new Set(
        params.attemptJournal
          .getAll()
          .flatMap((attempt) => attempt.leaseIndices)
      )
      const orphans = params.pool
        .records()
        .filter(
          (record) =>
            record.status === 'in-use' && !referenced.has(record.index)
        )
      if (orphans.length === 0) return
      if (params.recoverySource === undefined) {
        throw new MonadWalletOrphanedAccountError(
          orphans.map((record) => record.index)
        )
      }
      await params.recoverySource.assertRelayAvailable()
      const recovered: SubAccountRecord[] = []
      for (const orphan of orphans) {
        const evidence = await params.recoverySource.recoverSenderEvidence(
          orphan.index,
          orphan.address
        )
        if (
          evidence === undefined ||
          evidence.index !== orphan.index ||
          getAddress(evidence.address) !== getAddress(orphan.address) ||
          (evidence.status !== 'spent' && evidence.status !== 'retired') ||
          evidence.lifecycle?.funding === undefined ||
          evidence.lifecycle.spend === undefined ||
          evidence.lifecycle.recovery === undefined
        ) {
          throw new MonadWalletOrphanedAccountError(
            orphans.map((record) => record.index)
          )
        }
        for (const [kind, checkpoint] of [
          ['funding', evidence.lifecycle.funding],
          ['spend', evidence.lifecycle.spend],
        ] as const) {
          const transaction = Transaction.from(checkpoint.rawTx)
          if (
            transaction.hash === null ||
            transaction.hash.toLowerCase() !==
              checkpoint.txHash.toLowerCase() ||
            transaction.value.toString() !== checkpoint.valueWei ||
            (kind === 'funding' &&
              (transaction.to === null ||
                getAddress(transaction.to) !== getAddress(orphan.address))) ||
            (kind === 'spend' &&
              (transaction.from === null ||
                getAddress(transaction.from) !== getAddress(orphan.address)))
          ) {
            throw new Error(`Invalid recovered ${kind} transaction evidence`)
          }
        }
        recovered.push(evidence)
      }
      for (const evidence of recovered) {
        params.pool.restoreTerminalEvidence(evidence)
      }
      await params.pool.flush()
      await params.pool.compactTerminalAccounts({ limit: recovered.length })
      this.assertSemanticallyValid()
    },
    assertNoOrphanedLeases,
    async compactTerminalAccounts(limit: number): Promise<number> {
      const references = new Set(
        params.attemptJournal
          .getAll()
          .flatMap((attempt) => attempt.leaseIndices)
      )
      const pendingChange = params.changePool.pendingSourceBurnIndex()
      if (pendingChange !== undefined) references.add(pendingChange)
      return params.pool.compactTerminalAccounts({
        limit,
        referencedIndices: references,
      })
    },
    close: params.close,
  }
}

export function createInMemoryMonadWalletBundle(params: {
  mnemonic: string
  passphrase?: string
}): MonadWalletPersistenceBundle {
  const subKeyring = MonadHdKeyring.fromMnemonic(
    params.mnemonic,
    params.passphrase
  )
  const changeKeyring = MonadChangeKeyring.fromMnemonic(
    params.mnemonic,
    params.passphrase
  )
  const pool = new MonadSubAccountPool({
    keyring: subKeyring,
    store: new InMemorySubAccountPoolStore(),
    requireStampReconciliationPreflight: true,
  })
  return makeBundle({
    durability: 'test-only-ephemeral',
    bindingId: newBindingId(),
    pool,
    changePool: new MonadChangePool({
      keyring: changeKeyring,
      store: new InMemoryChangePoolStore(),
    }),
    attemptJournal: new InMemoryStampAttemptJournal(),
    paymentJournal: new InMemoryStampPaymentJournal(),
    subKeyring,
    changeKeyring,
    close: async () => undefined,
  })
}

export async function openMonadWalletBundle(
  params: OpenMonadWalletBundleParams
): Promise<MonadWalletPersistenceBundle> {
  prepareSecureWalletRoot(params.location)
  const nodeLease = acquireNodeWalletRootLease(params.location)
  const browserLease = await acquireBrowserWalletRootLease(params.location)
  let manifestDb: LevelDB | undefined
  const openedStores: Array<{ Close(): Promise<void> }> = []
  try {
    browserLease?.assertHeld()
    nodeLease?.assertHeld()
    const existing = await existingWalletComponents(params.location)
    const componentNames = [
      'sub-account-pool',
      'change-pool',
      'outgoing-stamp-attempts',
      'stamp-payment-journal',
    ] as const
    const hasManifestDatabase = existing.has('wallet-manifest')
    const hasLegacyComponents = componentNames.some((name) =>
      existing.has(name)
    )
    if (
      !hasManifestDatabase &&
      hasLegacyComponents &&
      componentNames.some((name) => !existing.has(name))
    ) {
      throw new Error(
        'Refusing to adopt a non-empty untrusted root with incomplete legacy components'
      )
    }

    let manifestValue: string | undefined
    let migrationValue: string | undefined
    let storedSeedValue: string | undefined
    if (hasManifestDatabase) {
      manifestDb = (level as any)(join(params.location, 'wallet-manifest'), {
        createIfMissing: false,
      }) as LevelDB
      await (manifestDb as any).open()
      const entries = new Map<string, string>()
      for await (const [key, value] of manifestDb.iterator({}) as any) {
        if (![MANIFEST_KEY, MIGRATION_KEY, SEED_KEY].includes(key)) {
          throw new Error(`Invalid wallet manifest key ${key}`)
        }
        entries.set(key, value)
      }
      manifestValue = entries.get(MANIFEST_KEY)
      migrationValue = entries.get(MIGRATION_KEY)
      storedSeedValue = entries.get(SEED_KEY)
      if (manifestValue !== undefined && migrationValue !== undefined) {
        throw new Error('Refusing to replace an invalid wallet manifest')
      }
    }

    const finalized =
      manifestValue === undefined ? undefined : parseManifest(manifestValue)
    const migration =
      migrationValue === undefined ? undefined : parseMigration(migrationValue)
    if (
      finalized === undefined &&
      migration === undefined &&
      hasManifestDatabase
    ) {
      throw new Error('Refusing to replace an invalid wallet manifest')
    }

    let seed: PersistedSeed
    if (params.seed !== undefined) {
      seed = {
        version: 1,
        mnemonic: params.seed.mnemonic,
        passphrase: params.seed.passphrase ?? '',
      }
    } else if (migration?.persistedSeed !== undefined) {
      seed = parseSeed(JSON.stringify(migration.persistedSeed))
    } else if (storedSeedValue !== undefined) {
      seed = parseSeed(storedSeedValue)
    } else if (!hasManifestDatabase && params.createSeedIfEmpty) {
      seed = {
        version: 1,
        mnemonic: MonadHdKeyring.generate().mnemonic,
        passphrase: '',
      }
    } else {
      throw new Error('Wallet root has no persisted seed')
    }

    const subKeyring = MonadHdKeyring.fromMnemonic(
      seed.mnemonic,
      seed.passphrase
    )
    const changeKeyring = MonadChangeKeyring.fromMnemonic(
      seed.mnemonic,
      seed.passphrase
    )
    const fingerprint = seedFingerprint(subKeyring, changeKeyring)
    const expectedFingerprint =
      finalized?.seedFingerprint ?? migration?.seedFingerprint
    if (
      expectedFingerprint !== undefined &&
      fingerprint !== expectedFingerprint
    ) {
      throw new Error('Wallet seed does not match the durable wallet manifest')
    }

    const bindingId =
      finalized?.bindingId ?? migration?.bindingId ?? newBindingId()
    const isMigration = finalized === undefined
    const isEmptySuppliedSeedRestore =
      migration?.restoreMode === true ||
      (finalized === undefined &&
        migration === undefined &&
        !hasLegacyComponents &&
        params.seed !== undefined)
    let restoredSenderRecords: SubAccountRecord[] = []
    let restoredSenderNextIndex: number | undefined
    let restoredChangeNextIndex: number | undefined
    if (isEmptySuppliedSeedRestore) {
      if (params.recovery === undefined) {
        throw new Error(
          'Supplied seed with an empty root requires explicit seed-restore evidence'
        )
      }
      await params.recovery.assertRelayAvailable()
      const maxIndex = params.recovery.maxIndex
      restoredSenderNextIndex = await recoverNextSubAccountIndex({
        keyring: subKeyring,
        provider: params.recovery.provider,
        maxIndex,
      })
      restoredChangeNextIndex = await recoverNextChangeIndex({
        keyring: changeKeyring,
        provider: params.recovery.provider,
        maxIndex,
      })
      for (let index = 0; index < restoredSenderNextIndex; index++) {
        const address = subKeyring.deriveSubAccount(index).address
        const evidence = await params.recovery.recoverSenderEvidence(
          index,
          address
        )
        if (
          evidence === undefined ||
          evidence.index !== index ||
          getAddress(evidence.address) !== address ||
          (evidence.status !== 'spent' && evidence.status !== 'retired') ||
          evidence.lifecycle?.funding === undefined ||
          evidence.lifecycle.spend === undefined ||
          evidence.lifecycle.recovery === undefined
        ) {
          throw new Error(
            `Ambiguous seed restore evidence for used sender index ${index}`
          )
        }
        restoredSenderRecords.push(evidence)
      }
    }
    if (
      finalized !== undefined &&
      componentNames.some((name) => !existing.has(name))
    ) {
      throw new Error('Bound wallet root is missing a component database')
    }

    const subStore = new LevelSubAccountPoolStore(
      params.location,
      bindingId,
      isMigration
    )
    const changeStore = new LevelChangePoolStore(
      params.location,
      bindingId,
      isMigration
    )
    const attemptJournal = new LevelStampAttemptJournal(
      params.location,
      bindingId,
      isMigration
    )
    const paymentJournal = new LevelStampPaymentJournal(
      params.location,
      bindingId,
      isMigration
    )
    const stores = [subStore, changeStore, attemptJournal, paymentJournal]
    for (const store of stores) {
      try {
        await store.Open()
        openedStores.push(store)
      } catch (error) {
        await store.Close().catch(() => undefined)
        throw error
      }
    }
    const pool = new MonadSubAccountPool({
      keyring: subKeyring,
      store: subStore,
      requireStampReconciliationPreflight: true,
    })
    const changePool = new MonadChangePool({
      keyring: changeKeyring,
      store: changeStore,
    })
    validateLoadedState({
      pool,
      changePool,
      attemptJournal,
      paymentJournal,
      subKeyring,
      changeKeyring,
      allowMissingAttemptRows: params.recovery !== undefined,
    })
    validateMonadWalletState({
      pool,
      changePool,
      attemptJournal,
      paymentJournal,
      subKeyring,
      changeKeyring,
      allowMissingAttemptSpend: true,
      allowMissingAttemptRows: params.recovery !== undefined,
    })

    if (isMigration) {
      await params.onMigrationPhase?.('validated')
      if (manifestDb === undefined) {
        manifestDb = level(join(params.location, 'wallet-manifest'))
        await (manifestDb as any).open()
      }
      const marker: WalletMigrationMarker = {
        version: 1,
        bindingId,
        seedFingerprint: fingerprint,
        completedComponents: migration?.completedComponents ?? 0,
        ...(params.createSeedIfEmpty ? { persistedSeed: seed } : {}),
        ...(isEmptySuppliedSeedRestore ? { restoreMode: true as const } : {}),
      }
      if (migration === undefined) {
        await manifestDb.put(MIGRATION_KEY, JSON.stringify(marker))
        await params.onMigrationPhase?.('marker')
      }
      if (restoredSenderNextIndex !== undefined) {
        const checkpointIndices = new Set(
          pool.terminalCheckpoints().map((checkpoint) => checkpoint.index)
        )
        for (const record of restoredSenderRecords) {
          if (
            pool.getRecord(record.index) === undefined &&
            !checkpointIndices.has(record.index)
          ) {
            subStore.put(record)
          }
        }
        subStore.setNextIndex(Math.max(1, restoredSenderNextIndex))
        changePool.setNextUnusedIndex(
          Math.max(1, restoredChangeNextIndex as number)
        )
        await subStore.flush()
        await changeStore.flush()
        await pool.compactTerminalAccounts({
          limit: restoredSenderRecords.length,
        })
        validateLoadedState({
          pool,
          changePool,
          attemptJournal,
          paymentJournal,
          subKeyring,
          changeKeyring,
        })
        validateMonadWalletState({
          pool,
          changePool,
          attemptJournal,
          paymentJournal,
          subKeyring,
          changeKeyring,
        })
      }
      for (const [index, store] of stores.entries()) {
        await store.Bind()
        marker.completedComponents = index + 1
        await manifestDb.put(MIGRATION_KEY, JSON.stringify(marker))
        await params.onMigrationPhase?.(componentNames[index])
      }
      const manifest: MonadWalletManifest = {
        schema: MANIFEST_SCHEMA,
        version: MANIFEST_VERSION,
        bindingId,
        seedFingerprint: fingerprint,
        intents: [
          'sub-account-pool-v2',
          'change-pool-v2',
          'stamp-attempt-journal-v1',
          'stamp-payment-journal-v1',
        ],
      }
      const writes: Array<
        | { type: 'put'; key: string; value: string }
        | { type: 'del'; key: string }
      > = [
        { type: 'put', key: MANIFEST_KEY, value: JSON.stringify(manifest) },
        { type: 'del', key: MIGRATION_KEY },
      ]
      if (params.createSeedIfEmpty) {
        writes.push({
          type: 'put',
          key: SEED_KEY,
          value: JSON.stringify(seed),
        })
      }
      await (manifestDb as any).batch(writes)
      await params.onMigrationPhase?.('manifest')
    }

    const close = async (): Promise<void> => {
      let firstError: unknown
      for (const store of stores.slice().reverse()) {
        await store.Close().catch((error) => {
          firstError ??= error
        })
      }
      await manifestDb?.close().catch((error: unknown) => {
        firstError ??= error
      })
      await browserLease?.release().catch((error) => {
        firstError ??= error
      })
      await nodeLease?.release().catch((error) => {
        firstError ??= error
      })
      if (firstError !== undefined) throw firstError
    }
    return makeBundle({
      durability: 'persistent',
      bindingId,
      pool,
      changePool,
      attemptJournal,
      paymentJournal,
      subKeyring,
      changeKeyring,
      recoverySource: params.recovery,
      close,
    })
  } catch (error) {
    for (const store of openedStores.slice().reverse()) {
      await store.Close().catch(() => undefined)
    }
    await manifestDb?.close().catch(() => undefined)
    await browserLease?.release().catch(() => undefined)
    await nodeLease?.release().catch(() => undefined)
    throw error
  }
}
