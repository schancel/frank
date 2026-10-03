const { build, packageRoot } = require('./build-tests.cjs')
const fs = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')
const assert = require('assert/strict')

const pack = value =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? { bigint: item.toString() }
      : item instanceof Uint8Array
      ? { bytes: Array.from(item) }
      : item,
  )
const unpack = value =>
  JSON.parse(value, (_, item) =>
    item && typeof item === 'object' && Object.keys(item).length === 1
      ? 'bigint' in item
        ? BigInt(item.bigint)
        : 'bytes' in item
        ? Uint8Array.from(item.bytes)
        : item
      : item,
  )
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
class CDP {
  constructor(socket) {
    this.socket = socket
    this.next = 1
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error)
        pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('browser connection closed'))
      }
      this.pending.clear()
    })
  }
  send(method, params = {}, sessionId) {
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout: ${method}`))
      }, 180000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  async evaluate(session, expression, awaitPromise = true) {
    const response = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      session,
    )
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails))
    return response.result.value
  }
  async call(session, command) {
    const response = await this.evaluate(
      session,
      `directoryTests.run(${JSON.stringify(command)})`,
    )
    if (!response.ok)
      throw Object.assign(new Error(response.error), { code: response.code })
    return unpack(response.value)
  }
}
async function poll(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error(`timed out: ${description}`)
}
async function launch(chrome, profile) {
  const processChild = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  )
  console.log(`Chromium PID ${processChild.pid}, persistent profile ${profile}`)
  let stderr = ''
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      processChild.kill('SIGKILL')
      reject(new Error(`Chrome startup timeout: ${stderr.slice(-1500)}`))
    }, 120000)
    processChild.stderr.on('data', data => {
      stderr += data
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    processChild.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    processChild.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Chrome exited ${code}: ${stderr.slice(-1500)}`))
    })
  })
  const socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  return { process: processChild, cdp: new CDP(socket) }
}
async function stop(browser, force = false) {
  if (
    !browser ||
    browser.process.exitCode !== null ||
    browser.process.signalCode !== null
  )
    return
  const exited = new Promise(resolve => browser.process.once('exit', resolve))
  const killGroup = () => {
    try {
      process.kill(-browser.process.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  if (force) killGroup()
  else browser.cdp.send('Browser.close').catch(() => {})
  const timer = setTimeout(killGroup, 10000)
  await exited
  clearTimeout(timer)
  killGroup()
  browser.cdp.socket.close()
}
async function tab(cdp, origin) {
  const { targetId } = await cdp.send('Target.createTarget', { url: origin })
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await poll(
    () =>
      cdp
        .evaluate(sessionId, 'typeof directoryTests === "object"')
        .catch(() => false),
    'browser bundle load',
  )
  return sessionId
}
async function expectedCode(operation, code, label) {
  await assert.rejects(operation, error => error.code === code, label)
}
async function race(cdp, a, b, left, right) {
  await Promise.all([
    cdp.call(a, { action: 'fault', value: 'snapshot' }),
    cdp.call(b, { action: 'fault', value: 'snapshot' }),
  ])
  const outcomes = [cdp.call(a, left), cdp.call(b, right)].map(promise =>
    promise.then(
      value => ({ value }),
      error => ({ code: error.code, message: error.message }),
    ),
  )
  await poll(
    async () =>
      (
        await Promise.all([
          cdp.evaluate(a, 'snapshotReady'),
          cdp.evaluate(b, 'snapshotReady'),
        ])
      ).every(Boolean),
    'both tabs captured same durable snapshot',
  )
  await Promise.all([
    cdp.evaluate(a, 'releaseSnapshot()'),
    cdp.evaluate(b, 'releaseSnapshot()'),
  ])
  return Promise.all(outcomes)
}
async function main() {
  const chrome = [
    process.env.FRANK_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
    .filter(Boolean)
    .find(existsSync)
  if (!chrome) {
    console.error('No Chromium: real IndexedDB gate NOT RUN')
    process.exitCode = 3
    return
  }
  await build('browser')
  const bundle = await fs.readFile(
    path.join(packageRoot, 'dist/test-browser.js'),
  )
  const server = http.createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/bundle.js' ? 'text/javascript' : 'text/html',
    )
    response.end(
      request.url === '/bundle.js'
        ? bundle
        : '<!doctype html><script src="/bundle.js"></script>',
    )
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), 'frank-admission-chrome-'),
  )
  let browser
  try {
    browser = await launch(chrome, profile)
    let { cdp } = browser
    let a = await tab(cdp, origin)
    let b = await tab(cdp, origin)
    const results = await cdp.call(a, { action: 'corpus' })
    console.log(
      `IndexedDB shared policy and failures: ${JSON.stringify(results)}`,
    )
    await cdp.call(a, { action: 'open', name: 'persistent', handle: 'a' })
    await cdp.call(a, {
      action: 'enroll',
      handle: 'a',
      ids: ['bootstrap', 'renew', 'rotate-stamp'],
    })
    const initial = await cdp.call(a, { action: 'status', handle: 'a' })
    await cdp.call(b, {
      action: 'open',
      name: 'persistent',
      handle: 'b',
      checkpoint: pack(initial.checkpoint),
    })
    const successors = await race(
      cdp,
      a,
      b,
      { action: 'advance', handle: 'a', ids: ['renew-after-rotation'] },
      { action: 'advance', handle: 'b', ids: ['renew-after-rotation'] },
    )
    assert.equal(
      successors.filter(item => item.code === 'retryable').length,
      1,
      'one stale validation is rejected by native cross-tab CAS',
    )
    assert.equal(
      successors.filter(item => item.value).length,
      1,
      'one native transaction commits',
    )
    const rotated = await cdp.call(b, {
      action: 'advance',
      handle: 'b',
      ids: ['renew-after-rotation'],
    })
    assert.equal(rotated.revision, 3n)
    await cdp.call(b, {
      action: 'advance',
      handle: 'b',
      ids: ['rotate-stamp-again', 'rotate-message'],
    })
    const fresh = await cdp.call(a, { action: 'current', handle: 'a' })
    assert.equal(
      fresh.revision,
      5n,
      'first tab reads new durable head instead of stale cache',
    )
    const clocks = await race(
      cdp,
      a,
      b,
      { action: 'current', handle: 'a', seconds: '1700000101' },
      { action: 'current', handle: 'b', seconds: '1700000102' },
    )
    assert.equal(
      clocks.filter(item => item.code === 'retryable').length,
      1,
      'freshness checks share commit sequence CAS',
    )
    await cdp.call(b, { action: 'current', handle: 'b', seconds: '1700000102' })
    await expectedCode(
      () =>
        cdp.call(a, { action: 'current', handle: 'a', seconds: '1700000101' }),
      'clock',
      'no lost clock update across tabs',
    )
    const prior = await cdp.call(a, { action: 'status', handle: 'a' })
    const exact = await cdp.call(a, { action: 'evidence', handle: 'a' })
    await cdp.call(a, { action: 'close', handle: 'a' })
    await cdp.call(b, { action: 'close', handle: 'b' })
    await stop(browser)
    browser = await launch(chrome, profile)
    cdp = browser.cdp
    a = await tab(cdp, origin)
    b = await tab(cdp, origin)
    await cdp.call(a, {
      action: 'open',
      name: 'persistent',
      handle: 'a',
      checkpoint: pack(prior.checkpoint),
    })
    assert.deepEqual(
      await cdp.call(a, { action: 'status', handle: 'a' }),
      prior,
      'browser process restart full head/stamp/counters',
    )
    assert.deepEqual(
      await cdp.call(a, { action: 'evidence', handle: 'a' }),
      exact,
      'browser process restart exact evidence',
    )
    await cdp.call(b, {
      action: 'open',
      name: 'persistent',
      handle: 'b',
      checkpoint: pack(prior.checkpoint),
    })
    await expectedCode(
      () =>
        cdp.call(b, {
          action: 'advance',
          handle: 'b',
          ids: ['fork-of-renew'],
          seconds: '1700000102',
        }),
      'fork',
      'authenticated conflict persisted in second tab',
    )
    await expectedCode(
      () =>
        cdp.call(a, { action: 'current', handle: 'a', seconds: '1700000102' }),
      'fork',
      'other tab never returns cached current after fork',
    )
    await cdp.call(a, {
      action: 'open',
      name: 'interrupted',
      handle: 'interrupt',
    })
    await cdp.call(a, {
      action: 'enroll',
      handle: 'interrupt',
      ids: ['bootstrap'],
    })
    const checkpoint = (
      await cdp.call(a, { action: 'status', handle: 'interrupt' })
    ).checkpoint
    await cdp.call(a, { action: 'fault', value: 'before' })
    await expectedCode(
      () =>
        cdp.call(a, {
          action: 'advance',
          handle: 'interrupt',
          ids: ['renew', 'rotate-stamp'],
        }),
      'unavailable',
      'aborted before commit',
    )
    await stop(browser, true)
    browser = await launch(chrome, profile)
    cdp = browser.cdp
    a = await tab(cdp, origin)
    await cdp.call(a, {
      action: 'open',
      name: 'interrupted',
      handle: 'interrupt',
      checkpoint: pack(checkpoint),
    })
    assert.equal(
      (await cdp.call(a, { action: 'status', handle: 'interrupt' })).revision,
      0n,
      'restart after abort preserves prior complete state',
    )
    await cdp.call(a, { action: 'fault', value: 'after' })
    const pending = cdp
      .call(a, {
        action: 'advance',
        handle: 'interrupt',
        ids: ['renew', 'rotate-stamp'],
      })
      .catch(() => {})
    await poll(
      () => cdp.evaluate(a, 'commitBarrier === "after"'),
      'strict transaction committed before acknowledgement',
    )
    await stop(browser, true)
    await pending
    browser = await launch(chrome, profile)
    cdp = browser.cdp
    a = await tab(cdp, origin)
    await cdp.call(a, {
      action: 'open',
      name: 'interrupted',
      handle: 'interrupt',
      checkpoint: pack(checkpoint),
    })
    const committed = await cdp.call(a, {
      action: 'status',
      handle: 'interrupt',
    })
    assert.equal(committed.revision, 2n)
    assert.equal(committed.accepted, 3)
    assert.equal(committed.retained, 3)
    assert.ok(
      committed.previousStamp,
      'lost acknowledgement retains exact stamp pair',
    )
    await cdp.call(a, {
      action: 'advance',
      handle: 'interrupt',
      ids: ['rotate-stamp'],
    })
    assert.deepEqual(
      await cdp.call(a, { action: 'status', handle: 'interrupt' }),
      committed,
      'duplicate retry never extends grace or counters',
    )
    console.log(
      JSON.stringify({
        ok: true,
        backend: 'real-chromium-indexeddb',
        ...results,
        tabs: 2,
        casRaces: 2,
        restarts: 3,
        interruptionBoundaries: 2,
      }),
    )
  } finally {
    await stop(browser)
    await new Promise(resolve => server.close(resolve))
    await fs.rm(profile, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
