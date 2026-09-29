/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import {
  Transaction,
  type Provider,
  getAddress,
  getBytes,
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
import {
  InMemoryChangePoolStore,
  type ChangeAccountRecord,
} from './change-pool-storage'
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
  type StampPaymentRecoveryRecord,
  type StampPaymentJournal,
} from './stamp-payment-journal'
import {
  InMemorySubAccountPoolStore,
  assertSubAccountLifecycleMatrix,
  type SubAccountRecord,
} from './sub-account-pool-storage'
import { validateMonadWalletState } from './monad-wallet-state-validator'
import {
  acquireBrowserWalletRootLease,
  acquireNodeWalletRootLease,
  existingWalletComponents,
  isBrowserWalletStorage,
  nodeWalletRootExists,
  nodeWalletCreationRecoveryExists,
  nodeWalletRootIsPrivateEmpty,
  type NodeWalletCreationClaim,
  prepareSecureWalletRootWithProvenance,
  publishNodeWalletRootWithIntent,
  readPrivateNodeCreationFile,
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
  creationMode?: 'caller-supplied'
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
  /** Admits one complete stateful wallet operation. Close stops admission immediately and waits
   * for every admitted operation before closing stores or releasing root ownership. */
  runOperation<T>(operation: () => Promise<T>): Promise<T>
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
  | 'creation-intent'
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
  /** Node first-use crash seam. The final root is absent before `root-published`. */
  onNodeCreationPublishPhase?: (
    phase:
      | 'staged'
      | 'temp-written'
      | 'temp-synced'
      | 'intent-published'
      | 'before-root-publish'
      | 'root-published'
      | 'intent-linked'
      | 'before-claim-cleanup'
  ) => void | Promise<void>
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
      seed: { mnemonic: string; passphrase?: string }
      createSeedIfEmpty?: false
      /** Explicit first-use creation with this exact caller-owned seed. This succeeds for an
       * unbound root only when exclusive acquisition proves the storage namespace never existed. */
      mode: 'create'
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
    /** Canonical signed sweep bytes fetched by the retained transaction hash. */
    resolveLegacyChangeRawTransaction?: (
      record: Readonly<ChangeAccountRecord>
    ) => Promise<string | Uint8Array>
    /** Exact retained relay-message authority for a pre-v2 recipient payment row. */
    resolveLegacyPaymentAuthority?: (
      record: Readonly<StampPaymentRecoveryRecord>
    ) => Promise<{
      rawTx: string | Uint8Array
      recipientPublicKeyHex: string | Uint8Array
      envelopeRecipientAddress: string
    }>
  }

interface LegacyMigrationResolutions {
  attempts: Map<string, string>
  changes: Map<number, ChangeAccountRecord>
  payments: Map<string, StampPaymentRecoveryRecord>
  hasSemanticState: boolean
  hasUnauthenticatedSenderHighWater: boolean
  hasUnauthenticatedChangeHighWater: boolean
}

function isCompleteAllocationPrefix(
  nextIndex: number,
  allocatedIndices: Iterable<number>
): boolean {
  if (nextIndex === 0) return true
  const sorted = Array.from(new Set(allocatedIndices)).sort((a, b) => a - b)
  return (
    sorted.length === nextIndex &&
    sorted.every((index, offset) => index === offset)
  )
}

interface WalletCreationIntent {
  version: 1
  kind: 'caller-supplied' | 'generated'
  bindingId: string
  seedFingerprint: string
  persistedSeed?: PersistedSeed
}

const NODE_CREATION_INTENT_FILE = '.frank-wallet-creation.json'
const BROWSER_CREATION_INTENT_STORE = 'creation-intent'
const BROWSER_CREATION_INTENT_KEY = 'intent'

function parseCreationIntent(value: string): WalletCreationIntent {
  const parsed = JSON.parse(value) as Partial<WalletCreationIntent>
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Object.keys(parsed).some(
      (key) =>
        ![
          'version',
          'kind',
          'bindingId',
          'seedFingerprint',
          'persistedSeed',
        ].includes(key)
    ) ||
    parsed.version !== 1 ||
    (parsed.kind !== 'caller-supplied' && parsed.kind !== 'generated') ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(parsed.seedFingerprint) ||
    (parsed.kind === 'caller-supplied' && parsed.persistedSeed !== undefined) ||
    (parsed.kind === 'generated' && parsed.persistedSeed === undefined)
  ) {
    throw new Error('Invalid wallet creation intent')
  }
  if (parsed.persistedSeed !== undefined) {
    parseSeed(JSON.stringify(parsed.persistedSeed))
  }
  return parsed as WalletCreationIntent
}

