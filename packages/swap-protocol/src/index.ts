import { sha256 } from '@noble/hashes/sha256.js'

const ZERO32 = new Uint8Array(32)
const MAX_PREREQUISITES = 32
const MAX_PAYLOAD_BYTES = 65_536
const MAX_PARTICIPANTS = 8
const ORDINARY_EVENT_BUDGET = 24
const SAFETY_EVENT_BUDGET = 8

export type SwapProtocolErrorCode =
  | 'bad-format'
  | 'bad-length'
  | 'bad-version'
  | 'non-canonical'
  | 'wrong-context'
  | 'unknown-sender'
  | 'unknown-message-type'
  | 'unauthorized-producer'
  | 'invalid-signature'
  | 'budget-exhausted'
  | 'equivocation'
  | 'transition-rejected'

export interface SwapProtocolError {
  readonly code: SwapProtocolErrorCode
  readonly detail?: string
}

export type SwapResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SwapProtocolError }

export interface UnsignedSwapEventCore {
  readonly protocolVersion: 1
  readonly swapId: Uint8Array
  readonly laneId: number
  readonly messageType: number
  readonly senderKeyId: Uint8Array
  readonly senderRole: number
  readonly sequence: bigint
  readonly previousEventHash: Uint8Array
  readonly prerequisiteEventIds: readonly Uint8Array[]
  readonly payload: Uint8Array
}

export interface SignedSwapEvent extends UnsignedSwapEventCore {
  readonly eventId: Uint8Array
  readonly signatureAlgorithm: number
  readonly signature: Uint8Array
}

export type EventBudgetClass = 'ordinary' | 'safety'

export interface SwapParticipant {
  readonly keyId: Uint8Array
  readonly role: number
}

export interface SwapSemanticEffect {
  /** A manifest-defined semantic slot. The same slot cannot acquire two different values. */
  readonly key: string
  readonly value: Uint8Array
}

export interface SwapMessageDescriptor<State> {
  readonly budget: EventBudgetClass
  readonly producerRoles: readonly number[]
  readonly effect: (event: SignedSwapEvent) => SwapResult<SwapSemanticEffect>
  readonly transition: (
    state: State,
    event: SignedSwapEvent,
  ) =>
    | { readonly disposition: 'apply'; readonly state: State }
    | { readonly disposition: 'buffer' }
    | { readonly disposition: 'reject'; readonly detail: string }
    | { readonly disposition: 'violation'; readonly detail: string }
}

export interface SwapManifest<State> {
  readonly swapId: Uint8Array
  readonly laneId: number
  readonly participants: readonly SwapParticipant[]
  readonly messageTypes: ReadonlyMap<number, SwapMessageDescriptor<State>>
  readonly initialState: State
  readonly verifySignature: (
    event: SignedSwapEvent,
    signaturePreimage: Uint8Array,
  ) => boolean
}

export interface ReducedSwapJournal<State> {
  readonly state: State
  readonly applied: readonly SignedSwapEvent[]
  readonly buffered: readonly SignedSwapEvent[]
  readonly ignored: readonly SignedSwapEvent[]
  readonly effects: ReadonlyMap<string, Uint8Array>
  readonly violation: SwapProtocolError | null
}

export interface LocalSafetySnapshot {
  /** True after this party durably releases ReadyToFund. */
  readonly readyToFundReleased: boolean
  /** True after any unilateral funding authorization may have escaped locally. */
  readonly fundingAuthorizationReleased: boolean
  /** A concrete claim, refund, salvage, or monitoring plan retained after the cutoff. */
  readonly recoveryPlan: 'claim' | 'refund' | 'salvage' | 'monitor' | null
}

export type LocalExitAction = 'terminal-cancel' | 'stop-and-enter-recovery'

function failure<T>(
  code: SwapProtocolErrorCode,
  detail?: string,
): SwapResult<T> {
  return { ok: false, error: { code, ...(detail ? { detail } : {}) } }
}

