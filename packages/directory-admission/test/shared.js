import { decodeCanonical, fromHex, toHex } from '@frank/codec'
import corpus from '../../../docs/protocol/cbor/vectors/directory-admission.json'
import vectors from '../../../docs/protocol/proposals/suite1-directory/vectors.json'
import { budget, counterFollows } from '../src/policy/history'

// These are published bytes and expectations, never the proposal's policy engine.
export { corpus, vectors }
const records = new Map(vectors.records.map(record => [record.id, record]))
export const canonical = value =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString()
      : item instanceof Uint8Array
      ? toHex(item)
      : item,
  )
export function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected))
    throw new Error(
      `${label}: expected ${canonical(expected)}, got ${canonical(actual)}`,
    )
}
export function assert(value, label) {
  if (!value) throw new Error(label)
}
export function candidate(id) {
  const record = records.get(id)
  assert(record, `unknown pinned record ${id}`)
  return {
    statement: fromHex(record.type4_hex),
    attestation: fromHex(record.type2_hex),
  }
}
export const hash = id => fromHex(records.get(id).t1)
export const anchor = (revisionZero = corpus.cases[0].anchor) => ({
  network: corpus.network,
  subject: { keyType: 1, keyBytes: fromHex(corpus.subject) },
  revisionZero:
    revisionZero === null ? new Uint8Array(32) : fromHex(revisionZero),
})
export const timestamp = seconds =>
  seconds === null ? null : { seconds: BigInt(seconds), nanoseconds: 0 }
export function relay(hex = vectors.synthetic_relay_cbor_hex) {
  if (hex === null) return null
  const value = decodeCanonical(fromHex(hex))
  const identity = value.get(2n)
  const expiry = value.get(3n)
  return {
    relayId: value.get(0n),
    endpoint: value.get(1n),
    identity: { keyType: Number(identity.get(0n)), keyBytes: identity.get(1n) },
    expiry: { seconds: expiry.get(0n), nanoseconds: Number(expiry.get(1n)) },
    unknownFields: new Map(),
  }
}
export const context = (
  seconds = '1700000100',
  binding = vectors.synthetic_relay_cbor_hex,
) => ({ now: timestamp(seconds), relay: relay(binding) })
export async function category(operation) {
  try {
    await operation()
    return 'accept'
  } catch (error) {
    if (typeof error.code !== 'string') throw error
    return error.code
  }
}
export async function rejects(operation, expected, label) {
  equal(await category(operation), expected, label)
}

export async function compareState(store, expected, label) {
  const status = await store.status()
  if (!expected.enrolled) {
    equal(status, null, `${label}: unenrolled`)
    return
  }
  equal(status.kind, 'historical-status', `${label}: status authority`)
  equal(status.head, expected.head_hash, `${label}: head hash`)
  equal(status.revision, expected.revision, `${label}: revision`)
  equal(status.generations, expected.generations, `${label}: generations`)
  equal(
    status.currentStamp?.keyBytes ?? null,
    expected.current_stamp,
    `${label}: stamp`,
  )
  equal(
    status.previousStamp?.keyBytes ?? null,
    expected.previous_stamp,
    `${label}: previous stamp`,
  )
  equal(status.accepted, expected.accepted, `${label}: accepted`)
  equal(status.retained, expected.retained, `${label}: retained`)
  equal(status.chargedBytes, expected.charged_bytes, `${label}: charged bytes`)
  equal(status.forked, expected.forked, `${label}: forked`)
  equal(
    status.checkedTime && [
      status.checkedTime.seconds.toString(),
      String(status.checkedTime.nanoseconds),
    ],
    expected.checked_time,
    `${label}: time`,
  )
  for (const id of expected.history) {
    const evidence = await store.historicalEvidence(hash(id))
    equal(
      evidence?.kind,
      'historical-evidence',
      `${label}: historical authority`,
    )
    equal(
      evidence?.statement,
      candidate(id).statement,
      `${label}: retained exact statement ${id}`,
    )
    equal(
      evidence?.attestation,
      candidate(id).attestation,
      `${label}: retained exact attestation ${id}`,
    )
    equal(evidence?.hash, hash(id), `${label}: retained T1 ${id}`)
  }
  const proof = await store.conflictEvidence()
  equal(proof.length, expected.proof.length, `${label}: conflict count`)
  for (let i = 0; i < proof.length; i++) {
    equal(proof[i].kind, 'historical-evidence', `${label}: conflict authority`)
    equal(
      proof[i].statement,
      candidate(expected.proof[i]).statement,
      `${label}: conflict statement`,
    )
    equal(
      proof[i].attestation,
      candidate(expected.proof[i]).attestation,
      `${label}: conflict wrapper`,
    )
  }
}