function browserCreationIntentName(location: string): string {
  return `frank-monad-wallet-creation:${location}`
}

async function readWalletCreationIntent(
  location: string
): Promise<WalletCreationIntent | undefined> {
  if (!isBrowserWalletStorage()) {
    const intentPath = join(location, NODE_CREATION_INTENT_FILE)
    const encoded = readPrivateNodeCreationFile(
      intentPath,
      'Wallet creation intent',
      false,
      [1, 2]
    )
    return encoded === undefined ? undefined : parseCreationIntent(encoded)
  }

  const indexedDb = (globalThis as any).indexedDB
  const databaseName = browserCreationIntentName(location)
  const databases = (await indexedDb.databases()) as Array<{ name?: string }>
  if (!databases.some((database) => database.name === databaseName)) {
    return undefined
  }
  const database = await new Promise<any>((resolveOpen, rejectOpen) => {
    const request = indexedDb.open(databaseName)
    request.onerror = () => rejectOpen(request.error)
    request.onsuccess = () => resolveOpen(request.result)
  })
  try {
    return await new Promise<WalletCreationIntent>(
      (resolveRead, rejectRead) => {
        if (
          !database.objectStoreNames.contains(BROWSER_CREATION_INTENT_STORE)
        ) {
          rejectRead(new Error('Invalid browser wallet creation intent'))
          return
        }
        const transaction = database.transaction(
          BROWSER_CREATION_INTENT_STORE,
          'readonly'
        )
        const request = transaction
          .objectStore(BROWSER_CREATION_INTENT_STORE)
          .get(BROWSER_CREATION_INTENT_KEY)
        request.onerror = () => rejectRead(request.error)
        request.onsuccess = () => {
          if (typeof request.result !== 'string') {
            rejectRead(new Error('Invalid browser wallet creation intent'))
            return
          }
          resolveRead(parseCreationIntent(request.result))
        }
      }
    )
  } finally {
    database.close()
  }
}

async function createWalletCreationIntent(
  location: string,
  intent: WalletCreationIntent
): Promise<void> {
  const encoded = JSON.stringify(intent)
  if (!isBrowserWalletStorage()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    const intentPath = join(location, NODE_CREATION_INTENT_FILE)
    const temporaryPath = `${intentPath}.tmp`
    try {
      const abandoned = fs.lstatSync(temporaryPath)
      if (abandoned.isSymbolicLink() || !abandoned.isFile()) {
        throw new Error('Invalid wallet creation intent temporary')
      }
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, encoded)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporaryPath, intentPath)
    const rootDescriptor = fs.openSync(location, 'r')
    try {
      fs.fsyncSync(rootDescriptor)
    } finally {
      fs.closeSync(rootDescriptor)
    }
    return
  }

  const indexedDb = (globalThis as any).indexedDB
  const databaseName = browserCreationIntentName(location)
  await new Promise<void>((resolveCreate, rejectCreate) => {
    const request = indexedDb.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(
        BROWSER_CREATION_INTENT_STORE
      )
      store.add(encoded, BROWSER_CREATION_INTENT_KEY)
    }
    request.onerror = () => rejectCreate(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolveCreate()
    }
  })
}

