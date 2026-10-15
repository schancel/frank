import level, { type LevelDB } from 'level'
import { join } from 'path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { durablePut, openDurableLevel } from '../storage/level-durability'

const COMPONENT = 'threshold-signing-uncertainty-v1'

export interface SigningSessionBinding {
  readonly sessionIdHex: string
  readonly digestHex: string
}

/** The custody caller must bind this validated public point to its actual local share.
 * Metadata alone never authorizes importing or using a private share. */
export interface SigningKeyBinding {
  readonly keyId: string
  readonly localPublicShareHex: string
  readonly termsHashHex: string
  readonly role: 'initiator' | 'responder'
  readonly allowedSessions: readonly SigningSessionBinding[]
}

interface StepReceipt {
  readonly frameHashHex: string
  readonly artifactHashHex: string
  readonly terminal: boolean
}
interface SessionHistory {
  readonly sessionIdHex: string
  readonly steps: readonly StepReceipt[]
}
type SigningState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'active'; readonly sessionIdHex: string }
  | {
      readonly kind: 'step-in-progress'
      readonly sessionIdHex: string
      readonly stepIndex: number
      readonly frameHashHex: string
    }
  | {
      readonly kind: 'retired'
      readonly reason: 'explicit' | 'step-failed'
    }

export interface SigningUncertaintyRecord {
  readonly schemaVersion: 1
  readonly binding: SigningKeyBinding
  readonly revision: number
  readonly sessions: readonly SessionHistory[]
  readonly state: SigningState
}
export interface SigningUncertaintyInspection {
  readonly record: SigningUncertaintyRecord
  readonly usable: boolean
  readonly refusal?:
    | 'retired'
    | 'interrupted-session'
    | 'step-uncertain'
    | 'sessions-exhausted'
    | 'key-quarantined'
}

