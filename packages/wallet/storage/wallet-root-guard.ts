/* eslint-disable @typescript-eslint/no-explicit-any */
import { join, normalize, resolve, sep } from 'path'

export const WALLET_COMPONENT_NAMES = [
  'wallet-manifest',
  'sub-account-pool',
  'change-pool',
  'outgoing-stamp-attempts',
  'stamp-payment-journal',
] as const

export function isBrowserWalletStorage(): boolean {
  const globals = globalThis as any
  return (
    globals.window !== undefined &&
    globals.indexedDB !== undefined &&
    globals.navigator !== undefined
  )
}

/** One spelling for both the Web Lock and every level-js database name. */
export function canonicalWalletStorageLocation(location: string): string {
  if (!isBrowserWalletStorage()) return resolve(location)
  const canonical = normalize(location).replace(/\\/g, '/')
  return canonical.replace(/^\.\//, '') || '.'
}

function lstatIfPresent(
  fs: typeof import('fs'),
  path: string
): import('fs').Stats | undefined {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function assertOwnedByCurrentUser(
  stat: import('fs').Stats,
  label: string
): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current user`)
  }
}

/** Performs every Unix trust check before the first Level constructor can touch the root. A
 * historical owner-only-write 0755 root is hardened once, after its identity and owner are
 * validated. Group/world-writable roots are never adopted. */
export function prepareSecureWalletRoot(location: string): string {
  const canonical = canonicalWalletStorageLocation(location)
  if (isBrowserWalletStorage()) return canonical
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  let rootLstat = lstatIfPresent(fs, canonical)
  if (rootLstat === undefined) {
    fs.mkdirSync(canonical, { recursive: true, mode: 0o700 })
    rootLstat = fs.lstatSync(canonical)
  }
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new Error('Wallet root must be a real directory, not a symlink')
  }
  assertOwnedByCurrentUser(rootLstat, 'Wallet root')
  const mode = rootLstat.mode & 0o777
  if (mode === 0o755) {
    fs.chmodSync(canonical, 0o700)
    rootLstat = fs.lstatSync(canonical)
  } else if (mode !== 0o700) {
    throw new Error(
      `Wallet root permissions must be 0700 (legacy 0755 is hardened automatically), got ${mode.toString(
        8
      )}`
    )
  }
  const rootReal = fs.realpathSync(canonical)
  const allowedEntries = new Set<string>([
    ...WALLET_COMPONENT_NAMES,
    '.frank-wallet.lock',
  ])
  const unexpected = fs
    .readdirSync(canonical)
    .find((entry) => !allowedEntries.has(entry))
  if (unexpected !== undefined) {
    throw new Error(`Wallet root contains unexpected entry ${unexpected}`)
  }
  for (const child of WALLET_COMPONENT_NAMES) {
    validateWalletComponentBeforeOpen(canonical, child, false)
  }
  return rootReal
}

/** Re-checks root and component identity immediately before each Level constructor/open. */
export function validateWalletComponentBeforeOpen(
  location: string,
  component: string,
  requireExisting: boolean
): void {
  if (isBrowserWalletStorage()) return
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const canonical = resolve(location)
  const rootLstat = fs.lstatSync(canonical)
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new Error('Wallet root identity changed before database open')
  }
  assertOwnedByCurrentUser(rootLstat, 'Wallet root')
  if ((rootLstat.mode & 0o777) !== 0o700) {
    throw new Error('Wallet root permissions changed before database open')
  }
  const rootReal = fs.realpathSync(canonical)
  const childPath = resolve(canonical, component)
  const childLstat = lstatIfPresent(fs, childPath)
  if (childLstat === undefined) {
    if (requireExisting) {
      throw new Error(`Wallet component ${component} is missing`)
    }
    return
  }
  if (childLstat.isSymbolicLink() || !childLstat.isDirectory()) {
    throw new Error(`Wallet component ${component} must be a real directory`)
  }
  assertOwnedByCurrentUser(childLstat, `Wallet component ${component}`)
  const childReal = fs.realpathSync(childPath)
  if (!childReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`Wallet component ${component} escapes its root`)
  }
}

export async function existingWalletComponents(
  location: string
): Promise<Set<string>> {
  const canonical = canonicalWalletStorageLocation(location)
  if (!isBrowserWalletStorage()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    return new Set(
      WALLET_COMPONENT_NAMES.filter(
        (name) => lstatIfPresent(fs, resolve(canonical, name)) !== undefined
      )
    )
  }
  const browserIndexedDb = (globalThis as any).indexedDB
  const databases = browserIndexedDb.databases
  if (typeof databases !== 'function') {
    throw new Error(
      'Browser wallet storage requires indexedDB.databases for read-only root inspection'
    )
  }
  const names = new Set(
    (
      (await databases.call(browserIndexedDb)) as Array<{ name?: string }>
    ).flatMap((database) =>
      database.name === undefined ? [] : [database.name]
    )
  )
  return new Set(
    WALLET_COMPONENT_NAMES.filter((name) =>
      names.has(`level-js-${join(canonical, name)}`)
    )
  )
}

export interface WalletRootLease {
  assertHeld(): void
  release(): Promise<void>
}

export function acquireNodeWalletRootLease(
  location: string
): WalletRootLease | undefined {
  if (isBrowserWalletStorage()) return undefined
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto') as typeof import('crypto')
  const lockPath = resolve(location, '.frank-wallet.lock')
  const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`
  let fd: number
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'Wallet root is already open or has an unreleased crash lock; verify no owner is running before removing the lock'
      )
    }
    throw error
  }
  fs.writeFileSync(fd, token, { encoding: 'utf8' })
  fs.fsyncSync(fd)
  const identity = fs.fstatSync(fd)
  let held = true
  const lose = (message: string): never => {
    held = false
    try {
      fs.closeSync(fd)
    } catch {
      // The ownership failure is the actionable error.
    }
    throw new Error(message)
  }
  return {
    assertHeld(): void {
      if (!held) throw new Error('Node wallet root lock was lost')
      let current: import('fs').Stats | undefined
      try {
        current = fs.lstatSync(lockPath)
      } catch {
        lose('Node wallet root lock was removed')
      }
      if (
        current === undefined ||
        !current.isFile() ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev
      ) {
        lose('Node wallet root lock was replaced')
      }
      let currentToken: string | undefined
      try {
        currentToken = fs.readFileSync(lockPath, 'utf8')
      } catch {
        lose('Node wallet root lock became unreadable')
      }
      if (currentToken !== token) lose('Node wallet root lock fence changed')
    },
    async release(): Promise<void> {
      if (!held) return
      this.assertHeld()
      held = false
      fs.closeSync(fd)
      const current = lstatIfPresent(fs, lockPath)
      if (
        current !== undefined &&
        current.ino === identity.ino &&
        current.dev === identity.dev
      ) {
        fs.unlinkSync(lockPath)
      }
    },
  }
}

