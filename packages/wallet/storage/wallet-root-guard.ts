/* eslint-disable @typescript-eslint/no-explicit-any */
import { dirname, join, normalize, resolve, sep } from 'path'

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
export interface PreparedWalletRoot {
  location: string
  /** True only when this call atomically created the final Node root directory. Browser
   * namespace provenance is established after acquiring the Web Lock and inspecting IDB. */
  nodeRootCreated: boolean
}

export function nodeWalletRootExists(location: string): boolean {
  if (isBrowserWalletStorage()) return false
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  return (
    lstatIfPresent(fs, canonicalWalletStorageLocation(location)) !== undefined
  )
}

function nodeCreationStagePrefix(canonical: string): string {
  const parent = dirname(canonical)
  const base = canonical.slice(parent.length + 1)
  return `.${base}.frank-wallet-create.`
}

export function nodeWalletCreationRecoveryExists(location: string): boolean {
  if (isBrowserWalletStorage()) return false
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const canonical = canonicalWalletStorageLocation(location)
  const parent = dirname(canonical)
  try {
    return fs
      .readdirSync(parent)
      .some((entry) => entry.startsWith(nodeCreationStagePrefix(canonical)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function nodeWalletRootIsPrivateEmpty(location: string): boolean {
  if (isBrowserWalletStorage()) return false
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const canonical = canonicalWalletStorageLocation(location)
  const root = lstatIfPresent(fs, canonical)
  if (
    root === undefined ||
    root.isSymbolicLink() ||
    !root.isDirectory() ||
    (root.mode & 0o777) !== 0o700
  ) {
    return false
  }
  try {
    assertOwnedByCurrentUser(root, 'Wallet root')
  } catch {
    return false
  }
  return fs.readdirSync(canonical).length === 0
}

function sameSeedBoundCreationIntent(
  retainedIntent: string,
  requestedIntent: string
): boolean {
  if (retainedIntent === requestedIntent) return true
  try {
    const retained = JSON.parse(retainedIntent) as Record<string, unknown>
    const requested = JSON.parse(requestedIntent) as Record<string, unknown>
    const { bindingId: _retainedBinding, ...retainedAuthority } = retained
    const { bindingId: _requestedBinding, ...requestedAuthority } = requested
    return JSON.stringify(retainedAuthority) === JSON.stringify(requestedAuthority)
  } catch {
    return false
  }
}

async function acquireNodeCreationLock(
  lockPath: string
): Promise<() => Promise<void>> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const nodeRequire = require as NodeRequire
  const childProcess = nodeRequire(
    ['child', 'process'].join('_')
  ) as typeof import('child_process')
  let artifact = lstatIfPresent(fs, lockPath)
  if (artifact === undefined) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    artifact = fs.lstatSync(lockPath)
  }
  if (
    artifact.isSymbolicLink() ||
    !artifact.isFile() ||
    artifact.nlink !== 1 ||
    (artifact.mode & 0o777) !== 0o600
  ) {
    throw new Error('Wallet creation lock must be a private regular file')
  }
  assertOwnedByCurrentUser(artifact, 'Wallet creation lock')

  const holderScript = [
    'process.stdout.write("FRANK_WALLET_CREATE_LOCKED\\n")',
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
  let stderr = ''
  holder.stderr.setEncoding('utf8')
  holder.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  await new Promise<void>((resolveReady, rejectReady) => {
    let output = ''
    let settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      rejectReady(
        new Error(
          `Wallet root creation is already active${
            stderr.trim() === '' ? '' : `: ${stderr.trim()}`
          }`
        )
      )
    }
    holder.once('error', fail)
    holder.once('exit', fail)
    holder.stdout.setEncoding('utf8')
    holder.stdout.on('data', (chunk: string) => {
      output += chunk
      if (!settled && output.includes('FRANK_WALLET_CREATE_LOCKED\n')) {
        settled = true
        resolveReady()
      }
    })
  })
  const current = fs.lstatSync(lockPath)
  if (
    !current.isFile() ||
    current.dev !== artifact.dev ||
    current.ino !== artifact.ino
  ) {
    if (!holder.stdin.destroyed) holder.stdin.end()
    if (holder.exitCode === null && holder.signalCode === null) {
      await new Promise<void>((resolveExit) =>
        holder.once('exit', () => resolveExit())
      )
    }
    throw new Error('Wallet creation lock was replaced during acquisition')
  }
  let releasePromise: Promise<void> | undefined
  return () => {
    releasePromise ??= (async () => {
      if (!holder.stdin.destroyed) holder.stdin.end()
      if (holder.exitCode === null && holder.signalCode === null) {
        await new Promise<void>((resolveExit) =>
          holder.once('exit', () => resolveExit())
        )
      }
    })()
    return releasePromise
  }
}

/** Publishes a first-use Node root only after its complete seed-bound intent is durable inside a
 * unique same-filesystem staging directory. A sibling advisory creation lock serializes recovery;
 * `mkdir` is the kernel-enforced no-replace publication boundary, and an exact abandoned stage is
 * the only authority allowed to finish a crash between that boundary and the intent transfer. */
export async function publishNodeWalletRootWithIntent(
  location: string,
  encodedIntent: string,
  onPhase?: (
    phase:
      | 'staged'
      | 'temp-written'
      | 'temp-synced'
      | 'intent-published'
      | 'before-root-publish'
      | 'root-published'
  ) => void | Promise<void>
): Promise<void> {
  if (isBrowserWalletStorage()) return
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const canonical = canonicalWalletStorageLocation(location)
  const parent = dirname(canonical)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const base = canonical.slice(parent.length + 1)
  const stagePrefix = nodeCreationStagePrefix(canonical)
  const lockPath = join(parent, `.${base}.frank-wallet-creation.lock`)
  const releaseCreationLock = await acquireNodeCreationLock(lockPath)
  try {
    const abandonedStages = fs
      .readdirSync(parent)
      .filter((entry) => entry.startsWith(stagePrefix))
      .map((entry) => join(parent, entry))
      .sort()
    let staging: string | undefined
    let createdStage = false
    for (const candidate of abandonedStages) {
      const candidateStat = fs.lstatSync(candidate)
      if (
        candidateStat.isSymbolicLink() ||
        !candidateStat.isDirectory() ||
        (candidateStat.mode & 0o777) !== 0o700
      ) {
        throw new Error('Wallet creation staging path is not a private directory')
      }
      assertOwnedByCurrentUser(candidateStat, 'Wallet creation staging path')
      const entries = fs.readdirSync(candidate)
      if (
        entries.some(
          (entry) =>
            entry !== '.frank-wallet-creation.json' &&
            entry !== '.frank-wallet-creation.json.tmp'
        )
      ) {
        throw new Error('Wallet creation staging path contains unexpected data')
      }
      const retainedPath = join(candidate, '.frank-wallet-creation.json')
      let retainedStat = lstatIfPresent(fs, retainedPath)
      if (retainedStat === undefined) {
        const temporaryPath = join(
          candidate,
          '.frank-wallet-creation.json.tmp'
        )
        const temporaryStat = lstatIfPresent(fs, temporaryPath)
        if (temporaryStat === undefined) {
          fs.rmdirSync(candidate)
          continue
        }
        const temporaryIntent = fs.readFileSync(temporaryPath, 'utf8')
        if (
          temporaryStat.isSymbolicLink() ||
          !temporaryStat.isFile() ||
          temporaryStat.nlink !== 1 ||
          (temporaryStat.mode & 0o777) !== 0o600 ||
          !sameSeedBoundCreationIntent(temporaryIntent, encodedIntent)
        ) {
          throw new Error('Abandoned wallet creation intent does not match')
        }
        const descriptor = fs.openSync(temporaryPath, 'r+')
        try {
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
        fs.renameSync(temporaryPath, retainedPath)
        retainedStat = fs.lstatSync(retainedPath)
      }
      const retainedIntent = fs.readFileSync(retainedPath, 'utf8')
      if (
        retainedStat.isSymbolicLink() ||
        !retainedStat.isFile() ||
        retainedStat.nlink !== 1 ||
        (retainedStat.mode & 0o777) !== 0o600 ||
        !sameSeedBoundCreationIntent(retainedIntent, encodedIntent)
      ) {
        throw new Error('Abandoned wallet creation intent does not match')
      }
      if (staging !== undefined) {
        throw new Error('Multiple abandoned wallet creation intents require audit')
      }
      staging = candidate
    }

    const existingRoot = lstatIfPresent(fs, canonical)
    if (existingRoot !== undefined) {
      if (
        existingRoot.isSymbolicLink() ||
        !existingRoot.isDirectory() ||
        (existingRoot.mode & 0o777) !== 0o700
      ) {
        throw new Error('First-use wallet creation found an invalid Node root')
      }
      assertOwnedByCurrentUser(existingRoot, 'Wallet root')
      if (fs.readdirSync(canonical).length !== 0 || staging === undefined) {
        throw new Error('First-use wallet creation requires a missing Node root')
      }
    } else if (staging === undefined) {
      staging = fs.mkdtempSync(join(parent, stagePrefix))
      createdStage = true
      fs.chmodSync(staging, 0o700)
      await onPhase?.('staged')
      const temporaryIntent = join(
        staging,
        '.frank-wallet-creation.json.tmp'
      )
      const finalIntent = join(staging, '.frank-wallet-creation.json')
      const descriptor = fs.openSync(temporaryIntent, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, encodedIntent)
        await onPhase?.('temp-written')
        fs.fsyncSync(descriptor)
        await onPhase?.('temp-synced')
      } finally {
        fs.closeSync(descriptor)
      }
      fs.renameSync(temporaryIntent, finalIntent)
      await onPhase?.('intent-published')
      const stagingDescriptor = fs.openSync(staging, 'r')
      try {
        fs.fsyncSync(stagingDescriptor)
      } finally {
        fs.closeSync(stagingDescriptor)
      }
    }

    if (staging === undefined) {
      throw new Error('Wallet creation intent was not established')
    }

    if (existingRoot === undefined) {
      const claimParentDescriptor = fs.openSync(parent, 'r')
      try {
        fs.fsyncSync(claimParentDescriptor)
      } finally {
        fs.closeSync(claimParentDescriptor)
      }
      await onPhase?.('before-root-publish')
      try {
        fs.mkdirSync(canonical, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          if (createdStage) {
            fs.unlinkSync(join(staging, '.frank-wallet-creation.json'))
            fs.rmdirSync(staging)
          }
          throw new Error('Wallet root appeared before atomic creation publish')
        }
        throw error
      }
      await onPhase?.('root-published')
    }

    const stagedIntent = join(staging, '.frank-wallet-creation.json')
    fs.renameSync(stagedIntent, join(canonical, '.frank-wallet-creation.json'))
    const rootDescriptor = fs.openSync(canonical, 'r')
    try {
      fs.fsyncSync(rootDescriptor)
    } finally {
      fs.closeSync(rootDescriptor)
    }
    fs.rmdirSync(staging)
    const parentDescriptor = fs.openSync(parent, 'r')
    try {
      fs.fsyncSync(parentDescriptor)
    } finally {
      fs.closeSync(parentDescriptor)
    }
  } finally {
    await releaseCreationLock()
  }
}

export function prepareSecureWalletRootWithProvenance(
  location: string,
  createIfMissing = true
): PreparedWalletRoot {
  const canonical = canonicalWalletStorageLocation(location)
  if (isBrowserWalletStorage()) {
    return { location: canonical, nodeRootCreated: false }
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  let rootLstat = lstatIfPresent(fs, canonical)
  let nodeRootCreated = false
  if (rootLstat === undefined) {
    if (!createIfMissing) {
      throw new Error('Wallet root does not exist')
    }
    fs.mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 })
    try {
      // The non-recursive final mkdir is the creation provenance boundary: EEXIST means this
      // caller did not create the wallet namespace, even if the directory is otherwise empty.
      fs.mkdirSync(canonical, { mode: 0o700 })
      nodeRootCreated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
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
    '.frank-wallet-creation.json',
    '.frank-wallet-creation.json.tmp',
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
  return { location: rootReal, nodeRootCreated }
}

export function prepareSecureWalletRoot(location: string): string {
  return prepareSecureWalletRootWithProvenance(location).location
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
      // --no-fork makes the helper itself the kernel lock owner. Waiting for that PID to exit is
      // therefore sufficient proof that the advisory lock has actually been released.
      args: ['-n', '-x', '-F', lockPath, process.execPath, '-e', holderScript],
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
  if (artifact.nlink !== 1) {
    throw new Error('Node wallet root lock artifact must not be hard-linked')
  }
  assertOwnedByCurrentUser(artifact, 'Node wallet root lock artifact')
  if ((artifact.mode & 0o777) !== 0o600) {
    throw new Error('Node wallet root lock artifact permissions must be 0600')
  }
  const rootIdentity = fs.lstatSync(location)
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) {
    throw new Error('Wallet root identity changed before lock acquisition')
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
      current.nlink !== 1 ||
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
      !currentRoot.isDirectory() ||
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino
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
  let rejectReady!: (error: unknown) => void
  let completionError: unknown
  const ready = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  let completion: Promise<unknown>
  try {
    completion = Promise.resolve(
      locks.request(
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
    )
  } catch (error) {
    throw error
  }
  // Web Locks may reject before invoking the callback. Feed that failure into readiness as well
  // as retaining the completion promise for release, so acquisition neither hangs nor produces
  // an unhandled rejection.
  void completion.catch((error) => {
    completionError = error
    held = false
    rejectReady(error)
  })
  if (!(await ready)) {
    await completion
    throw new Error('Wallet root is already open in another browser context')
  }
  return {
    assertHeld(): void {
      if (completionError !== undefined) {
        throw new Error('Browser wallet root lock was lost')
      }
      if (!held) throw new Error('Browser wallet root lock was lost')
    },
    async release(): Promise<void> {
      if (held) releaseHold?.()
      await completion
    },
  }
}
