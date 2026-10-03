// Section 9 validation order, stages 1-9 plus stage 10.6 (the signature verification of the
// type-2 attestation). Stages 10.1-10.5 (the type-1 stamp checks: decrypted frame, T3, DLEQ,
// payment observations) are not implemented; a `full` type-1 root is a context error.
import { Counters, FrankValue, decodeSingleItem, newCounters } from './cbor'
import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_VERSION,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_ITEMS_TOTAL,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_TEXT_MESSAGE_ITEM,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
  U32_MAX,
} from './constants'
import {
  ErrorCategory,
  ErrorStage,
  FrankCodecError,
  FrankContextError,
} from './errors'
import {
  checkAllocated,
  checkRootFrameLimit,
  checkTypeLimits,
  parseDraft,
} from './schema'
import { checkSemantics } from './semantic'
import type {
  ChildFrame,
  DirectoryStatement,
  DraftPayload,
  FinalPayload,
  ParsedFrame,
  RetainedFrame,
  RetentionReason,
  ValidationResult,
} from './types'
import { verifyDirectoryAttestation } from './verify'

export type Operation = 'frame' | 'generic' | 'typed' | 'full'

export interface SupportedSchema {
  typeId: number
  /** The highest schema version this reader supports for the type (`1..highest`). */
  schemaVersion: number
}

/** The normative validation context of README section 10; no ambient state is consulted. */
export interface ValidationContext {
  /**
   * `frame` stops after stage 4, `generic` after stage 7, `typed` after stage 9. `full`
   * adds stage 10.6, the signature verification of a type-2 root; the type-1 stage-10
   * checks (10.1-10.5) are outside this slice and make a type-1 `full` root a context error.
   * Preview directory `full` also fails: trusted admission requires a separate stateful API.
   */
  operation: Operation
  /** Stage 1 caller limit, at most MAX_FRAME_BYTES. */
  routeByteLimit: number
  readerVersion: number
  supportedSchemas: readonly SupportedSchema[]
  /** Governs the root frame only (V6.1). */
  opaqueRetentionAllowed: boolean
  /**
   * For a type-2 root under `typed` or `full`: the last accepted type-4 frame, or `null` for
   * bootstrap. Required (not `undefined`) in that case; ignored for other roots.
   * Preview wrappers require null because this codec does not validate their history.
   */
  priorDirectoryStatementFrame?: Uint8Array | null
}

/** Types with a version-1 schema in this codec (README E5). */
export const KNOWN_TYPES: readonly number[] = [
  TYPE_DIRECT_MESSAGE_DELIVERY,
  TYPE_DIRECTORY_ATTESTATION,
  TYPE_MAILBOX_CHECKPOINT,
  TYPE_DIRECTORY_STATEMENT,
  TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
  TYPE_ENCRYPTED_MESSAGE_CONTENT,
  TYPE_KEY_TRANSITION_STATEMENT,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_TOPIC_POST,
  TYPE_TOPIC_POST_SUBMISSION,
  TYPE_TOPIC_VOTE_SUBMISSION,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_TEXT_MESSAGE_ITEM,
]

export function defaultContext(
  overrides: Partial<ValidationContext> = {},
): ValidationContext {
  return {
    operation: 'typed',
    routeByteLimit: MAX_FRAME_BYTES,
    // Reader version 2 reads type 4 at schema 3 and the production type-5 DM at schema 2.
    readerVersion: 2,
    supportedSchemas: KNOWN_TYPES.map(typeId => ({
      typeId,
      schemaVersion:
        typeId === TYPE_DIRECTORY_STATEMENT
          ? 3
          : typeId === TYPE_RECIPIENT_ENCRYPTED_PAYLOAD
          ? 2
          : 1,
    })),
    opaqueRetentionAllowed: false,
    priorDirectoryStatementFrame: null,
    ...overrides,
  }
}

type Mode =
  | { kind: 'root' }
  | { kind: 'open' }
  | { kind: 'required'; typeId: number }

interface Shared {
  ctx: ValidationContext
  supported: ReadonlyMap<number, number>
  counters: Counters
  /** R2: message items opened across the whole recursively opened graph. */
  itemsOpened: number
}

