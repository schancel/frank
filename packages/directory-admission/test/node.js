import { mkdtemp, rm, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import level from 'level'
import LevelUP from 'levelup'
import { openNodeDirectoryStore } from '../src/node'
import {
  anchor,
  candidate,
  context,
  hash,
  runCorpus,
  facadeRegressions,
  checkpointRegressions,
  assert,
  equal,
  rejects,
} from './shared'

const open = (location, mode = { kind: 'new' }) =>
  openNodeDirectoryStore({ location, anchor: anchor(), mode })
const savedBatch = LevelUP.prototype.batch
let batchHook = null
LevelUP.prototype.batch = function (operations, options, callback) {
  if (!batchHook) return savedBatch.call(this, operations, options, callback)
  assert(
    options?.sync === true,
    'every trusted write requires native sync:true',
  )
  return batchHook(this, operations, options, callback)
}
function pauseAtBatch(phase) {
  batchHook = (db, operations, options, callback) => {
    const pause = () => {
      process.send({ type: 'barrier', phase })
      return new Promise(() => {})
    }
    if (phase === 'before') return pause()
    if (callback)
      return savedBatch.call(db, operations, options, error => {
        if (error) callback(error)
        else pause()
      })
    return savedBatch.call(db, operations, options).then(pause)
  }
}
async function child(configuration) {
  const store = await open(configuration.location, configuration.mode)
  if (configuration.action === 'lock') {
    process.send({ type: 'held' })
    return
  }
  try {
    if (configuration.phase) pauseAtBatch(configuration.phase)
    if (configuration.action === 'enroll')
      await store.enroll([candidate('bootstrap')], context())
    if (configuration.action === 'advance')
      await store.advance(configuration.ids.map(candidate), context())
    const status = await store.status()
    const evidence = status?.head
      ? await store.historicalEvidence(status.head)
      : null
    process.send({ type: 'done', status, evidence })
  } finally {
    await store.close()
  }
}
function launch(configuration, expected = 'done') {
  const processChild = fork(__filename, ['--child'], {
    serialization: 'advanced',
    silent: true,
  })
  let stderr = ''
  processChild.stderr.on('data', chunk => {
    stderr += chunk
  })
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      processChild.kill('SIGKILL')
      reject(new Error(`child timeout: ${stderr}`))
    }, 20000)
    processChild.on('message', message => {
      if (message.type === expected || message.type === 'error') {
        clearTimeout(timeout)
        resolve(message)
      }
    })
    processChild.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    processChild.on('exit', code => {
      clearTimeout(timeout)
      if (code && code !== 0)
        reject(new Error(`child exited ${code}: ${stderr}`))
    })
  })
  processChild.send(configuration)
  return { process: processChild, result }
}
async function stop(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return
  const exited = new Promise(resolve => childProcess.once('exit', resolve))
  childProcess.kill('SIGKILL')
  await exited
}
async function childResult(configuration) {
  const task = launch(configuration)
  const result = await task.result
  if (task.process.connected) task.process.disconnect()
  if (result.type === 'error')
    throw Object.assign(new Error(result.message), { code: result.code })
  return result
}
async function persistence(root) {
  const location = path.join(root, 'process-restart')
  const first = await childResult({
    location,
    mode: { kind: 'new' },
    action: 'enroll',
  })
  const mode = { kind: 'reopen', checkpoint: first.status.checkpoint }
  const restarted = await childResult({ location, mode, action: 'read' })
  equal(restarted.status, first.status, 'child process restart exact state')
  equal(restarted.evidence, first.evidence, 'child process restart exact bytes')
  const lockHolder = launch({ location, mode, action: 'lock' }, 'held')
  equal(
    (await lockHolder.result).type,
    'held',
    'first process owns native lock',
  )
  try {
    await rejects(
      () => childResult({ location, mode, action: 'read' }),
      'unavailable',
      'second process native Level lock',
    )
  } finally {
    await stop(lockHolder.process)
  }
  for (const phase of ['before', 'after']) {
    const interrupted = launch(
      {
        location,
        mode,
        action: 'advance',
        ids: ['renew', 'rotate-stamp'],
        phase,
      },
      'barrier',
    )
    equal(
      (await interrupted.result).phase,
      phase,
      `reached ${phase}-commit interruption`,
    )
    await stop(interrupted.process)
    const recovered = await childResult({ location, mode, action: 'read' })
    if (phase === 'before')
      equal(
        recovered.status,
        first.status,
        'before-commit termination preserves complete prior state',
      )
    else {
      equal(
        recovered.status.revision,
        2n,
        'after-commit lost acknowledgement retains terminal',
      )
      equal(recovered.status.accepted, 3, 'after-commit accepted count')
      equal(recovered.status.retained, 3, 'after-commit retained count')
      assert(
        recovered.status.previousStamp !== null,
        'after-commit previous stamp survives restart',
      )
      const retried = await childResult({
        location,
        mode,
        action: 'advance',
        ids: ['rotate-stamp'],
      })
      equal(
        retried.status,
        recovered.status,
        'lost acknowledgement duplicate retry preserves full state',
      )
    }
  }
  const store = await open(location, mode)
  await rejects(
    () => open(location, mode),
    'unavailable',
    'second same-process native handle cannot bypass exclusive lock',
  )
  const concurrent = await Promise.all([
    store.current(context('1700000101')),
    store.current(context('1700000102')),
  ])
  equal(
    concurrent[1].status.checkedTime.seconds,
    1700000102n,
    'same-handle serialized clocks',
  )
  await rejects(
    () => store.current(context('1700000101')),
    'clock',
    'concurrent clock floor retained',
  )
  const durable = await store.status()
  await store.close()
  await rejects(
    () => open(location),
    'already-enrolled',
    'new mode cannot overwrite existing database',
  )
  const missing = path.join(root, 'deleted-store')
  await rejects(
    () => open(missing, { kind: 'reopen', checkpoint: durable.checkpoint }),
    'unavailable',
    'explicit reopen never creates missing namespace',
  )
  let exists = true
  try {
    await access(missing)
  } catch {
    exists = false
  }
  equal(exists, false, 'failed reopen does not recreate deleted namespace')
  return { process: 9, concurrency: 2 }
}
async function failures(root) {
  for (const forkFailure of [false, true]) {
    const location = path.join(
      root,
      forkFailure ? 'failed-fork' : 'failed-write',
    )
    let store = await open(location)
    await store.enroll([candidate('bootstrap'), candidate('renew')], context())
    const before = await store.status()
    batchHook = (_db, _operations, _options, callback) => {
      const error = new Error('injected native sync batch failure')
      if (callback) {
        queueMicrotask(() => callback(error))
        return
      }
      return Promise.reject(error)
    }
    try {
      await rejects(
        () =>
          store.advance(
            [candidate(forkFailure ? 'fork-of-renew' : 'rotate-stamp')],
            context(),
          ),
        'unavailable',
        'failed sync batch cannot acknowledge candidate',
      )
    } finally {
      batchHook = null
    }
    if (forkFailure)
      await rejects(
        () => store.current(context()),
        'unavailable',
        'failed conflict recording disables handle',
      )
    await store.close()
    store = await open(location, {
      kind: 'reopen',
      checkpoint: before.checkpoint,
    })
    equal(
      await store.status(),
      before,
      'failed native write reopens exact prior head/stamp/counters',
    )
    if (forkFailure) {
      await rejects(
        () => store.advance([candidate('fork-of-renew')], context()),
        'fork',
        'verified reopen may record conflict',
      )
      await rejects(
        () => store.current(context()),
        'fork',
        'durable conflict disables fresh use',
      )
    }
    await store.close()
  }
  return { failures: 2 }
}
async function corruption(root) {
  const unrelatedLocation = path.join(root, 'unrelated-store')
  const unrelated = level(unrelatedLocation, { valueEncoding: 'utf8' })
  await unrelated.open()
  await unrelated.put('sentinel', 'preserve-me', { sync: true })
  await unrelated.close()
  for (const mutation of [
    'unknown-format',
    'missing-history',
    'head',
    'truncated-evidence',
  ]) {
    const location = path.join(root, mutation)
    const store = await open(location)
    await store.enroll(
      [candidate('bootstrap'), candidate('renew'), candidate('rotate-stamp')],
      context(),
    )
    const expected = await store.status()
    await store.close()
    const db = level(location, { valueEncoding: 'utf8' })
    await db.open()
    const rows = []
    for await (const row of db.createReadStream()) rows.push(row)
    const evidence = rows.filter(row => row.key.startsWith('e:'))
    equal(evidence.length, 3, 'one physical evidence row per retained record')
    assert(
      rows.length <= 6,
      'retained layout is linear, without nested snapshots',
    )
    if (mutation === 'unknown-format')
      await db.put('format', 'directory-admission-v999', { sync: true })
    if (mutation === 'missing-history')
      await db.del(evidence[0].key, { sync: true })
    if (mutation === 'head') await db.put('head', '{}', { sync: true })
    if (mutation === 'truncated-evidence')
      await db.put(evidence[0].key, evidence[0].value.slice(0, 10), {
        sync: true,
      })
    await db.close()
    await rejects(
      () => open(location, { kind: 'reopen', checkpoint: expected.checkpoint }),
      'unavailable',
      `reject ${mutation}`,
    )
    const inspect = level(unrelatedLocation, { valueEncoding: 'utf8' })
    await inspect.open()
    equal(
      await inspect.get('sentinel'),
      'preserve-me',
      'corruption rejection never resets unrelated databases',
    )
    await inspect.close()
  }
  return { corruption: 4 }
}
async function main() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), 'frank-admission-node-')),
  )
  try {
    const factory = (name, installed, mode) =>
      openNodeDirectoryStore({
        location: path.join(root, name),
        anchor: installed,
        mode,
      })
    const results = {}
    if (process.argv.includes('--corpus')) {
      Object.assign(
        results,
        await runCorpus(factory),
        await facadeRegressions(factory),
        await checkpointRegressions(factory),
      )
      const store = await factory('independent-checkpoint-digest', anchor(), {
        kind: 'new',
      })
      const checkpoint = await store.checkpointForEnrollment(
        candidate('bootstrap'),
        context().now,
      )
      const network = Buffer.from(anchor().network)
      equal(
        checkpoint.identity,
        new Uint8Array(
          createHash('sha256')
            .update(
              Buffer.concat([
                Buffer.from([network.length]),
                network,
                anchor().subject.keyBytes,
              ]),
            )
            .digest(),
        ),
        'Rust-compatible independent checkpoint identity',
      )
      const input = candidate('bootstrap')
      const lengths = Buffer.alloc(8)
      lengths.writeBigUInt64BE(BigInt(input.attestation.length))
      const digest = createHash('sha256')
        .update(Buffer.alloc(8))
        .update(hash('bootstrap'))
        .update(lengths)
        .update(input.attestation)
        .digest()
      equal(
        checkpoint.evidenceDigest,
        new Uint8Array(digest),
        'Rust-compatible independent checkpoint evidence transcript',
      )
      await store.close()
    } else {
      Object.assign(
        results,
        await persistence(root),
        await failures(root),
        await corruption(root),
      )
    }
    console.log(
      JSON.stringify({ ok: true, backend: 'native-level-7', ...results }),
    )
  } finally {
    batchHook = null
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv.includes('--child'))
  process.on('message', configuration => {
    child(configuration).catch(error => {
      process.send(
        { type: 'error', code: error.code, message: error.message },
        () => process.disconnect(),
      )
    })
  })
else
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
