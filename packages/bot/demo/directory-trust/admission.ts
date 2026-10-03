import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { toHex } from '@frank/codec'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { Candidate, Current } from '@frank/directory-admission'
import { checkNode, reopenBundle } from './index'
import type { BundleRef, TrustInputs } from './index'
import {
  admissionAnchor,
  admissionContext,
  candidateSnapshot,
  continuityJSON,
  installationSnapshot,
  parseContinuity,
  trustJSON,
  trustSnapshot,
} from './browser-admission'
import type { DemoAdmission } from './browser-admission'

export interface NodeAdmissionOptions {
  bundle: BundleRef
  installed: TrustInputs
  location: string
  continuityFile: string
  mode: 'new' | 'reopen'
  nowNs: bigint
}
function externalPath(file: string, location: string): string {
  if (
    !isAbsolute(file) ||
    !isAbsolute(location) ||
    resolve(file) !== file ||
    resolve(location) !== location
  )
    throw new Error(
      'Absolute dedicated admission and continuity paths required',
    )
  const parent = realpathSync(dirname(file))
  const dbParent = realpathSync(dirname(location))
  const canonicalFile = join(parent, basename(file))
  const canonicalDb = existsSync(location)
    ? realpathSync(location)
    : join(dbParent, basename(location))
  const inside = relative(canonicalDb, canonicalFile)
  if (
    !inside ||
    (!inside.startsWith('..' + '/') && inside !== '..' && !isAbsolute(inside))
  )
    throw new Error(
      'Continuity must be outside the admission rollback directory',
    )
  return canonicalFile
}
function readContinuity(file: string): string {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
    throw new Error('Invalid bounded continuity file')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!fstatSync(fd).isFile())
      throw new Error('Regular continuity file required')
    const bytes = Buffer.alloc(8193)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > 8192) throw new Error('Continuity size limit')
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, length),
    )
  } finally {
    closeSync(fd)
  }
}
/** Small public configuration, not a second admission database or full-disk rollback defense. */
function saveContinuity(file: string, text: string, first: boolean): void {
  if (Buffer.byteLength(text) > 8192) throw new Error('Continuity size limit')
  if (!first) readContinuity(file)
  const target = first
    ? file
    : file + '.pending-' + randomBytes(8).toString('hex')
  const fd = openSync(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  if (!first) renameSync(target, file)
  const parent = openSync(dirname(file), constants.O_RDONLY)
  try {
    fsyncSync(parent)
  } finally {
    closeSync(parent)
  }
}

/** Demo-only consumer. Its only transport and admission dependencies are public facades. */
export async function openDemoNodeAdmission(
  options: NodeAdmissionOptions,
): Promise<DemoAdmission> {
  const ref = {
    runDir: options.bundle.runDir,
    manifestIdentity: options.bundle.manifestIdentity,
  }
  const installed = trustSnapshot(options.installed)
  const location = options.location,
    intent = options.mode,
    nowNs = options.nowNs
  if (intent !== 'new' && intent !== 'reopen')
    throw new Error('Explicit new/reopen intent required')
  const file = externalPath(options.continuityFile, location)
  const bundle = reopenBundle(ref, nowNs)
  if (
    JSON.stringify(trustJSON(installed)) !==
    JSON.stringify(trustJSON(bundle.trustInputs))
  )
    throw new Error('Operator trust differs from provisioned bundle')
  const installation = installationSnapshot({
    manifestIdentity: ref.manifestIdentity,
    trustInputs: installed,
    witnessHex: bundle.witnessHex!,
  })
  let firstSave = intent === 'new'
  if (firstSave && existsSync(file))
    throw new Error('Existing continuity forbids new enrollment')
  const mode =
    intent === 'new'
      ? { kind: 'new' as const }
      : {
          kind: 'reopen' as const,
          checkpoint: parseContinuity(readContinuity(file), installation),
        }
  admissionContext(installed, nowNs)
  await checkNode(ref, nowNs)
  const store = await openNodeDirectoryStore({
    location,
    anchor: admissionAnchor(installed),
    mode,
  })
  let enrolled = intent === 'reopen',
    failed = false,
    closing = false
  let queue: Promise<unknown> = Promise.resolve()
  const save = (checkpoint: Parameters<typeof continuityJSON>[1]) => {
    saveContinuity(file, continuityJSON(installation, checkpoint), firstSave)
    firstSave = false
  }
  function use(
    candidates: readonly Candidate[],
    time: bigint,
    enroll: boolean,
  ): Promise<Current> {
    const owned = candidateSnapshot(candidates),
      context = admissionContext(installed, time)
    if (closing) return Promise.reject(new Error('Demo admission is closing'))
    const action = queue.then(async () => {
      if (failed)
        throw new Error('Demo admission unavailable; explicitly reopen')
      await checkNode(ref, time)
      try {
        if (enroll) {
          if (
            enrolled ||
            intent !== 'new' ||
            !owned.length ||
            toHex(owned[0].attestation) !== installation.witnessHex
          )
            throw new Error('Explicit fresh enrollment witness required')
          save(await store.checkpointForEnrollment(owned[0], context.now!))
        }
        const current = enroll
          ? await store.enroll(owned, context)
          : await store.advance(owned, context)
        enrolled = true
        save(current.status.checkpoint)
        return current
      } catch (error) {
        failed = true
        if ((error as { code?: string }).code === 'fork') {
          const status = await store.status()
          if (status) save(status.checkpoint)
        }
        throw error
      }
    })
    queue = action.catch(() => undefined)
    return action
  }
  return {
    enroll: (c, t) => use(c, t, true),
    advance: (c, t) => use(c, t, false),
    current: t => use([], t, false),
    status: () => store.status(),
    historicalEvidence: hash => store.historicalEvidence(hash),
    conflictEvidence: () => store.conflictEvidence(),
    async close() {
      closing = true
      await queue
      await store.close()
    },
  }
}
