import {
  compareBytes,
  encodeCanonical,
  previewDirectoryContext,
  uncompressedPubkey,
  validateFrame,
  verifyPreviewDirectoryEvidence,
} from '@frank/codec'
import type { AccountRef, Timestamp, RelayBinding } from '@frank/codec'
import type {
  AdmissionErrorCode,
  Anchor,
  Candidate,
  HistoricalEvidence,
} from '../index'

export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code)
    this.name = 'AdmissionError'
  }
}
export function fail(code: AdmissionErrorCode): never {
  throw new AdmissionError(code)
}
export const MAX_STATEMENTS = 4096
export const MAX_BYTES = 16_777_216
export const MAX_FRAME = 262_144
export const U64_MAX = (1n << 64n) - 1n
export const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  compareBytes(a, b) === 0
export const keyEqual = (a: AccountRef, b: AccountRef): boolean =>
  a.keyType === b.keyType && equal(a.keyBytes, b.keyBytes)
export const nanos = (t: Timestamp): bigint =>
  t.seconds * 1_000_000_000n + BigInt(t.nanoseconds)
export function validTime(t: Timestamp | null | undefined): t is Timestamp {
  return (
    !!t &&
    typeof t.seconds === 'bigint' &&
    t.seconds >= -(1n << 63n) &&
    t.seconds < 1n << 63n &&
    Number.isInteger(t.nanoseconds) &&
    t.nanoseconds >= 0 &&
    t.nanoseconds < 1_000_000_000
  )
}
export function clock(t: Timestamp | null, prior?: Timestamp): Timestamp {
  if (!validTime(t) || (prior && nanos(t) < nanos(prior))) fail('clock')
  return t
}
/** JS callers must supply the complete typed trust tuple, including for fork observations. */
export function requireRelay(relay: RelayBinding | null): void {
  if (
    !relay ||
    !(relay.relayId instanceof Uint8Array) ||
    typeof relay.endpoint !== 'string' ||
    !relay.identity ||
    relay.identity.keyType !== 1 ||
    !(relay.identity.keyBytes instanceof Uint8Array) ||
    relay.identity.keyBytes.length !== 33 ||
    !validTime(relay.expiry) ||
    !(relay.unknownFields instanceof Map)
  )
    fail('binding')
}
export function validateAnchor(a: Anchor): void {
  try {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.network) ||
      a.subject.keyType !== 1 ||
      a.subject.keyBytes.length !== 33 ||
      a.revisionZero.length !== 32
    )
      fail('anchor')
    uncompressedPubkey(a.subject.keyBytes)
  } catch {
    fail('anchor')
  }
}
export function budget(
  count: number,
  bytes: number,
  incomingCount: number,
  incomingBytes: number,
): void {
  if (
    ![count, bytes, incomingCount, incomingBytes].every(
      n => Number.isSafeInteger(n) && n >= 0,
    ) ||
    count + incomingCount > MAX_STATEMENTS ||
    bytes + incomingBytes > MAX_BYTES
  )
    fail('resource')
}
export function preflight(
  count: number,
  bytes: number,
  candidates: readonly Candidate[],
): void {
  budget(count, bytes, candidates.length, 0)
  let incoming = 0
  for (const c of candidates) {
    if (
      !(c.statement instanceof Uint8Array) ||
      !(c.attestation instanceof Uint8Array)
    )
      fail('evidence')
    if (c.statement.length > MAX_FRAME || c.attestation.length > MAX_FRAME)
      fail('resource')
    incoming += c.statement.length + c.attestation.length
  }
  budget(count, bytes, candidates.length, incoming)
}
/** Generic bounded codec pass: no child decoding, curve validation or signature work. */
export function statementBytes(wrapper: Uint8Array): Uint8Array {
  try {
    const result = validateFrame(wrapper, {
      ...previewDirectoryContext(),
      operation: 'generic',
      routeByteLimit: MAX_FRAME,
    })
    if (
      result.kind !== 'parsed' ||
      result.typeId !== 2 ||
      !(result.payload instanceof Map)
    )
      fail('evidence')
    const statement = result.payload.get(0n)
    if (!(statement instanceof Uint8Array) || statement.length > MAX_FRAME)
      fail('evidence')
    return statement
  } catch {
    fail('evidence')
  }
}
export interface Record {
  evidence: HistoricalEvidence
  schema: number
  revision: bigint
  issued: Timestamp
  expiry: Timestamp
  relay: RelayBinding
  message: AccountRef
  stamp: AccountRef
  generations: [bigint, bigint]
  predecessor: Uint8Array | null
}
export function authenticate(anchor: Anchor, wrapper: Uint8Array): Record {
  let signed
  try {
    signed = verifyPreviewDirectoryEvidence(wrapper, anchor.network)
  } catch {
    fail('evidence')
  }
  const s = signed.statement
  if (!keyEqual(s.subject, anchor.subject)) fail('anchor')
  return {
    evidence: {
      kind: 'historical-evidence',
      statement: signed.statementFrame.frame,
      attestation: wrapper,
      hash: signed.statementHash,
    },
    schema: signed.statementFrame.schemaVersion,
    revision: s.revision,
    issued: s.timestamp,
    expiry: s.expiry,
    relay: s.relays[0],
    message: s.preview.messageDhKey,
    stamp: s.stampKey,
    generations: [s.preview.mailboxKeyGeneration, s.preview.stampKeyGeneration],
    predecessor: s.preview.predecessor,
  }
}
export const charge = (r: Record): number =>
  r.evidence.statement.length + r.evidence.attestation.length
