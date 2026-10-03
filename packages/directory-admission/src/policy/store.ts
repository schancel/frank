import { toHex } from '@frank/codec'
import type {
  Anchor,
  Candidate,
  Context,
  Current,
  DirectoryStore,
  OpenMode,
  Checkpoint,
} from '../index'
import type { Timestamp } from '@frank/codec'
import {
  ownBytes,
  ownCandidate,
  ownContext,
  ownEvidence,
  ownPoint,
  ownTime,
} from './owned-inputs'
import {
  AdmissionError,
  authenticate,
  bootstrap,
  budget,
  classify,
  clock,
  equal,
  fail,
  fresh,
  nanos,
  preflight,
  previousStamp,
  requireRelay,
  statementBytes,
  U64_MAX,
  validateAnchor,
} from './history'
import {
  allRecords,
  evidenceDigest,
  header,
  identity,
  load,
  marker,
  metadata,
  recordKey,
  State,
  status,
  Storage,
  verifiesCheckpoint,
  Row,
  Metadata,
} from '../storage/records'

export async function openStore(
  storage: Storage,
  anchor: Anchor,
  mode: OpenMode,
): Promise<DirectoryStore> {
  let unavailable = false
  let closed = false
  let enrolled = mode.kind === 'reopen'
  let continuity: Checkpoint | null =
    mode.kind === 'reopen' ? mode.checkpoint : null
  let queue: Promise<unknown> = Promise.resolve()
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      if (unavailable || closed) fail('unavailable')
      try {
        return await action()
      } catch (e) {
        if (!(e instanceof AdmissionError) || e.code === 'unavailable') {
          unavailable = true
          fail('unavailable')
        }
        throw e
      }
    })
    queue = result.catch(() => undefined)
    return result
  }
  async function read(): Promise<{
    rows: Row[]
    meta: Metadata | null
    state: State | null
  }> {
    const rows = await storage.read()
    const meta = header(rows, anchor)
    if (enrolled && !meta) fail('unavailable')
    const state = await load(rows, anchor, meta)
    if (
      continuity &&
      (!state || !(await verifiesCheckpoint(anchor, state, continuity)))
    )
      fail('continuity')
    if (state) enrolled = true
    return { rows, meta, state }
  }
  try {
    validateAnchor(anchor)
    const loaded = await read()
    if (mode.kind === 'new' && loaded.state) fail('already-enrolled')
    if (mode.kind === 'reopen' && !loaded.state) fail('unavailable')
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }

  async function commit(
    s: State,
    prior: Metadata | null,
    rows: Row[],
  ): Promise<Metadata> {
    let m = await metadata(anchor, s)
    const additions: Row[] = []
    if (JSON.stringify(prior) !== JSON.stringify(m)) {
      if (s.sequence === U64_MAX) fail('unavailable')
      s.sequence++
      m = await metadata(anchor, s)
      budget(m.retained, m.charged, 0, 0)
      const records = allRecords(s)
      for (let i = prior?.retained ?? 0; i < records.length; i++)
        additions.push([
          recordKey(i, records[i]),
          toHex(records[i].evidence.attestation),
        ])
      additions.push(['marker', marker(anchor)], ['head', JSON.stringify(m)])
    }
    // Even unchanged current results must CAS against the validated snapshot across tabs.
    await storage.commit(rows, additions)
    enrolled = true
    continuity = status(m).checkpoint
    return m
  }
  function update(
    candidates: readonly Candidate[],
    context: Context,
    intent: 'enroll' | 'advance',
  ): Promise<Current> {
    // Meter before copying attacker-supplied arrays or invoking expensive crypto.
    try {
      preflight(0, 0, candidates)
    } catch (error) {
      return Promise.reject(error)
    }
    const owned = candidates.map(ownCandidate)
    // Snapshot before yielding, but keep malformed-relay errors at the existing
    // relay-validation boundary (after storage/evidence preflight and clock).
    let ctx: Context = {
      now: context?.now == null ? null : ownTime(context.now),
      relay: null,
    }
    let contextError: AdmissionError | null = null
    try {
      ctx = ownContext(context)
    } catch (error) {
      if (!(error instanceof AdmissionError) || error.code !== 'binding')
        throw error
      contextError = error
    }
    return run(async () => {
      const rows = await storage.read()
      const meta = header(rows, anchor)
      if (enrolled && !meta) fail('unavailable')
      if (intent === 'enroll' && meta) fail('already-enrolled')
      if (intent === 'advance' && !meta) fail('unenrolled')
      preflight(meta?.retained ?? 0, meta?.charged ?? 0, owned)
      for (const c of owned)
        if (!equal(statementBytes(c.attestation), c.statement)) fail('evidence')
      const loaded = await load(rows, anchor, meta)
      if (
        continuity &&
        (!loaded || !(await verifiesCheckpoint(anchor, loaded, continuity)))
      )
        fail('continuity')
      const now = clock(ctx.now, loaded?.checked)
      if (contextError) throw contextError
      requireRelay(ctx.relay)
      const s: State = loaded ?? {
        history: [],
        proof: [],
        checked: now,
        sequence: 0n,
      }
      if (s.proof.length) fail('fork')
      const incoming = owned.map(c => {
        const r = authenticate(anchor, c.attestation)
        if (!equal(r.evidence.statement, c.statement)) fail('evidence')
        if (nanos(r.issued) > nanos(now)) fail('validity')
        return r
      })
      const accepted = s.history.length
      for (const r of incoming) {
        const transition = classify(s.history, anchor, r)
        if (transition === 'append') s.history.push(r)
        if (transition === 'fork') {
          s.proof = [...s.history.splice(accepted), r]
          s.checked = now
          await commit(s, meta, rows)
          fail('fork')
        }
      }
      const head = s.history[s.history.length - 1]
      if (!head) fail('unenrolled')
      fresh(head, now, ctx.relay)
      s.checked = now
      const committed = await commit(s, meta, rows)
      const previous = previousStamp(s.history)
      return {
        kind: 'current',
        evidence: ownEvidence(head.evidence),
        messageKey: ownPoint(head.message, 'evidence'),
        stampKey: ownPoint(head.stamp, 'evidence'),
        previousStamp: previous ? ownPoint(previous, 'evidence') : null,
        revision: head.revision,
        generations: [...head.generations] as [bigint, bigint],
        status: status(committed),
      }
    })
  }
  return {
    checkpointForEnrollment(
      candidate: Candidate,
      now: Timestamp,
    ): Promise<Checkpoint> {
      try {
        preflight(0, 0, [candidate])
      } catch (error) {
        return Promise.reject(error)
      }
      const c = ownCandidate(candidate),
        time = ownTime(now)
      return run(async () => {
        if (!equal(statementBytes(c.attestation), c.statement)) fail('evidence')
        const r = authenticate(anchor, c.attestation)
        bootstrap(anchor, r)
        clock(time)
        if (nanos(r.issued) > nanos(time)) fail('validity')
        return {
          kind: 'ProspectiveEnrollment',
          identity: await identity(anchor),
          anchor: ownBytes(anchor.revisionZero, 32, 'anchor', true),
          head: ownBytes(r.evidence.hash, 32, 'evidence', true),
          accepted: 1,
          retained: 1,
          evidenceDigest: await evidenceDigest([r]),
          checkedTime: time,
          forked: false,
        }
      })
    },
    enroll: (c, ctx) => update(c, ctx, 'enroll'),
    advance: (c, ctx) => update(c, ctx, 'advance'),
    current: ctx => update([], ctx, 'advance'),
    status: () =>
      run(async () => {
        const { meta } = await read()
        return meta ? status(meta) : null
      }),
    historicalEvidence(hash) {
      const owned = ownBytes(hash, 32, 'evidence', true)
      return run(async () => {
        const { state } = await read()
        if (!state) fail('unenrolled')
        const evidence = state.history.find(r =>
          equal(r.evidence.hash, owned),
        )?.evidence
        return evidence ? ownEvidence(evidence) : null
      })
    },
    conflictEvidence: () =>
      run(async () => {
        const { state } = await read()
        if (!state) fail('unenrolled')
        return state.proof.map(r => ownEvidence(r.evidence))
      }),
    close() {
      const result = queue.then(async () => {
        closed = true
        await storage.close()
      })
      queue = result.catch(() => undefined)
      return result
    },
  }
}