function success<T>(value: T): SwapResult<T> {
  return { ok: true, value }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function copy(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function keyOf(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16(value: number): Uint8Array {
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff)
}

function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  )
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  let remaining = value
  for (let index = 7; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  )
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0)
  }
  return value
}

function ascii(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) throw new Error('frame tag must be ASCII')
    out[index] = code
  }
  return out
}

/** Exact framing helper from the atomic-swap specification. */
export function frame(tag: string, payload: Uint8Array): Uint8Array {
  const tagBytes = ascii(tag)
  if (tagBytes.length > 0xffff || payload.length > 0xffffffff) {
    throw new Error('frame component exceeds its canonical length field')
  }
  return concat(u16(tagBytes.length), tagBytes, u32(payload.length), payload)
}

function validateCore(core: UnsignedSwapEventCore): SwapResult<true> {
  if (core.protocolVersion !== 1) return failure('bad-version')
  if (!isUint8Array(core.swapId) || core.swapId.length !== 32) {
    return failure('bad-length', 'swapId')
  }
  if (!Number.isInteger(core.laneId) || core.laneId < 0 || core.laneId > 0xff) {
    return failure('bad-format', 'laneId')
  }
  if (
    !Number.isInteger(core.messageType) ||
    core.messageType < 0 ||
    core.messageType > 0xffff
  ) {
    return failure('bad-format', 'messageType')
  }
  if (!isUint8Array(core.senderKeyId) || core.senderKeyId.length !== 32) {
    return failure('bad-length', 'senderKeyId')
  }
  if (
    !Number.isInteger(core.senderRole) ||
    core.senderRole < 0 ||
    core.senderRole > 0xff
  ) {
    return failure('bad-format', 'senderRole')
  }
  if (
    typeof core.sequence !== 'bigint' ||
    core.sequence < 0n ||
    core.sequence > 0xffffffffffffffffn
  ) {
    return failure('bad-format', 'sequence')
  }
  if (
    !isUint8Array(core.previousEventHash) ||
    core.previousEventHash.length !== 32
  ) {
    return failure('bad-length', 'previousEventHash')
  }
  if (
    !Array.isArray(core.prerequisiteEventIds) ||
    core.prerequisiteEventIds.length > MAX_PREREQUISITES
  ) {
    return failure('bad-format', 'prerequisites')
  }
  let previous: Uint8Array | undefined
  for (const prerequisite of core.prerequisiteEventIds) {
    if (!isUint8Array(prerequisite) || prerequisite.length !== 32) {
      return failure('bad-length', 'prerequisite')
    }
    if (previous && compareBytes(previous, prerequisite) >= 0) {
      return failure('non-canonical', 'prerequisites must be sorted and unique')
    }
    previous = prerequisite
  }
  if (!isUint8Array(core.payload) || core.payload.length > MAX_PAYLOAD_BYTES) {
    return failure('bad-length', 'payload')
  }
  if (
    (core.sequence === 0n && !equal(core.previousEventHash, ZERO32)) ||
    (core.sequence !== 0n && equal(core.previousEventHash, ZERO32))
  ) {
    return failure('non-canonical', 'sender chain head')
  }
  return success(true)
}

/** Encodes the exact v1 unsigned event core, including its payload digest. */
export function encodeUnsignedSwapEventCore(
  core: UnsignedSwapEventCore,
): SwapResult<Uint8Array> {
  const valid = validateCore(core)
  if (!valid.ok) return valid
  return success(
    concat(
      u16(core.protocolVersion),
      copy(core.swapId),
      Uint8Array.of(core.laneId),
      u16(core.messageType),
      copy(core.senderKeyId),
      Uint8Array.of(core.senderRole),
      u64(core.sequence),
      copy(core.previousEventHash),
      Uint8Array.of(core.prerequisiteEventIds.length),
      ...core.prerequisiteEventIds.map(copy),
      u32(core.payload.length),
      copy(core.payload),
      sha256(core.payload),
    ),
  )
}

