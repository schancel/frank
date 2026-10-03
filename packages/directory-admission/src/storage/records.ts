import { fromHex, toHex } from '@frank/codec'
import type { Anchor, Checkpoint, Status } from '../index'
import type { Timestamp } from '@frank/codec'
import {
  authenticate,
  budget,
  charge,
  classify,
  equal,
  fail,
  MAX_BYTES,
  MAX_FRAME,
  MAX_STATEMENTS,
  nanos,
  previousStamp,
  Record,
  statementBytes,
  U64_MAX,
  validTime,
} from '../policy/history'

/** Private concrete-backend transaction boundary. Never exported as a caller store adapter. */
export type Row = readonly [string, string]
export interface Storage {
  read(): Promise<Row[]>
  commit(expected: readonly Row[], additions: readonly Row[]): Promise<void>
  close(): Promise<void>
}
export const FORMAT = 'directory-admission-v1'
export const MAX_ROWS = MAX_STATEMENTS + 3
export const MAX_SERIALIZED_BYTES = MAX_BYTES * 2 + MAX_STATEMENTS * 120 + 8192
export function boundedRow(
  key: unknown,
  value: unknown,
): asserts key is string {
  if (
    typeof key !== 'string' ||
    typeof value !== 'string' ||
    key.length > 128 ||
    value.length > MAX_FRAME * 2
  )
    fail('unavailable')
}
export const sameRows = (a: readonly Row[], b: readonly Row[]): boolean =>
  a.length === b.length &&
  a.every(([k, v], i) => k === b[i][0] && v === b[i][1])