async function clearWalletCreationIntent(location: string): Promise<void> {
  if (!isBrowserWalletStorage()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    const intentPath = join(location, NODE_CREATION_INTENT_FILE)
    try {
      fs.unlinkSync(intentPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const rootDescriptor = fs.openSync(location, 'r')
    try {
      fs.fsyncSync(rootDescriptor)
    } finally {
      fs.closeSync(rootDescriptor)
    }
    return
  }
  const indexedDb = (globalThis as any).indexedDB
  await new Promise<void>((resolveDelete, rejectDelete) => {
    const request = indexedDb.deleteDatabase(
      browserCreationIntentName(location)
    )
    request.onsuccess = () => resolveDelete()
    request.onerror = () => rejectDelete(request.error)
    request.onblocked = () =>
      rejectDelete(new Error('Browser wallet creation intent deletion blocked'))
  })
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

function authenticateGeneratedCreationIntent(
  encoded: string
): WalletCreationIntent {
  const intent = parseCreationIntent(encoded)
  if (intent.kind !== 'generated' || intent.persistedSeed === undefined) {
    throw new Error('Abandoned wallet creation intent has the wrong mode')
  }
  const seed = parseSeed(JSON.stringify(intent.persistedSeed))
  const subKeyring = MonadHdKeyring.fromMnemonic(
    seed.mnemonic,
    seed.passphrase
  )
  const changeKeyring = MonadChangeKeyring.fromMnemonic(
    seed.mnemonic,
    seed.passphrase
  )
  if (seedFingerprint(subKeyring, changeKeyring) !== intent.seedFingerprint) {
    throw new Error('Abandoned wallet creation intent failed authentication')
  }
  return intent
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
          'creationMode',
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
    (parsed.restoreMode !== undefined && parsed.restoreMode !== true) ||
    (parsed.creationMode !== undefined &&
      parsed.creationMode !== 'caller-supplied')
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
  allowUnresolvedLegacyFinalizedRows?: boolean
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
    assertSubAccountLifecycleMatrix(record)
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
        'authorityState',
        'authorityReason',
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
      ) ||
      (attempt.authorityState !== undefined &&
        attempt.authorityState !== 'pending' &&
        attempt.authorityState !== 'incompatible-protobuf') ||
      (attempt.authorityState === 'incompatible-protobuf' &&
        attempt.authorityReason !== 'noncanonical_protobuf') ||
      (attempt.authorityReason !== undefined &&
        attempt.authorityState !== 'incompatible-protobuf')
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
        'envelopeRecipientAddress',
        'address',
        'valueWei',
        'status',
        'sweepTxHash',
        'sweepRawTx',
        'sweepValueWei',
        'sweepDestinationAddress',
        'failedSweeps',
      ],
      'stamp-payment recovery record'
    )
    assertHex(payment.payloadHashHex, 32, 'stamp-payment payload hash')
    assertHex(payment.txHash, 32, 'stamp-payment transaction hash')
    const unresolvedLegacyAuthority =
      payment.rawTx === undefined ||
      payment.recipientPublicKeyHex === undefined ||
      payment.envelopeRecipientAddress === undefined
    if (
      unresolvedLegacyAuthority &&
      !params.allowUnresolvedLegacyFinalizedRows
    ) {
      throw new Error('Stamp-payment recovery authority is incomplete')
    }
    if (payment.recipientPublicKeyHex !== undefined) {
      assertHex(
        payment.recipientPublicKeyHex,
        33,
        'stamp-payment recipient public key'
      )
      const recipientKey = getBytes(payment.recipientPublicKeyHex)
      if (recipientKey[0] !== 0x02 && recipientKey[0] !== 0x03) {
        throw new Error('Stamp-payment recipient public key is not compressed')
      }
    }
    if (
      !Number.isSafeInteger(payment.childIndex) ||
      payment.childIndex < 0 ||
      !/^\d+$/.test(payment.valueWei) ||
      !['discovered', 'sweep-pending', 'sweep-failed', 'swept'].includes(
        payment.status
      )
    ) {
      throw new Error('Invalid stamp-payment recovery record')
    }
    getAddress(payment.address)
    if (payment.envelopeRecipientAddress !== undefined) {
      getAddress(payment.envelopeRecipientAddress)
    }
    if (
      payment.status !== 'discovered' &&
      (payment.sweepTxHash === undefined ||
        payment.sweepRawTx === undefined ||
        payment.sweepValueWei === undefined ||
        payment.sweepDestinationAddress === undefined)
    ) {
      throw new Error('Invalid pending stamp-payment recovery record')
    }
    if (
      payment.status === 'discovered' &&
      (payment.sweepTxHash !== undefined ||
        payment.sweepRawTx !== undefined ||
        payment.sweepValueWei !== undefined ||
        payment.sweepDestinationAddress !== undefined ||
        (payment.failedSweeps?.length ?? 0) > 0)
    ) {
      throw new Error('Invalid discovered stamp-payment recovery record')
    }
    if (
      payment.failedSweeps !== undefined &&
      (!Array.isArray(payment.failedSweeps) ||
        payment.failedSweeps.some(
          (failed) =>
            typeof failed.txHash !== 'string' ||
            typeof failed.rawTx !== 'string' ||
            !/^\d+$/.test(failed.valueWei) ||
            typeof failed.destinationAddress !== 'string'
        ))
    ) {
      throw new Error('Invalid failed stamp-payment sweep ledger')
    }
    for (const failed of payment.failedSweeps ?? []) {
      assertOnlyKeys(
        failed,
        ['txHash', 'rawTx', 'valueWei', 'destinationAddress'],
        'failed stamp-payment sweep record'
      )
    }
    if (payment.status === 'sweep-failed') {
      const terminal = payment.failedSweeps?.[payment.failedSweeps.length - 1]
      if (
        terminal === undefined ||
        terminal.txHash !== payment.sweepTxHash ||
        terminal.rawTx !== payment.sweepRawTx ||
        terminal.valueWei !== payment.sweepValueWei ||
        terminal.destinationAddress !== payment.sweepDestinationAddress
      ) {
        throw new Error('Invalid failed stamp-payment sweep authority')
      }
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
  resolveLegacyChangeRawTransaction?: (
    record: Readonly<ChangeAccountRecord>
  ) => Promise<string | Uint8Array>
  resolveLegacyPaymentAuthority?: (
    record: Readonly<StampPaymentRecoveryRecord>
  ) => Promise<{
    rawTx: string | Uint8Array
    recipientPublicKeyHex: string | Uint8Array
    envelopeRecipientAddress: string
  }>
}): Promise<LegacyMigrationResolutions> {
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
      allowUnresolvedLegacyFinalizedRows: true,
    })
    const senderEvidenceIndices = [
      ...pool.records().map((record) => record.index),
      ...pool.terminalCheckpoints().map((checkpoint) => checkpoint.index),
      ...attemptJournal.getAll().flatMap((attempt) => attempt.leaseIndices),
    ]
    const changeEvidenceIndices = changePool
      .records()
      .map((record) => record.index)
    const hasAuthenticatedRows =
      pool.records().length > 0 ||
      pool.terminalCheckpoints().length > 0 ||
      changePool.records().length > 0 ||
      changePool.pendingIntent() !== undefined ||
      attemptJournal.getAll().length > 0 ||
      paymentJournal.getAll().length > 0
    const hasCounters =
      pool.nextUnusedIndex() > 0 || changePool.nextUnusedIndex() > 0
    const resolutions: LegacyMigrationResolutions = {
      attempts: new Map(),
      changes: new Map(),
      payments: new Map(),
      hasSemanticState: hasAuthenticatedRows || hasCounters,
      hasUnauthenticatedSenderHighWater: !isCompleteAllocationPrefix(
        pool.nextUnusedIndex(),
        senderEvidenceIndices
      ),
      hasUnauthenticatedChangeHighWater: !isCompleteAllocationPrefix(
        changePool.nextUnusedIndex(),
        changeEvidenceIndices
      ),
    }
    const attemptOverlay = new InMemoryStampAttemptJournal()
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
        resolutions.attempts.set(attempt.payloadHashHex, recipientHex)
        resolved = { ...attempt, recipientPublicKeyHex: recipientHex }
      }
      await attemptOverlay.put(resolved)
    }
    const changeOverlayStore = new InMemoryChangePoolStore()
    changeOverlayStore.setNextIndex(changePool.nextUnusedIndex())
    const pendingChange = changePool.pendingIntent()
    if (pendingChange !== undefined)
      changeOverlayStore.setPendingIntent(pendingChange)
    for (const record of changePool.records()) {
      let resolved = record
      if (record.rawTx === undefined) {
        if (params.resolveLegacyChangeRawTransaction === undefined) {
          throw new Error(
            'Legacy finalized change rows require an authoritative transaction resolver'
          )
        }
        const rawTx = await params.resolveLegacyChangeRawTransaction(record)
        resolved = {
          ...record,
          rawTx: typeof rawTx === 'string' ? rawTx : hexlify(rawTx),
        }
        resolutions.changes.set(record.index, resolved)
      }
      changeOverlayStore.putRecord(resolved)
    }
    const changeOverlay = new MonadChangePool({
      keyring: params.changeKeyring,
      store: changeOverlayStore,
    })
    const paymentOverlay = new InMemoryStampPaymentJournal()
    for (const record of paymentJournal.getAll()) {
      let resolved = record
      if (
        record.rawTx === undefined ||
        record.recipientPublicKeyHex === undefined ||
        record.envelopeRecipientAddress === undefined
      ) {
        if (params.resolveLegacyPaymentAuthority === undefined) {
          throw new Error(
            'Legacy stamp-payment rows require an authoritative retained-message resolver'
          )
        }
        const authority = await params.resolveLegacyPaymentAuthority(record)
        resolved = {
          ...record,
          rawTx:
            typeof authority.rawTx === 'string'
              ? authority.rawTx
              : hexlify(authority.rawTx),
          recipientPublicKeyHex:
            typeof authority.recipientPublicKeyHex === 'string'
              ? authority.recipientPublicKeyHex
              : hexlify(authority.recipientPublicKeyHex),
          envelopeRecipientAddress: authority.envelopeRecipientAddress,
        }
        resolutions.payments.set(
          `${record.payloadHashHex}:${record.childIndex}`,
          resolved
        )
      }
      await paymentOverlay.put(resolved)
    }
    validateMonadWalletState({
      pool,
      changePool: changeOverlay,
      attemptJournal: attemptOverlay,
      paymentJournal: paymentOverlay,
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
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let activeOperations = 0
  let resolveDrained: (() => void) | undefined
  let closePromise: Promise<void> | undefined
  const runOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== 'open') {
      throw new Error('Monad wallet bundle is closing or closed')
    }
    activeOperations++
    try {
      return await operation()
    } finally {
      activeOperations--
      if (activeOperations === 0) resolveDrained?.()
    }
  }
  params.pool.attachWalletOperationGate(runOperation)
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
      if (lifecycle !== 'open') {
        throw new Error('Monad wallet bundle is closing or closed')
      }
    },
    runOperation,
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
      return runOperation(async () => {
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
      })
    },
    async reconcileRestoreState(): Promise<void> {
      return runOperation(async () => {
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
      })
    },
    assertNoOrphanedLeases,
    async compactTerminalAccounts(limit: number): Promise<number> {
      return runOperation(async () => {
        const pendingChange = params.changePool.pendingSourceBurnIndex()
        return params.pool.compactTerminalAccounts({
          limit,
          isReferenced: (index) =>
            index === pendingChange ||
            params.attemptJournal.referencesLeaseIndex(index),
        })
      })
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      lifecycle = 'closing'
      trustedPersistentBundles.delete(bundle as object)
      closePromise = (async () => {
        if (activeOperations > 0) {
          await new Promise<void>((resolve) => {
            resolveDrained = resolve
          })
        }
        await params.close()
        lifecycle = 'closed'
      })()
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
  const paymentJournal = new InMemoryStampPaymentJournal()
  return makeBundle({
    durability: 'test-only-ephemeral',
    bindingId: newBindingId(),
    pool,
    changePool: new MonadChangePool({
      keyring: changeKeyring,
      store: new InMemoryChangePoolStore(),
    }),
    attemptJournal: new InMemoryStampAttemptJournal(),
    paymentJournal,
    subKeyring,
    changeKeyring,
    close: () => paymentJournal.Close(),
  })
}

