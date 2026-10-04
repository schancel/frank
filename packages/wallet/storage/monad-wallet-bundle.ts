/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join, resolve } from 'path'
import { hexlify, keccak256, randomBytes, toUtf8Bytes } from 'ethers'

import { MonadSubAccountPool } from '../monad-account-pool'
import { SubAccountLeaseManager } from '../monad-account-lease'
import { MonadChangePool } from '../monad-change-pool'
import { MonadChangeKeyring } from '../monad-change-keyring'
import { MonadHdKeyring } from '../monad-hd-keyring'
import {
  InMemoryChangePoolStore,
  type ChangeAccountRecord,
} from './change-pool-storage'
import { LevelChangePoolStore } from './level-change-pool-store'
import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import {
  InMemorySubAccountPoolStore,
  type SubAccountRecord,
} from './sub-account-pool-storage'
import { validateMonadWalletState } from './monad-wallet-state-validator'
import { durableBatch, openDurableLevel } from './level-durability'
import {
  InMemoryTopicOperationJournal,
  LevelTopicOperationJournal,
  TOPIC_OPERATION_KEY_PREFIX,
  type TopicOperationJournal,
} from './topic-operation-journal'

const MANIFEST_KEY = 'manifest'
const SEED_KEY = 'seed'
const MANIFEST_SCHEMA = 'frank-monad-wallet-state'
const MANIFEST_VERSION = 1
const CURRENT_MANIFEST_INTENTS = [
  'sub-account-pool-v2',
  'change-pool-v2',
] as const
const ACCEPTED_MANIFEST_INTENTS: Record<number, readonly string[]> = {
  1: ['sub-account-pool-v2', 'change-pool-v2'],
  2: [
    'sub-account-pool-v2',
    'change-pool-v3-authoritative-tx',
    'stamp-attempt-journal-v1',
    'stamp-payment-journal-v2-authoritative-tx',
  ],
}

interface MonadWalletManifest {
  schema: typeof MANIFEST_SCHEMA
  version: number
  bindingId: string
  seedFingerprint: string
  intents: readonly string[]
}

interface PersistedSeed {
  version: 1
  mnemonic: string
  passphrase: string
}

export class MonadWalletOrphanedAccountError extends Error {
  readonly indices: number[]

  constructor(indices: number[]) {
    super(
      `Wallet has ${
        indices.length
      } in-use funding account(s) without a local exact-set attempt: ${indices.join(
        ', ',
      )}`,
    )
    this.indices = indices
  }
}

/** Opaque proof that a complete high-level operation was admitted before close began. */
export interface MonadWalletOperationAdmission {
  readonly walletBindingId: string
}

export interface MonadWalletPersistenceBundle {
  readonly durability: 'persistent' | 'test-only-ephemeral'
  readonly bindingId: string
  readonly pool: MonadSubAccountPool
  readonly leaseManager: SubAccountLeaseManager
  readonly changePool: MonadChangePool
  readonly topicOperationJournal: TopicOperationJournal
  assertOpen(): void
  /** Admits one complete stateful wallet operation. Close stops admission immediately and waits
   * for every admitted operation before closing stores or releasing root ownership. */
  runOperation<T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    admission?: MonadWalletOperationAdmission,
  ): Promise<T>
  assertSemanticallyValid(): void
  assertNoOrphanedLeases(): void
  compactTerminalAccounts(
    limit: number,
    admission?: MonadWalletOperationAdmission,
  ): Promise<number>
  close(): Promise<void>
}

const trustedPersistentBundles = new WeakSet<object>()
const poolOwners = new WeakMap<MonadSubAccountPool, object>()
const manifestOwners = new Map<string, object>()

function claimManifest(location: string): { token: object; release(): void } {
  const key = resolve(location, 'wallet-manifest')
  if (manifestOwners.has(key))
    throw new Error('Monad wallet manifest already has an owner')
  const token = {}
  manifestOwners.set(key, token)
  return {
    token,
    release() {
      if (manifestOwners.get(key) === token) manifestOwners.delete(key)
    },
  }
}

export function assertMonadWalletBundleProvenance(
  bundle: MonadWalletPersistenceBundle,
): void {
  if (!trustedPersistentBundles.has(bundle as object)) {
    throw new Error(
      'Monad wallet bundle was not produced by the persistent bundle factory',
    )
  }
}

