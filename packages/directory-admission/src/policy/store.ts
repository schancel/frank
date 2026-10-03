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

/** Copies occur synchronously at the API boundary, before queued operations yield. */
function copy<T>(value: T): T {
  return structuredClone(value)
}

export async function openStore(
  storage: Storage,
  anchor: Anchor,
  mode: OpenMode,
): Promise<DirectoryStore> {
  let unavailable = false
  let closed = false
  let enrolled = mode.kind === 'reopen'
  let continuity: Checkpoint | null =
    mode.kind === 'reopen' ? copy(mode.checkpoint) : null
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
    const owned = copy(candidates)
    const ctx = copy(context)
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
      return copy({
        kind: 'current',
        evidence: head.evidence,
        messageKey: head.message,
        stampKey: head.stamp,
        previousStamp: previousStamp(s.history),
        revision: head.revision,
        generations: head.generations,
        status: status(committed),
      })
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
      const c = copy(candidate),
        time = copy(now)
      return run(async () => {
        if (!equal(statementBytes(c.attestation), c.statement)) fail('evidence')
        const r = authenticate(anchor, c.attestation)
        bootstrap(anchor, r)
        clock(time)
        if (nanos(r.issued) > nanos(time)) fail('validity')
        return {
          kind: 'ProspectiveEnrollment',
          identity: await identity(anchor),
          anchor: copy(anchor.revisionZero),
          head: copy(r.evidence.hash),
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
      const owned = copy(hash)
      return run(async () => {
        const { state } = await read()
        if (!state) fail('unenrolled')
        return copy(
          state.history.find(r => equal(r.evidence.hash, owned))?.evidence ??
            null,
        )
      })
    },
    conflictEvidence: () =>
      run(async () => {
        const { state } = await read()
        if (!state) fail('unenrolled')
        return copy(state.proof.map(r => r.evidence))
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