function fail(message: string): never {
  throw new Error(`Signing uncertainty journal: ${message}`)
}
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('corrupt record')
  const result = value as Record<string, unknown>
  if (Object.keys(result).sort().join(',') !== [...fields].sort().join(','))
    fail('corrupt record fields')
  return result
}
function hashHex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    fail('invalid 32-byte identifier')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail('invalid revision or step index')
  return value
}
function parseSession(value: unknown): SigningSessionBinding {
  const row = object(value, ['sessionIdHex', 'digestHex'])
  return {
    sessionIdHex: hashHex(row.sessionIdHex),
    digestHex: hashHex(row.digestHex),
  }
}
function parseBinding(value: unknown): SigningKeyBinding {
  const row = object(value, [
    'keyId',
    'localPublicShareHex',
    'termsHashHex',
    'role',
    'allowedSessions',
  ])
  if (
    typeof row.keyId !== 'string' ||
    row.keyId.length === 0 ||
    row.keyId.length > 256
  )
    fail('invalid key identity')
  if (
    typeof row.localPublicShareHex !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(row.localPublicShareHex)
  )
    fail('invalid public share identity')
  try {
    secp256k1.ProjectivePoint.fromHex(row.localPublicShareHex).assertValidity()
  } catch {
    fail('invalid public share point')
  }
  if (row.role !== 'initiator' && row.role !== 'responder') fail('invalid role')
  if (
    !Array.isArray(row.allowedSessions) ||
    row.allowedSessions.length < 1 ||
    row.allowedSessions.length > 2
  )
    fail('expected one or two predeclared sessions')
  const allowedSessions = row.allowedSessions.map(parseSession)
  if (
    new Set(allowedSessions.map(session => session.sessionIdHex)).size !==
      allowedSessions.length ||
    new Set(allowedSessions.map(session => session.digestHex)).size !==
      allowedSessions.length
  )
    fail('duplicate allowed session or digest')
  return {
    keyId: row.keyId,
    localPublicShareHex: row.localPublicShareHex,
    termsHashHex: hashHex(row.termsHashHex),
    role: row.role,
    allowedSessions,
  }
}
function terminal(session: SessionHistory): boolean {
  return session.steps.at(-1)?.terminal === true
}
function parseRecord(text: string, key: string): SigningUncertaintyRecord {
  const row = object(JSON.parse(text), [
    'schemaVersion',
    'binding',
    'revision',
    'sessions',
    'state',
  ])
  if (row.schemaVersion !== 1) fail('unsupported schema version')
  const binding = parseBinding(row.binding)
  if (key !== binding.localPublicShareHex)
    fail('record key/public share mismatch')
  if (
    !Array.isArray(row.sessions) ||
    row.sessions.length > binding.allowedSessions.length
  )
    fail('corrupt session history')
  const seenSessions = new Set<string>()
  const seenFrames = new Set<string>()
  const sessions = row.sessions.map((value): SessionHistory => {
    const session = object(value, ['sessionIdHex', 'steps'])
    const sessionIdHex = hashHex(session.sessionIdHex)
    if (
      seenSessions.has(sessionIdHex) ||
      !binding.allowedSessions.some(
        allowed => allowed.sessionIdHex === sessionIdHex,
      ) ||
      !Array.isArray(session.steps)
    )
      fail('corrupt session history')
    seenSessions.add(sessionIdHex)
    const rawSteps = session.steps
    const steps = rawSteps.map((value, index): StepReceipt => {
      const step = object(value, [
        'frameHashHex',
        'artifactHashHex',
        'terminal',
      ])
      const frameHashHex = hashHex(step.frameHashHex)
      if (
        seenFrames.has(frameHashHex) ||
        typeof step.terminal !== 'boolean' ||
        (step.terminal && index !== rawSteps.length - 1)
      )
        fail('corrupt step history')
      seenFrames.add(frameHashHex)
      return {
        frameHashHex,
        artifactHashHex: hashHex(step.artifactHashHex),
        terminal: step.terminal,
      }
    })
    return { sessionIdHex, steps }
  })
  if (sessions.slice(0, -1).some(session => !terminal(session)))
    fail('nonsequential session history')
  const state = row.state as Record<string, unknown> | null
  let parsedState: SigningState
  switch (state?.kind) {
    case 'ready':
      object(state, ['kind'])
      if (sessions.some(session => !terminal(session)))
        fail('incomplete ready record')
      parsedState = { kind: 'ready' }
      break
    case 'active':
    case 'step-in-progress': {
      const progressing = state.kind === 'step-in-progress'
      object(
        state,
        progressing
          ? ['kind', 'sessionIdHex', 'stepIndex', 'frameHashHex']
          : ['kind', 'sessionIdHex'],
      )
      const sessionIdHex = hashHex(state.sessionIdHex)
      const current = sessions.at(-1)
      if (
        !current ||
        current.sessionIdHex !== sessionIdHex ||
        terminal(current)
      )
        fail('invalid active session')
      if (progressing) {
        const stepIndex = integer(state.stepIndex)
        const frameHashHex = hashHex(state.frameHashHex)
        if (stepIndex !== current.steps.length || seenFrames.has(frameHashHex))
          fail('invalid pending step')
        parsedState = {
          kind: 'step-in-progress',
          sessionIdHex,
          stepIndex,
          frameHashHex,
        }
      } else parsedState = { kind: 'active', sessionIdHex }
      break
    }
    case 'retired':
      object(state, ['kind', 'reason'])
      if (state.reason !== 'explicit' && state.reason !== 'step-failed')
        fail('invalid retirement reason')
      parsedState = { kind: 'retired', reason: state.reason }
      break
    default:
      fail('corrupt signing state')
  }
  return {
    schemaVersion: 1,
    binding,
    revision: integer(row.revision),
    sessions,
    state: parsedState,
  }
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function digest(bytes: Uint8Array): string {
  return Buffer.from(sha256(bytes)).toString('hex')
}
function advance(record: SigningUncertaintyRecord): number {
  return integer(record.revision + 1)
}

/** Internal native-Level predecessor. No production export/composition and no nonce resume. */
export class SigningUncertaintyJournal {
  private readonly records = new Map<string, SigningUncertaintyRecord>()
  // Derived index; the public-share row is the sole durable owner.
  private readonly keyIds = new Map<string, string>()
  private readonly quarantined = new Set<string>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private closed = false

  private constructor(
    private readonly db: LevelDB,
    private readonly writable: boolean,
  ) {}

  static create(location: string): Promise<SigningUncertaintyJournal> {
    return this.open(location, 'create')
  }
  static openForMutation(location: string): Promise<SigningUncertaintyJournal> {
    return this.open(location, 'mutation')
  }
  static openReadOnly(location: string): Promise<SigningUncertaintyJournal> {
    return this.open(location, 'read-only')
  }
  private static async open(
    location: string,
    mode: 'create' | 'mutation' | 'read-only',
  ): Promise<SigningUncertaintyJournal> {
    // C0 has no qualified browser host. In particular, probing absent IndexedDB must not create it.
    if (typeof window !== 'undefined')
      fail('native Level host required; browser custody unsupported')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync } = require('fs') as typeof import('fs')
    const path = join(location, COMPONENT)
    if (!existsSync(path) && mode !== 'create') fail('namespace missing')
    if (existsSync(path) && mode === 'create') fail('namespace already exists')
    // Supply a callback so auto-open failures do not become unhandled Level error events.
    let db!: LevelDB
    let opened = false
    const initialOpen = new Promise<void>((resolve, reject) => {
      db = level(path, { createIfMissing: mode === 'create' }, error => {
        if (error) reject(error)
        else {
          opened = true
          resolve()
        }
      })
    })
    const journal = new SigningUncertaintyJournal(db, mode !== 'read-only')
    try {
      // Level 7's second open waits only for success while auto-open is pending.
      // Observe its initial callback as well so lock/corruption failures reject.
      await Promise.all([
        initialOpen,
        openDurableLevel(db, location, COMPONENT),
      ])
      for await (const [key, value] of db.iterator()) {
        const record = parseRecord(value, key)
        if (journal.keyIds.has(record.binding.keyId))
          fail('duplicate opaque key identity')
        journal.records.set(key, record)
        journal.keyIds.set(record.binding.keyId, key)
        // A completed row cannot distinguish an acknowledged terminal commit from
        // a committed-but-rejected write followed by a failed tombstone. C0
        // deliberately permits further sessions only in this live owner.
        if (record.sessions.length > 0) journal.quarantined.add(key)
      }
      return journal
    } catch (error) {
      if (opened) await db.close().catch(() => {})
      throw error
    }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.db.close()
  }
  inspect(
    bindingInput: SigningKeyBinding,
  ): SigningUncertaintyInspection | undefined {
    if (this.closed) fail('closed')
    const binding = parseBinding(bindingInput)
    const record = this.records.get(binding.localPublicShareHex)
    if (!record) {
      if (this.quarantined.has(binding.localPublicShareHex))
        fail('admission commit uncertain; key quarantined')
      return undefined
    }
    this.match(record, binding)
    const refusal =
      record.state.kind === 'retired'
        ? 'retired'
        : record.state.kind === 'step-in-progress'
        ? 'step-uncertain'
        : this.quarantined.has(binding.localPublicShareHex)
        ? record.state.kind === 'active'
          ? 'interrupted-session'
          : 'key-quarantined'
        : record.state.kind === 'ready' &&
          record.sessions.length === binding.allowedSessions.length
        ? 'sessions-exhausted'
        : undefined
    return {
      record: copy(record),
      usable: refusal === undefined,
      ...(refusal ? { refusal } : {}),
    }
  }
  private match(
    record: SigningUncertaintyRecord,
    binding: SigningKeyBinding,
  ): void {
    if (JSON.stringify(record.binding) !== JSON.stringify(binding))
      fail('immutable binding mismatch')
  }
  private requireRecord(
    binding: SigningKeyBinding,
    revision: number,
    allowRetirement = false,
  ): SigningUncertaintyRecord {
    if (this.closed || !this.writable) fail('closed or read-only')
    const record = this.records.get(binding.localPublicShareHex)
    if (!record) fail('key record missing')
    this.match(record, binding)
    if (record.revision !== integer(revision)) fail('stale revision')
    if (
      !allowRetirement &&
      (this.quarantined.has(binding.localPublicShareHex) ||
        record.state.kind === 'retired')
    )
      fail('key quarantined or retired')
    return record
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(action)
    this.queues.set(key, next)
    void next
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key)
      })
      .catch(() => {})
    return next
  }
  private async commit(record: SigningUncertaintyRecord): Promise<void> {
    try {
      await durablePut(
        this.db,
        record.binding.localPublicShareHex,
        JSON.stringify(record),
      )
      this.records.set(record.binding.localPublicShareHex, record)
    } catch {
      this.quarantined.add(record.binding.localPublicShareHex)
      fail('durable commit uncertain; key quarantined')
    }
  }
  async createKey(
    input: SigningKeyBinding,
  ): Promise<SigningUncertaintyInspection> {
    const binding = parseBinding(input)
    // Only new binding admission shares this short namespace queue; signer work never does.
    return this.serial('create', async () => {
      if (this.closed || !this.writable) fail('closed or read-only')
      if (
        this.records.has(binding.localPublicShareHex) ||
        this.quarantined.has(binding.localPublicShareHex) ||
        this.keyIds.has(binding.keyId)
      )
        fail('key or public share identity already admitted')
      this.keyIds.set(binding.keyId, binding.localPublicShareHex)
      await this.commit({
        schemaVersion: 1,
        binding,
        revision: 0,
        sessions: [],
        state: { kind: 'ready' },
      })
      return this.inspect(binding)!
    })
  }
  async beginSession(
    input: SigningKeyBinding,
    sessionInput: SigningSessionBinding,
    expectedRevision: number,
  ): Promise<SigningUncertaintyInspection> {
    const binding = parseBinding(input)
    const session = parseSession(sessionInput)
    return this.serial(binding.localPublicShareHex, async () => {
      const record = this.requireRecord(binding, expectedRevision)
      if (
        !binding.allowedSessions.some(
          allowed => JSON.stringify(allowed) === JSON.stringify(session),
        )
      )
        fail('session/digest not predeclared')
      if (
        record.state.kind !== 'ready' ||
        record.sessions.some(used => used.sessionIdHex === session.sessionIdHex)
      )
        fail('active or consumed session')
      await this.commit({
        ...record,
        revision: advance(record),
        sessions: [
          ...record.sessions,
          { sessionIdHex: session.sessionIdHex, steps: [] },
        ],
        state: { kind: 'active', sessionIdHex: session.sessionIdHex },
      })
      return this.inspect(binding)!
    })
  }
  /** The trusted callback performs local signing computation only. It must throw on a
   * primitive failure and must never send, log, persist or fund with its output. */
  async runGuardedStep(
    input: SigningKeyBinding,
    sessionInput: SigningSessionBinding,
    expectedRevision: number,
    stepIndex: number,
    authenticatedFrame: Uint8Array,
    signer: (
      frame: Uint8Array,
    ) =>
      | Promise<{ output: Uint8Array; terminal: boolean }>
      | { output: Uint8Array; terminal: boolean },
  ): Promise<{ output: Uint8Array; revision: number }> {
    const binding = parseBinding(input)
    const session = parseSession(sessionInput)
    if (!(authenticatedFrame instanceof Uint8Array))
      fail('invalid authenticated frame bytes')
    const frame = Uint8Array.from(authenticatedFrame)
    const frameHashHex = digest(frame)
    const pending = await this.serial(binding.localPublicShareHex, async () => {
      const record = this.requireRecord(binding, expectedRevision)
      if (
        !binding.allowedSessions.some(
          allowed => JSON.stringify(allowed) === JSON.stringify(session),
        ) ||
        record.state.kind !== 'active' ||
        record.state.sessionIdHex !== session.sessionIdHex
      )
        fail('session/digest mismatch or step already in progress')
      if (
        integer(stepIndex) !== record.sessions.at(-1)!.steps.length ||
        record.sessions.some(used =>
          used.steps.some(step => step.frameHashHex === frameHashHex),
        )
      )
        fail('duplicate frame or out-of-order step')
      const next: SigningUncertaintyRecord = {
        ...record,
        revision: advance(record),
        state: {
          kind: 'step-in-progress',
          sessionIdHex: session.sessionIdHex,
          stepIndex,
          frameHashHex,
        },
      }
      await this.commit(next)
      return next
    })
    let lastAttemptRevision = pending.revision
    try {
      // Close/retirement can occur while the durable pre-step write is awaiting acknowledgment.
      this.requireRecord(binding, pending.revision)
      const result = await signer(frame)
      if (
        !(result.output instanceof Uint8Array) ||
        typeof result.terminal !== 'boolean'
      )
        fail('invalid local signer result')
      const output = Uint8Array.from(result.output)
      const receipt: StepReceipt = {
        frameHashHex,
        artifactHashHex: digest(output),
        terminal: result.terminal,
      }
      return await this.serial(binding.localPublicShareHex, async () => {
        const record = this.requireRecord(binding, pending.revision)
        if (record.state.kind !== 'step-in-progress') fail('pending step lost')
        const current = record.sessions.at(-1)!
        const next: SigningUncertaintyRecord = {
          ...record,
          revision: advance(record),
          sessions: [
            ...record.sessions.slice(0, -1),
            { ...current, steps: [...current.steps, receipt] },
          ],
          state: receipt.terminal
            ? { kind: 'ready' }
            : { kind: 'active', sessionIdHex: session.sessionIdHex },
        }
        lastAttemptRevision = next.revision
        await this.commit(next)
        this.requireRecord(binding, next.revision)
        return { output, revision: next.revision }
      })
    } catch {
      this.quarantined.add(binding.localPublicShareHex)
      await this.serial(binding.localPublicShareHex, async () => {
        if (this.closed) return
        const record = this.records.get(binding.localPublicShareHex)!
        if (record.state.kind !== 'retired')
          await this.commit({
            ...record,
            // An unacknowledged success write may have committed its revision.
            revision: integer(
              Math.max(record.revision, lastAttemptRevision) + 1,
            ),
            state: { kind: 'retired', reason: 'step-failed' },
          })
      }).catch(() => {})
      fail('signer or success commit failed; key quarantined')
    }
  }
  async retire(
    input: SigningKeyBinding,
    expectedRevision: number,
  ): Promise<void> {
    const binding = parseBinding(input)
    // Validate before closing authority; a mismatched caller cannot retire another binding.
    this.requireRecord(binding, expectedRevision, true)
    this.quarantined.add(binding.localPublicShareHex)
    await this.serial(binding.localPublicShareHex, async () => {
      const record = this.requireRecord(binding, expectedRevision, true)
      if (record.state.kind !== 'retired')
        await this.commit({
          ...record,
          revision: advance(record),
          state: { kind: 'retired', reason: 'explicit' },
        })
    })
  }
}