const fail = (
  category: ErrorCategory,
  stage: ErrorStage,
  message: string,
  location: string,
): FrankCodecError => new FrankCodecError(category, stage, message, location)

interface Envelope {
  typeId: number
  schemaVersion: number
  minReaderVersion: number
  payloadBytes: Uint8Array
}

/** Stage 6. */
function parseEnvelope(v: FrankValue, location: string): Envelope {
  const bad = (m: string) => fail('schema', '6', m, `${location}/envelope`)
  if (!(v instanceof Map)) throw bad('the envelope must be a map (E1)')
  if (v.size !== 4) throw bad('the envelope must have exactly keys 0..3 (E1)')
  for (const k of [0n, 1n, 2n, 3n])
    if (!v.has(k)) throw bad(`missing envelope key ${k} (E1)`)
  const u32 = (k: bigint, min: bigint): number => {
    const x = v.get(k)
    if (typeof x !== 'bigint')
      throw bad(`envelope key ${k} must be an unsigned integer`)
    if (x < min || x > BigInt(U32_MAX))
      throw bad(`envelope key ${k} out of range`)
    return Number(x)
  }
  const typeId = u32(0n, 0n)
  const schemaVersion = u32(1n, 1n)
  const minReaderVersion = u32(2n, 1n)
  const payloadBytes = v.get(3n)
  if (!(payloadBytes instanceof Uint8Array))
    throw bad('envelope payload must be a byte string')
  if (minReaderVersion > schemaVersion) {
    throw bad('min_reader_version exceeds schema_version (E2)')
  }
  return { typeId, schemaVersion, minReaderVersion, payloadBytes }
}

function retained(
  reason: RetentionReason,
  frame: Uint8Array,
  env?: Envelope,
): RetainedFrame {
  const r: RetainedFrame = { kind: 'retained', reason, frame }
  if (env) {
    r.typeId = env.typeId
    r.schemaVersion = env.schemaVersion
    r.minReaderVersion = env.minReaderVersion
  }
  return r
}

