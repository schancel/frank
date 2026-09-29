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
  // path.normalize only treats the host platform's separator specially. Browser
  // storage names must be stable even when a caller supplies Windows spelling on
  // a Unix build host, so translate first and normalize second.
  const canonical = normalize(location.replace(/\\/g, '/')).replace(/\\/g, '/')
  const withoutDot = canonical.replace(/^\.\//, '')
  const withoutTrailingSeparators =
    withoutDot === '/' ? withoutDot : withoutDot.replace(/\/+$/, '')
  return withoutTrailingSeparators || '.'
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

export function nodeAdvisoryLockCommand(
  platform: NodeJS.Platform,
  lockPath: string,
  holderScript: string
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: [
        '-k',
        '-n',
        '-w',
        '-t',
        '0',
        lockPath,
        process.execPath,
        '-e',
        holderScript,
      ],
    }
  }
  if (platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: ['-n', '-x', lockPath, process.execPath, '-e', holderScript],
    }
  }
  throw new Error(
    `Persistent Node wallet ownership is unsupported on platform ${platform}`
  )
}

export async function acquireNodeWalletRootLease(
  location: string,
  testHooks: {
    /** Deterministic acquisition-failure seam. Production callers must not supply it. */
    beforePostReadyOperation?: (
      operation: 'lstat' | 'open' | 'fstat' | 'random' | 'write' | 'fsync'
    ) => void
    onHolderReady?: (holder: import('child_process').ChildProcess) => void
  } = {}
): Promise<WalletRootLease | undefined> {
  if (isBrowserWalletStorage()) return undefined
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  // Keep this Node-only ownership backend out of the browser module graph.
  const nodeRequire = require as NodeRequire
  const childProcess = nodeRequire(
    ['child', 'process'].join('_')
  ) as typeof import('child_process')
  const lockPath = resolve(location, '.frank-wallet.lock')
  let artifact = lstatIfPresent(fs, lockPath)
  if (artifact === undefined) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    artifact = fs.lstatSync(lockPath)
  }
  if (artifact.isSymbolicLink() || !artifact.isFile()) {
    throw new Error('Node wallet root lock artifact must be a regular file')
  }
  assertOwnedByCurrentUser(artifact, 'Node wallet root lock artifact')
  if ((artifact.mode & 0o777) !== 0o600) {
    throw new Error('Node wallet root lock artifact permissions must be 0600')
  }

  const holderScript = [
    'process.stdout.write("FRANK_WALLET_LOCKED\\n")',
    'process.stdin.on("end", () => process.exit(0))',
    'process.stdin.resume()',
  ].join(';')
  const advisory = nodeAdvisoryLockCommand(
    process.platform,
    lockPath,
    holderScript
  )
  const holder = childProcess.spawn(advisory.command, advisory.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let fd: number | undefined
  let holderExited = false
  const holderExit = new Promise<void>((resolveExit) => {
    holder.once('exit', () => {
      holderExited = true
      resolveExit()
    })
    holder.once('error', () => {
      holderExited = true
      resolveExit()
    })
  })
  const closeFenceFd = (): void => {
    if (fd === undefined) return
    try {
      fs.closeSync(fd)
    } finally {
      fd = undefined
    }
  }
  const stopAndReapHolder = async (): Promise<void> => {
    let closeError: unknown
    try {
      closeFenceFd()
    } catch (error) {
      closeError = error
    }
    // A successfully acquired lease deliberately unrefs this lifetime edge. Explicit cleanup
    // must restore the refs before closing it so release cannot resolve until the helper has
    // actually exited and the kernel has released the advisory lock.
    holder.ref()
    ;(holder.stdin as any).ref?.()
    if (!holder.stdin.destroyed) holder.stdin.end()
    await holderExit
    if (closeError !== undefined) throw closeError
  }
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= stopAndReapHolder()
    return cleanupPromise
  }
  let stderr = ''
  holder.stderr.setEncoding('utf8')
  holder.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  let identity!: import('fs').Stats
  let token!: string
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      let output = ''
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        rejectReady(error)
      }
      holder.once('error', fail)
      holder.once('exit', () =>
        fail(
          new Error(
            `Wallet root is already open in another process${
              stderr.trim() === '' ? '' : `: ${stderr.trim()}`
            }`
          )
        )
      )
      holder.stdout.setEncoding('utf8')
      holder.stdout.on('data', (chunk: string) => {
        output += chunk
        if (!settled && output.includes('FRANK_WALLET_LOCKED\n')) {
          settled = true
          resolveReady()
        }
      })
    })
    testHooks.onHolderReady?.(holder)

    testHooks.beforePostReadyOperation?.('lstat')
    const currentArtifact = fs.lstatSync(lockPath)
    if (
      !currentArtifact.isFile() ||
      currentArtifact.dev !== artifact.dev ||
      currentArtifact.ino !== artifact.ino
    ) {
      throw new Error('Node wallet root lock was replaced during acquisition')
    }
    testHooks.beforePostReadyOperation?.('open')
    fd = fs.openSync(lockPath, 'r+')
    testHooks.beforePostReadyOperation?.('fstat')
    identity = fs.fstatSync(fd)
    if (identity.dev !== artifact.dev || identity.ino !== artifact.ino) {
      throw new Error('Node wallet root lock was replaced during acquisition')
    }
    const random = new Uint8Array(16)
    const webCrypto = (globalThis as any).crypto as Crypto | undefined
    if (
      webCrypto === undefined ||
      typeof webCrypto.getRandomValues !== 'function'
    ) {
      throw new Error(
        'Secure randomness is unavailable for wallet lock fencing'
      )
    }
    testHooks.beforePostReadyOperation?.('random')
    webCrypto.getRandomValues(random)
    token = `${process.pid}:${Array.from(random, (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')}`
    fs.ftruncateSync(fd, 0)
    testHooks.beforePostReadyOperation?.('write')
    fs.writeFileSync(fd, token, { encoding: 'utf8' })
    testHooks.beforePostReadyOperation?.('fsync')
    fs.fsyncSync(fd)
  } catch (error) {
    await cleanup()
    throw error
  }
  let held = true
  // The open stdin pipe is the lifetime edge. It closes automatically if the
  // wallet process is killed, causing the lock holder to exit and the kernel to
  // release the advisory lock. Unref it so an otherwise finished process can exit.
  holder.unref()
  holder.stdout.destroy()
  holder.stderr.destroy()
  ;(holder.stdin as any).unref?.()
  const lose = (message: string): never => {
    held = false
    void cleanup().catch(() => undefined)
    throw new Error(message)
  }
  const assertHeld = (): void => {
    if (!held) throw new Error('Node wallet root lock was lost')
    if (
      holderExited ||
      holder.exitCode !== null ||
      holder.signalCode !== null
    ) {
      lose('Node wallet root advisory lock was lost')
    }
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
    const verifiedCurrent = current as import('fs').Stats
    try {
      assertOwnedByCurrentUser(
        verifiedCurrent,
        'Node wallet root lock artifact'
      )
    } catch {
      lose('Node wallet root lock ownership changed')
    }
    if ((verifiedCurrent.mode & 0o777) !== 0o600) {
      lose('Node wallet root lock permissions changed')
    }
    let currentRoot: import('fs').Stats | undefined
    try {
      currentRoot = fs.lstatSync(location)
    } catch {
      lose('Node wallet root was removed')
    }
    if (
      currentRoot === undefined ||
      currentRoot.isSymbolicLink() ||
      !currentRoot.isDirectory()
    ) {
      lose('Node wallet root identity changed')
    }
    const verifiedRoot = currentRoot as import('fs').Stats
    try {
      assertOwnedByCurrentUser(verifiedRoot, 'Wallet root')
    } catch {
      lose('Node wallet root ownership changed')
    }
    if ((verifiedRoot.mode & 0o777) !== 0o700) {
      lose('Node wallet root permissions changed')
    }
    let currentToken: string | undefined
    try {
      currentToken = fs.readFileSync(lockPath, 'utf8')
    } catch {
      lose('Node wallet root lock became unreadable')
    }
    if (currentToken !== token) lose('Node wallet root lock fence changed')
  }
  return {
    assertHeld,
    async release(): Promise<void> {
      if (held) {
        try {
          assertHeld()
        } catch (error) {
          await cleanup()
          throw error
        }
        held = false
      }
      await cleanup()
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
