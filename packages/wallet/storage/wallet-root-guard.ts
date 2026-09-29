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

const NODE_CREATION_INTENT_FILE = '.frank-wallet-creation.json'
const NODE_CREATION_INTENT_TEMP = `${NODE_CREATION_INTENT_FILE}.tmp`
const NODE_CREATION_ROOT_IDENTITY_FILE = '.frank-wallet-root-identity.json'
const NODE_CREATION_ROOT_IDENTITY_TEMP = `${NODE_CREATION_ROOT_IDENTITY_FILE}.tmp`
const MAX_NODE_CREATION_FILE_BYTES = 16 * 1024

export interface NodeWalletCreationIntentSource {
  /** Called under the sibling creation lock only when no durable intent exists. */
  create(): string
  /** Must fully authenticate a retained intent without exposing its secret material. */
  validateRetained(encodedIntent: string): void
}

export interface NodeWalletCreationClaim {
  readonly encodedIntent: string
  readonly rootIdentity: { dev: string; ino: string }
  /** Revalidates the published root without mutating it. */
  assertRootIdentity(): void
  /** Removes the sibling claim only after the caller has finalized the wallet under its root
   * lease. The root creation intent may already have been removed; the retained staged link is
   * sufficient to resume an interrupted cleanup against the same inode. */
  finalize(): Promise<void>
}

function assertPrivateCreationFile(
  stat: import('fs').Stats,
  label: string,
  allowedLinkCounts: readonly number[] = [1]
): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    !allowedLinkCounts.includes(stat.nlink) ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(`${label} must be an owner-only regular file`)
  }
  assertOwnedByCurrentUser(stat, label)
  if (stat.size <= 0 || stat.size > MAX_NODE_CREATION_FILE_BYTES) {
    throw new Error(`${label} has an invalid size`)
  }
}