export async function acquireBrowserWalletRootLease(
  location: string
): Promise<WalletRootLease | undefined> {
  if (!isBrowserWalletStorage()) return undefined
  const canonical = canonicalWalletStorageLocation(location)
  const locks = (globalThis as any).navigator.locks
  if (locks === undefined || typeof locks.request !== 'function') {
    throw new Error('Browser wallet storage requires Web Locks')
  }
  let releaseHold: (() => void) | undefined
  let held = false
  let resolveReady!: (acquired: boolean) => void
  const ready = new Promise<boolean>((resolvePromise) => {
    resolveReady = resolvePromise
  })
  const completion = locks.request(
    `frank-monad-wallet:${canonical}`,
    { ifAvailable: true, mode: 'exclusive' },
    async (lock: unknown) => {
      if (lock === null || lock === undefined) {
        resolveReady(false)
        return
      }
      held = true
      resolveReady(true)
      await new Promise<void>((resolvePromise) => {
        releaseHold = resolvePromise
      })
      held = false
    }
  )
  if (!(await ready)) {
    await completion
    throw new Error('Wallet root is already open in another browser context')
  }
  return {
    assertHeld(): void {
      if (!held) throw new Error('Browser wallet root lock was lost')
    },
    async release(): Promise<void> {
      if (held) releaseHold?.()
      await completion
    },
  }
}
