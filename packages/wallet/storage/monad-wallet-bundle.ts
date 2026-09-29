/* eslint-disable @typescript-eslint/no-explicit-any */
import level, { type LevelDB } from 'level'
import { join } from 'path'
import {
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
import { InMemorySubAccountPoolStore } from './sub-account-pool-storage'

const MANIFEST_KEY = 'manifest'
const SEED_KEY = 'seed'
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
    'stamp-payment-journal-v1',
  ]
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

export interface MonadWalletPersistenceBundle {
  readonly bindingId: string
  readonly pool: MonadSubAccountPool
  readonly leaseManager: SubAccountLeaseManager
  readonly changePool: MonadChangePool
  readonly stampAttemptJournal: StampAttemptJournal
  readonly stampPaymentJournal: StampPaymentJournal
  assertNoOrphanedLeases(): void
  compactTerminalAccounts(limit: number): Promise<number>
  close(): Promise<void>
}

export type OpenMonadWalletBundleParams =
  | {
      location: string
      seed: { mnemonic: string; passphrase?: string }
      createSeedIfEmpty?: false
    }
  | {
      location: string
      seed?: undefined
      createSeedIfEmpty: true
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

async function databaseHasEntries(location: string): Promise<boolean> {
  const db = level(location)
  try {
    for await (const _entry of db.iterator({ limit: 1 }) as any) {
      return true
    }
    return false
  } finally {
    await db.close()
  }
}

async function rootHasWalletData(location: string): Promise<boolean> {
  const children = [
    'sub-account-pool',
    'change-pool',
    'outgoing-stamp-attempts',
    'stamp-payment-journal',
  ]
  for (const child of children) {
    if (await databaseHasEntries(join(location, child))) return true
  }
  return false
}

function parseManifest(value: string): MonadWalletManifest {
  const parsed = JSON.parse(value) as Partial<MonadWalletManifest>
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
    parsed.version !== MANIFEST_VERSION ||
    typeof parsed.bindingId !== 'string' ||
    typeof parsed.seedFingerprint !== 'string' ||
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
      key => !['version', 'mnemonic', 'passphrase'].includes(key),
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
  label: string,
): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
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
      `${label} ${transactionName} transaction`,
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
}): void {
  let highestSubAccountIndex = -1
  for (const record of params.pool.records()) {
    assertOnlyKeys(
      record,
      ['index', 'address', 'status', 'fundingAttempt', 'lifecycle'],
      'stored sub-account record',
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
        `Stored sub-account ${record.index} does not belong to this seed`,
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
        `sub-account ${record.index} funding attempt`,
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
      'terminal sub-account checkpoint',
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
        `Invalid terminal checkpoint for sub-account ${checkpoint.index}`,
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
      'stored change record',
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
      ['payloadHashHex', 'messageBytes', 'leaseIndices'],
      'stamp-attempt journal record',
    )
    assertHex(attempt.payloadHashHex, 32, 'stamp-attempt payload hash')
    if (
      !Array.isArray(attempt.messageBytes) ||
      attempt.messageBytes.some(
        value => !Number.isInteger(value) || value < 0 || value > 255,
      ) ||
      !Array.isArray(attempt.leaseIndices) ||
      new Set(attempt.leaseIndices).size !== attempt.leaseIndices.length ||
      attempt.leaseIndices.some(
        index => !Number.isSafeInteger(index) || index < 0,
      )
    ) {
      throw new Error('Invalid stamp-attempt journal record')
    }
    for (const index of attempt.leaseIndices) {
      if (params.pool.getRecord(index) === undefined) {
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
      'stamp-payment recovery record',
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
  bindingId: string
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  attemptJournal: StampAttemptJournal
  paymentJournal: StampPaymentJournal
  close: () => Promise<void>
}): MonadWalletPersistenceBundle {
  const leaseManager = new SubAccountLeaseManager(params.pool)
  const assertNoOrphanedLeases = (): void => {
    const referenced = new Set(
      params.attemptJournal.getAll().flatMap(attempt => attempt.leaseIndices),
    )
    const orphaned = params.pool
      .records()
      .filter(
        record => record.status === 'in-use' && !referenced.has(record.index),
      )
      .map(record => record.index)
    if (orphaned.length > 0) throw new MonadWalletOrphanedAccountError(orphaned)
  }
  return {
    bindingId: params.bindingId,
    pool: params.pool,
    leaseManager,
    changePool: params.changePool,
    stampAttemptJournal: params.attemptJournal,
    stampPaymentJournal: params.paymentJournal,
    assertNoOrphanedLeases,
    async compactTerminalAccounts(limit: number): Promise<number> {
      const references = new Set(
        params.attemptJournal.getAll().flatMap(attempt => attempt.leaseIndices),
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
  return makeBundle({
    bindingId: newBindingId(),
    pool,
    changePool: new MonadChangePool({
      keyring: changeKeyring,
      store: new InMemoryChangePoolStore(),
    }),
    attemptJournal: new InMemoryStampAttemptJournal(),
    paymentJournal: new InMemoryStampPaymentJournal(),
    close: async () => undefined,
  })
}

export async function openMonadWalletBundle(
  params: OpenMonadWalletBundleParams,
): Promise<MonadWalletPersistenceBundle> {
  const manifestDb: LevelDB = level(join(params.location, 'wallet-manifest'))
  let seed: PersistedSeed
  let manifest: MonadWalletManifest
  try {
    const manifestValue = await manifestDb
      .get(MANIFEST_KEY)
      .catch((error: { notFound?: boolean }) => {
        if (error.notFound) return undefined
        throw error
      })
    if (manifestValue === undefined) {
      let manifestHasEntries = false
      for await (const _entry of manifestDb.iterator({ limit: 1 }) as any) {
        manifestHasEntries = true
      }
      if (manifestHasEntries) {
        throw new Error('Refusing to replace an invalid wallet manifest')
      }
      if (await rootHasWalletData(params.location)) {
        throw new Error(
          'Refusing to create a wallet manifest over a non-empty untrusted root',
        )
      }
      if (params.seed === undefined && !params.createSeedIfEmpty) {
        throw new Error('A seed is required for an empty wallet root')
      }
      const supplied = params.seed
      const generated =
        supplied === undefined ? MonadHdKeyring.generate().mnemonic : undefined
      seed = {
        version: 1,
        mnemonic: supplied?.mnemonic ?? (generated as string),
        passphrase: supplied?.passphrase ?? '',
      }
      const subKeyring = MonadHdKeyring.fromMnemonic(
        seed.mnemonic,
        seed.passphrase,
      )
      const changeKeyring = MonadChangeKeyring.fromMnemonic(
        seed.mnemonic,
        seed.passphrase,
      )
      manifest = {
        schema: MANIFEST_SCHEMA,
        version: MANIFEST_VERSION,
        bindingId: newBindingId(),
        seedFingerprint: seedFingerprint(subKeyring, changeKeyring),
        intents: [
          'sub-account-pool-v2',
          'change-pool-v2',
          'stamp-attempt-journal-v1',
          'stamp-payment-journal-v1',
        ],
      }
      const writes: Array<{ type: 'put'; key: string; value: string }> = [
        { type: 'put', key: MANIFEST_KEY, value: JSON.stringify(manifest) },
      ]
      if (params.createSeedIfEmpty) {
        writes.push({
          type: 'put',
          key: SEED_KEY,
          value: JSON.stringify(seed),
        })
      }
      await (manifestDb as any).batch(writes)
    } else {
      manifest = parseManifest(manifestValue)
      if (params.seed !== undefined) {
        seed = {
          version: 1,
          mnemonic: params.seed.mnemonic,
          passphrase: params.seed.passphrase ?? '',
        }
      } else {
        const storedSeed = await manifestDb
          .get(SEED_KEY)
          .catch((error: { notFound?: boolean }) => {
            if (error.notFound) {
              throw new Error('Wallet root has no persisted seed')
            }
            throw error
          })
        seed = parseSeed(storedSeed)
      }
    }
  } finally {
    await manifestDb.close()
  }

  const subKeyring = MonadHdKeyring.fromMnemonic(seed.mnemonic, seed.passphrase)
  const changeKeyring = MonadChangeKeyring.fromMnemonic(
    seed.mnemonic,
    seed.passphrase,
  )
  if (seedFingerprint(subKeyring, changeKeyring) !== manifest.seedFingerprint) {
    throw new Error('Wallet seed does not match the durable wallet manifest')
  }

  const subStore = new LevelSubAccountPoolStore(
    params.location,
    manifest.bindingId,
  )
  const changeStore = new LevelChangePoolStore(
    params.location,
    manifest.bindingId,
  )
  const attemptJournal = new LevelStampAttemptJournal(
    params.location,
    manifest.bindingId,
  )
  const paymentJournal = new LevelStampPaymentJournal(
    params.location,
    manifest.bindingId,
  )
  const stores = [subStore, changeStore, attemptJournal, paymentJournal]
  let opened = 0
  try {
    for (const store of stores) {
      try {
        await store.Open()
        opened++
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
    })
    await Promise.all(stores.map(store => store.Bind()))
    return makeBundle({
      bindingId: manifest.bindingId,
      pool,
      changePool,
      attemptJournal,
      paymentJournal,
      close: async () => {
        for (const store of stores.slice().reverse()) await store.Close()
      },
    })
  } catch (error) {
    for (const store of stores.slice(0, opened).reverse()) {
      await store.Close().catch(() => undefined)
    }
    throw error
  }
}