/** Reads an untrusted creation file without ever following or blocking on a FIFO/device. */
export function readPrivateNodeCreationFile(
  path: string,
  label: string,
  fsyncBeforeClose = false,
  allowedLinkCounts: readonly number[] = [1]
): string | undefined {
  if (isBrowserWalletStorage()) return undefined
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as typeof import('fs')
  const before = lstatIfPresent(fs, path)
  if (before === undefined) return undefined
  assertPrivateCreationFile(before, label, allowedLinkCounts)
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW
  const nonblock = (fs.constants as Record<string, number>).O_NONBLOCK
  if (noFollow === undefined || nonblock === undefined) {
    throw new Error('Secure wallet creation file reads are unavailable')
  }
  const descriptor = fs.openSync(
    path,
    fs.constants.O_RDONLY | noFollow | nonblock
  )
  try {
    const opened = fs.fstatSync(descriptor)
    assertPrivateCreationFile(opened, label, allowedLinkCounts)
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed during secure open`)
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        offset
      )
      if (count === 0) break
      offset += count
    }
    const after = fs.fstatSync(descriptor)
    if (
      offset !== bytes.length ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      throw new Error(`${label} changed during bounded read`)
    }
    if (fsyncBeforeClose) fs.fsyncSync(descriptor)
    const encoded = bytes.toString('utf8')
    if (!Buffer.from(encoded, 'utf8').equals(bytes)) {
      throw new Error(`${label} is not valid UTF-8`)
    }
    return encoded
  } finally {
    fs.closeSync(descriptor)
  }
}

interface NodeCreationRootIdentity {
  version: 1
  bindingId: string
  dev: string
  ino: string
}

function creationIntentBindingId(encodedIntent: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(encodedIntent) as Record<string, unknown>
  } catch {
    throw new Error('Invalid wallet creation intent')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.bindingId !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(parsed.bindingId)
  ) {
    throw new Error('Invalid wallet creation intent binding')
  }
  return parsed.bindingId.toLowerCase()
}

function parseNodeCreationRootIdentity(
  encoded: string,
  bindingId: string
): NodeCreationRootIdentity {
  let parsed: Partial<NodeCreationRootIdentity>
  try {
    parsed = JSON.parse(encoded) as Partial<NodeCreationRootIdentity>
  } catch {
    throw new Error('Invalid wallet creation root identity')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Object.keys(parsed).some(
      (key) => !['version', 'bindingId', 'dev', 'ino'].includes(key)
    ) ||
    parsed.version !== 1 ||
    parsed.bindingId?.toLowerCase() !== bindingId ||
    typeof parsed.dev !== 'string' ||
    !/^\d+$/.test(parsed.dev) ||
    typeof parsed.ino !== 'string' ||
    !/^\d+$/.test(parsed.ino)
  ) {
    throw new Error('Invalid wallet creation root identity')
  }
  return parsed as NodeCreationRootIdentity
}

function fsyncDirectory(fs: typeof import('fs'), path: string): void {
  const descriptor = fs.openSync(path, 'r')
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function writePrivateCreationFile(
  fs: typeof import('fs'),
  temporaryPath: string,
  finalPath: string,
  encoded: string
): void {
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, encoded)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporaryPath, finalPath)
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
  intentSource: string | NodeWalletCreationIntentSource,
  onPhase?: (
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
): Promise<NodeWalletCreationClaim> {
  if (isBrowserWalletStorage()) {
    throw new Error('Node wallet root publication is unavailable in browsers')
  }
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
    const validateRetainedIntent = (retained: string): void => {
      if (typeof intentSource === 'string') {
        if (!sameSeedBoundCreationIntent(retained, intentSource)) {
          throw new Error(
            'Abandoned wallet creation intent does not match: seed does not match durable claim'
          )
        }
      } else {
        intentSource.validateRetained(retained)
      }
      creationIntentBindingId(retained)
    }
    const abandonedStages = fs
      .readdirSync(parent)
      .filter((entry) => entry.startsWith(stagePrefix))
      .map((entry) => join(parent, entry))
      .sort()
    let staging: string | undefined
    let encodedIntent: string | undefined
    let intentAlreadyInRoot = false
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
            entry !== NODE_CREATION_INTENT_FILE &&
            entry !== NODE_CREATION_INTENT_TEMP &&
            entry !== NODE_CREATION_ROOT_IDENTITY_FILE &&
            entry !== NODE_CREATION_ROOT_IDENTITY_TEMP
        )
      ) {
        throw new Error('Wallet creation staging path contains unexpected data')
      }
      if (
        (entries.includes(NODE_CREATION_INTENT_FILE) &&
          entries.includes(NODE_CREATION_INTENT_TEMP)) ||
        (entries.includes(NODE_CREATION_ROOT_IDENTITY_FILE) &&
          entries.includes(NODE_CREATION_ROOT_IDENTITY_TEMP))
      ) {
        throw new Error('Wallet creation staging path is ambiguous')
      }
      // Validate every attacker-controlled path before any potentially blocking read.
      for (const entry of entries) {
        assertPrivateCreationFile(
          fs.lstatSync(join(candidate, entry)),
          'Wallet creation staging file',
          entry === NODE_CREATION_INTENT_FILE ? [1, 2] : [1]
        )
      }

      const retainedPath = join(candidate, NODE_CREATION_INTENT_FILE)
      let retainedIntent = readPrivateNodeCreationFile(
        retainedPath,
        'Wallet creation intent',
        false,
        [1, 2]
      )
      if (retainedIntent === undefined) {
        const temporaryPath = join(candidate, NODE_CREATION_INTENT_TEMP)
        const temporaryIntent = readPrivateNodeCreationFile(
          temporaryPath,
          'Wallet creation intent temporary',
          true
        )
        if (temporaryIntent !== undefined) {
          validateRetainedIntent(temporaryIntent)
          fs.renameSync(temporaryPath, retainedPath)
          fsyncDirectory(fs, candidate)
          retainedIntent = temporaryIntent
        }
      }
      let candidateIntentInRoot = false
      const retainedStat = lstatIfPresent(fs, retainedPath)
      if (retainedIntent !== undefined && retainedStat?.nlink === 2) {
        const rootIntentPath = join(canonical, NODE_CREATION_INTENT_FILE)
        const rootIntentStat = lstatIfPresent(fs, rootIntentPath)
        const rootIntent = readPrivateNodeCreationFile(
          rootIntentPath,
          'Wallet creation intent',
          false,
          [2]
        )
        if (
          rootIntentStat === undefined ||
          rootIntentStat.dev !== retainedStat.dev ||
          rootIntentStat.ino !== retainedStat.ino ||
          rootIntent !== retainedIntent
        ) {
          throw new Error('Wallet creation intent link authority is invalid')
        }
        candidateIntentInRoot = true
      }
      if (retainedIntent === undefined) {
        if (entries.length === 0) {
          fs.rmdirSync(candidate)
          continue
        }
        retainedIntent = readPrivateNodeCreationFile(
          join(canonical, NODE_CREATION_INTENT_FILE),
          'Wallet creation intent'
        )
        if (retainedIntent === undefined) {
          throw new Error('Abandoned wallet creation intent is incomplete')
        }
        candidateIntentInRoot = true
      }
      validateRetainedIntent(retainedIntent)
      if (staging !== undefined) {
        throw new Error('Multiple abandoned wallet creation intents require audit')
      }
      staging = candidate
      encodedIntent = retainedIntent
      intentAlreadyInRoot = candidateIntentInRoot
    }

    const existingRoot = lstatIfPresent(fs, canonical)
    let claimedRootIdentity: NodeCreationRootIdentity | undefined
    if (existingRoot !== undefined) {
      if (
        existingRoot.isSymbolicLink() ||
        !existingRoot.isDirectory() ||
        (existingRoot.mode & 0o777) !== 0o700
      ) {
        throw new Error('First-use wallet creation found an invalid Node root')
      }
      assertOwnedByCurrentUser(existingRoot, 'Wallet root')
      if (staging === undefined || encodedIntent === undefined) {
        throw new Error('First-use wallet creation requires a missing Node root')
      }
      const bindingId = creationIntentBindingId(encodedIntent)
      const identityPath = join(staging, NODE_CREATION_ROOT_IDENTITY_FILE)
      let encodedIdentity = readPrivateNodeCreationFile(
        identityPath,
        'Wallet creation root identity'
      )
      if (encodedIdentity === undefined) {
        const temporaryIdentityPath = join(
          staging,
          NODE_CREATION_ROOT_IDENTITY_TEMP
        )
        const temporaryIdentity = readPrivateNodeCreationFile(
          temporaryIdentityPath,
          'Wallet creation root identity temporary',
          true
        )
        if (temporaryIdentity !== undefined) {
          parseNodeCreationRootIdentity(temporaryIdentity, bindingId)
          fs.renameSync(temporaryIdentityPath, identityPath)
          fsyncDirectory(fs, staging)
          encodedIdentity = temporaryIdentity
        }
      }
      if (encodedIdentity === undefined) {
        throw new Error(
          'Existing wallet root is not bound to the durable creation claim'
        )
      }
      const identity = parseNodeCreationRootIdentity(
        encodedIdentity,
        bindingId
      )
      if (
        identity.dev !== String(existingRoot.dev) ||
        identity.ino !== String(existingRoot.ino)
      ) {
        throw new Error('Wallet root identity does not match creation claim')
      }
      claimedRootIdentity = identity
    } else if (staging === undefined) {
      staging = fs.mkdtempSync(join(parent, stagePrefix))
      fs.chmodSync(staging, 0o700)
      encodedIntent =
        typeof intentSource === 'string' ? intentSource : intentSource.create()
      validateRetainedIntent(encodedIntent)
      const temporaryIntent = join(staging, NODE_CREATION_INTENT_TEMP)
      const finalIntent = join(staging, NODE_CREATION_INTENT_FILE)
      const descriptor = fs.openSync(temporaryIntent, 'wx', 0o600)
      try {
        fs.writeFileSync(descriptor, encodedIntent)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
      // Every injected pre-publication crash occurs only after both the intent and its unique
      // sibling-stage directory entry are durable.
      fsyncDirectory(fs, staging)
      fsyncDirectory(fs, parent)
      await onPhase?.('staged')
      await onPhase?.('temp-written')
      await onPhase?.('temp-synced')
      fs.renameSync(temporaryIntent, finalIntent)
      await onPhase?.('intent-published')
      fsyncDirectory(fs, staging)
    }

    if (staging === undefined || encodedIntent === undefined) {
      throw new Error('Wallet creation intent was not established')
    }

    if (existingRoot === undefined) {
      if (
        lstatIfPresent(
          fs,
          join(staging, NODE_CREATION_ROOT_IDENTITY_FILE)
        ) !== undefined ||
        lstatIfPresent(fs, join(staging, NODE_CREATION_ROOT_IDENTITY_TEMP)) !==
          undefined
      ) {
        throw new Error('Wallet root disappeared after creation was bound')
      }
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
          throw new Error('Wallet root appeared before atomic creation publish')
        }
        throw error
      }
      const publishedRoot = fs.lstatSync(canonical)
      if (
        publishedRoot.isSymbolicLink() ||
        !publishedRoot.isDirectory() ||
        (publishedRoot.mode & 0o777) !== 0o700
      ) {
        throw new Error('Published wallet root has an invalid identity')
      }
      assertOwnedByCurrentUser(publishedRoot, 'Wallet root')
      const rootIdentity: NodeCreationRootIdentity = {
        version: 1,
        bindingId: creationIntentBindingId(encodedIntent),
        dev: String(publishedRoot.dev),
        ino: String(publishedRoot.ino),
      }
      writePrivateCreationFile(
        fs,
        join(staging, NODE_CREATION_ROOT_IDENTITY_TEMP),
        join(staging, NODE_CREATION_ROOT_IDENTITY_FILE),
        JSON.stringify(rootIdentity)
      )
      fsyncDirectory(fs, staging)
      fsyncDirectory(fs, parent)
      await onPhase?.('root-published')
      const afterHook = fs.lstatSync(canonical)
      if (
        afterHook.isSymbolicLink() ||
        !afterHook.isDirectory() ||
        String(afterHook.dev) !== rootIdentity.dev ||
        String(afterHook.ino) !== rootIdentity.ino
      ) {
        throw new Error('Wallet root identity changed after publication')
      }
      claimedRootIdentity = rootIdentity
    }

    if (claimedRootIdentity === undefined) {
      throw new Error('Wallet root was not bound to the durable creation claim')
    }
    const assertClaimedRootIdentity = (): void => {
      const current = fs.lstatSync(canonical)
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        String(current.dev) !== claimedRootIdentity?.dev ||
        String(current.ino) !== claimedRootIdentity?.ino
      ) {
        throw new Error('Wallet root identity does not match creation claim')
      }
      assertOwnedByCurrentUser(current, 'Wallet root')
      if ((current.mode & 0o777) !== 0o700) {
        throw new Error('Wallet root permissions changed during creation')
      }
    }

    const stagedIntent = join(staging, NODE_CREATION_INTENT_FILE)
    const rootIntent = join(canonical, NODE_CREATION_INTENT_FILE)
    if (!intentAlreadyInRoot) {
      // Hard-link publication is atomic and no-replace; an unexpected root file is untouched.
      assertClaimedRootIdentity()
      fs.linkSync(stagedIntent, rootIntent)
      fsyncDirectory(fs, canonical)
      await onPhase?.('intent-linked')
      assertClaimedRootIdentity()
    } else if (lstatIfPresent(fs, stagedIntent) === undefined) {
      // Resume the narrow legacy crash window after the old publisher removed the staged link but
      // before it removed the inode claim. Re-establish the retained link before handing off.
      assertClaimedRootIdentity()
      fs.linkSync(rootIntent, stagedIntent)
      fsyncDirectory(fs, staging)
    }
    return {
      encodedIntent,
      rootIdentity: {
        dev: claimedRootIdentity.dev,
        ino: claimedRootIdentity.ino,
      },
      assertRootIdentity: assertClaimedRootIdentity,
      async finalize(): Promise<void> {
        const releaseCleanupLock = await acquireNodeCreationLock(lockPath)
        try {
          assertClaimedRootIdentity()
          const retained = readPrivateNodeCreationFile(
            stagedIntent,
            'Wallet creation intent',
            false,
            [1, 2]
          )
          validateRetainedIntent(retained ?? '')
          const identity = parseNodeCreationRootIdentity(
            readPrivateNodeCreationFile(
              join(staging!, NODE_CREATION_ROOT_IDENTITY_FILE),
              'Wallet creation root identity'
            ) ?? '',
            creationIntentBindingId(encodedIntent!)
          )
          if (
            identity.dev !== claimedRootIdentity?.dev ||
            identity.ino !== claimedRootIdentity?.ino
          ) {
            throw new Error('Wallet creation cleanup claim changed')
          }
          await onPhase?.('before-claim-cleanup')
          assertClaimedRootIdentity()
          fs.unlinkSync(stagedIntent)
          fs.unlinkSync(join(staging!, NODE_CREATION_ROOT_IDENTITY_FILE))
          fs.rmdirSync(staging!)
          fsyncDirectory(fs, parent)
        } finally {
          await releaseCleanupLock()
        }
      },
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
    /** Creation-time inode authority. It is checked before the lock artifact can be created. */
    expectedRootIdentity?: { dev: string; ino: string }
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
  const rootIdentity = fs.lstatSync(location)
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) {
    throw new Error('Wallet root identity changed before lock acquisition')
  }
  if (
    testHooks.expectedRootIdentity !== undefined &&
    (String(rootIdentity.dev) !== testHooks.expectedRootIdentity.dev ||
      String(rootIdentity.ino) !== testHooks.expectedRootIdentity.ino)
  ) {
    throw new Error('Wallet root identity does not match creation claim')
  }
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
  const rootAfterArtifact = fs.lstatSync(location)
  if (
    rootAfterArtifact.isSymbolicLink() ||
    !rootAfterArtifact.isDirectory() ||
    rootAfterArtifact.dev !== rootIdentity.dev ||
    rootAfterArtifact.ino !== rootIdentity.ino
  ) {
    throw new Error('Wallet root identity changed during lock acquisition')
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
