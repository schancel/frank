/** Offline proposal tooling only. Never imported by an active codec or writer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  commonTranscript,
  decodeCanonical,
  defaultContext,
  directorySignatureDigest,
  encodeCanonical,
  encodeFrame,
  fromHex,
  toHex,
  validateFrame,
  verifyAlgorithm1,
} from '../../src'
import type { Encodable } from '../../src'

const ROOT = resolve(__dirname, '../../../..')
const FILE = resolve(
  ROOT,
  'docs/protocol/proposals/suite1-directory/vectors.json',
)
const NETWORK = 'monad-testnet'
const NOW = 1700000100n
const MAX = (1n << 64n) - 1n
const HISTORY_MAX_RECORDS = 4096n
const HISTORY_MAX_BYTES = 16777216n
function present<T>(value: T | undefined): T {
  assert(value !== undefined, 'missing fixture value')
  return value
}
const map = (...pairs: [number, Encodable][]): Map<number, Encodable> =>
  new Map(pairs)
const time = (seconds: bigint): Encodable => map([0, seconds], [1, 0])
const scalar = (n: number): Uint8Array =>
  fromHex(n.toString(16).padStart(64, '0'))
const key = (n: number): Encodable =>
  map([0, 1], [1, secp256k1.getPublicKey(scalar(n), true)])
const sha = (b: Uint8Array): string =>
  createHash('sha256').update(b).digest('hex')
const t1 = (network: string, b: Uint8Array): string =>
  sha(commonTranscript('frank/content-hash/v1', network, b))
// Deliberately synthetic caller-provisioned input. No default exists in a writer.
const relay = map(
  [0, Uint8Array.from({ length: 16 }, (_, i) => i)],
  [1, 'https://relay.example.invalid'],
  [2, key(4)],
  [3, time(1700007200n)],
)
const base = (): Map<number, Encodable> =>
  map(
    [0, NETWORK],
    [1, key(1)],
    [2, 0n],
    [3, time(1700000000n)],
    [4, [relay]],
    [6, time(1700003600n)],
    [8, key(3)],
    [10, key(2)],
    [11, 0n],
    [12, 0n],
    [13, null],
  )
interface RecordVector {
  id: string
  type4_hex: string
  type2_hex: string
  t1: string
  t2_digest: string
  signature_valid: boolean
  old_reader: string
}
interface Case {
  id: string
  operation:
    | 'directory'
    | 'stamp'
    | 'message'
    | 'counter'
    | 'advance'
    | 'history-budget'
  record?: string
  history: string[]
  expected: string
  anchor?: string | null
  clock?: string | null
  last_clock?: string
  network?: string
  reader?: number
  relay?: string | null
  claimed_t1?: string
  candidate_key?: string
  restart?: 'pair-lost' | 'head-lost'
  archive?: boolean
  prior_value?: string
  next_value?: string
  increment?: boolean
  candidates?: string[]
  committed_history?: string[]
  previous_stamp?: string | null
  in_flight?: boolean
  stored_count?: string
  stored_bytes?: string
  incoming_count?: string
  incoming_bytes?: string
}
interface Corpus {
  format: string
  status: string
  base_commit: string
  synthetic_relay_cbor_hex: string
  frozen_sha256: { path: string; sha256: string }[]
  records: RecordVector[]
  cases: Case[]
}
function oldReader(frame: Uint8Array): string {
  try {
    validateFrame(frame, defaultContext({ operation: 'full' }))
    return 'accept'
  } catch (e) {
    return String((e as { category?: string }).category ?? e)
  }
}
function generate(): Corpus {
  const records: RecordVector[] = []
  const payloads = new Map<string, Map<number, Encodable>>()
  function add(
    id: string,
    payload: Map<number, Encodable>,
    schema = 4,
    floor = 4,
    signWith = 1,
    corrupt = false,
  ): RecordVector {
    const frame = encodeFrame(
      { typeId: 4, schemaVersion: schema, minReaderVersion: floor },
      payload,
    )
    const network = payload.get(0) as string
    const digest = directorySignatureDigest(network, frame)
    const signature = secp256k1
      .sign(digest, scalar(signWith), { lowS: true })
      .toDERRawBytes()
    if (corrupt) signature[signature.length - 1] ^= 1
    const signer = secp256k1.getPublicKey(scalar(signWith), true)
    const wrapper = encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      map([0, frame], [1, [map([0, 1], [1, key(signWith)], [2, signature])]]),
    )
    const r = {
      id,
      type4_hex: toHex(frame),
      type2_hex: toHex(wrapper),
      t1: t1(network, frame),
      t2_digest: toHex(digest),
      signature_valid: verifyAlgorithm1(digest, signature, signer),
      old_reader: oldReader(wrapper),
    }
    records.push(r)
    payloads.set(id, payload)
    return r
  }
  const bootstrap = add('bootstrap', base())
  function next(
    id: string,
    predecessor: string,
    changes: [number, Encodable][] = [],
  ): RecordVector {
    const p = new Map(present(payloads.get(predecessor)))
    p.set(2, (p.get(2) as bigint) + 1n)
    p.set(3, time(1700000000n + (p.get(2) as bigint)))
    p.set(13, fromHex(present(records.find(r => r.id === predecessor)).t1))
    for (const [k, v] of changes) p.set(k, v)
    return add(id, p)
  }
  next('renew', 'bootstrap')
  next('rotate-stamp', 'renew', [
    [8, key(6)],
    [12, 1n],
  ])
  next('renew-after-rotation', 'rotate-stamp')
  next('rotate-stamp-again', 'renew-after-rotation', [
    [8, key(7)],
    [12, 2n],
  ])
  next('rotate-message', 'rotate-stamp-again', [
    [10, key(5)],
    [11, 1n],
  ])
  for (const [id, field] of [
    ['missing-message', 10],
    ['missing-stamp', 8],
    ['missing-auth', 1],
  ] as const) {
    const p = base()
    p.delete(field)
    add(id, p)
  }
  for (const [id, changes] of [
    ['auth-as-message', [[10, key(1)]]],
    ['auth-as-stamp', [[8, key(1)]]],
    ['stamp-as-message', [[10, key(3)]]],
    ['wrong-key-type', [[10, map([0, 2], [1, new Uint8Array(32)])]]],
    [
      'invalid-point',
      [[10, map([0, 1], [1, fromHex('02' + 'ff'.repeat(32))])]],
    ],
    ['wrong-network', [[0, 'other-network']]],
    ['bootstrap-generation', [[11, 1n]]],
    ['bootstrap-revision', [[2, 1n]]],
    ['bootstrap-predecessor', [[13, new Uint8Array(32)]]],
    ['future-issue', [[3, time(NOW + 1n)]]],
    ['expired', [[6, time(NOW)]]],
    ['long-validity', [[6, time(1700003601n)]]],
    ['short-binding', [[4, [new Map(relay).set(3, time(NOW))]]]],
    ['wrong-relay', [[4, [new Map(relay).set(2, key(8))]]]],
    ['profile-field', [[9, []]]],
    ['transition-field', [[5, []]]],
    ['recovery-field', [[7, [key(8)]]]],
    ['unknown-exact-field', [[100, Uint8Array.of(0, 255, 1)]]],
  ] as [string, [number, Encodable][]][]) {
    const p = base()
    for (const [k, v] of changes) p.set(k, v)
    add(id, p)
  }
  const negative = secp256k1.ProjectivePoint.fromHex(
    secp256k1.getPublicKey(scalar(1), true),
  )
    .negate()
    .toRawBytes(true)
  add(
    'negated-auth-as-message',
    new Map(base()).set(10, map([0, 1], [1, negative])),
  )
  next('unchanged-key-bumped-generation', 'bootstrap', [[11, 1n]])
  next('changed-key-same-generation', 'bootstrap', [[10, key(5)]])
  next('skipped-generation', 'bootstrap', [
    [10, key(5)],
    [11, 2n],
  ])
  next('skipped-revision', 'bootstrap', [[2, 2n]])
  next('wrong-predecessor', 'bootstrap', [[13, new Uint8Array(32)]])
  next('wrapper-predecessor', 'bootstrap', [
    [13, fromHex(t1(NETWORK, fromHex(bootstrap.type2_hex)))],
  ])
  next('backward-issue', 'bootstrap', [
    [3, time(1699999999n)],
    [6, time(1700003599n)],
  ])
  next('fork-of-renew', 'bootstrap', [
    [8, key(6)],
    [12, 1n],
  ])
  next('swapped-retired-roles', 'rotate-message', [
    [10, key(3)],
    [11, 2n],
  ])
  next('reused-stamp', 'rotate-stamp-again', [
    [8, key(3)],
    [12, 3n],
  ])
  next('changed-subject', 'bootstrap', [[1, key(8)]])
  add('bad-signature', base(), 4, 4, 1, true)
  add('wrong-signer', base(), 4, 4, 8)
  add('wrong-reader-floor', base(), 4, 2)
  add('unknown-required-version', base(), 5, 5)
  add(
    'optional-future',
    new Map(base()).set(
      100,
      map([0, Uint8Array.of(0, 255, 128)], [24, ['opaque', null]]),
    ),
    5,
    4,
  )
  const tampered = add(
    'optional-tamper',
    new Map(base()).set(
      100,
      map([0, Uint8Array.of(0, 255, 129)], [24, ['opaque', null]]),
    ),
    5,
    4,
  )
  const originalWrapper = open(
    present(records.find(r => r.id === 'optional-future')).type2_hex,
  ).payload
  tampered.type2_hex = toHex(
    encodeFrame(
      { typeId: 2, schemaVersion: 1, minReaderVersion: 1 },
      map([0, fromHex(tampered.type4_hex)], [1, at(originalWrapper, 1)]),
    ),
  )
  tampered.signature_valid = false
  tampered.old_reader = oldReader(fromHex(tampered.type2_hex))
  const downgraded = new Map(present(payloads.get('optional-future')))
  downgraded.delete(100)
  downgraded.set(2, 1n)
  downgraded.set(
    13,
    fromHex(present(records.find(r => r.id === 'optional-future')).t1),
  )
  add('compatible-schema-downgrade', downgraded)
  const old = base()
  ;[10, 11, 12, 13].forEach(k => old.delete(k))
  add('old-schema2', new Map(old), 2, 2)
  add('old-schema3', new Map(old), 3, 2)
  next('revision-max', 'bootstrap', [[2, MAX]])
  next('generation-max', 'bootstrap', [
    [10, key(5)],
    [11, MAX],
  ])
  next('short-head', 'bootstrap', [[6, time(1700000150n)]])
  next('expired-middle', 'bootstrap', [
    [3, time(1700003601n)],
    [6, time(1700007201n)],
    [4, [new Map(relay).set(3, time(1700007300n))]],
    [8, key(6)],
    [12, 1n],
  ])
  const freshRelay = new Map(relay).set(3, time(1700020000n))
  next('fresh-head', 'expired-middle', [
    [3, time(1700007202n)],
    [6, time(1700010802n)],
    [4, [freshRelay]],
    [8, key(7)],
    [12, 2n],
  ])
  add(
    'expired-middle-bad-signature',
    new Map(present(payloads.get('expired-middle'))),
    4,
    4,
    1,
    true,
  )
  add(
    'expired-middle-bad-generation',
    new Map(present(payloads.get('expired-middle'))).set(12, 0n),
  )
  const cases: Case[] = []
  const directory = (
    id: string,
    record: string,
    expected: string,
    history: string[] = [],
    extras: Partial<Case> = {},
  ): void => {
    cases.push({
      id,
      operation: 'directory',
      record,
      history,
      expected,
      ...extras,
    })
  }
  const chain = [
    'bootstrap',
    'renew',
    'rotate-stamp',
    'renew-after-rotation',
    'rotate-stamp-again',
    'rotate-message',
  ]
  chain.forEach((id, i) => directory(id, id, 'accept', chain.slice(0, i)))
  directory('idempotent-head', 'rotate-stamp', 'duplicate', chain.slice(0, 3))
  const failures: [string, string, string[]?][] = [
    ['missing-message', 'shape'],
    ['missing-stamp', 'shape'],
    ['missing-auth', 'shape'],
    ['auth-as-message', 'role-separation'],
    ['auth-as-stamp', 'role-separation'],
    ['stamp-as-message', 'role-separation'],
    ['negated-auth-as-message', 'role-separation'],
    ['wrong-key-type', 'key'],
    ['invalid-point', 'key'],
    ['wrong-network', 'network'],
    ['bootstrap-generation', 'bootstrap'],
    ['bootstrap-revision', 'bootstrap'],
    ['bootstrap-predecessor', 'bootstrap'],
    ['future-issue', 'validity'],
    ['expired', 'validity'],
    ['long-validity', 'validity'],
    ['short-binding', 'binding-expiry'],
    ['wrong-relay', 'binding'],
    ['profile-field', 'unsupported-policy'],
    ['transition-field', 'unsupported-policy'],
    ['recovery-field', 'unsupported-policy'],
    ['unknown-exact-field', 'shape'],
    ['unchanged-key-bumped-generation', 'generation', ['bootstrap']],
    ['changed-key-same-generation', 'generation', ['bootstrap']],
    ['skipped-generation', 'generation', ['bootstrap']],
    ['skipped-revision', 'revision', ['bootstrap']],
    ['wrong-predecessor', 'predecessor', ['bootstrap']],
    ['wrapper-predecessor', 'predecessor', ['bootstrap']],
    ['backward-issue', 'issue-order', ['bootstrap']],
    ['fork-of-renew', 'fork', ['bootstrap', 'renew']],
    ['swapped-retired-roles', 'key-reuse', chain],
    ['reused-stamp', 'key-reuse', chain.slice(0, 5)],
    ['changed-subject', 'unsupported-policy', ['bootstrap']],
    ['bad-signature', 'signature'],
    ['wrong-signer', 'signer'],
    ['wrong-reader-floor', 'unsupported-version'],
    ['unknown-required-version', 'unsupported-version'],
    ['old-schema2', 'unsupported-version'],
    ['old-schema3', 'unsupported-version'],
    ['revision-max', 'revision', ['bootstrap']],
    ['generation-max', 'generation', ['bootstrap']],
  ]
  failures.forEach(([id, expected, history]) =>
    directory(id, id, expected, history),
  )
  directory('optional-retention', 'optional-future', 'accept')
  directory('optional-byte-tamper', 'optional-tamper', 'signature')
  directory(
    'compatible-schema-downgrade',
    'compatible-schema-downgrade',
    'schema-downgrade',
    ['optional-future'],
  )
  directory('historical-fork', 'fork-of-renew', 'fork', chain)
  directory('required-old-reader', 'bootstrap', 'unsupported-version', [], {
    reader: 2,
  })
  directory('missing-anchor', 'bootstrap', 'anchor', [], { anchor: null })
  directory('wrong-anchor', 'bootstrap', 'anchor', [], {
    anchor: '00'.repeat(32),
  })
  directory('missing-clock', 'bootstrap', 'clock', [], { clock: null })
  directory('clock-rollback', 'renew', 'clock', ['bootstrap'], {
    last_clock: (NOW + 1n).toString(),
  })
  directory('missing-relay', 'bootstrap', 'binding', [], { relay: null })
  directory('wrong-claimed-t1', 'bootstrap', 'commitment', [], {
    claimed_t1: '00'.repeat(32),
  })
  directory('rollback', 'bootstrap', 'rollback', chain.slice(0, 3))
  directory('cross-schema-downgrade', 'old-schema3', 'unsupported-version', [
    'bootstrap',
  ])
  directory('lost-head', 'bootstrap', 'state-lost', [], {
    restart: 'head-lost',
  })
  const stamp = (
    id: string,
    history: string[],
    candidate: number,
    expected: string,
    restart?: Case['restart'],
  ): void => {
    cases.push({
      id,
      operation: 'stamp',
      history,
      candidate_key: toHex(secp256k1.getPublicKey(scalar(candidate), true)),
      expected,
      ...(restart ? { restart } : {}),
    })
  }
  stamp('stamp-current', chain.slice(0, 3), 6, 'accept')
  stamp('stamp-previous', chain.slice(0, 3), 3, 'accept')
  stamp('renew-preserves-previous', chain.slice(0, 4), 3, 'accept')
  stamp('second-rotation-closes-old', chain.slice(0, 5), 3, 'stamp-binding')
  stamp('second-rotation-graces-immediate', chain.slice(0, 5), 6, 'accept')
  stamp('stamp-auth-rejected', chain.slice(0, 3), 1, 'stamp-binding')
  stamp('restart-restores-pair', chain.slice(0, 3), 3, 'accept')
  stamp('lost-pair-current-only', chain.slice(0, 3), 6, 'accept', 'pair-lost')
  stamp(
    'lost-pair-rejects-previous',
    chain.slice(0, 3),
    3,
    'stamp-binding',
    'pair-lost',
  )
  stamp(
    'lost-head-rejects-stamp',
    chain.slice(0, 3),
    6,
    'state-lost',
    'head-lost',
  )
  for (const [id, record, archive, expected] of [
    ['message-current', 'rotate-message', false, 'accept'],
    ['retired-message-new-use', 'rotate-stamp-again', false, 'message-retired'],
    ['retired-message-archive', 'rotate-stamp-again', true, 'archive-only'],
  ] as const)
    cases.push({
      id,
      operation: 'message',
      record,
      history: chain,
      archive,
      expected,
    })
  cases.push(
    {
      id: 'message-two-rotations-old-stamp',
      operation: 'message',
      history: chain.slice(0, 5),
      record: 'bootstrap',
      in_flight: true,
      expected: 'stamp-binding',
    },
    {
      id: 'message-previous-stamp-in-flight',
      operation: 'message',
      history: chain.slice(0, 5),
      record: 'rotate-stamp',
      in_flight: true,
      expected: 'accept',
    },
    {
      id: 'message-previous-stamp-lost-pair',
      operation: 'message',
      history: chain.slice(0, 5),
      record: 'rotate-stamp',
      in_flight: true,
      restart: 'pair-lost',
      expected: 'stamp-binding',
    },
    {
      id: 'message-old-unchanged-new',
      operation: 'message',
      history: chain.slice(0, 2),
      record: 'bootstrap',
      expected: 'message-head',
    },
    {
      id: 'message-old-unchanged-in-flight',
      operation: 'message',
      history: chain.slice(0, 2),
      record: 'bootstrap',
      in_flight: true,
      expected: 'accept',
    },
    {
      id: 'message-expired-current-head',
      operation: 'message',
      history: ['bootstrap', 'short-head'],
      record: 'bootstrap',
      clock: '1700000200',
      in_flight: true,
      expected: 'head-expired',
    },
    {
      id: 'message-expired-head-archive',
      operation: 'message',
      history: ['bootstrap', 'short-head'],
      record: 'bootstrap',
      clock: '1700000200',
      archive: true,
      expected: 'archive-only',
    },
    {
      id: 'stamp-expired-current-head',
      operation: 'stamp',
      history: ['bootstrap', 'short-head'],
      candidate_key: toHex(secp256k1.getPublicKey(scalar(3), true)),
      clock: '1700000200',
      expected: 'head-expired',
    },
  )
  const catchUp = (
    id: string,
    history: string[],
    candidates: string[],
    expected: string,
    extras: Partial<Case> = {},
  ): void => {
    cases.push({
      id,
      operation: 'advance',
      history,
      candidates,
      clock: '1700007500',
      anchor: bootstrap.t1,
      relay: toHex(encodeCanonical(freshRelay)),
      expected,
      committed_history:
        expected === 'accept' ? [...history, ...candidates] : history,
      previous_stamp:
        expected === 'accept'
          ? toHex(secp256k1.getPublicKey(scalar(6), true))
          : null,
      ...extras,
    })
  }
  catchUp(
    'offline-catch-up',
    ['bootstrap'],
    ['expired-middle', 'fresh-head'],
    'accept',
  )
  catchUp(
    'late-contact-bootstrap',
    [],
    ['bootstrap', 'expired-middle', 'fresh-head'],
    'accept',
  )
  catchUp('catch-up-missing-link', ['bootstrap'], ['fresh-head'], 'revision')
  catchUp(
    'catch-up-bad-historical-signature',
    ['bootstrap'],
    ['expired-middle-bad-signature', 'fresh-head'],
    'signature',
  )
  catchUp(
    'catch-up-bad-historical-generation',
    ['bootstrap'],
    ['expired-middle-bad-generation', 'fresh-head'],
    'generation',
  )
  catchUp(
    'catch-up-expired-terminal',
    ['bootstrap'],
    ['expired-middle'],
    'validity',
  )
  catchUp('catch-up-empty-cannot-revive', ['bootstrap'], [], 'validity')
  catchUp(
    'late-contact-wrong-anchor',
    [],
    ['bootstrap', 'expired-middle', 'fresh-head'],
    'anchor',
    { anchor: '00'.repeat(32) },
  )
  catchUp(
    'catch-up-untrusted-head-binding',
    ['bootstrap'],
    ['expired-middle', 'fresh-head'],
    'binding',
    { relay: null },
  )
  catchUp(
    'failed-catch-up-preserves-existing-pair',
    chain.slice(0, 3),
    ['renew-after-rotation'],
    'validity',
    { previous_stamp: toHex(secp256k1.getPublicKey(scalar(3), true)) },
  )
  for (const [
    id,
    storedCount,
    storedBytes,
    incomingCount,
    incomingBytes,
    expected,
  ] of [
    ['history-count-at-bound', 4095n, 100n, 1n, 100n, 'accept'],
    ['history-count-over-bound', 4096n, 100n, 1n, 100n, 'history-resource'],
    ['history-batch-over-bound', 0n, 0n, 4097n, 100n, 'history-resource'],
    [
      'history-bytes-at-bound',
      1n,
      HISTORY_MAX_BYTES - 100n,
      1n,
      100n,
      'accept',
    ],
    [
      'history-bytes-over-bound',
      1n,
      HISTORY_MAX_BYTES,
      1n,
      1n,
      'history-resource',
    ],
  ] as const)
    cases.push({
      id,
      operation: 'history-budget',
      history: [],
      expected,
      stored_count: storedCount.toString(),
      stored_bytes: storedBytes.toString(),
      incoming_count: incomingCount.toString(),
      incoming_bytes: incomingBytes.toString(),
    })
  for (const [id, prior, nextValue, increment, expected] of [
    ['counter-last-increment', MAX - 1n, MAX, true, 'accept'],
    ['counter-overflow-wrap', MAX, 0n, true, 'counter'],
    ['counter-terminal-increment', MAX, MAX, true, 'counter'],
    ['counter-max-unchanged', MAX, MAX, false, 'accept'],
  ] as const)
    cases.push({
      id,
      operation: 'counter',
      history: [],
      prior_value: prior.toString(),
      next_value: nextValue.toString(),
      increment,
      expected,
    })
  // Make the separate trust input explicit: no checker learns an anchor from an untrusted wire record.
  for (const c of cases)
    if (
      c.operation === 'directory' &&
      !c.history.length &&
      c.anchor === undefined
    )
      c.anchor = present(records.find(r => r.id === c.record)).t1
  const frozen = [
    'docs/protocol/cbor/directory.cddl',
    'docs/protocol/cbor/common.cddl',
    'docs/protocol/cbor/README.md',
    'docs/protocol/cbor/vectors/manifest.json',
    'docs/protocol/cbor/vectors/account-registration.json',
    'docs/protocol/cbor/vectors/dm-suite-1.json',
    'docs/domain-derivation-registry-v1.md',
  ]
  return {
    format: 'suite1-directory-proposal-v1',
    status: 'PROPOSED-NOT-ALLOCATED',
    base_commit: '6a8cbdf7cb44296f646d233474afc9784323f63b',
    synthetic_relay_cbor_hex: toHex(encodeCanonical(relay)),
    frozen_sha256: frozen.map(path => ({
      path,
      sha256: sha(readFileSync(resolve(ROOT, path))),
    })),
    records,
    cases,
  }
}

// A deliberately small reference policy interpreter, not an active schema validator.
type Value = ReturnType<typeof decodeCanonical>
const m = (value: Value): ReadonlyMap<bigint, Value> => {
  assert(value instanceof Map)
  return value
}
const at = (value: Value, field: number): Value =>
  present(m(value).get(BigInt(field)))
const b = (value: Value): Uint8Array => {
  assert(value instanceof Uint8Array)
  return value
}
const n = (value: Value): bigint => {
  assert(typeof value === 'bigint')
  return value
}
const eq = (a: Value, other: Value): boolean =>
  toHex(encodeCanonical(a)) === toHex(encodeCanonical(other))
const point = (value: Value): string => {
  try {
    if (m(value).size !== 2 || n(at(value, 0)) !== 1n) throw Error()
    const raw = b(at(value, 1))
    if (raw.length !== 33 || ![2, 3].includes(raw[0])) throw Error()
    secp256k1.ProjectivePoint.fromHex(raw).assertValidity()
    return toHex(raw).slice(2)
  } catch {
    throw new Error('key')
  }
}
function timestamp(value: Value): bigint {
  const seconds = n(at(value, 0)),
    nanos = n(at(value, 1))
  if (
    m(value).size !== 2 ||
    seconds < -(1n << 63n) ||
    seconds >= 1n << 63n ||
    nanos < 0n ||
    nanos > 999999999n
  )
    throw Error('shape')
  return seconds * 1000000000n + nanos
}
function open(hex: string): {
  frame: Uint8Array
  env: ReadonlyMap<bigint, Value>
  payload: Value
} {
  const frame = fromHex(hex)
  assert.equal(toHex(frame.subarray(0, 5)), '46524e4b01')
  assert.equal(Buffer.from(frame).readUInt32BE(5), frame.length - 9)
  const env = m(decodeCanonical(frame.subarray(9)))
  assert.equal(env.size, 4)
  return { frame, env, payload: decodeCanonical(b(present(env.get(3n)))) }
}
function stampPair(
  history: Value[],
  lost = false,
): { current: Value; previous: Value } {
  let current: Value = null,
    previous: Value = null
  for (const h of history)
    if (!eq(at(h, 8), current)) {
      previous = current
      current = at(h, 8)
    }
  return { current, previous: lost ? null : previous }
}
function historyFits(
  storedCount: bigint,
  storedBytes: bigint,
  incomingCount: bigint,
  incomingBytes: bigint,
): boolean {
  return (
    [storedCount, storedBytes, incomingCount, incomingBytes].every(
      v => v >= 0n,
    ) &&
    storedCount + incomingCount <= HISTORY_MAX_RECORDS &&
    storedBytes + incomingBytes <= HISTORY_MAX_BYTES
  )
}
function chargedBytes(ids: string[], corpus: Corpus): bigint {
  return ids.reduce((total, id) => {
    const r = present(corpus.records.find(r => r.id === id))
    return total + BigInt((r.type4_hex.length + r.type2_hex.length) / 2)
  }, 0n)
}
function advance(
  c: Case,
  corpus: Corpus,
): { result: string; history: string[]; previous_stamp: string | null } {
  const candidates = c.candidates ?? []
  const previousStamp = (ids: string[]): string | null => {
    const pair = stampPair(
      ids.map(
        id =>
          open(present(corpus.records.find(r => r.id === id)).type4_hex)
            .payload,
      ),
    )
    return pair.previous === null ? null : toHex(b(at(pair.previous, 1)))
  }
  const unchanged = (result: string): ReturnType<typeof advance> => ({
    result,
    history: [...c.history],
    previous_stamp: previousStamp(c.history),
  })
  // Charge the entire transaction before opening any candidate or doing curve work.
  if (
    !historyFits(
      BigInt(c.history.length),
      chargedBytes(c.history, corpus),
      BigInt(candidates.length),
      chargedBytes(candidates, corpus),
    )
  )
    return unchanged('history-resource')
  if (!candidates.length) {
    const id = c.history[c.history.length - 1]
    return unchanged(
      id
        ? outcome({ ...c, operation: 'directory', record: id }, corpus)
        : 'bootstrap',
    )
  }
  const staged = [...c.history]
  for (let i = 0; i < candidates.length; i++) {
    const result = outcome(
      { ...c, operation: 'directory', record: candidates[i], history: staged },
      corpus,
      i < candidates.length - 1,
    )
    if (result !== 'accept' && result !== 'duplicate') return unchanged(result)
    if (result === 'accept') staged.push(candidates[i])
  }
  return {
    result: 'accept',
    history: staged,
    previous_stamp: previousStamp(staged),
  }
}
function outcome(c: Case, corpus: Corpus, historicalLink = false): string {
  const byId = (id: string): RecordVector => {
    const r = corpus.records.find(r => r.id === id)
    assert(r, id)
    return r
  }
  const history = c.history.map(id => open(byId(id).type4_hex).payload)
  const head = history[history.length - 1]
  try {
    if (c.operation === 'history-budget')
      return historyFits(
        BigInt(present(c.stored_count)),
        BigInt(present(c.stored_bytes)),
        BigInt(present(c.incoming_count)),
        BigInt(present(c.incoming_bytes)),
      )
        ? 'accept'
        : 'history-resource'
    if (c.operation === 'advance') return advance(c, corpus).result
    if (c.operation === 'counter') {
      const prior = BigInt(present(c.prior_value)),
        nextValue = BigInt(present(c.next_value))
      return (
        c.increment
          ? prior < MAX && nextValue === prior + 1n
          : nextValue === prior
      )
        ? 'accept'
        : 'counter'
    }
    if (c.restart === 'head-lost') throw Error('state-lost')
    if (
      c.clock === null ||
      (c.last_clock !== undefined &&
        BigInt(c.last_clock) > BigInt(c.clock ?? NOW))
    )
      throw Error('clock')
    const now = BigInt(c.clock ?? NOW) * 1000000000n
    if (c.operation === 'stamp') {
      assert(head)
      if (timestamp(at(head, 3)) > now || now >= timestamp(at(head, 6)))
        return 'head-expired'
      const { current, previous } = stampPair(
        history,
        c.restart === 'pair-lost',
      )
      const matches = (p: Value): boolean =>
        p !== null && toHex(b(at(p, 1))) === c.candidate_key
      return matches(current) || matches(previous) ? 'accept' : 'stamp-binding'
    }
    const r = byId(present(c.record)),
      opened = open(r.type4_hex),
      p = opened.payload
    if (c.operation === 'message') {
      if (!c.history.includes(r.id)) return 'unverified-history'
      if (c.archive) return 'archive-only'
      if (
        !head ||
        timestamp(at(head, 3)) > now ||
        now >= timestamp(at(head, 6))
      )
        return 'head-expired'
      if (!eq(at(head, 10), at(p, 10))) return 'message-retired'
      if (!c.in_flight && r.id !== c.history[c.history.length - 1])
        return 'message-head'
      if (timestamp(at(p, 3)) > now || now >= timestamp(at(p, 6)))
        return 'validity'
      const { current, previous } = stampPair(
        history,
        c.restart === 'pair-lost',
      )
      return eq(at(p, 8), current) || eq(at(p, 8), previous)
        ? 'accept'
        : 'stamp-binding'
    }
    const fail = (condition: boolean, reason: string): void => {
      if (!condition) throw Error(reason)
    }
    const schema = n(present(opened.env.get(1n))),
      floor = n(present(opened.env.get(2n)))
    fail(
      historyFits(
        BigInt(c.history.length),
        chargedBytes(c.history, corpus),
        1n,
        chargedBytes([r.id], corpus),
      ),
      'history-resource',
    )
    fail(
      schema >= 4n && floor === 4n && BigInt(c.reader ?? 4) >= floor,
      'unsupported-version',
    )
    const required = [0, 1, 2, 3, 4, 6, 8, 10, 11, 12, 13]
    fail(
      required.every(k => m(p).has(BigInt(k))),
      'shape',
    )
    fail(![5, 7, 9].some(k => m(p).has(BigInt(k))), 'unsupported-policy')
    fail(
      schema > 4n || [...m(p).keys()].every(k => required.includes(Number(k))),
      'shape',
    )
    fail(
      opened.frame.length <= 262144 && fromHex(r.type2_hex).length <= 262144,
      'resource',
    )
    fail(at(p, 0) === (c.network ?? NETWORK), 'network')
    const points = [1, 10, 8].map(k => point(at(p, k)))
    fail(new Set(points).size === 3, 'role-separation')
    if (head) fail(eq(at(p, 1), at(head, 1)), 'unsupported-policy')
    const issued = timestamp(at(p, 3)),
      expiry = timestamp(at(p, 6))
    fail(
      issued <= now &&
        (historicalLink || now < expiry) &&
        expiry > issued &&
        expiry - issued <= 3600000000000n,
      'validity',
    )
    const bindings = at(p, 4)
    fail(Array.isArray(bindings) && bindings.length === 1, 'shape')
    const binding = (bindings as Value[])[0]
    point(at(binding, 2))
    const endpoint = at(binding, 1),
      relayId = b(at(binding, 0))
    fail(
      typeof endpoint === 'string' &&
        endpoint.startsWith('https:') &&
        endpoint.length <= 2048 &&
        /^[\x21-\x7e]+$/.test(endpoint) &&
        !/["<>\\^`{|}]/.test(endpoint) &&
        relayId.length >= 16 &&
        relayId.length <= 64,
      'binding',
    )
    fail(timestamp(at(binding, 3)) >= expiry, 'binding-expiry')
    fail(
      historicalLink ||
        (c.relay !== null &&
          toHex(encodeCanonical(binding)) ===
            (c.relay ?? corpus.synthetic_relay_cbor_hex)),
      'binding',
    )
    const wrapper = open(r.type2_hex)
    fail(eq(at(wrapper.payload, 0), opened.frame), 'commitment')
    const entries = at(wrapper.payload, 1) as Value[]
    fail(
      entries.length === 1 &&
        n(at(entries[0], 0)) === 1n &&
        eq(at(entries[0], 1), at(p, 1)),
      'signer',
    )
    fail(
      verifyAlgorithm1(
        directorySignatureDigest(at(p, 0) as string, opened.frame),
        b(at(entries[0], 2)),
        b(at(at(p, 1), 1)),
      ),
      'signature',
    )
    fail(c.claimed_t1 === undefined || c.claimed_t1 === r.t1, 'commitment')
    if (!head) {
      fail(
        n(at(p, 2)) === 0n &&
          n(at(p, 11)) === 0n &&
          n(at(p, 12)) === 0n &&
          at(p, 13) === null,
        'bootstrap',
      )
      fail(
        c.anchor !== undefined && c.anchor !== null && c.anchor === r.t1,
        'anchor',
      )
      return 'accept'
    }
    const prior = byId(c.history[c.history.length - 1])
    if (r.type4_hex === prior.type4_hex) return 'duplicate'
    const sameRevision = c.history.find(
      id => n(at(open(byId(id).type4_hex).payload, 2)) === n(at(p, 2)),
    )
    if (sameRevision && byId(sameRevision).type4_hex !== r.type4_hex)
      throw Error('fork')
    fail(n(at(p, 2)) >= n(at(head, 2)), 'rollback')
    fail(n(at(p, 2)) !== n(at(head, 2)), 'fork')
    fail(
      schema >= n(present(open(prior.type4_hex).env.get(1n))),
      'schema-downgrade',
    )
    fail(
      n(at(head, 2)) < MAX && n(at(p, 2)) === n(at(head, 2)) + 1n,
      'revision',
    )
    fail(eq(at(p, 13), fromHex(prior.t1)), 'predecessor')
    fail(issued >= timestamp(at(head, 3)), 'issue-order')
    for (const [role, generation] of [
      [10, 11],
      [8, 12],
    ]) {
      const changed = !eq(at(p, role), at(head, role)),
        prev = n(at(head, generation))
      fail(
        changed
          ? prev < MAX && n(at(p, generation)) === prev + 1n
          : n(at(p, generation)) === prev,
        'generation',
      )
      if (changed)
        fail(
          !history.some(h =>
            [1, 10, 8].some(k => point(at(h, k)) === point(at(p, role))),
          ),
          'key-reuse',
        )
    }
    return 'accept'
  } catch (error) {
    return (error as Error).message
  }
}
const generated = generate()
if (process.argv.includes('--write'))
  writeFileSync(FILE, JSON.stringify(generated, null, 2) + '\n')
const corpus = JSON.parse(readFileSync(FILE, 'utf8')) as Corpus
assert.deepEqual(
  corpus,
  generated,
  'deterministic corpus differs; inspect change before --write',
)
for (const r of corpus.records) {
  for (const hex of [r.type4_hex, r.type2_hex]) {
    const opened = open(hex)
    assert.equal(
      toHex(encodeCanonical(opened.env)),
      toHex(opened.frame.subarray(9)),
    )
    assert.equal(
      toHex(encodeCanonical(opened.payload)),
      toHex(b(present(opened.env.get(3n)))),
    )
  }
  assert.equal(
    t1(at(open(r.type4_hex).payload, 0) as string, fromHex(r.type4_hex)),
    r.t1,
  )
  assert.equal(oldReader(fromHex(r.type2_hex)), r.old_reader)
  if (n(present(open(r.type4_hex).env.get(2n))) >= 4n) {
    const retained = validateFrame(
      fromHex(r.type4_hex),
      defaultContext({ opaqueRetentionAllowed: true }),
    )
    assert.equal(retained.kind, 'retained')
    assert.equal(toHex(retained.frame), r.type4_hex)
  }
}
// Positive history inputs represent previously verified state, never attacker-selected shortcuts.
for (const c of corpus.cases) {
  for (let i = 0; i < c.history.length; i++) {
    const h: Case = {
      id: 'history',
      operation: 'directory',
      record: c.history[i],
      history: c.history.slice(0, i),
      expected: 'accept',
      anchor: present(corpus.records.find(r => r.id === c.history[i])).t1,
    }
    assert.equal(outcome(h, corpus), 'accept', `${c.id}: invalid history`)
  }
  assert.equal(outcome(c, corpus), c.expected, c.id)
  if (c.operation === 'advance') {
    const before = JSON.stringify(c.history)
    const transaction = advance(c, corpus)
    assert.deepEqual(
      transaction.history,
      c.committed_history,
      `${c.id}: atomic history`,
    )
    assert.equal(
      transaction.previous_stamp,
      c.previous_stamp,
      `${c.id}: atomic stamp pair`,
    )
    assert.equal(
      JSON.stringify(c.history),
      before,
      `${c.id}: input state mutated`,
    )
  }
}
for (const s of corpus.frozen_sha256)
  assert.equal(sha(readFileSync(resolve(ROOT, s.path))), s.sha256, s.path)
assert.equal(
  present(corpus.records.find(r => r.id === 'bootstrap')).old_reader,
  'unsupported',
)
assert.equal(
  present(corpus.records.find(r => r.id === 'old-schema2')).old_reader,
  'accept',
)
assert.equal(
  present(corpus.records.find(r => r.id === 'old-schema3')).old_reader,
  'accept',
)
if (!process.argv.includes('--write')) {
  const rust = JSON.parse(
    readFileSync(
      resolve(
        ROOT,
        'backend/cashweb/frank-cbor/proposals/suite1-directory/rust-origin.json',
      ),
      'utf8',
    ),
  ) as RecordVector
  const wrapper = open(rust.type2_hex).payload
  const entry = (at(wrapper, 1) as Value[])[0]
  assert.equal(toHex(b(at(wrapper, 0))), corpus.records[0].type4_hex)
  assert.equal(rust.t1, corpus.records[0].t1)
  assert(
    verifyAlgorithm1(
      fromHex(rust.t2_digest),
      b(at(entry, 2)),
      b(at(at(entry, 1), 1)),
    ),
  )
}
console.log(
  `proposal TS: ${corpus.records.length} exact frame pairs; ${corpus.cases.length} policy cases; ${corpus.frozen_sha256.length} frozen files unchanged`,
)