export async function runCorpus(open) {
  let passed = 0
  for (const item of corpus.cases) {
    const installed = anchor(item.anchor)
    let store = await open(item.id, installed, { kind: 'new' })
    try {
      if (item.history.length)
        await store.enroll(
          item.history.map(candidate),
          context(item.initial_clock),
        )
      let result
      const actual = await category(async () => {
        result = await store[item.history.length ? 'advance' : 'enroll'](
          item.candidates.map(candidate),
          context(item.clock, item.relay),
        )
      })
      equal(actual, item.result, `${item.id}: result category`)
      await compareState(store, item.expected, item.id)
      if (result) {
        equal(result.kind, 'current', `${item.id}: current authority`)
        equal(
          result.messageKey.keyBytes,
          item.expected.message_key,
          `${item.id}: message key`,
        )
        equal(
          result.evidence.statement,
          candidate(item.expected.head).statement,
          `${item.id}: terminal bytes`,
        )
        equal(
          result.evidence.attestation,
          candidate(item.expected.head).attestation,
          `${item.id}: terminal wrapper`,
        )
        equal(
          result.evidence.hash,
          item.expected.head_hash,
          `${item.id}: terminal T1`,
        )
      }
      const status = await store.status()
      await store.close()
      if (status) {
        store = await open(item.id, installed, {
          kind: 'reopen',
          checkpoint: status.checkpoint,
        })
        await compareState(store, item.expected, `${item.id}: reopen`)
      }
      passed++
    } catch (error) {
      throw new Error(`shared case ${item.id}: ${error.message}`, {
        cause: error,
      })
    } finally {
      await store.close()
    }
  }
  for (const probe of corpus.probes) {
    const result = await category(async () => {
      if (probe.operation === 'history-budget')
        budget(
          Number(probe.stored_count),
          Number(probe.stored_bytes),
          Number(probe.incoming_count),
          Number(probe.incoming_bytes),
        )
      else if (
        !counterFollows(
          BigInt(probe.prior_value),
          BigInt(probe.next_value),
          probe.increment,
        )
      )
        throw Object.assign(new Error('counter'), { code: 'counter' })
    })
    // Probe names retain proposal vocabulary; public Rust/TS category is resource.
    equal(
      result,
      probe.expected === 'history-resource' ? 'resource' : probe.expected,
      `${probe.id}: shared private boundary probe`,
    )
  }
  return { cases: passed, probes: corpus.probes.length }
}