function processFrame(
  f: Uint8Array,
  mode: Mode,
  containerDepth: number,
  sh: Shared,
  location: string,
  stopAfter: Operation,
): ValidationResult {
  // Stage 2: header.
  if (f.length < FRAME_HEADER_BYTES)
    throw fail('frame', '2', 'fewer than nine header bytes', location)
  for (let i = 0; i < 4; i++) {
    if (f[i] !== FRAME_MAGIC[i])
      throw fail('frame', '2', 'bad magic (F1)', location)
  }
  // Stage 3: version.
  if (f[4] !== FRAME_VERSION) {
    if (mode.kind === 'required') {
      throw fail(
        'unsupported',
        '3',
        `unsupported frame version ${f[4]} (F2)`,
        location,
      )
    }
    if (mode.kind === 'open' || sh.ctx.opaqueRetentionAllowed) {
      return retained('unsupported-frame-version', f)
    }
    throw fail(
      'unsupported',
      '3',
      `unsupported frame version ${f[4]} (F2)`,
      location,
    )
  }
  // Stage 4: length.
  const declared = ((f[5] << 24) | (f[6] << 16) | (f[7] << 8) | f[8]) >>> 0
  if (declared !== f.length - FRAME_HEADER_BYTES) {
    throw fail(
      'frame',
      '4',
      `declared length ${declared} differs from the ${
        f.length - FRAME_HEADER_BYTES
      } bytes present (F3)`,
      location,
    )
  }
  if (mode.kind === 'root' && stopAfter === 'frame') {
    return {
      kind: 'frame',
      frame: f,
      version: f[4],
      body: f.subarray(FRAME_HEADER_BYTES),
    }
  }
  // Stage 5: envelope CBOR (passes A then B), sharing the operation's counters (R1).
  const envValue = decodeSingleItem(
    f.subarray(FRAME_HEADER_BYTES),
    { stage: '5', location: `${location}/envelope` },
    sh.counters,
    containerDepth,
  )
  // Stage 6: envelope keys, types, ranges.
  const env = parseEnvelope(envValue, location)
  if (mode.kind === 'required' && env.typeId !== mode.typeId) {
    throw fail(
      'semantic',
      '8.4',
      `a required-type field must carry type ${mode.typeId}, found ${env.typeId} (S8)`,
      location,
    )
  }
  if (mode.kind === 'open' && env.typeId >= 1 && env.typeId <= 11) {
    throw fail(
      'semantic',
      '8.4',
      `an open message-item field cannot carry assigned type ${env.typeId} (S8)`,
      location,
    )
  }
  // Stage 7: payload CBOR, then the V6 decision.
  const envDepth = containerDepth + 1
  const payload = decodeSingleItem(
    env.payloadBytes,
    { stage: '7', location: `${location}/payload` },
    sh.counters,
    envDepth,
  )
  const highest = KNOWN_TYPES.includes(env.typeId)
    ? sh.supported.get(env.typeId)
    : undefined
  const keep = (reason: RetentionReason, message: string): RetainedFrame => {
    if (mode.kind === 'required')
      throw fail('unsupported', '7', message, location)
    if (mode.kind === 'open' || sh.ctx.opaqueRetentionAllowed)
      return retained(reason, f, env)
    throw fail('unsupported', '7', message, location)
  }
  if (highest === undefined) {
    return keep(
      'unknown-type',
      `type ${env.typeId} is not known to this reader (V6.1)`,
    )
  }
  if (env.minReaderVersion > sh.ctx.readerVersion) {
    return keep(
      'unsupported-min-reader',
      `min_reader_version ${env.minReaderVersion} exceeds reader version (V6.1)`,
    )
  }
  if (
    env.typeId === TYPE_DIRECTORY_STATEMENT &&
    env.schemaVersion >= 4 &&
    env.minReaderVersion >= 4 &&
    highest < 4
  ) {
    throw fail(
      'unsupported',
      '7',
      'directory preview requires type-4 schema-4 support',
      location,
    )
  }
  if (
    env.typeId === TYPE_DIRECTORY_STATEMENT &&
    highest >= 4 &&
    env.schemaVersion >= 4 &&
    env.minReaderVersion !== 4
  ) {
    throw fail(
      'unsupported',
      '7',
      'directory preview requires min_reader_version 4',
      location,
    )
  }
  // Suite 1 authenticates the complete schema-2 field set. A future type-5 schema needs an
  // updated authenticated context before this reader may project or retain its extensions.
  if (
    env.typeId === TYPE_RECIPIENT_ENCRYPTED_PAYLOAD &&
    env.schemaVersion > highest
  ) {
    throw fail(
      'unsupported',
      '7',
      `type 5 schema ${env.schemaVersion} requires an updated authenticated context`,
      location,
    )
  }
  if (
    env.typeId === TYPE_RECIPIENT_ENCRYPTED_PAYLOAD &&
    env.schemaVersion === 2 &&
    env.minReaderVersion !== 2
  ) {
    throw fail(
      'unsupported',
      '7',
      'type 5 schema 2 requires min_reader_version 2',
      location,
    )
  }
  const projection = env.schemaVersion > highest ? 'newer-schema' : 'exact'
  const parsed: ParsedFrame = {
    kind: 'parsed',
    frame: f,
    typeId: env.typeId,
    schemaVersion: env.schemaVersion,
    minReaderVersion: env.minReaderVersion,
    payloadBytes: env.payloadBytes,
    payload,
    projection,
  }
  if (mode.kind === 'root' && stopAfter === 'generic') return parsed

  // Stage 8.1: type-specific limits.
  const effectiveSchema = Math.min(env.schemaVersion, highest)
  if (
    (mode.kind === 'root' ||
      (env.typeId === TYPE_DIRECTORY_STATEMENT && effectiveSchema >= 4)) &&
    !checkRootFrameLimit(env.typeId, f.length, effectiveSchema)
  ) {
    throw fail(
      'resource',
      '8.1',
      'frame exceeds its type-specific limit (R2/R3)',
      location,
    )
  }
  const draft = relocating(location, () => {
    checkTypeLimits(env.typeId, payload, env.schemaVersion)
    // Stage 8.2 and 8.3: structure, then allocated identifiers.
    const d = parseDraft(env.typeId, payload, projection === 'newer-schema', {
      envelope: env.schemaVersion,
      effective: Math.min(env.schemaVersion, highest),
    })
    checkAllocated(d)
    return d
  })
  // Stage 8.4: recursive opening of declared framed fields.
  const typed = openChildren(draft, envDepth, sh, location)
  // Stage 9: semantics. Only the root type-2 case consults the prior statement.
  const previewAttestation =
    typed.type === 2 &&
    typed.statementFrame.typed?.type === 4 &&
    typed.statementFrame.typed.preview !== undefined
  if (previewAttestation && sh.ctx.priorDirectoryStatementFrame !== null)
    throw new FrankContextError(
      'preview evidence does not validate directory history; use a null prior and perform trusted admission separately',
    )
  relocating(location, () =>
    checkSemantics(
      typed,
      typed.type === 2 && !previewAttestation
        ? resolvePrior(sh.ctx)
        : undefined,
    ),
  )
  parsed.typed = typed
  if (mode.kind === 'root' && stopAfter === 'full') runStage10(typed)
  return parsed
}

