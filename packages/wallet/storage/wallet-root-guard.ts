/* eslint-disable @typescript-eslint/no-explicit-any */
import { join, resolve, sep } from 'path'

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

/** Performs every Unix trust check before the first Level constructor can touch the root. */
export function prepareSecureWalletRoot(location: string): void {
  if (isBrowserWalletStorage()) return
  // Kept behind the runtime branch so browser bundlers never execute the Node-only module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const absolute = resolve(location)
  if (!fs.existsSync(absolute)) {
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 })
  }
  const rootLstat = fs.lstatSync(absolute)
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new Error('Wallet root must be a real directory, not a symlink')
  }
  if (
    typeof process.getuid === 'function' &&
    rootLstat.uid !== process.getuid()
  ) {
    throw new Error('Wallet root must be owned by the current user')
  }
  if ((rootLstat.mode & 0o777) !== 0o700) {
    throw new Error('Wallet root permissions must be exactly 0700')
  }
  const rootReal = fs.realpathSync(absolute)
  const allowedEntries = new Set<string>([
    ...WALLET_COMPONENT_NAMES,
    '.frank-wallet.lock',
  ])
  const unexpected = fs
    .readdirSync(absolute)
    .find((entry) => !allowedEntries.has(entry))
  if (unexpected !== undefined) {
    throw new Error(`Wallet root contains unexpected entry ${unexpected}`)
  }
  for (const child of WALLET_COMPONENT_NAMES) {
    const childPath = resolve(absolute, child)
    if (!fs.existsSync(childPath)) continue
    const childLstat = fs.lstatSync(childPath)
    if (childLstat.isSymbolicLink() || !childLstat.isDirectory()) {
      throw new Error(`Wallet component ${child} must be a real directory`)
    }
    if (
      typeof process.getuid === 'function' &&
      childLstat.uid !== process.getuid()
    ) {
      throw new Error(`Wallet component ${child} has a foreign owner`)
    }
    const childReal = fs.realpathSync(childPath)
    if (!childReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`Wallet component ${child} escapes its root`)
    }
  }
}

export async function existingWalletComponents(
  location: string
): Promise<Set<string>> {
  if (!isBrowserWalletStorage()) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs')
    return new Set(
      WALLET_COMPONENT_NAMES.filter((name) =>
        fs.existsSync(resolve(location, name))
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
      names.has(`level-js-${join(location, name)}`)
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
  const lockPath = resolve(location, '.frank-wallet.lock')
  let fd: number
  const open = (): number => {
    try {
      return fs.openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid: number | undefined
      try {
        ownerPid = Number(fs.readFileSync(lockPath, 'utf8'))
        if (Number.isSafeInteger(ownerPid) && (ownerPid as number) > 0) {
          process.kill(ownerPid as number, 0)
          throw new Error('Wallet root is already open in another process')
        }
      } catch (ownerError) {
        if (
          ownerError instanceof Error &&
          ownerError.message ===
            'Wallet root is already open in another process'
        ) {
          throw ownerError
        }
        const code = (ownerError as NodeJS.ErrnoException).code
        if (code !== 'ESRCH' && code !== 'ENOENT' && code !== undefined) {
          throw ownerError
        }
      }
      fs.unlinkSync(lockPath)
      return fs.openSync(lockPath, 'wx', 0o600)
    }
  }
  fd = open()
  fs.writeFileSync(fd, String(process.pid), { encoding: 'utf8' })
  const inode = fs.fstatSync(fd).ino
  let held = true
  return {
    assertHeld(): void {
      if (!held) throw new Error('Node wallet root lock was lost')
      const current = fs.lstatSync(lockPath)
      if (current.ino !== inode || !current.isFile()) {
        held = false
        throw new Error('Node wallet root lock was replaced')
      }
    },
    async release(): Promise<void> {
      if (!held) return
      held = false
      fs.closeSync(fd)
      try {
        if (fs.lstatSync(lockPath).ino === inode) fs.unlinkSync(lockPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  }
}

export async function acquireBrowserWalletRootLease(
  location: string
): Promise<WalletRootLease | undefined> {
  if (!isBrowserWalletStorage()) return undefined
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
    `frank-monad-wallet:${location}`,
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
