import { fromHex, toHex, uncompressedPubkey } from '@frank/codec'
import { openBrowserDirectoryStore } from '@frank/directory-admission/browser'
import type {
  Anchor,
  Candidate,
  Checkpoint,
  Context,
  Current,
  DirectoryStore,
  Timestamp,
} from '@frank/directory-admission'
import type { TrustInputs } from './index'

/** Operator configuration, never inferred from the downloaded witness. */
export interface DemoInstallation {
  manifestIdentity: string
  trustInputs: TrustInputs
  witnessHex: string
}
export interface DemoAdmission {
  enroll(candidates: readonly Candidate[], nowNs: bigint): Promise<Current>
  advance(candidates: readonly Candidate[], nowNs: bigint): Promise<Current>
  current(nowNs: bigint): Promise<Current>
  status: DirectoryStore['status']
  historicalEvidence: DirectoryStore['historicalEvidence']
  conflictEvidence: DirectoryStore['conflictEvidence']
  close(): Promise<void>
}
export function exactHex(value: string, bytes: number): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length !== bytes * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new Error('Canonical exact public hex required')
  return fromHex(value)
}
export function splitTime(nowNs: bigint): Timestamp {
  if (
    typeof nowNs !== 'bigint' ||
    nowNs < 0n ||
    nowNs / 1000000000n > (1n << 63n) - 1n
  )
    throw new Error('Explicit in-range bigint nanosecond time required')
  return {
    seconds: nowNs / 1000000000n,
    nanoseconds: Number(nowNs % 1000000000n),
  }
}
export function trustSnapshot(t: TrustInputs): TrustInputs {
  if (
    !t ||
    typeof t.network !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(t.network)
  )
    throw new Error('Explicit canonical network required')
  const subject = exactHex(t.subject, 33)
  const relay = exactHex(t.relayIdentity?.point, 33)
  uncompressedPubkey(subject)
  uncompressedPubkey(relay)
  exactHex(t.rev0T1, 32)
  exactHex(t.relayId, 16)
  splitTime(t.bindingExpiryNs)
  if (
    t.relayIdentity.keyType !== 1 ||
    !/^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(t.endpoint) ||
    Number(t.endpoint.slice(t.endpoint.lastIndexOf(':') + 1)) > 65535
  )
    throw new Error('Exact synthetic HTTPS relay tuple required')
  return {
    network: t.network,
    subject: t.subject,
    rev0T1: t.rev0T1,
    relayId: t.relayId,
    relayIdentity: { keyType: 1, point: t.relayIdentity.point },
    endpoint: t.endpoint,
    bindingExpiryNs: t.bindingExpiryNs,
  }
}
export function trustJSON(t: TrustInputs) {
  return { ...trustSnapshot(t), bindingExpiryNs: t.bindingExpiryNs.toString() }
}
export function installationSnapshot(
  input: DemoInstallation,
): DemoInstallation {
  exactHex(input.manifestIdentity, 32)
  if (
    typeof input.witnessHex !== 'string' ||
    input.witnessHex.length > 524288 ||
    !/^(?:[0-9a-f]{2})+$/.test(input.witnessHex)
  )
    throw new Error('Explicit bounded signed witness required')
  return {
    manifestIdentity: input.manifestIdentity,
    trustInputs: trustSnapshot(input.trustInputs),
    witnessHex: input.witnessHex,
  }
}
export function admissionAnchor(t: TrustInputs): Anchor {
  return {
    network: t.network,
    subject: { keyType: 1, keyBytes: exactHex(t.subject, 33) },
    revisionZero: exactHex(t.rev0T1, 32),
  }
}
export function admissionContext(t: TrustInputs, nowNs: bigint): Context {
  return {
    now: splitTime(nowNs),
    relay: {
      relayId: exactHex(t.relayId, 16),
      endpoint: t.endpoint,
      identity: { keyType: 1, keyBytes: exactHex(t.relayIdentity.point, 33) },
      expiry: splitTime(t.bindingExpiryNs),
      unknownFields: new Map(),
    },
  }
}
/** Meter the complete batch before any byte allocation; never truncate a prefix. */
export function candidateSnapshot(
  candidates: readonly Candidate[],
): Candidate[] {
  if (!Array.isArray(candidates) || candidates.length > 4096)
    throw new Error('Presented batch limit')
  let bytes = 0
  for (const c of candidates) {
    if (
      !c ||
      !(c.statement instanceof Uint8Array) ||
      !(c.attestation instanceof Uint8Array) ||
      c.statement.byteLength > 262144 ||
      c.attestation.byteLength > 262144
    )
      throw new Error('Presented frame limit')
    bytes += c.statement.byteLength + c.attestation.byteLength
    if (bytes > 16777216) throw new Error('Presented byte limit')
  }
  return candidates.map(c => ({
    statement: new Uint8Array(c.statement),
    attestation: new Uint8Array(c.attestation),
  }))
}
/** Whole public checkpoint and configuration, retained outside the admission database. */
export function continuityJSON(
  installation: DemoInstallation,
  checkpoint: Checkpoint,
): string {
  return JSON.stringify({
    format: 'frank-demo-directory-continuity-v1',
    intent: 'enrolled',
    manifestIdentity: installation.manifestIdentity,
    trust: trustJSON(installation.trustInputs),
    checkpoint: {
      kind: checkpoint.kind,
      identity: toHex(checkpoint.identity),
      anchor: toHex(checkpoint.anchor),
      head: checkpoint.head === null ? null : toHex(checkpoint.head),
      accepted: checkpoint.accepted,
      retained: checkpoint.retained,
      evidenceDigest: toHex(checkpoint.evidenceDigest),
      checkedTime: {
        seconds: checkpoint.checkedTime.seconds.toString(),
        nanoseconds: checkpoint.checkedTime.nanoseconds,
      },
      forked: checkpoint.forked,
    },
  })
}
export function parseContinuity(
  text: string,
  installation: DemoInstallation,
): Checkpoint {
  if (typeof text !== 'string' || text.length > 8192)
    throw new Error('Bounded continuity record required')
  const record = JSON.parse(text)
  if (
    record.format !== 'frank-demo-directory-continuity-v1' ||
    record.intent !== 'enrolled' ||
    record.manifestIdentity !== installation.manifestIdentity ||
    JSON.stringify(record.trust) !==
      JSON.stringify(trustJSON(installation.trustInputs))
  )
    throw new Error('Installed trust/manifest continuity mismatch')
  const c = record.checkpoint
  if (
    !c ||
    !['ProspectiveEnrollment', 'CommittedPrefix'].includes(c.kind) ||
    !/^(0|[1-9][0-9]{0,18})$/.test(c.checkedTime?.seconds) ||
    typeof c.forked !== 'boolean' ||
    !Number.isInteger(c.checkedTime.nanoseconds) ||
    c.checkedTime.nanoseconds < 0 ||
    c.checkedTime.nanoseconds >= 1000000000 ||
    !Number.isInteger(c.accepted) ||
    !Number.isInteger(c.retained) ||
    c.accepted < 0 ||
    c.retained < c.accepted ||
    c.retained > 4096
  )
    throw new Error('Invalid full continuity checkpoint')
  const checkpoint: Checkpoint = {
    kind: c.kind,
    identity: exactHex(c.identity, 32),
    anchor: exactHex(c.anchor, 32),
    head: c.head === null ? null : exactHex(c.head, 32),
    accepted: c.accepted,
    retained: c.retained,
    evidenceDigest: exactHex(c.evidenceDigest, 32),
    checkedTime: {
      seconds: BigInt(c.checkedTime.seconds),
      nanoseconds: c.checkedTime.nanoseconds,
    },
    forked: c.forked,
  }
  if (continuityJSON(installation, checkpoint) !== text)
    throw new Error('Noncanonical continuity configuration')
  return checkpoint
}
/** Readiness only: no participant is selected when even one installation is missing/different. */
export function assertInstalledParticipants(
  expected: TrustInputs,
  participants: Readonly<Record<string, TrustInputs | null>>,
): void {
  const identity = JSON.stringify(trustJSON(expected))
  for (const name of ['relay-a', 'relay-b', 'bot']) {
    const actual = participants?.[name]
    if (!actual || JSON.stringify(trustJSON(actual)) !== identity)
      throw new Error('Participant configuration pending or mismatched')
  }
}