export function sorted(rows: readonly Row[]): Row[] {
  return [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}
export interface State {
  history: Record[]
  proof: Record[]
  checked: Timestamp
  sequence: bigint
}
export interface Metadata {
  version: 1
  identity: string
  anchor: string
  sequence: string
  accepted: number
  retained: number
  charged: number
  forked: boolean
  checked: [string, number]
  head: string | null
  revision: string | null
  generations: [string, string] | null
  currentStamp: string | null
  previousStamp: string | null
  evidenceDigest: string
}
const timeTuple = (t: Timestamp): [string, number] => [
  String(t.seconds),
  t.nanoseconds,
]
export const allRecords = (s: State): Record[] => [...s.history, ...s.proof]
async function sha(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)),
  )
}
export async function identity(a: Anchor): Promise<Uint8Array> {
  const network = new TextEncoder().encode(a.network)
  return sha(
    Uint8Array.from([network.length, ...network, ...a.subject.keyBytes]),
  )
}
export async function evidenceDigest(
  records: readonly Record[],
): Promise<Uint8Array> {
  const bytes = new Uint8Array(
    records.reduce((n, r) => n + 48 + r.evidence.attestation.length, 0),
  )
  const view = new DataView(bytes.buffer)
  let offset = 0
  for (const r of records) {
    view.setBigUint64(offset, r.revision)
    offset += 8
    bytes.set(r.evidence.hash, offset)
    offset += 32
    view.setBigUint64(offset, BigInt(r.evidence.attestation.length))
    offset += 8
    bytes.set(r.evidence.attestation, offset)
    offset += r.evidence.attestation.length
  }
  return sha(bytes)
}
export function marker(a: Anchor): string {
  return JSON.stringify({
    version: 1,
    network: a.network,
    subject: toHex(a.subject.keyBytes),
    anchor: toHex(a.revisionZero),
  })
}
export function recordKey(index: number, r: Record): string {
  return `e:${String(index).padStart(8, '0')}:${String(r.revision).padStart(
    20,
    '0',
  )}:${toHex(r.evidence.hash)}`
}
export async function metadata(a: Anchor, s: State): Promise<Metadata> {
  const records = allRecords(s)
  const head = s.history[s.history.length - 1]
  const previous = previousStamp(s.history)
  return {
    version: 1,
    identity: toHex(await identity(a)),
    anchor: toHex(a.revisionZero),
    sequence: String(s.sequence),
    accepted: s.history.length,
    retained: records.length,
    charged: records.reduce((n, r) => n + charge(r), 0),
    forked: s.proof.length > 0,
    checked: timeTuple(s.checked),
    head: head ? toHex(head.evidence.hash) : null,
    revision: head ? String(head.revision) : null,
    generations: head
      ? (head.generations.map(String) as [string, string])
      : null,
    currentStamp: head ? toHex(head.stamp.keyBytes) : null,
    previousStamp: previous ? toHex(previous.keyBytes) : null,
    evidenceDigest: toHex(await evidenceDigest(records)),
  }
}
/** Read the bounded cheap header before admitting any candidate crypto work. */
export function header(rows: readonly Row[], a: Anchor): Metadata | null {
  const fields = new Map(rows)
  if (rows.length !== fields.size || fields.get('format') !== FORMAT)
    fail('unavailable')
  if (fields.size === 1) return null
  const raw = fields.get('head')
  if (!raw || raw.length > 4096 || fields.get('marker') !== marker(a))
    fail('unavailable')
  let m: Metadata
  try {
    m = JSON.parse(raw)
  } catch {
    fail('unavailable')
  }
  try {
    if (
      m.version !== 1 ||
      !/^(0|[1-9][0-9]*)$/.test(m.sequence) ||
      BigInt(m.sequence) > U64_MAX ||
      m.accepted > m.retained ||
      m.retained === 0 ||
      !Number.isSafeInteger(m.accepted) ||
      m.accepted < 0 ||
      typeof m.forked !== 'boolean' ||
      m.forked !== m.accepted < m.retained ||
      !Array.isArray(m.checked) ||
      m.checked.length !== 2 ||
      typeof m.checked[0] !== 'string' ||
      !/^(0|-?[1-9][0-9]*)$/.test(m.checked[0]) ||
      !validTime({ seconds: BigInt(m.checked[0]), nanoseconds: m.checked[1] })
    )
      fail('unavailable')
    budget(m.retained, m.charged, 0, 0)
  } catch {
    fail('unavailable')
  }
  return m
}
/** Reconstruct all derived state from exact authenticated history, then compare every field. */
export async function load(
  rows: readonly Row[],
  a: Anchor,
  m: Metadata | null,
): Promise<State | null> {
  try {
    if (!m) {
      if (rows.length !== 1) fail('unavailable')
      return null
    }
    if (rows.length !== m.retained + 3) fail('unavailable')
    const evidenceRows = rows.filter(([k]) => k.startsWith('e:'))
    if (evidenceRows.length !== m.retained) fail('unavailable')
    let bytes = 0
    const wrappers = evidenceRows.map(([, value]) => {
      if (!/^(?:[0-9a-f]{2})+$/.test(value) || value.length > MAX_FRAME * 2)
        fail('unavailable')
      const wrapper = fromHex(value)
      bytes += wrapper.length
      if (bytes > MAX_BYTES) fail('unavailable')
      return wrapper
    })
    for (const wrapper of wrappers) {
      bytes += statementBytes(wrapper).length
      if (bytes > MAX_BYTES) fail('unavailable')
    }
    if (bytes !== m.charged) fail('unavailable')
    const state: State = {
      history: [],
      proof: [],
      checked: { seconds: BigInt(m.checked[0]), nanoseconds: m.checked[1] },
      sequence: BigInt(m.sequence),
    }
    const staged: Record[] = []
    for (let i = 0; i < wrappers.length; i++) {
      const r = authenticate(a, wrappers[i])
      if (
        evidenceRows[i][0] !== recordKey(i, r) ||
        nanos(r.issued) > nanos(state.checked)
      )
        fail('unavailable')
      const finalFork = m.forked && i + 1 === wrappers.length
      if (classify(staged, a, r) !== (finalFork ? 'fork' : 'append'))
        fail('unavailable')
      if (!finalFork) staged.push(r)
      ;(i < m.accepted ? state.history : state.proof).push(r)
    }
    if (JSON.stringify(await metadata(a, state)) !== new Map(rows).get('head'))
      fail('unavailable')
    return state
  } catch {
    fail('unavailable')
  }
}
export function status(m: Metadata): Status {
  const point = (hex: string | null) =>
    hex === null ? null : { keyType: 1, keyBytes: fromHex(hex) }
  const checkedTime = {
    seconds: BigInt(m.checked[0]),
    nanoseconds: m.checked[1],
  }
  return {
    kind: 'historical-status',
    checkpoint: {
      kind: 'CommittedPrefix',
      identity: fromHex(m.identity),
      anchor: fromHex(m.anchor),
      head: m.head === null ? null : fromHex(m.head),
      accepted: m.accepted,
      retained: m.retained,
      evidenceDigest: fromHex(m.evidenceDigest),
      checkedTime,
      forked: m.forked,
    },
    head: m.head === null ? null : fromHex(m.head),
    revision: m.revision === null ? null : BigInt(m.revision),
    generations:
      m.generations === null
        ? null
        : (m.generations.map(BigInt) as [bigint, bigint]),
    currentStamp: point(m.currentStamp),
    previousStamp: point(m.previousStamp),
    accepted: m.accepted,
    retained: m.retained,
    chargedBytes: m.charged,
    forked: m.forked,
    checkedTime,
  }
}
export async function verifiesCheckpoint(
  a: Anchor,
  s: State,
  expected: Checkpoint,
): Promise<boolean> {
  try {
    const records = allRecords(s)
    const common =
      equal(expected.identity, await identity(a)) &&
      equal(expected.anchor, a.revisionZero) &&
      Number.isSafeInteger(expected.retained) &&
      expected.retained > 0 &&
      Number.isSafeInteger(expected.accepted) &&
      expected.accepted >= 0 &&
      expected.accepted <= expected.retained &&
      expected.retained <= records.length &&
      validTime(expected.checkedTime) &&
      nanos(expected.checkedTime) <= nanos(s.checked) &&
      equal(
        expected.evidenceDigest,
        await evidenceDigest(records.slice(0, expected.retained)),
      )
    if (!common) return false
    if (expected.kind === 'ProspectiveEnrollment')
      return (
        expected.accepted === 1 &&
        expected.retained === 1 &&
        expected.forked === false &&
        expected.head !== null &&
        equal(expected.head, a.revisionZero) &&
        equal(records[0].evidence.hash, a.revisionZero) &&
        (s.history.length > 0 || s.proof.length > 0)
      )
    if (
      expected.kind !== 'CommittedPrefix' ||
      expected.accepted > s.history.length
    )
      return false
    const head = s.history[expected.accepted - 1]?.evidence.hash ?? null
    if (
      !(head === null && expected.head === null) &&
      !(head && expected.head && equal(head, expected.head))
    )
      return false
    return expected.forked === true
      ? s.proof.length > 0 &&
          expected.accepted === s.history.length &&
          expected.retained === records.length
      : expected.forked === false &&
          expected.accepted > 0 &&
          expected.retained === expected.accepted
  } catch {
    return false
  }
}
