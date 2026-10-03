import {
  MAX_ARRAY_ELEMENTS,
  MAX_CONTAINERS,
  MAX_DEPTH,
  MAX_ITEMS,
  MAX_MAP_ENTRIES,
} from '@frank/codec'
import type {
  AccountRef,
  FrankValue,
  Timestamp,
  UnknownFields,
} from '@frank/codec'
import type {
  AdmissionErrorCode,
  Anchor,
  Candidate,
  Checkpoint,
  Context,
  HistoricalEvidence,
  OpenMode,
} from '../index'
import { fail, MAX_FRAME } from './history'

/** Copy only the bounded view into ordinary memory, never its entire backing buffer. */
export function ownBytes(
  value: Uint8Array,
  limit: number,
  code: AdmissionErrorCode,
  exact = false,
): Uint8Array {
  if (!(value instanceof Uint8Array)) fail(code)
  const length = value.byteLength
  if (length > limit || (exact && length !== limit)) fail(code)
  const owned = new Uint8Array(length)
  owned.set(new Uint8Array(value.buffer, value.byteOffset, length))
  return owned
}
export function ownTime(value: Timestamp): Timestamp {
  return { seconds: value.seconds, nanoseconds: value.nanoseconds }
}
export function ownPoint(
  value: AccountRef,
  code: AdmissionErrorCode,
): AccountRef {
  if (!value) fail(code)
  return {
    keyType: value.keyType,
    keyBytes: ownBytes(value.keyBytes, 33, code, true),
  }
}
export function ownAnchor(value: Anchor): Anchor {
  if (!value) fail('anchor')
  return {
    network: value.network,
    subject: ownPoint(value.subject, 'anchor'),
    revisionZero: ownBytes(value.revisionZero, 32, 'anchor', true),
  }
}
export function ownMode(mode: OpenMode): OpenMode {
  if (mode?.kind === 'new') return { kind: 'new' }
  if (mode?.kind !== 'reopen' || !mode.checkpoint) fail('continuity')
  const c = mode.checkpoint
  if (!c.checkedTime) fail('continuity')
  const checkpoint: Checkpoint = {
    kind: c.kind,
    identity: ownBytes(c.identity, 32, 'continuity', true),
    anchor: ownBytes(c.anchor, 32, 'continuity', true),
    head: c.head === null ? null : ownBytes(c.head, 32, 'continuity', true),
    accepted: c.accepted,
    retained: c.retained,
    evidenceDigest: ownBytes(c.evidenceDigest, 32, 'continuity', true),
    checkedTime: ownTime(c.checkedTime),
    forked: c.forked,
  }
  return { kind: 'reopen', checkpoint }
}
export function ownCandidate(c: Candidate): Candidate {
  return {
    statement: ownBytes(c.statement, MAX_FRAME, 'evidence'),
    attestation: ownBytes(c.attestation, MAX_FRAME, 'evidence'),
  }
}
export function ownEvidence(e: HistoricalEvidence): HistoricalEvidence {
  return {
    kind: 'historical-evidence',
    ...ownCandidate(e),
    hash: ownBytes(e.hash, 32, 'evidence', true),
  }
}

/** Only the codec's optional-field data vocabulary, with its existing bounds. */
function ownOptionalFields(fields: UnknownFields): UnknownFields {
  let items = 0
  let bytes = 0
  let containers = 0
  function value(input: FrankValue, depth: number): FrankValue {
    if (++items > MAX_ITEMS || depth > MAX_DEPTH) fail('binding')
    if (input instanceof Uint8Array) {
      bytes += input.byteLength
      if (bytes > MAX_FRAME) fail('binding')
      return ownBytes(input, MAX_FRAME, 'binding')
    }
    if (typeof input === 'string') {
      // Strings are immutable; bound UTF-8 measurement before allocating its temporary bytes.
      if (input.length > MAX_FRAME) fail('binding')
      bytes += new TextEncoder().encode(input).length
      if (bytes > MAX_FRAME) fail('binding')
      return input
    }
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'bigint'
    )
      return input
    if (Array.isArray(input)) {
      const length = input.length
      if (
        length > MAX_ARRAY_ELEMENTS ||
        length > MAX_ITEMS - items ||
        depth >= MAX_DEPTH ||
        ++containers > MAX_CONTAINERS
      )
        fail('binding')
      const copied: FrankValue[] = []
      for (let i = 0; i < length; i++) {
        if (!Object.prototype.hasOwnProperty.call(input, i)) fail('binding')
        copied.push(value(input[i], depth + 1))
      }
      return copied
    }
    if (input instanceof Map) {
      if (
        input.size > MAX_MAP_ENTRIES ||
        depth >= MAX_DEPTH ||
        ++containers > MAX_CONTAINERS
      )
        fail('binding')
      const copied = new Map<bigint, FrankValue>()
      for (const [key, item] of input) {
        if (typeof key !== 'bigint' || ++items > MAX_ITEMS) fail('binding')
        copied.set(key, value(item, depth + 1))
      }
      return copied
    }
    fail('binding')
  }
  if (!(fields instanceof Map)) fail('binding')
  return value(fields, 0) as UnknownFields
}
export function ownContext(context: Context): Context {
  const relay = context?.relay
  return {
    now: context?.now == null ? null : ownTime(context.now),
    relay:
      relay == null
        ? null
        : {
            relayId: ownBytes(relay.relayId, 64, 'binding'),
            endpoint: relay.endpoint,
            identity: ownPoint(relay.identity, 'binding'),
            expiry: relay.expiry ? ownTime(relay.expiry) : fail('binding'),
            unknownFields: ownOptionalFields(relay.unknownFields),
          },
  }
}
