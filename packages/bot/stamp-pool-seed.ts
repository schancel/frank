/**
 * The bots' stamp sub-account pool seed (#313). Every stamp payment is sent from a single-use
 * sub-account derived from an HD mnemonic and funded by the bot. That mnemonic used to be
 * regenerated on every start and held only in memory, so any value left on a sub-account or
 * change account was unrecoverable after a restart. It now lives in the bot's state directory:
 *
 *   <stateDir>/stamp-pool-seed.json        {"version":1,"mnemonic":"..."}   mode 0600
 *   <stateDir>/sub-account-pool, change-pool   the pool's own records (index/address/status, no keys)
 *
 * The seed is a wallet secret: it is never logged, never in the repo (state directories are not
 * checked in; keep it that way), and a file that cannot be read back is an error, not an
 * invitation to generate a new seed, because a new seed would strand whatever the old one holds.
 * Bots that predate this change have no seed file; one is created on first start (they never had
 * a persisted pool, so nothing is lost), and their identity and other state files are untouched.
 */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'fs'
import { join } from 'path'

import * as bip39 from 'bip39'

import { MonadChangeKeyring } from '@frank/wallet/monad-change-keyring'
import { MonadChangePool } from '@frank/wallet/monad-change-pool'
import { MonadHdKeyring } from '@frank/wallet/monad-hd-keyring'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { LevelChangePoolStore } from '@frank/wallet/storage/level-change-pool-store'
import { LevelSubAccountPoolStore } from '@frank/wallet/storage/level-sub-account-pool-store'

export const POOL_SEED_FILE = 'stamp-pool-seed.json'
const MAX_SEED_FILE_BYTES = 4096

function seedError(path: string, why: string): Error {
  return new Error(
    `Stamp pool seed file ${path} ${why}. Refusing to continue: generating a new seed would ` +
      'strand any funds the old one controls. Restore the file, or (only if you are sure the ' +
      'bot holds no funds on its sub-accounts) delete it to start a new pool.',
  )
}

function readSeed(path: string, label: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw seedError(path, 'is not a regular file')
  if (stat.size > MAX_SEED_FILE_BYTES) throw seedError(path, 'is unexpectedly large')
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(path, 0o600)
    console.warn(`[${label}] tightened permissions on ${path} to 0600`)
  }
  let mnemonic: unknown
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown
      mnemonic?: unknown
    }
    if (parsed.version !== 1) throw new Error('unsupported version')
    mnemonic = parsed.mnemonic
  } catch {
    throw seedError(path, 'is not valid seed JSON')
  }
  if (typeof mnemonic !== 'string' || !bip39.validateMnemonic(mnemonic)) {
    throw seedError(path, 'does not hold a valid mnemonic')
  }
  return mnemonic
}

/** Returns the persisted pool mnemonic for `stateDir`, creating (and durably writing) one on first
 * use. Concurrent first starts converge on one file: the loser of the race reads the winner's. */
export function loadOrCreatePoolMnemonic(
  stateDir: string,
  label: string,
): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, POOL_SEED_FILE)
  try {
    return readSeed(path, label)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const { mnemonic } = MonadHdKeyring.generate()
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, JSON.stringify({ version: 1, mnemonic }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    linkSync(tmp, path) // exclusive: fails if another start created it first
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return readSeed(path, label)
    }
    throw err
  } finally {
    unlinkSync(tmp)
  }
  console.log(
    `[${label}] created a new stamp pool seed at ${path} (keep it private; never commit it)`,
  )
  return mnemonic
}

export interface StampPool {
  pool: MonadSubAccountPool
  changePool: MonadChangePool
  /** Flushes and closes the pool's on-disk records. Idempotent. */
  close(): Promise<void>
}

/** Opens the pool for `stateDir`: the same seed and the same records on every start. */
export async function openPersistentStampPool(
  stateDir: string,
  label: string,
): Promise<StampPool> {
  const mnemonic = loadOrCreatePoolMnemonic(stateDir, label)
  const poolStore = new LevelSubAccountPoolStore(stateDir)
  const changeStore = new LevelChangePoolStore(stateDir)
  await poolStore.Open()
  try {
    await changeStore.Open()
  } catch (err) {
    await poolStore.Close()
    throw err
  }
  let closing: Promise<void> | undefined
  return {
    pool: new MonadSubAccountPool({
      keyring: MonadHdKeyring.fromMnemonic(mnemonic),
      store: poolStore,
    }),
    changePool: new MonadChangePool({
      keyring: MonadChangeKeyring.fromMnemonic(mnemonic),
      store: changeStore,
    }),
    close: () =>
      (closing ??= (async () => {
        await poolStore.Close()
        await changeStore.Close()
      })()),
  }
}