function seedFingerprint(
  subKeyring: MonadHdKeyring,
  changeKeyring: MonadChangeKeyring,
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
  const decoded: unknown = JSON.parse(value)
  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Unsupported or corrupt Monad wallet manifest')
  }
  const parsed = decoded as Partial<MonadWalletManifest>
  const expectedIntents = ACCEPTED_MANIFEST_INTENTS[parsed.version as number]
  if (
    Object.keys(parsed).some(
      key =>
        ![
          'schema',
          'version',
          'bindingId',
          'seedFingerprint',
          'intents',
        ].includes(key),
    ) ||
    parsed.schema !== MANIFEST_SCHEMA ||
    typeof parsed.version !== 'number' ||
    expectedIntents === undefined ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId) ||
    typeof parsed.seedFingerprint !== 'string' ||
    !/^0x[0-9a-f]{64}$/i.test(parsed.seedFingerprint) ||
    !Array.isArray(parsed.intents) ||
    parsed.intents.length !== expectedIntents.length ||
    parsed.intents.some(
      (intent, index) =>
        typeof intent !== 'string' || intent !== expectedIntents[index],
    )
  ) {
    throw new Error('Unsupported or corrupt Monad wallet manifest')
  }
  return parsed as MonadWalletManifest
}

function makeBundle(params: {
  durability: 'persistent' | 'test-only-ephemeral'
  bindingId: string
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  topicJournal: TopicOperationJournal
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  close: () => Promise<void>
  leaseManager?: SubAccountLeaseManager
  additionalLeaseReference?: (index: number) => boolean
  attachSharedPoolGates?: boolean
  assertEnclosingAdmission?: () => void
  ownerToken?: object
}): MonadWalletPersistenceBundle {
  const ownerToken = params.ownerToken ?? {}
  const existingOwner = poolOwners.get(params.pool)
  if (existingOwner !== undefined && existingOwner !== params.ownerToken) {
    throw new Error('Monad wallet pool already has an owner')
  }
  poolOwners.set(params.pool, ownerToken)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let activeOperations = 0
  let resolveDrained: (() => void) | undefined
  const activeAdmissions = new Set<MonadWalletOperationAdmission>()
  let operationTail: Promise<unknown> = Promise.resolve()

  const runOperation = async <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    admission?: MonadWalletOperationAdmission,
  ): Promise<T> => {
    params.assertEnclosingAdmission?.()
    if (admission !== undefined) {
      if (!activeAdmissions.has(admission)) {
        throw new Error(
          'Monad wallet operation admission does not belong to this wallet session',
        )
      }
      return operation(admission)
    }
    if (lifecycle !== 'open') {
      throw new Error('Monad wallet bundle is closing or closed')
    }
    const admitted = Object.freeze({
      walletBindingId: params.bindingId,
    }) satisfies MonadWalletOperationAdmission
    activeAdmissions.add(admitted)
    activeOperations++
    const run = operationTail.then(() => {
      params.assertEnclosingAdmission?.()
      return operation(admitted)
    })
    operationTail = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await run
    } finally {
      activeAdmissions.delete(admitted)
      activeOperations--
      if (activeOperations === 0) resolveDrained?.()
    }
  }

  if (params.attachSharedPoolGates !== false) {
    params.pool.attachWalletOperationGate(runOperation)
    params.changePool.attachWalletOperationGate(runOperation)
  }
  const leaseManager =
    params.leaseManager ?? new SubAccountLeaseManager(params.pool)

  const assertNoOrphanedLeases = (): void => {
    const referenced = new Set(
      params.topicJournal.getAll().map(operation => operation.leaseIndex),
    )
    const orphaned = params.pool
      .records()
      .filter(
        record =>
          record.status === 'in-use' &&
          !referenced.has(record.index) &&
          !params.additionalLeaseReference?.(record.index),
      )
      .map(record => record.index)
    if (orphaned.length > 0) throw new MonadWalletOrphanedAccountError(orphaned)
  }

  let closePromise: Promise<void> | undefined
  let bundle!: MonadWalletPersistenceBundle

  bundle = Object.freeze({
    durability: params.durability,
    bindingId: params.bindingId,
    pool: params.pool,
    leaseManager,
    changePool: params.changePool,
    topicOperationJournal: params.topicJournal,
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
        subKeyring: params.subKeyring,
        changeKeyring: params.changeKeyring,
      }),
    assertNoOrphanedLeases,
    async compactTerminalAccounts(
      limit: number,
      admission?: MonadWalletOperationAdmission,
    ): Promise<number> {
      return runOperation(async () => {
        const pendingChange = params.changePool.pendingSourceBurnIndex()
        return params.pool.compactTerminalAccounts({
          limit,
          isReferenced: index =>
            index === pendingChange ||
            params.topicJournal.referencesLeaseIndex(index) ||
            (params.additionalLeaseReference?.(index) ?? false),
        })
      }, admission)
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      lifecycle = 'closing'
      trustedPersistentBundles.delete(bundle as object)
      closePromise = (async () => {
        if (activeOperations > 0) {
          await new Promise<void>(resolve => {
            resolveDrained = resolve
          })
        }
        await params.close()
        lifecycle = 'closed'
        if (poolOwners.get(params.pool) === ownerToken)
          poolOwners.delete(params.pool)
      })()
      return closePromise
    },
  })

  if (params.durability === 'persistent') {
    trustedPersistentBundles.add(bundle as object)
  }
  return bundle
}