export function eventIdForCore(
  core: UnsignedSwapEventCore,
): SwapResult<Uint8Array> {
  const encoded = encodeUnsignedSwapEventCore(core)
  if (!encoded.ok) return encoded
  return success(sha256(frame('frank/swap-event-id/v1', encoded.value)))
}

export function signaturePreimageForCore(
  core: UnsignedSwapEventCore,
): SwapResult<Uint8Array> {
  const encoded = encodeUnsignedSwapEventCore(core)
  if (!encoded.ok) return encoded
  const eventId = sha256(frame('frank/swap-event-id/v1', encoded.value))
  return success(
    frame('frank/swap-event-signature/v1', concat(encoded.value, eventId)),
  )
}

export function createSignedSwapEvent(params: {
  readonly core: UnsignedSwapEventCore
  readonly signatureAlgorithm: number
  readonly sign: (preimage: Uint8Array) => Uint8Array
}): SwapResult<SignedSwapEvent> {
  if (
    !Number.isInteger(params.signatureAlgorithm) ||
    params.signatureAlgorithm < 0 ||
    params.signatureAlgorithm > 0xffff
  ) {
    return failure('bad-format', 'signatureAlgorithm')
  }
  const encoded = encodeUnsignedSwapEventCore(params.core)
  if (!encoded.ok) return encoded
  const eventId = sha256(frame('frank/swap-event-id/v1', encoded.value))
  let signature: Uint8Array
  try {
    signature = params.sign(
      frame('frank/swap-event-signature/v1', concat(encoded.value, eventId)),
    )
  } catch {
    return failure('invalid-signature')
  }
  if (!isUint8Array(signature) || signature.length > 0xffff) {
    return failure('bad-length', 'signature')
  }
  return success({
    ...params.core,
    swapId: copy(params.core.swapId),
    senderKeyId: copy(params.core.senderKeyId),
    previousEventHash: copy(params.core.previousEventHash),
    prerequisiteEventIds: params.core.prerequisiteEventIds.map(copy),
    payload: copy(params.core.payload),
    eventId,
    signatureAlgorithm: params.signatureAlgorithm,
    signature: copy(signature),
  })
}

export function encodeSignedSwapEvent(
  event: SignedSwapEvent,
): SwapResult<Uint8Array> {
  const encoded = encodeUnsignedSwapEventCore(event)
  if (!encoded.ok) return encoded
  const expectedId = sha256(frame('frank/swap-event-id/v1', encoded.value))
  if (!isUint8Array(event.eventId) || !equal(event.eventId, expectedId)) {
    return failure('non-canonical', 'eventId')
  }
  if (
    !Number.isInteger(event.signatureAlgorithm) ||
    event.signatureAlgorithm < 0 ||
    event.signatureAlgorithm > 0xffff ||
    !isUint8Array(event.signature) ||
    event.signature.length > 0xffff
  ) {
    return failure('bad-format', 'signature')
  }
  return success(
    concat(
      encoded.value,
      event.eventId,
      u16(event.signatureAlgorithm),
      u16(event.signature.length),
      event.signature,
    ),
  )
}