async function browserTransport(installation: DemoInstallation): Promise<void> {
  const origin = installation.trustInputs.endpoint
  if (location.origin !== new URL(origin).origin)
    throw new Error('Controlled fixture origin required')
  const response = await fetch(origin + '/fixture/evidence', {
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  })
  if (
    response.status !== 200 ||
    response.url !== origin + '/fixture/evidence' ||
    !response.body
  )
    throw new Error('Fixture transport rejected')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.length
      if (size > 600000) throw new Error('Fixture response limit')
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const expected = JSON.stringify({
    kind: 'synthetic-directory-evidence',
    trustInputs: trustJSON(installation.trustInputs),
    witnessHex: installation.witnessHex,
  })
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== expected)
    throw new Error('Fixture public tuple/evidence mismatch')
}

/** Only for the isolated fixture after strict Node exact-certificate preflight. */
export async function openDemoBrowserAdmission(options: {
  name: string
  installation: DemoInstallation
  nowNs: bigint
  mode: { kind: 'new' } | { kind: 'reopen'; continuity: string }
  saveContinuity: (record: string) => Promise<void>
}): Promise<DemoAdmission> {
  const installation = installationSnapshot(options.installation)
  const name = options.name,
    nowNs = options.nowNs,
    save = options.saveContinuity
  const mode =
    options.mode.kind === 'new'
      ? { kind: 'new' as const }
      : {
          kind: 'reopen' as const,
          checkpoint: parseContinuity(options.mode.continuity, installation),
        }
  admissionContext(installation.trustInputs, nowNs)
  await browserTransport(installation)
  const store = await openBrowserDirectoryStore({
    name,
    anchor: admissionAnchor(installation.trustInputs),
    mode,
  })
  let closing = false,
    failed = false,
    enrolled = mode.kind === 'reopen'
  let queue: Promise<unknown> = Promise.resolve()
  function use(
    candidates: readonly Candidate[],
    time: bigint,
    enroll: boolean,
  ): Promise<Current> {
    const owned = candidateSnapshot(candidates),
      context = admissionContext(installation.trustInputs, time)
    if (closing) return Promise.reject(new Error('Demo admission is closing'))
    const action = queue.then(async () => {
      if (failed)
        throw new Error('Demo admission unavailable; explicitly reopen')
      await browserTransport(installation)
      try {
        if (enroll) {
          if (
            enrolled ||
            mode.kind !== 'new' ||
            !owned.length ||
            toHex(owned[0].attestation) !== installation.witnessHex
          )
            throw new Error('Explicit fresh enrollment witness required')
          await save(
            continuityJSON(
              installation,
              await store.checkpointForEnrollment(owned[0], context.now!),
            ),
          )
        }
        const current = enroll
          ? await store.enroll(owned, context)
          : await store.advance(owned, context)
        enrolled = true
        await save(continuityJSON(installation, current.status.checkpoint))
        return current
      } catch (error) {
        failed = true
        if ((error as { code?: string }).code === 'fork') {
          const status = await store.status()
          if (status)
            await save(continuityJSON(installation, status.checkpoint))
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