/** Owns the existing topic namespace and only topic admission. The caller must enclose every
 * operation in its wallet queue; neither this owner nor its journal is exposed to DM clients. */
export async function openExistingPoolMonadTopicOwner(params: {
  location?: string
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  leaseManager: SubAccountLeaseManager
  subKeyring: MonadHdKeyring
  changeKeyring: MonadChangeKeyring
  stampReferencesLeaseIndex: (index: number) => boolean
  assertEnclosingAdmission: () => void
}): Promise<MonadWalletPersistenceBundle> {
  if (poolOwners.has(params.pool))
    throw new Error('Monad wallet pool already has an owner')
  const ownerToken = {}
  poolOwners.set(params.pool, ownerToken)
  let database: LevelDB | undefined
  let manifestClaim: ReturnType<typeof claimManifest> | undefined
  let journalOpen = true
  try {
    let topicJournal: TopicOperationJournal
    const assertJournalMutation = () => {
      if (!journalOpen) throw new Error('Monad topic journal is closed')
      params.assertEnclosingAdmission()
    }
    if (params.location === undefined) {
      const memory = new InMemoryTopicOperationJournal()
      topicJournal = {
        put: async operation => {
          assertJournalMutation()
          await memory.put(operation)
        },
        delete: async operation => {
          assertJournalMutation()
          await memory.delete(operation)
        },
        getAll: () => memory.getAll(),
        referencesLeaseIndex: index => memory.referencesLeaseIndex(index),
      }
    } else {
      manifestClaim = claimManifest(params.location)
      try {
        const fs = require('fs') as typeof import('fs')
        fs.mkdirSync(params.location, { recursive: true })
      } catch {
        /* browser runtimes have no filesystem */
      }
      database = level(join(params.location, 'wallet-manifest'))
      await openDurableLevel(database, params.location, 'wallet-manifest')
      topicJournal = new LevelTopicOperationJournal(
        database,
        assertJournalMutation,
      )
      await (topicJournal as LevelTopicOperationJournal).Open()
    }
    return makeBundle({
      durability:
        params.location === undefined ? 'test-only-ephemeral' : 'persistent',
      // This identifier is session-local: existing manifest/root/binding bytes are never rewritten.
      bindingId: newBindingId(),
      pool: params.pool,
      changePool: params.changePool,
      leaseManager: params.leaseManager,
      topicJournal,
      subKeyring: params.subKeyring,
      changeKeyring: params.changeKeyring,
      additionalLeaseReference: params.stampReferencesLeaseIndex,
      attachSharedPoolGates: false,
      assertEnclosingAdmission: params.assertEnclosingAdmission,
      ownerToken,
      close: async () => {
        await database?.close()
        journalOpen = false
        manifestClaim?.release()
      },
    })
  } catch (error) {
    // Never close another owner's handles. These were all created by this invocation.
    try {
      await database?.close()
      manifestClaim?.release()
      if (poolOwners.get(params.pool) === ownerToken)
        poolOwners.delete(params.pool)
    } catch {
      // Uncertain close retains ownership and prevents a second opener.
    }
    throw error
  }
}