export function decodeSignedSwapEvent(
  bytes: Uint8Array,
): SwapResult<SignedSwapEvent> {
  if (!isUint8Array(bytes)) return failure('bad-format')
  const minimum = 2 + 32 + 1 + 2 + 32 + 1 + 8 + 32 + 1 + 4 + 32 + 32 + 2 + 2
  if (bytes.length < minimum) return failure('bad-length')
  let offset = 0
  const protocolVersion = readU16(bytes, offset)
  offset += 2
  if (protocolVersion !== 1) return failure('bad-version')
  const swapId = bytes.slice(offset, offset + 32)
  offset += 32
  const laneId = bytes[offset] ?? 0
  offset += 1
  const messageType = readU16(bytes, offset)
  offset += 2
  const senderKeyId = bytes.slice(offset, offset + 32)
  offset += 32
  const senderRole = bytes[offset] ?? 0
  offset += 1
  const sequence = readU64(bytes, offset)
  offset += 8
  const previousEventHash = bytes.slice(offset, offset + 32)
  offset += 32
  const prerequisiteCount = bytes[offset] ?? 0
  offset += 1
  if (prerequisiteCount > MAX_PREREQUISITES) return failure('bad-format')
  const prerequisiteBytes = prerequisiteCount * 32
  if (offset + prerequisiteBytes + 4 + 32 + 32 + 4 > bytes.length) {
    return failure('bad-length')
  }
  const prerequisiteEventIds: Uint8Array[] = []
  for (let index = 0; index < prerequisiteCount; index += 1) {
    prerequisiteEventIds.push(bytes.slice(offset, offset + 32))
    offset += 32
  }
  const payloadLength = readU32(bytes, offset)
  offset += 4
  if (
    payloadLength > MAX_PAYLOAD_BYTES ||
    offset + payloadLength + 32 + 36 > bytes.length
  ) {
    return failure('bad-length')
  }
  const payload = bytes.slice(offset, offset + payloadLength)
  offset += payloadLength
  const payloadHash = bytes.slice(offset, offset + 32)
  offset += 32
  if (!equal(payloadHash, sha256(payload))) {
    return failure('non-canonical', 'payload hash')
  }
  const core: UnsignedSwapEventCore = {
    protocolVersion: 1,
    swapId,
    laneId,
    messageType,
    senderKeyId,
    senderRole,
    sequence,
    previousEventHash,
    prerequisiteEventIds,
    payload,
  }
  const valid = validateCore(core)
  if (!valid.ok) return valid
  const eventId = bytes.slice(offset, offset + 32)
  offset += 32
  const signatureAlgorithm = readU16(bytes, offset)
  offset += 2
  const signatureLength = readU16(bytes, offset)
  offset += 2
  if (offset + signatureLength !== bytes.length) return failure('bad-length')
  const signature = bytes.slice(offset)
  const expectedId = eventIdForCore(core)
  if (!expectedId.ok || !equal(eventId, expectedId.value)) {
    return failure('non-canonical', 'eventId')
  }
  return success({ ...core, eventId, signatureAlgorithm, signature })
}

function signaturePreimage(event: SignedSwapEvent): Uint8Array | null {
  const encoded = encodeUnsignedSwapEventCore(event)
  if (!encoded.ok) return null
  return frame(
    'frank/swap-event-signature/v1',
    concat(encoded.value, event.eventId),
  )
}

function validateManifest<State>(
  manifest: SwapManifest<State>,
): SwapResult<true> {
  if (!isUint8Array(manifest.swapId) || manifest.swapId.length !== 32) {
    return failure('bad-length', 'manifest swapId')
  }
  if (
    !Number.isInteger(manifest.laneId) ||
    manifest.laneId < 0 ||
    manifest.laneId > 0xff ||
    manifest.participants.length === 0 ||
    manifest.participants.length > MAX_PARTICIPANTS
  ) {
    return failure('bad-format', 'manifest')
  }
  const keys = new Set<string>()
  const roles = new Set<number>()
  for (const participant of manifest.participants) {
    if (!isUint8Array(participant.keyId) || participant.keyId.length !== 32) {
      return failure('bad-length', 'participant key')
    }
    const key = keyOf(participant.keyId)
    if (keys.has(key) || roles.has(participant.role)) {
      return failure('non-canonical', 'participant')
    }
    keys.add(key)
    roles.add(participant.role)
  }
  return success(true)
}

