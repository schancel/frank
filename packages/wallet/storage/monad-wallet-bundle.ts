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
import {
  isSubAccountIndexUsed,
  recoverNextSubAccountIndex,
} from '../monad-sub-account-recovery'
import { InMemoryChangePoolStore } from './change-pool-storage'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import {
  InMemoryStampAttemptJournal,
  LevelStampAttemptJournal,
  type OutgoingStampAttempt,
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
  validateWalletComponentBeforeOpen,
} from './wallet-root-guard'

const MANIFEST_KEY = 'manifest'
const SEED_KEY = 'seed'
const MIGRATION_KEY = 'migration'
const MANIFEST_SCHEMA = 'frank-monad-wallet-state'
const MANIFEST_VERSION = 2
const CURRENT_MANIFEST_INTENTS = [
  'sub-account-pool-v2',
  'change-pool-v3-authoritative-tx',
  'stamp-attempt-journal-v1',
  'stamp-payment-journal-v2-authoritative-tx',
] as const
const LEGACY_MANIFEST_INTENTS = [
  'sub-account-pool-v2',
  'change-pool-v2',
  'stamp-attempt-journal-v1',
  'stamp-payment-journal-v1',
] as const

interface MonadWalletManifest {
  schema: typeof MANIFEST_SCHEMA
  version: 1 | typeof MANIFEST_VERSION
  bindingId: string
  seedFingerprint: string
  intents: readonly string[]
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
  assertOpen(): void
  assertSemanticallyValid(): void
  repairAttemptSpendLifecycles(): Promise<void>
  reconcileRestoreState(): Promise<void>
  assertNoOrphanedLeases(): void
  compactTerminalAccounts(limit: number): Promise<number>
  close(): Promise<void>
}

const trustedPersistentBundles = new WeakSet<object>()

export function assertMonadWalletBundleProvenance(
  bundle: MonadWalletPersistenceBundle
): void {
  if (!trustedPersistentBundles.has(bundle as object)) {
    throw new Error(
      'Monad wallet bundle was not produced by the persistent bundle factory'
    )
  }
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
  /** Crash seam after a component binding commits but before the marker advances. */
  onMigrationBind?: (component: MigrationPhase) => void | Promise<void>
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
  OpenMonadWalletBundleTestHooks & {
    /** Authoritative retained-envelope lookup for pre-manifest attempts created before recipient
     * keys were journaled. Rejection or a key/transaction mismatch leaves the legacy DBs unbound. */
    resolveLegacyAttemptRecipientPublicKey?: (
      attempt: Readonly<OutgoingStampAttempt>
    ) => Promise<string | Uint8Array>
  }

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
    (parsed.version !== 1 && parsed.version !== MANIFEST_VERSION) ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(parsed.seedFingerprint) ||
    !Array.isArray(parsed.intents) ||
    parsed.intents.join('|') !==
      (parsed.version === 1
        ? LEGACY_MANIFEST_INTENTS
        : CURRENT_MANIFEST_INTENTS
      ).join('|')
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
  allowUnresolvedLegacyAttempts?: boolean
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
        'rawTx',
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
        'envelopeRecipientAddress',
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
      (!params.allowUnresolvedLegacyAttempts &&
        typeof attempt.recipientPublicKeyHex !== 'string') ||
      new Set(attempt.leaseIndices).size !== attempt.leaseIndices.length ||
      attempt.leaseIndices.some(
        (index) => !Number.isSafeInteger(index) || index < 0
      )
    ) {
      throw new Error('Invalid stamp-attempt journal record')
    }
    if (attempt.recipientPublicKeyHex !== undefined) {
      assertHex(
        attempt.recipientPublicKeyHex,
        33,
        'stamp-attempt recipient public key'
      )
    }
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
        'rawTx',
        'recipientPublicKeyHex',
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
    assertHex(
      payment.recipientPublicKeyHex,
      33,
      'stamp-payment recipient public key'
    )
    if (
      !Number.isSafeInteger(payment.childIndex) ||
      payment.childIndex < 0 ||
      !/^\d+$/.test(payment.valueWei) ||
      !['discovered', 'sweep-pending', 'swept'].includes(payment.status)
    ) {
      throw new Error('Invalid stamp-payment recovery record')
    }
    getAddress(payment.address)
    getAddress(payment.envelopeRecipientAddress)
    if (
      payment.status !== 'discovered' &&
      (payment.sweepTxHash === undefined ||
        payment.sweepRawTx === undefined ||
        payment.sweepValueWei === undefined ||
        payment.sweepDestinationAddress === undefined)
    ) {
      throw new Error('Invalid pending stamp-payment recovery record')
    }
  }
}