export function bootstrap(anchor: Anchor, r: Record): void {
  if (
    r.revision !== 0n ||
    !equal(r.evidence.hash, anchor.revisionZero) ||
    r.generations.some(n => n !== 0n) ||
    r.predecessor !== null
  )
    fail('anchor')
}
export function counterFollows(
  previous: bigint,
  next: bigint,
  changed: boolean,
): boolean {
  return (
    previous >= 0n &&
    previous <= U64_MAX &&
    next >= 0n &&
    next <= U64_MAX &&
    next === previous + (changed ? 1n : 0n)
  )
}
export function previousStamp(records: readonly Record[]): AccountRef | null {
  let previous: AccountRef | null = null
  for (let i = 1; i < records.length; i++)
    if (!keyEqual(records[i - 1].stamp, records[i].stamp))
      previous = records[i - 1].stamp
  return previous
}
export function classify(
  records: readonly Record[],
  anchor: Anchor,
  r: Record,
): 'append' | 'duplicate' | 'fork' {
  const head = records[records.length - 1]
  if (!head) {
    bootstrap(anchor, r)
    return 'append'
  }
  if (equal(head.evidence.statement, r.evidence.statement)) return 'duplicate'
  if (records.some(h => equal(h.evidence.statement, r.evidence.statement)))
    fail('rollback')
  if (r.revision === 0n) fail('anchor')
  const parentIndex = records.findIndex(
    h => r.predecessor !== null && equal(h.evidence.hash, r.predecessor),
  )
  if (parentIndex < 0) fail('link')
  const parent = records[parentIndex]
  if (!counterFollows(parent.revision, r.revision, true)) fail('link')
  if (r.schema < parent.schema || nanos(r.issued) < nanos(parent.issued))
    fail('order')
  for (const [i, key, old] of [
    [0, r.message, parent.message],
    [1, r.stamp, parent.stamp],
  ] as const) {
    const changed = !keyEqual(key, old)
    if (!counterFollows(parent.generations[i], r.generations[i], changed))
      fail('generation')
    if (
      changed &&
      (equal(key.keyBytes.subarray(1), anchor.subject.keyBytes.subarray(1)) ||
        records
          .slice(0, parentIndex + 1)
          .some(h =>
            [h.message, h.stamp].some(k =>
              equal(key.keyBytes.subarray(1), k.keyBytes.subarray(1)),
            ),
          ))
    )
      fail('key-reuse')
  }
  return parentIndex + 1 < records.length ? 'fork' : 'append'
}
export function fresh(
  r: Record,
  now: Timestamp,
  relay: RelayBinding | null,
): void {
  if (nanos(r.issued) > nanos(now) || nanos(now) >= nanos(r.expiry))
    fail('validity')
  try {
    if (
      !relay ||
      !equal(r.relay.relayId, relay.relayId) ||
      r.relay.endpoint !== relay.endpoint ||
      !keyEqual(r.relay.identity, relay.identity) ||
      r.relay.expiry.seconds !== relay.expiry.seconds ||
      r.relay.expiry.nanoseconds !== relay.expiry.nanoseconds ||
      !equal(
        encodeCanonical(new Map(r.relay.unknownFields)),
        encodeCanonical(new Map(relay.unknownFields)),
      )
    )
      fail('binding')
  } catch {
    fail('binding')
  }
}