/**
 * Validates sender chains, applies ready events in event-id order, and reports every buffered or
 * ignored input. It has no clock, network, storage, signing, or chain side effects.
 */
export function reduceSwapJournal<State>(
  encodedEvents: readonly Uint8Array[],
  manifest: SwapManifest<State>,
): SwapResult<ReducedSwapJournal<State>> {
  const validManifest = validateManifest(manifest)
  if (!validManifest.ok) return validManifest
  const participants = new Map(
    manifest.participants.map(participant => [
      keyOf(participant.keyId),
      participant,
    ]),
  )
  const unique = new Map<string, SignedSwapEvent>()
  const ignored: SignedSwapEvent[] = []
  for (const encoded of encodedEvents) {
    const decoded = decodeSignedSwapEvent(encoded)
    if (!decoded.ok) return decoded
    const event = decoded.value
    if (
      !equal(event.swapId, manifest.swapId) ||
      event.laneId !== manifest.laneId
    ) {
      return failure('wrong-context')
    }
    const participant = participants.get(keyOf(event.senderKeyId))
    if (!participant || participant.role !== event.senderRole) {
      return failure('unknown-sender')
    }
    const descriptor = manifest.messageTypes.get(event.messageType)
    if (!descriptor) return failure('unknown-message-type')
    if (!descriptor.producerRoles.includes(event.senderRole)) {
      return failure('unauthorized-producer')
    }
    const preimage = signaturePreimage(event)
    let signatureValid = false
    try {
      signatureValid =
        preimage !== null && manifest.verifySignature(event, preimage)
    } catch {
      signatureValid = false
    }
    if (!signatureValid) {
      return failure('invalid-signature')
    }
    const id = keyOf(event.eventId)
    if (unique.has(id)) continue
    unique.set(id, event)
  }

  const chainAccepted: SignedSwapEvent[] = []
  const chainBuffered = new Set<string>()
  let chainViolation: SwapProtocolError | null = null
  for (const participant of manifest.participants) {
    const senderEvents = Array.from(unique.values()).filter(event =>
      equal(event.senderKeyId, participant.keyId),
    )
    let sequence = 0n
    let previous: Uint8Array = ZERO32
    let ordinary = 0
    let safety = 0
    for (;;) {
      const atSequence = senderEvents.filter(
        event => event.sequence === sequence,
      )
      if (atSequence.length === 0) break
      const admissible: SignedSwapEvent[] = []
      for (const event of atSequence) {
        const descriptor = manifest.messageTypes.get(event.messageType)!
        const exhausted =
          descriptor.budget === 'ordinary'
            ? ordinary >= ORDINARY_EVENT_BUDGET
            : safety >= SAFETY_EVENT_BUDGET
        if (exhausted) {
          ignored.push(event)
        } else {
          admissible.push(event)
        }
      }
      if (admissible.length === 0) break
      const successors = senderEvents.filter(event => {
        const descriptor = manifest.messageTypes.get(event.messageType)!
        const exhausted =
          descriptor.budget === 'ordinary'
            ? ordinary >= ORDINARY_EVENT_BUDGET
            : safety >= SAFETY_EVENT_BUDGET
        return !exhausted && equal(event.previousEventHash, previous)
      })
      if (admissible.length > 1 || successors.length > 1) {
        const conflicts = [...admissible, ...successors]
          .filter(
            (event, index, values) =>
              values.findIndex(candidate =>
                equal(candidate.eventId, event.eventId),
              ) === index,
          )
          .sort((a, b) => compareBytes(a.eventId, b.eventId))
        for (const conflict of conflicts) {
          chainBuffered.add(keyOf(conflict.eventId))
        }
        chainViolation ??= {
          code: 'equivocation',
          detail: `sender ${keyOf(participant.keyId)} sequence ${sequence}`,
        }
        break
      }
      const accepted = admissible[0]!
      if (!equal(accepted.previousEventHash, previous)) {
        chainBuffered.add(keyOf(accepted.eventId))
        break
      }
      chainAccepted.push(accepted)
      const descriptor = manifest.messageTypes.get(accepted.messageType)!
      if (descriptor.budget === 'ordinary') ordinary += 1
      else safety += 1
      previous = copy(accepted.eventId)
      sequence += 1n
    }
    for (const event of senderEvents) {
      if (!chainAccepted.includes(event) && !ignored.includes(event)) {
        chainBuffered.add(keyOf(event.eventId))
      }
    }
  }

  let state = manifest.initialState
  const applied: SignedSwapEvent[] = []
  const appliedIds = new Set<string>()
  const effects = new Map<string, Uint8Array>()
  const pending = chainAccepted.slice()
  let violation: SwapProtocolError | null = null
  for (;;) {
    const ready = pending
      .filter(
        event =>
          (event.sequence === 0n ||
            appliedIds.has(keyOf(event.previousEventHash))) &&
          event.prerequisiteEventIds.every(id => appliedIds.has(keyOf(id))),
      )
      .sort((a, b) => compareBytes(a.eventId, b.eventId))
    if (ready.length === 0) break
    let progressed = false
    for (const event of ready) {
      const descriptor = manifest.messageTypes.get(event.messageType)!
      const effect = descriptor.effect(event)
      if (!effect.ok) {
        violation = effect.error
        break
      }
      const prior = effects.get(effect.value.key)
      if (prior && !equal(prior, effect.value.value)) {
        violation = {
          code: 'equivocation',
          detail: `semantic slot ${effect.value.key}`,
        }
        break
      }
      if (prior) {
        applied.push(event)
        appliedIds.add(keyOf(event.eventId))
        pending.splice(pending.indexOf(event), 1)
        progressed = true
        continue
      }
      const transition = descriptor.transition(state, event)
      if (transition.disposition === 'buffer') continue
      if (transition.disposition === 'reject') {
        ignored.push(event)
        pending.splice(pending.indexOf(event), 1)
        progressed = true
        continue
      }
      if (transition.disposition === 'violation') {
        violation = {
          code: 'transition-rejected',
          detail: transition.detail,
        }
        break
      }
      state = transition.state
      effects.set(effect.value.key, copy(effect.value.value))
      applied.push(event)
      appliedIds.add(keyOf(event.eventId))
      pending.splice(pending.indexOf(event), 1)
      progressed = true
    }
    if (violation || !progressed) break
  }

  const buffered = [
    ...pending,
    ...Array.from(unique.values()).filter(event =>
      chainBuffered.has(keyOf(event.eventId)),
    ),
  ]
    .filter(
      (event, index, values) =>
        values.findIndex(candidate =>
          equal(candidate.eventId, event.eventId),
        ) === index,
    )
    .sort((a, b) => compareBytes(a.eventId, b.eventId))

  return success({
    state,
    applied,
    buffered,
    ignored,
    effects,
    violation: violation ?? chainViolation,
  })
}

/** The conservative local exit rule. Absence of an observation never restores terminal cancel. */
export function allowedLocalExit(
  snapshot: LocalSafetySnapshot,
): SwapResult<LocalExitAction> {
  const afterCutoff =
    snapshot.readyToFundReleased || snapshot.fundingAuthorizationReleased
  if (!afterCutoff) return success('terminal-cancel')
  if (snapshot.recoveryPlan === null) {
    return failure(
      'transition-rejected',
      'post-cutoff state has no retained recovery plan',
    )
  }
  return success('stop-and-enter-recovery')
}

export const swapProtocolLimits = Object.freeze({
  maxParticipants: MAX_PARTICIPANTS,
  maxPrerequisites: MAX_PREREQUISITES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  ordinaryEventsPerSender: ORDINARY_EVENT_BUDGET,
  safetyEventsPerSender: SAFETY_EVENT_BUDGET,
})

export * from './stage0'