/** Stage 10 for a root frame. Only 10.6 exists in this slice; it applies to a type-2 root. */
function runStage10(typed: FinalPayload): void {
  if (
    (typed.type === 4 && typed.preview) ||
    (typed.type === 2 &&
      typed.statementFrame.typed?.type === 4 &&
      typed.statementFrame.typed.preview)
  )
    throw new FrankContextError(
      'full preview directory admission requires trusted anchor, history, clock, relay and atomic state; use verifyPreviewDirectoryEvidence for bounded signed evidence',
    )
  switch (typed.type) {
    case 2:
      verifyDirectoryAttestation(typed)
      return
    case 1:
      throw new FrankContextError(
        'stages 10.1-10.5 (the type-1 stamp checks) are outside this slice; `full` runs only the type-2 signature verification of stage 10.6',
      )
    default:
  }
}

/** Schema and semantic checks name paths relative to `root`; re-root them at this frame. */
function relocating<T>(location: string, f: () => T): T {
  try {
    return f()
  } catch (e) {
    if (
      e instanceof FrankCodecError &&
      location !== 'root' &&
      e.location.startsWith('root')
    ) {
      throw new FrankCodecError(
        e.category,
        e.stage,
        e.detail,
        location + e.location.slice('root'.length),
        e.pass,
      )
    }
    throw e
  }
}

function required(
  bytes: Uint8Array,
  typeId: number,
  containerDepth: number,
  sh: Shared,
  location: string,
): ParsedFrame {
  const r = processFrame(
    bytes,
    { kind: 'required', typeId },
    containerDepth,
    sh,
    location,
    'typed',
  )
  if (r.kind !== 'parsed')
    throw new Error('internal: required child was not parsed')
  return r
}

function openItems(
  items: Uint8Array[],
  containerDepth: number,
  sh: Shared,
  location: string,
): ChildFrame[] {
  const out: ChildFrame[] = []
  items.forEach((bytes, i) => {
    // R2: charged when 8.4 begins opening the child, before its stage 2.
    sh.itemsOpened += 1
    if (sh.itemsOpened > MAX_MESSAGE_ITEMS_TOTAL) {
      throw fail(
        'resource',
        '8.4',
        'more than 256 message items in the opened graph (R2)',
        location,
      )
    }
    const r = processFrame(
      bytes,
      { kind: 'open' },
      containerDepth,
      sh,
      `${location}[${i}]`,
      'typed',
    )
    if (r.kind === 'frame')
      throw new Error('internal: unexpected frame-only result')
    out.push(r)
  })
  return out
}