export async function facadeRegressions(open) {
  const store = await open('facade', anchor(), { kind: 'new' })
  try {
    await store.enroll([candidate('bootstrap')], context())
    const snapshot = await store.status()
    const before = canonical(snapshot)
    const input = candidate('renew')
    const pending = store.advance([input], context())
    input.statement.fill(0)
    input.attestation.fill(0)
    const result = await pending
    result.evidence.statement.fill(0)
    result.evidence.attestation.fill(0)
    result.messageKey.keyBytes.fill(0)
    result.stampKey.keyBytes.fill(0)
    equal(
      (await store.historicalEvidence(hash('renew'))).statement,
      candidate('renew').statement,
      'owned returned/input evidence',
    )
    equal(canonical(snapshot), before, 'old status is a point-in-time snapshot')
    const after = await store.status()
    await store.advance([candidate('renew')], context())
    equal(await store.status(), after, 'duplicate retry preserves all state')
    await rejects(
      () => store.current(context('1700000099')),
      'clock',
      'clock rollback',
    )
    equal(await store.status(), after, 'failed current preserves status')
    const edge = context()
    edge.now.nanoseconds = 1
    await store.current(edge)
    await rejects(
      () => store.current(context()),
      'clock',
      'nanosecond rollback',
    )
    const oversized = {
      statement: new Uint8Array(corpus.frame_limit + 1),
      attestation: new Uint8Array(1),
    }
    await rejects(
      () => store.advance([oversized], edge),
      'resource',
      'frame bound before crypto',
    )
    await rejects(
      () =>
        store.advance(
          Array(corpus.statement_limit).fill(candidate('renew')),
          edge,
        ),
      'resource',
      'duplicate inputs counted before crypto',
    )
    const charged = candidate('renew')
    charged.attestation = new Uint8Array(corpus.frame_limit)
    await rejects(
      () => store.advance(Array(65).fill(charged), edge),
      'resource',
      'actual aggregate frames before crypto',
    )
    await rejects(
      () => store.enroll([candidate('bootstrap')], edge),
      'already-enrolled',
      'explicit enrollment cannot replace history',
    )
    const safe = await store.status()
    const shadow = context()
    shadow.now = edge.now
    shadow.relay.endpoint = 'https://untrusted.invalid'
    shadow.relay.unknownFields.set(1n, context().relay.endpoint)
    await rejects(
      () => store.current(shadow),
      'binding',
      'unknown fields cannot shadow trusted endpoint',
    )
    await rejects(
      () =>
        store.advance([candidate('fork-of-renew')], {
          now: edge.now,
          relay: {},
        }),
      'binding',
      'malformed relay cannot poison healthy state',
    )
    equal(
      await store.status(),
      safe,
      'rejected trust input preserves healthy state',
    )
    return { facade: 14 }
  } finally {
    await store.close()
  }
}

export async function checkpointRegressions(open) {
  let store = await open('checkpoint', anchor(), { kind: 'new' })
  const prepared = await store.checkpointForEnrollment(
    candidate('bootstrap'),
    context().now,
  )
  equal(
    prepared.kind,
    'ProspectiveEnrollment',
    'prepared checkpoint provenance',
  )
  await store.enroll([candidate('bootstrap')], context())
  const committed = (await store.status()).checkpoint
  equal(committed.kind, 'CommittedPrefix', 'durable checkpoint provenance')
  equal(
    prepared.evidenceDigest,
    committed.evidenceDigest,
    'prepared and committed exact prefix digest',
  )
  await store.advance(['renew', 'rotate-stamp'].map(candidate), context())
  await store.close()
  for (const checkpoint of [prepared, committed]) {
    store = await open('checkpoint', anchor(), { kind: 'reopen', checkpoint })
    equal(
      (await store.status()).revision,
      2n,
      'authenticated descendant survives lost acknowledgement',
    )
    await store.close()
    for (const field of [
      'identity',
      'anchor',
      'head',
      'evidenceDigest',
      'checkedTime',
    ]) {
      const wrong = structuredClone(checkpoint)
      if (field === 'checkedTime') wrong.checkedTime.nanoseconds++
      else wrong[field][0] ^= 1
      await rejects(
        () =>
          open('checkpoint', anchor(), { kind: 'reopen', checkpoint: wrong }),
        'continuity',
        `reject altered ${checkpoint.kind} ${field}`,
      )
    }
  }
  for (const mode of [{ kind: 'reopen' }, { kind: 'reopen', checkpoint: null }])
    await rejects(
      () => open('checkpoint', anchor(), mode),
      'continuity',
      'reopen requires full explicit checkpoint',
    )
  return { checkpoints: 16 }
}
