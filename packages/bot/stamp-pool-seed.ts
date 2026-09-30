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
 * The state directory must belong to the bot's user and not be writable by group/others, and so
 * must the seed file: on a shared machine another user could otherwise pre-create the directory
 * and plant a mnemonic they know, and the bot would fund accounts they control. A `stamp-pool-meta.json`
 * marker (no secret) records that pool records were created; a surviving seed whose records
 * directory has vanished is refused, because restarting at index 0 would reuse spent accounts.
 * Bots that predate this change have no seed file; one is created on first start (they never had
 * a persisted pool, so nothing is lost), and their identity and other state files are untouched.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  Stats,
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
export const POOL_META_FILE = 'stamp-pool-meta.json'
const SUB_ACCOUNT_RECORDS_DIR = 'sub-account-pool'
const MAX_SEED_FILE_BYTES = 4096

function seedError(path: string, why: string): Error {
  return new Error(
    `Stamp pool seed file ${path} ${why}. Refusing to continue: generating a new seed would ` +
      'strand any funds the old one controls. Restore the file, or (only if you are sure the ' +
      'bot holds no funds on its sub-accounts) delete it to start a new pool.',
  )
}

/** Refuses anything not owned by this user (when the platform has uids) or writable by group or
 * others. Pure over a `Stats`-like value so it is unit-tested with a fake owner. */
export function assertOwnedAndPrivate(
  stat: Pick<Stats, 'uid' | 'mode'>,
  uid: number | undefined,
  path: string,
  what: 'file' | 'directory',
): void {
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(
      `Stamp pool ${what} ${path} is owned by another user (uid ${stat.uid}, not ${uid}). ` +
        'Refusing to continue: it could hold a seed someone else knows. Use a directory you own.',
    )
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error(
      `Stamp pool ${what} ${path} is writable by group or others (mode ${(stat.mode & 0o777).toString(8)}). ` +
        `Refusing to continue: run chmod go-w on it, or use a private directory.`,
    )
  }
}

const currentUid = (): number | undefined =>
  typeof process.getuid === 'function' ? process.getuid() : undefined

/** Makes `dir` exist as a private directory owned by this user. A directory that already exists
 * must already be ours and not group/world-writable; one we create is tightened to 0700 (mkdir's
 * mode is subject to the umask). Returns whether it already existed. */
function ensurePrivateDir(dir: string): boolean {
  let existed = true
  try {
    const stat = lstatSync(dir)
    if (!stat.isDirectory()) {
      throw new Error(`Stamp pool state path ${dir} is not a directory (symlinks are refused)`)
    }
    assertOwnedAndPrivate(stat, currentUid(), dir, 'directory')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    existed = false
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    assertOwnedAndPrivate(lstatSync(dir), currentUid(), dir, 'directory')
  }
  return existed
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Removes leftovers of an interrupted seed write (they hold the mnemonic). */
function removeOrphanTemps(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(`${POOL_SEED_FILE}.`) && name.endsWith('.tmp')) {
      const path = join(dir, name)
      if (lstatSync(path).isFile()) unlinkSync(path)
    }
  }
}

function readSeed(path: string, label: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw seedError(path, 'is not a regular file')
  assertOwnedAndPrivate(stat, currentUid(), path, 'file')
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
  ensurePrivateDir(stateDir)
  removeOrphanTemps(stateDir)
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
    fsyncDir(stateDir) // make the new directory entry durable too
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

interface PoolMeta {
  version: 1
  /** A non-secret marker: pool records were created in this state directory. */
  recordsCreated: true
}

function readMeta(stateDir: string): PoolMeta | undefined {
  const path = join(stateDir, POOL_META_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PoolMeta>
    return parsed.version === 1 && parsed.recordsCreated === true ? (parsed as PoolMeta) : undefined
  } catch {
    return undefined
  }
}

function writeMeta(stateDir: string): void {
  const path = join(stateDir, POOL_META_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify({ version: 1, recordsCreated: true }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDir(stateDir)
}

/** Opens the pool for `stateDir`: the same seed and the same records on every start. Refuses to
 * start when the seed survives but the records directory is gone while the marker says records
 * existed: the pool would restart at index 0 and reuse accounts that were already spent. */
export async function openPersistentStampPool(
  stateDir: string,
  label: string,
): Promise<StampPool> {
  const mnemonic = loadOrCreatePoolMnemonic(stateDir, label)
  const recordsDir = join(stateDir, SUB_ACCOUNT_RECORDS_DIR)
  if (readMeta(stateDir) && !existsSync(recordsDir)) {
    throw new Error(
      `Stamp pool records directory ${recordsDir} is missing, but ${join(stateDir, POOL_META_FILE)} says it existed. ` +
        'Refusing to continue: restarting the pool at index 0 would reuse spent sub-accounts. ' +
        'Restore the directory from a backup, or (only if you accept address reuse) delete the marker file.',
    )
  }
  const poolStore = new LevelSubAccountPoolStore(stateDir)
  const changeStore = new LevelChangePoolStore(stateDir)
  await poolStore.Open()
  try {
    await changeStore.Open()
  } catch (err) {
    await poolStore.Close()
    throw err
  }
  writeMeta(stateDir)
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