export async function openMonadWalletBundle(
  params: OpenMonadWalletBundleParams
): Promise<MonadWalletPersistenceBundle> {
  const runtimeParams = params as unknown as {
    location: string
    seed?: { mnemonic: string; passphrase?: string }
    createSeedIfEmpty?: boolean
    mode?: 'create' | 'restore'
  }
  if (
    (runtimeParams.mode !== undefined &&
      runtimeParams.mode !== 'create' &&
      runtimeParams.mode !== 'restore') ||
    (runtimeParams.createSeedIfEmpty !== undefined &&
      runtimeParams.createSeedIfEmpty !== true &&
      runtimeParams.createSeedIfEmpty !== false) ||
    (runtimeParams.seed !== undefined &&
      (typeof runtimeParams.seed !== 'object' ||
        runtimeParams.seed === null ||
        typeof runtimeParams.seed.mnemonic !== 'string' ||
        runtimeParams.seed.mnemonic.length === 0 ||
        (runtimeParams.seed.passphrase !== undefined &&
          typeof runtimeParams.seed.passphrase !== 'string'))) ||
    (runtimeParams.seed !== undefined &&
      runtimeParams.createSeedIfEmpty === true) ||
    (runtimeParams.mode === 'restore' && runtimeParams.seed === undefined) ||
    (runtimeParams.mode === 'create' &&
      runtimeParams.seed === undefined &&
      runtimeParams.createSeedIfEmpty !== true) ||
    (runtimeParams.createSeedIfEmpty === true &&
      runtimeParams.mode === 'restore') ||
    (runtimeParams.seed === undefined &&
      runtimeParams.createSeedIfEmpty !== true)
  ) {
    throw new Error('Invalid Monad wallet creation/restore mode')
  }
  const explicitNodeCreation =
    !isBrowserWalletStorage() &&
    (runtimeParams.mode === 'create' ||
      runtimeParams.createSeedIfEmpty === true)
  if (
    explicitNodeCreation &&
    nodeWalletRootExists(params.location) &&
    !nodeWalletCreationRecoveryExists(params.location) &&
    nodeWalletRootIsPrivateEmpty(params.location)
  ) {
    throw new Error(
      'First-use wallet creation requires a missing Node root created by this exclusive acquisition or an exact durable creation claim'
    )
  }
  let nodeCreationPublished = false
  let nodeCreationClaim: NodeWalletCreationClaim | undefined
  if (
    !isBrowserWalletStorage() &&
    (!nodeWalletRootExists(params.location) ||
      nodeWalletCreationRecoveryExists(params.location))
  ) {
    const isExplicitCreate =
      runtimeParams.mode === 'create' ||
      runtimeParams.createSeedIfEmpty === true
    if (!isExplicitCreate) {
      throw new Error(
        'Cannot restore a Monad wallet from a missing Node root; restore the state backup or explicitly create a new wallet'
      )
    }
    const callerIntent = (): string => {
      if (runtimeParams.seed === undefined) {
        throw new Error('Caller seed is unavailable')
      }
      const creationSeed: PersistedSeed = {
        version: 1,
        mnemonic: runtimeParams.seed.mnemonic,
        passphrase: runtimeParams.seed.passphrase ?? '',
      }
      const creationSubKeyring = MonadHdKeyring.fromMnemonic(
        creationSeed.mnemonic,
        creationSeed.passphrase
      )
      const creationChangeKeyring = MonadChangeKeyring.fromMnemonic(
        creationSeed.mnemonic,
        creationSeed.passphrase
      )
      return JSON.stringify({
        version: 1,
        kind: 'caller-supplied',
        bindingId: newBindingId(),
        seedFingerprint: seedFingerprint(
          creationSubKeyring,
          creationChangeKeyring
        ),
      } satisfies WalletCreationIntent)
    }
    const generatedIntentSource = {
      create: (): string => {
        const creationSeed: PersistedSeed = {
          version: 1,
          mnemonic: MonadHdKeyring.generate().mnemonic,
          passphrase: '',
        }
        const creationSubKeyring = MonadHdKeyring.fromMnemonic(
          creationSeed.mnemonic,
          creationSeed.passphrase
        )
        const creationChangeKeyring = MonadChangeKeyring.fromMnemonic(
          creationSeed.mnemonic,
          creationSeed.passphrase
        )
        return JSON.stringify({
          version: 1,
          kind: 'generated',
          bindingId: newBindingId(),
          seedFingerprint: seedFingerprint(
            creationSubKeyring,
            creationChangeKeyring
          ),
          persistedSeed: creationSeed,
        } satisfies WalletCreationIntent)
      },
      validateRetained: (encoded: string): void => {
        authenticateGeneratedCreationIntent(encoded)
      },
    }
    nodeCreationClaim = await publishNodeWalletRootWithIntent(
      params.location,
      runtimeParams.seed === undefined ? generatedIntentSource : callerIntent(),
      params.onNodeCreationPublishPhase
    )
    nodeCreationPublished = true
  }
  const preparedRoot = prepareSecureWalletRootWithProvenance(
    params.location,
    false
  )
  const location = preparedRoot.location
  nodeCreationClaim?.assertRootIdentity()
  const nodeLease = await acquireNodeWalletRootLease(location, {
    expectedRootIdentity: nodeCreationClaim?.rootIdentity,
  })
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
    const namespaceNeverExisted = isBrowserWalletStorage()
      ? existing.size === 0
      : preparedRoot.nodeRootCreated
    let creationIntent = await readWalletCreationIntent(location)
    if (nodeCreationPublished) {
      await params.onMigrationPhase?.('creation-intent')
    }
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
      creationIntent === undefined &&
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
    if (finalized?.version === 1) {
      throw new Error(
        'Monad wallet manifest v1 cannot be opened safely; restore a current state backup, rescan into a new root, or create a new seed'
      )
    }
    const migration =
      migrationValue === undefined ? undefined : parseMigration(migrationValue)
    if (
      finalized === undefined &&
      migration === undefined &&
      hasManifestDatabase &&
      creationIntent === undefined
    ) {
      throw new Error('Refusing to replace an invalid wallet manifest')
    }

    const explicitCallerSeedCreation =
      params.seed !== undefined && params.mode === 'create'
    const generatedSeedCreation = params.createSeedIfEmpty === true
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
    } else if (creationIntent?.kind === 'generated') {
      seed = parseSeed(JSON.stringify(creationIntent.persistedSeed))
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
      finalized?.seedFingerprint ??
      migration?.seedFingerprint ??
      creationIntent?.seedFingerprint
    if (
      expectedFingerprint !== undefined &&
      fingerprint !== expectedFingerprint
    ) {
      throw new Error('Wallet seed does not match the durable wallet manifest')
    }

    if (creationIntent !== undefined) {
      if (
        finalized !== undefined &&
        (creationIntent.bindingId !== finalized.bindingId ||
          creationIntent.seedFingerprint !== finalized.seedFingerprint)
      ) {
        throw new Error(
          'Wallet creation intent does not match the finalized wallet manifest'
        )
      }
      const expectedKind = explicitCallerSeedCreation
        ? 'caller-supplied'
        : generatedSeedCreation
        ? 'generated'
        : undefined
      if (
        finalized === undefined &&
        (expectedKind === undefined || creationIntent.kind !== expectedKind)
      ) {
        throw new Error(
          'Wallet creation intent requires the exact original creation mode'
        )
      }
      if (
        migration !== undefined &&
        (creationIntent.bindingId !== migration.bindingId ||
          creationIntent.seedFingerprint !== migration.seedFingerprint ||
          migration.restoreMode !== undefined ||
          (creationIntent.kind === 'caller-supplied'
            ? migration.creationMode !== 'caller-supplied' ||
              migration.persistedSeed !== undefined
            : migration.creationMode !== undefined ||
              JSON.stringify(migration.persistedSeed) !==
                JSON.stringify(creationIntent.persistedSeed)))
      ) {
        throw new Error(
          'Wallet creation intent does not match the migration marker'
        )
      }
    }
    const bindingId =
      finalized?.bindingId ??
      migration?.bindingId ??
      creationIntent?.bindingId ??
      newBindingId()
    const isMigration = finalized === undefined
    if (
      finalized === undefined &&
      migration === undefined &&
      (explicitCallerSeedCreation || generatedSeedCreation) &&
      creationIntent === undefined
    ) {
      if (!namespaceNeverExisted) {
        throw new Error(
          'First-use creation requires a storage namespace created by this exclusive acquisition'
        )
      }
      if (hasLegacyComponents) {
        throw new Error(
          'First-use creation cannot adopt an existing component namespace'
        )
      }
      const intent: WalletCreationIntent = {
        version: 1,
        kind: explicitCallerSeedCreation ? 'caller-supplied' : 'generated',
        bindingId,
        seedFingerprint: fingerprint,
        ...(generatedSeedCreation ? { persistedSeed: seed } : {}),
      }
      await createWalletCreationIntent(location, intent)
      creationIntent = intent
      await params.onMigrationPhase?.('creation-intent')
    }
    const legacyResolutions =
      !hasManifestDatabase &&
      hasLegacyComponents &&
      creationIntent === undefined
        ? await validateLegacySnapshot({
            location,
            subKeyring,
            changeKeyring,
            resolveLegacyAttemptRecipientPublicKey:
              params.resolveLegacyAttemptRecipientPublicKey,
            resolveLegacyChangeRawTransaction:
              params.resolveLegacyChangeRawTransaction,
            resolveLegacyPaymentAuthority: params.resolveLegacyPaymentAuthority,
          })
        : {
            attempts: new Map<string, string>(),
            changes: new Map<number, ChangeAccountRecord>(),
            payments: new Map<string, StampPaymentRecoveryRecord>(),
            hasSemanticState: false,
            hasUnauthenticatedSenderHighWater: false,
            hasUnauthenticatedChangeHighWater: false,
          }
    if (
      legacyResolutions.hasUnauthenticatedSenderHighWater ||
      legacyResolutions.hasUnauthenticatedChangeHighWater
    ) {
      throw new Error(
        'Each unbound legacy high-water domain requires complete authenticated seed-bound recovery evidence'
      )
    }
    const semanticallyEmptyUnboundRoot =
      finalized === undefined &&
      migration === undefined &&
      (!hasLegacyComponents || !legacyResolutions.hasSemanticState)
    const isEmptySuppliedSeedRestore =
      migration?.restoreMode === true ||
      (semanticallyEmptyUnboundRoot &&
        params.seed !== undefined &&
        (!explicitCallerSeedCreation ||
          (!namespaceNeverExisted && creationIntent === undefined)))
    if (isEmptySuppliedSeedRestore) {
      throw new Error(
        'Restoring a supplied seed into an empty wallet root is disabled without a verifiable seed-bound allocation ledger; restore the wallet state backup or create a new seed'
      )
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
      allowUnresolvedLegacyFinalizedRows: isMigration,
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
            legacyResolutions.attempts.get(attempt.payloadHashHex) ??
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
        allowUnresolvedLegacyFinalizedRows: isMigration,
      })
    }
    const resolvedLegacyChanges: ChangeAccountRecord[] = []
    const validationChangeStore = new InMemoryChangePoolStore()
    validationChangeStore.setNextIndex(changePool.nextUnusedIndex())
    const pendingChange = changePool.pendingIntent()
    if (pendingChange !== undefined)
      validationChangeStore.setPendingIntent(pendingChange)
    for (const record of changePool.records()) {
      let resolved: ChangeAccountRecord | undefined = record
      if (record.rawTx === undefined) {
        resolved = legacyResolutions.changes.get(record.index)
        if (
          resolved === undefined &&
          isMigration &&
          params.resolveLegacyChangeRawTransaction !== undefined
        ) {
          const rawTx = await params.resolveLegacyChangeRawTransaction(record)
          resolved = {
            ...record,
            rawTx: typeof rawTx === 'string' ? rawTx : hexlify(rawTx),
          }
        }
      }
      if (resolved === undefined) {
        throw new Error(
          'Legacy finalized change rows require authoritative transaction evidence'
        )
      }
      if (resolved !== record) resolvedLegacyChanges.push(resolved)
      validationChangeStore.putRecord(resolved)
    }
    const validationChangePool = new MonadChangePool({
      keyring: changeKeyring,
      store: validationChangeStore,
    })
    const resolvedLegacyPayments: StampPaymentRecoveryRecord[] = []
    const validationPaymentJournal = new InMemoryStampPaymentJournal()
    for (const record of paymentJournal.getAll()) {
      const unresolved =
        record.rawTx === undefined ||
        record.recipientPublicKeyHex === undefined ||
        record.envelopeRecipientAddress === undefined
      let resolved: StampPaymentRecoveryRecord | undefined = record
      if (unresolved) {
        resolved = legacyResolutions.payments.get(
          `${record.payloadHashHex}:${record.childIndex}`
        )
        if (
          resolved === undefined &&
          isMigration &&
          params.resolveLegacyPaymentAuthority !== undefined
        ) {
          const authority = await params.resolveLegacyPaymentAuthority(record)
          resolved = {
            ...record,
            rawTx:
              typeof authority.rawTx === 'string'
                ? authority.rawTx
                : hexlify(authority.rawTx),
            recipientPublicKeyHex:
              typeof authority.recipientPublicKeyHex === 'string'
                ? authority.recipientPublicKeyHex
                : hexlify(authority.recipientPublicKeyHex),
            envelopeRecipientAddress: authority.envelopeRecipientAddress,
          }
        }
      }
      if (resolved === undefined) {
        throw new Error(
          'Legacy stamp-payment rows require authoritative retained-message evidence'
        )
      }
      if (resolved !== record) resolvedLegacyPayments.push(resolved)
      await validationPaymentJournal.put(resolved)
    }
    validateMonadWalletState({
      pool,
      changePool: validationChangePool,
      attemptJournal: validationAttemptJournal,
      paymentJournal: validationPaymentJournal,
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
        ...(explicitCallerSeedCreation
          ? { creationMode: 'caller-supplied' as const }
          : {}),
      }
      if (migration === undefined) {
        assertLeaseHeld()
        await manifestDb.put(MIGRATION_KEY, JSON.stringify(marker))
        await params.onMigrationPhase?.('marker')
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
          } else if (store === changeStore) {
            await changeStore.Bind(resolvedLegacyChanges)
          } else if (store === paymentJournal) {
            await paymentJournal.Bind(resolvedLegacyPayments)
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
    if (creationIntent !== undefined) {
      assertLeaseHeld()
      await clearWalletCreationIntent(location)
      creationIntent = undefined
    }
    if (nodeCreationClaim !== undefined) {
      assertLeaseHeld()
      await nodeCreationClaim.finalize()
      nodeCreationClaim = undefined
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