async function validateLegacySnapshot(params: {
  location: string
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  resolveLegacyAttemptRecipientPublicKey?: (
    attempt: Readonly<OutgoingStampAttempt>
  ) => Promise<string | Uint8Array>
}): Promise<Map<string, string>> {
  const components = [
    'sub-account-pool',
    'change-pool',
    'outgoing-stamp-attempts',
    'stamp-payment-journal',
  ] as const
  const browser = (globalThis as any).window !== undefined
  let fs: typeof import('fs') | undefined
  let snapshotRoot: string
  const createdBrowserSnapshots: string[] = []
  if (browser) {
    snapshotRoot = `__frank-wallet-validation-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
    try {
      for (const component of components) {
        const destination = join(snapshotRoot, component)
        await cloneBrowserLevelDatabaseReadOnly(
          join(params.location, component),
          destination
        )
        createdBrowserSnapshots.push(`level-js-${destination}`)
      }
    } catch (error) {
      for (const name of createdBrowserSnapshots) {
        await deleteBrowserDatabase(name).catch(() => undefined)
      }
      throw error
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    fs = require('fs') as typeof import('fs')
    // Keep the Node-only snapshot backend out of the browser module graph.
    const nodeRequire = require as NodeRequire
    const os = nodeRequire(['o', 's'].join('')) as typeof import('os')
    snapshotRoot = fs.mkdtempSync(join(os.tmpdir(), 'frank-wallet-legacy-'))
    fs.chmodSync(snapshotRoot, 0o700)
    for (const component of components) {
      fs.cpSync(
        join(params.location, component),
        join(snapshotRoot, component),
        { recursive: true }
      )
    }
  }
  const stores: Array<{ Open(): Promise<void>; Close(): Promise<void> }> = []
  try {
    const subStore = new LevelSubAccountPoolStore(snapshotRoot)
    const changeStore = new LevelChangePoolStore(snapshotRoot)
    const attemptJournal = new LevelStampAttemptJournal(snapshotRoot)
    const paymentJournal = new LevelStampPaymentJournal(snapshotRoot)
    stores.push(subStore, changeStore, attemptJournal, paymentJournal)
    for (const store of stores) await store.Open()
    const pool = new MonadSubAccountPool({
      keyring: params.subKeyring,
      store: subStore,
    })
    const changePool = new MonadChangePool({
      keyring: params.changeKeyring,
      store: changeStore,
    })
    validateLoadedState({
      pool,
      changePool,
      attemptJournal,
      paymentJournal,
      subKeyring: params.subKeyring,
      changeKeyring: params.changeKeyring,
      allowUnresolvedLegacyAttempts: true,
    })
    const resolutions = new Map<string, string>()
    const overlay = new InMemoryStampAttemptJournal()
    for (const attempt of attemptJournal.getAll()) {
      let resolved = attempt
      if (attempt.recipientPublicKeyHex === undefined) {
        if (params.resolveLegacyAttemptRecipientPublicKey === undefined) {
          throw new Error(
            'Legacy stamp attempts require an authoritative retained-envelope recipient-key resolver'
          )
        }
        const recipient = await params.resolveLegacyAttemptRecipientPublicKey(
          attempt
        )
        const recipientHex =
          typeof recipient === 'string' ? recipient : hexlify(recipient)
        resolutions.set(attempt.payloadHashHex, recipientHex)
        resolved = { ...attempt, recipientPublicKeyHex: recipientHex }
      }
      await overlay.put(resolved)
    }
    validateMonadWalletState({
      pool,
      changePool,
      attemptJournal: overlay,
      paymentJournal,
      subKeyring: params.subKeyring,
      changeKeyring: params.changeKeyring,
      allowMissingAttemptSpend: true,
      allowMissingChangeRecovery: true,
    })
    return resolutions
  } finally {
    for (const store of stores.reverse()) {
      await store.Close().catch(() => undefined)
    }
    if (browser) {
      for (const name of createdBrowserSnapshots) {
        await deleteBrowserDatabase(name)
      }
    } else {
      fs?.rmSync(snapshotRoot, { recursive: true, force: true })
    }
  }
}

async function cloneBrowserLevelDatabaseReadOnly(
  sourceLocation: string,
  destinationLocation: string
): Promise<void> {
  const indexedDb = (globalThis as any).indexedDB
  const sourceName = `level-js-${sourceLocation}`
  const source = await new Promise<any>((resolveDb, rejectDb) => {
    const request = indexedDb.open(sourceName)
    request.onupgradeneeded = () => {
      request.transaction?.abort()
      rejectDb(new Error(`Legacy browser component ${sourceName} is missing`))
    }
    request.onerror = () => rejectDb(request.error)
    request.onsuccess = () => resolveDb(request.result)
  })
  let entries: Array<{ key: any; value: unknown }>
  try {
    entries = await new Promise((resolveEntries, rejectEntries) => {
      if (!source.objectStoreNames.contains(sourceLocation)) {
        rejectEntries(
          new Error(`Invalid legacy browser component ${sourceName}`)
        )
        return
      }
      const transaction = source.transaction(sourceLocation, 'readonly')
      const request = transaction.objectStore(sourceLocation).openCursor()
      const values: Array<{ key: any; value: unknown }> = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor === null) return
        values.push({ key: cursor.key, value: cursor.value })
        cursor.continue()
      }
      transaction.onerror = () => rejectEntries(transaction.error)
      transaction.onabort = () => rejectEntries(transaction.error)
      transaction.oncomplete = () => resolveEntries(values)
    })
  } finally {
    source.close()
  }
  const destinationName = `level-js-${destinationLocation}`
  const destination = await new Promise<any>((resolveDb, rejectDb) => {
    const request = indexedDb.open(destinationName, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore(destinationLocation)
    request.onerror = () => rejectDb(request.error)
    request.onsuccess = () => resolveDb(request.result)
  })
  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const transaction = destination.transaction(
        destinationLocation,
        'readwrite'
      )
      const store = transaction.objectStore(destinationLocation)
      for (const entry of entries) store.put(entry.value, entry.key)
      transaction.onerror = () => rejectWrite(transaction.error)
      transaction.onabort = () => rejectWrite(transaction.error)
      transaction.oncomplete = () => resolveWrite()
    })
  } finally {
    destination.close()
  }
}

async function deleteBrowserDatabase(name: string): Promise<void> {
  const indexedDb = (globalThis as any).indexedDB
  await new Promise<void>((resolveDelete, rejectDelete) => {
    const request = indexedDb.deleteDatabase(name)
    request.onsuccess = () => resolveDelete()
    request.onerror = () => rejectDelete(request.error)
    request.onblocked = () =>
      rejectDelete(new Error(`Browser validation snapshot ${name} is blocked`))
  })
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
  let closed = false
  let closePromise: Promise<void> | undefined
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
  let bundle!: MonadWalletPersistenceBundle
  bundle = Object.freeze({
    durability: params.durability,
    bindingId: params.bindingId,
    pool: params.pool,
    leaseManager,
    changePool: params.changePool,
    stampAttemptJournal: params.attemptJournal,
    stampPaymentJournal: params.paymentJournal,
    assertOpen(): void {
      if (closed) throw new Error('Monad wallet bundle is closed')
    },
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
      const stagedByIndex = new Map(
        params.pool.records().map((record) => [record.index, record])
      )
      const repairedIndices = new Set<number>()
      for (const attempt of params.attemptJournal.getAll()) {
        const message = decodeMonadStampedMessage(
          Uint8Array.from(attempt.messageBytes)
        )
        for (const [offset, index] of attempt.leaseIndices.entries()) {
          const record =
            stagedByIndex.get(index) ?? params.pool.stageJournaledInUse(index)
          const payment = message.stampPayments[offset]
          if (record?.lifecycle?.spend !== undefined || payment === undefined) {
            continue
          }
          const transaction = Transaction.from(hexlify(payment.rawTx))
          stagedByIndex.set(index, {
            ...record,
            lifecycle: {
              ...record.lifecycle,
              spend: {
                rawTx: hexlify(payment.rawTx),
                txHash: transaction.hash as string,
                valueWei: transaction.value.toString(),
              },
            },
          })
          repairedIndices.add(index)
        }
      }
      if (repairedIndices.size > 0) {
        const stagedStore = new InMemorySubAccountPoolStore()
        stagedStore.putMany(Array.from(stagedByIndex.values()))
        stagedStore.setNextIndex(params.pool.nextUnusedIndex())
        for (const checkpoint of params.pool.terminalCheckpoints()) {
          stagedStore.replaceWithCheckpoint(checkpoint)
        }
        const stagedPool = new MonadSubAccountPool({
          keyring: params.subKeyring,
          store: stagedStore,
        })
        validateMonadWalletState({
          pool: stagedPool,
          changePool: params.changePool,
          attemptJournal: params.attemptJournal,
          paymentJournal: params.paymentJournal,
          subKeyring: params.subKeyring,
          changeKeyring: params.changeKeyring,
        })
        params.pool.applyPrevalidatedRecoveryRecords(
          Array.from(repairedIndices).map(
            (index) => stagedByIndex.get(index) as SubAccountRecord
          )
        )
        await params.pool.flush()
      }
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
      const pendingChange = params.changePool.pendingSourceBurnIndex()
      return params.pool.compactTerminalAccounts({
        limit,
        isReferenced: (index) =>
          index === pendingChange ||
          params.attemptJournal.referencesLeaseIndex(index),
      })
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closed = true
      trustedPersistentBundles.delete(bundle as object)
      closePromise = params.close()
      return closePromise
    },
  })
  if (params.durability === 'persistent') {
    trustedPersistentBundles.add(bundle as object)
  }
  return bundle
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
  const location = prepareSecureWalletRoot(params.location)
  const nodeLease = await acquireNodeWalletRootLease(location)
  const browserLease = await acquireBrowserWalletRootLease(location)
  const assertLeaseHeld = (): void => {
    browserLease?.assertHeld()
    nodeLease?.assertHeld()
  }
  let manifestDb: LevelDB | undefined
  const openedStores: Array<{ Close(): Promise<void> }> = []
  try {
    assertLeaseHeld()
    const existing = await existingWalletComponents(location)
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
      assertLeaseHeld()
      validateWalletComponentBeforeOpen(location, 'wallet-manifest', true)
      manifestDb = (level as any)(join(location, 'wallet-manifest'), {
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
    const legacyRecipientResolutions =
      !hasManifestDatabase && hasLegacyComponents
        ? await validateLegacySnapshot({
            location,
            subKeyring,
            changeKeyring,
            resolveLegacyAttemptRecipientPublicKey:
              params.resolveLegacyAttemptRecipientPublicKey,
          })
        : new Map<string, string>()
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
      const recovery = params.recovery
      await recovery.assertRelayAvailable()
      const maxIndex = recovery.maxIndex
      const [senderNext, changeNext, senderZeroUsed] = await Promise.all([
        recoverNextSubAccountIndex({
          keyring: subKeyring,
          provider: recovery.provider,
          maxIndex,
          minimumIndex: 1,
        }),
        recoverNextChangeIndex({
          keyring: changeKeyring,
          provider: recovery.provider,
          maxIndex,
          minimumIndex: 1,
        }),
        isSubAccountIndexUsed(
          recovery.provider,
          subKeyring.deriveSubAccount(0).address
        ),
      ])
      restoredSenderNextIndex = senderNext
      restoredChangeNextIndex = changeNext
      const stageEvidence = async (index: number): Promise<void> => {
        const address = subKeyring.deriveSubAccount(index).address
        const evidence = await recovery.recoverSenderEvidence(index, address)
        if (
          evidence === undefined &&
          !(await isSubAccountIndexUsed(recovery.provider, address))
        ) {
          return
        }
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
      if (senderZeroUsed) await stageEvidence(0)
      for (let index = 1; index < restoredSenderNextIndex; index++) {
        await stageEvidence(index)
      }
      // Treat recovery input as hostile: validate the complete staged set before a manifest,
      // component binding, high-water mark, or row can be written.
      const stagedStore = new InMemorySubAccountPoolStore()
      for (const evidence of restoredSenderRecords) stagedStore.put(evidence)
      stagedStore.setNextIndex(Math.max(1, restoredSenderNextIndex))
      const stagedPool = new MonadSubAccountPool({
        keyring: subKeyring,
        store: stagedStore,
      })
      const stagedChangeStore = new InMemoryChangePoolStore()
      stagedChangeStore.setNextIndex(Math.max(1, restoredChangeNextIndex))
      const stagedChangePool = new MonadChangePool({
        keyring: changeKeyring,
        store: stagedChangeStore,
      })
      const stagedAttempts = new InMemoryStampAttemptJournal()
      const stagedPayments = new InMemoryStampPaymentJournal()
      validateLoadedState({
        pool: stagedPool,
        changePool: stagedChangePool,
        attemptJournal: stagedAttempts,
        paymentJournal: stagedPayments,
        subKeyring,
        changeKeyring,
      })
      validateMonadWalletState({
        pool: stagedPool,
        changePool: stagedChangePool,
        attemptJournal: stagedAttempts,
        paymentJournal: stagedPayments,
        subKeyring,
        changeKeyring,
      })
    }
    if (
      finalized !== undefined &&
      componentNames.some((name) => !existing.has(name))
    ) {
      throw new Error('Bound wallet root is missing a component database')
    }

    const subStore = new LevelSubAccountPoolStore(
      location,
      bindingId,
      isMigration,
      assertLeaseHeld
    )
    const changeStore = new LevelChangePoolStore(
      location,
      bindingId,
      isMigration,
      assertLeaseHeld
    )
    const attemptJournal = new LevelStampAttemptJournal(
      location,
      bindingId,
      isMigration,
      assertLeaseHeld
    )
    const paymentJournal = new LevelStampPaymentJournal(
      location,
      bindingId,
      isMigration,
      assertLeaseHeld
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
    if (isMigration) {
      const completed = migration?.completedComponents ?? 0
      for (const [index, store] of stores.entries()) {
        const actual = store.bindingId()
        if (index < completed && actual !== bindingId) {
          throw new Error(
            `Migration provenance mismatch for completed component ${componentNames[index]}`
          )
        }
        if (index === completed) {
          if (actual !== undefined && actual !== bindingId) {
            throw new Error(
              `Migration boundary binding mismatch for ${componentNames[index]}`
            )
          }
        } else if (index > completed && actual !== undefined) {
          throw new Error(
            `Migration provenance has a bound unfinished component ${componentNames[index]}`
          )
        }
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
      allowUnresolvedLegacyAttempts: isMigration,
    })
    const unresolvedAttempts = attemptJournal
      .getAll()
      .filter((attempt) => attempt.recipientPublicKeyHex === undefined)
    const resolvedLegacyAttempts: OutgoingStampAttempt[] = []
    let validationAttemptJournal: StampAttemptJournal = attemptJournal
    if (unresolvedAttempts.length > 0) {
      if (
        !isMigration ||
        params.resolveLegacyAttemptRecipientPublicKey === undefined
      ) {
        throw new Error(
          'Legacy stamp attempts require an authoritative retained-envelope recipient-key resolver'
        )
      }
      const overlay = new InMemoryStampAttemptJournal()
      const unresolvedHashes = new Set(
        unresolvedAttempts.map((attempt) => attempt.payloadHashHex)
      )
      for (const attempt of attemptJournal.getAll()) {
        let resolved = attempt
        if (unresolvedHashes.has(attempt.payloadHashHex)) {
          const recipient =
            legacyRecipientResolutions.get(attempt.payloadHashHex) ??
            (await params.resolveLegacyAttemptRecipientPublicKey(
              Object.freeze({
                ...attempt,
                messageBytes: Object.freeze([...attempt.messageBytes]),
                leaseIndices: Object.freeze([...attempt.leaseIndices]),
              }) as unknown as Readonly<OutgoingStampAttempt>
            ))
          resolved = {
            ...attempt,
            recipientPublicKeyHex:
              typeof recipient === 'string' ? recipient : hexlify(recipient),
          }
          resolvedLegacyAttempts.push(resolved)
        }
        await overlay.put(resolved)
      }
      validationAttemptJournal = overlay
      validateLoadedState({
        pool,
        changePool,
        attemptJournal: validationAttemptJournal,
        paymentJournal,
        subKeyring,
        changeKeyring,
        allowMissingAttemptRows: params.recovery !== undefined,
      })
    }
    validateMonadWalletState({
      pool,
      changePool,
      attemptJournal: validationAttemptJournal,
      paymentJournal,
      subKeyring,
      changeKeyring,
      allowMissingAttemptSpend: true,
      allowMissingAttemptRows: params.recovery !== undefined,
      allowMissingChangeRecovery: true,
    })

    if (isMigration) {
      await params.onMigrationPhase?.('validated')
      if (manifestDb === undefined) {
        assertLeaseHeld()
        validateWalletComponentBeforeOpen(location, 'wallet-manifest', false)
        manifestDb = level(join(location, 'wallet-manifest'))
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
        assertLeaseHeld()
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
      for (
        let index = marker.completedComponents;
        index < stores.length;
        index++
      ) {
        const store = stores[index]
        if (store.bindingId() === undefined) {
          if (store === attemptJournal) {
            await attemptJournal.Bind(resolvedLegacyAttempts)
          } else {
            await store.Bind()
          }
          await params.onMigrationBind?.(componentNames[index])
        }
        marker.completedComponents = index + 1
        assertLeaseHeld()
        await manifestDb.put(MIGRATION_KEY, JSON.stringify(marker))
        await params.onMigrationPhase?.(componentNames[index])
      }
      const manifest: MonadWalletManifest = {
        schema: MANIFEST_SCHEMA,
        version: MANIFEST_VERSION,
        bindingId,
        seedFingerprint: fingerprint,
        intents: CURRENT_MANIFEST_INTENTS,
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
      assertLeaseHeld()
      await (manifestDb as any).batch(writes)
      await params.onMigrationPhase?.('manifest')
    }

    let repairedChangeRecovery = false
    for (const record of changePool.records()) {
      const source = pool.getRecord(record.sourceBurnIndex)
      if (source !== undefined && source.lifecycle?.recovery === undefined) {
        pool.recordRecoveryDisposition(record.sourceBurnIndex, {
          kind: 'change',
          changeIndex: record.index,
          address: record.address,
          valueWei: record.sweptValueWei,
          txHash: record.txHash,
        })
        repairedChangeRecovery = true
      }
    }
    if (repairedChangeRecovery) await pool.flush()
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
    if (finalized?.version === 1) {
      assertLeaseHeld()
      await (manifestDb as LevelDB).put(
        MANIFEST_KEY,
        JSON.stringify({
          ...finalized,
          version: MANIFEST_VERSION,
          intents: CURRENT_MANIFEST_INTENTS,
        } satisfies MonadWalletManifest)
      )
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