export function createInMemoryMonadWalletBundle(params: {
  mnemonic: string
  passphrase?: string
}): MonadWalletPersistenceBundle {
  const subKeyring = MonadHdKeyring.fromMnemonic(
    params.mnemonic,
    params.passphrase,
  )
  const changeKeyring = MonadChangeKeyring.fromMnemonic(
    params.mnemonic,
    params.passphrase,
  )
  const pool = new MonadSubAccountPool({
    keyring: subKeyring,
    store: new InMemorySubAccountPoolStore(),
    requireStampReconciliationPreflight: true,
  })
  const changePool = new MonadChangePool({
    keyring: changeKeyring,
    store: new InMemoryChangePoolStore(),
  })
  return makeBundle({
    durability: 'test-only-ephemeral',
    bindingId: newBindingId(),
    pool,
    changePool,
    topicJournal: new InMemoryTopicOperationJournal(),
    subKeyring,
    changeKeyring,
    close: async () => {},
  })
}

export interface OpenMonadWalletBundleParams {
  location: string
  seed?: { mnemonic: string; passphrase?: string }
  createSeedIfEmpty?: boolean
  mode?: 'create' | 'restore'
  onMigrationPhase?: (phase: string) => void | Promise<void>
}

export async function openMonadWalletBundle(
  params: OpenMonadWalletBundleParams,
): Promise<MonadWalletPersistenceBundle> {
  if (
    (params.mode !== undefined &&
      params.mode !== 'create' &&
      params.mode !== 'restore') ||
    (params.createSeedIfEmpty !== undefined &&
      params.createSeedIfEmpty !== true &&
      params.createSeedIfEmpty !== false) ||
    (params.seed !== undefined &&
      (typeof params.seed !== 'object' ||
        params.seed === null ||
        typeof params.seed.mnemonic !== 'string' ||
        params.seed.mnemonic.length === 0 ||
        (params.seed.passphrase !== undefined &&
          typeof params.seed.passphrase !== 'string'))) ||
    (params.seed !== undefined && params.createSeedIfEmpty === true) ||
    (params.mode === 'restore' && params.seed === undefined) ||
    (params.mode === 'create' &&
      params.seed === undefined &&
      params.createSeedIfEmpty !== true) ||
    (params.createSeedIfEmpty === true && params.mode === 'restore')
  ) {
    throw new Error('Invalid Monad wallet creation/restore mode')
  }

  const manifestClaim = claimManifest(params.location)

  // Ensure location directory exists on Node
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    fs.mkdirSync(params.location, { recursive: true })
  } catch {
    // ignore in browser or if fs is unavailable
  }

  const manifestDbLocation = join(params.location, 'wallet-manifest')
  let manifestDb: LevelDB | undefined
  try {
    manifestDb = level(manifestDbLocation)
    await openDurableLevel(manifestDb, params.location, 'wallet-manifest')
  } catch (error) {
    try {
      await manifestDb?.close()
      manifestClaim.release()
    } catch {
      /* uncertain close keeps the claim */
    }
    throw error
  }
  if (manifestDb === undefined)
    throw new Error('Monad wallet manifest did not open')
  const ownedManifestDb = manifestDb

  const openedStores: Array<{ Close(): Promise<void> }> = []
  let ownedBundle: MonadWalletPersistenceBundle | undefined
  try {
    const entries = new Map<string, string>()
    for await (const [key, value] of manifestDb.iterator({}) as any) {
      if (
        ![MANIFEST_KEY, SEED_KEY].includes(key) &&
        !key.startsWith(TOPIC_OPERATION_KEY_PREFIX)
      ) {
        throw new Error(`Invalid wallet manifest key ${key}`)
      }
      entries.set(key, value)
    }

    const manifestValue = entries.get(MANIFEST_KEY)
    let bindingId: string
    let subKeyring: MonadHdKeyring
    let changeKeyring: MonadChangeKeyring

    if (manifestValue !== undefined) {
      const manifest = parseManifest(manifestValue)
      bindingId = manifest.bindingId

      let resolvedSeed: { mnemonic: string; passphrase?: string }
      if (params.seed !== undefined) {
        resolvedSeed = params.seed
      } else {
        const storedSeedValue = entries.get(SEED_KEY)
        if (storedSeedValue === undefined) {
          throw new Error('Monad wallet seed is required to open this wallet')
        }
        const parsedSeed = JSON.parse(storedSeedValue) as PersistedSeed
        resolvedSeed = {
          mnemonic: parsedSeed.mnemonic,
          passphrase: parsedSeed.passphrase,
        }
      }

      subKeyring = MonadHdKeyring.fromMnemonic(
        resolvedSeed.mnemonic,
        resolvedSeed.passphrase,
      )
      changeKeyring = MonadChangeKeyring.fromMnemonic(
        resolvedSeed.mnemonic,
        resolvedSeed.passphrase,
      )
      const fingerprint = seedFingerprint(subKeyring, changeKeyring)
      if (fingerprint !== manifest.seedFingerprint) {
        throw new Error(
          'Monad wallet seed does not match the existing manifest fingerprint',
        )
      }
    } else {
      bindingId = newBindingId()
      let seedToUse: { mnemonic: string; passphrase?: string }
      if (params.seed !== undefined) {
        seedToUse = params.seed
      } else {
        const generated = MonadHdKeyring.generate()
        seedToUse = { mnemonic: generated.mnemonic, passphrase: '' }
      }

      subKeyring = MonadHdKeyring.fromMnemonic(
        seedToUse.mnemonic,
        seedToUse.passphrase,
      )
      changeKeyring = MonadChangeKeyring.fromMnemonic(
        seedToUse.mnemonic,
        seedToUse.passphrase,
      )
      const fingerprint = seedFingerprint(subKeyring, changeKeyring)

      const manifest: MonadWalletManifest = {
        schema: MANIFEST_SCHEMA,
        version: MANIFEST_VERSION,
        bindingId,
        seedFingerprint: fingerprint,
        intents: CURRENT_MANIFEST_INTENTS,
      }

      const writes: Array<{ type: 'put'; key: string; value: string }> = [
        { type: 'put', key: MANIFEST_KEY, value: JSON.stringify(manifest) },
      ]
      if (params.createSeedIfEmpty) {
        const persistedSeed: PersistedSeed = {
          version: 1,
          mnemonic: seedToUse.mnemonic,
          passphrase: seedToUse.passphrase ?? '',
        }
        writes.push({
          type: 'put',
          key: SEED_KEY,
          value: JSON.stringify(persistedSeed),
        })
      }

      await durableBatch(manifestDb, writes)
      await params.onMigrationPhase?.('manifest')
    }

    const isMigration = manifestValue === undefined
    const subAccountStore = new LevelSubAccountPoolStore(
      params.location,
      bindingId,
      isMigration,
    )
    openedStores.push(subAccountStore)
    await subAccountStore.Open()
    if (subAccountStore.bindingId() === undefined) {
      await subAccountStore.Bind()
    }

    const changePoolStore = new LevelChangePoolStore(
      params.location,
      bindingId,
      isMigration,
    )
    openedStores.push(changePoolStore)
    await changePoolStore.Open()
    if (changePoolStore.bindingId() === undefined) {
      await changePoolStore.Bind()
    }

    const pool = new MonadSubAccountPool({
      keyring: subKeyring,
      store: subAccountStore,
      requireStampReconciliationPreflight: true,
    })
    const changePool = new MonadChangePool({
      keyring: changeKeyring,
      store: changePoolStore,
    })

    const topicJournal = new LevelTopicOperationJournal(
      manifestDb,
      () => undefined,
    )
    await topicJournal.Open()

    const bundle = makeBundle({
      durability: 'persistent',
      bindingId,
      pool,
      changePool,
      topicJournal,
      subKeyring,
      changeKeyring,
      close: async () => {
        await changePoolStore.Close()
        await subAccountStore.Close()
        await ownedManifestDb.close()
        manifestClaim.release()
      },
    })

    ownedBundle = bundle
    bundle.assertSemanticallyValid()
    return bundle
  } catch (error) {
    if (ownedBundle !== undefined) {
      try {
        await ownedBundle.close()
      } catch {
        /* preserve the original validation error */
      }
      throw error
    }
    for (const store of openedStores.reverse()) {
      try {
        await store.Close()
      } catch {
        // preserve original error
      }
    }
    try {
      await ownedManifestDb.close()
      manifestClaim.release()
    } catch {
      // preserve original error
    }
    throw error
  }
}