function openChildren(
  d: DraftPayload,
  envDepth: number,
  sh: Shared,
  loc: string,
): FinalPayload {
  const P = `${loc}/payload`
  switch (d.type) {
    case 1:
      return {
        ...d,
        payloadFrame: required(
          d.payloadFrame,
          TYPE_RECIPIENT_ENCRYPTED_PAYLOAD,
          envDepth + 1,
          sh,
          `${P}.2`,
        ),
      }
    case 2:
      return {
        ...d,
        statementFrame: required(
          d.statementFrame,
          TYPE_DIRECTORY_STATEMENT,
          envDepth + 1,
          sh,
          `${P}.0`,
        ),
      }
    case 4: {
      if (!d.keyTransitions) {
        return { ...d, keyTransitions: undefined }
      }
      return {
        ...d,
        keyTransitions: d.keyTransitions.map((t, i) => ({
          ...t,
          statementFrame: required(
            t.statementFrame,
            TYPE_KEY_TRANSITION_STATEMENT,
            envDepth + 3,
            sh,
            `${P}.5[${i}].0`,
          ),
        })),
      }
    }
    case 6:
      return {
        ...d,
        revisionFrame: required(
          d.revisionFrame,
          TYPE_MESSAGE_CONTENT_REVISION,
          envDepth + 1,
          sh,
          `${P}.2`,
        ),
      }
    case 10:
      return {
        ...d,
        postFrame: required(
          d.postFrame,
          TYPE_TOPIC_POST,
          envDepth + 1,
          sh,
          `${P}.1`,
        ),
      }
    case 8:
      return { ...d, items: openItems(d.items, envDepth + 2, sh, `${P}.1`) }
    case 16:
      return { ...d, items: openItems(d.items, envDepth + 2, sh, `${P}.0`) }
    default:
      return d
  }
}

function resolvePrior(
  ctx: ValidationContext,
): DirectoryStatement<ParsedFrame> | null {
  const prior = ctx.priorDirectoryStatementFrame
  if (prior === undefined) {
    throw new FrankContextError(
      'a type-2 root under `typed` needs priorDirectoryStatementFrame (null for bootstrap)',
    )
  }
  if (prior === null) return null
  let r: ValidationResult
  try {
    r = validateFrame(
      prior,
      defaultContext({
        supportedSchemas: ctx.supportedSchemas,
        readerVersion: ctx.readerVersion,
        opaqueRetentionAllowed: false,
        priorDirectoryStatementFrame: null,
      }),
    )
  } catch (e) {
    if (e instanceof FrankCodecError) {
      throw new FrankContextError(
        `the prior directory statement is invalid: ${e.message}`,
      )
    }
    throw e
  }
  if (r.kind !== 'parsed' || r.typed?.type !== 4) {
    throw new FrankContextError(
      'the prior directory statement is not a type-4 frame',
    )
  }
  return r.typed
}

/**
 * Runs section 9 up to `ctx.operation` and returns the result, or throws
 * {@link FrankCodecError} carrying the stable category and stage of the first failing check.
 * The input is copied once; the returned frames are views of that copy. On any failure nothing
 * partial is returned. No protobuf/JSON/BCS fallback ever occurs (F5).
 */
export function validateFrame(
  bytes: Uint8Array,
  ctx: ValidationContext = defaultContext(),
): ValidationResult {
  if (!Number.isInteger(ctx.routeByteLimit) || ctx.routeByteLimit < 1) {
    throw new FrankContextError('routeByteLimit must be a positive integer')
  }
  // Stage 1: root limits, before anything is copied or decoded.
  if (bytes.length > ctx.routeByteLimit || bytes.length > MAX_FRAME_BYTES) {
    throw fail(
      'resource',
      '1',
      `frame length ${bytes.length} exceeds a root limit`,
      'root',
    )
  }
  const supported = new Map<number, number>()
  for (const s of ctx.supportedSchemas) supported.set(s.typeId, s.schemaVersion)
  const sh: Shared = { ctx, supported, counters: newCounters(), itemsOpened: 0 }
  return processFrame(
    // A real copy: `slice()` on some Uint8Array subclasses returns a view of the caller's memory.
    new Uint8Array(bytes),
    { kind: 'root' },
    0,
    sh,
    'root',
    ctx.operation,
  )
}

/** Alias: parses a frame under `ctx` (default: typed, all v1 types, no root retention). */
export const parseFrame = validateFrame
