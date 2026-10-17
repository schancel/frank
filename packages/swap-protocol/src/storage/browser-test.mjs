import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['packages/swap-protocol/src/storage/browser-suite.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
})
for (const input of Object.keys(bundle.metafile.inputs)) {
  assert.ok(
    !/(?:negotiation-native|packages\/wallet|node_modules\/level)/.test(input),
    `Native import in browser bundle: ${input}`,
  )
  assert.ok(
    !bundle.metafile.inputs[input].imports.some(item =>
      item.path.startsWith('node:'),
    ),
    `Node import in browser bundle: ${input}`,
  )
}
assert.ok(
  Object.values(bundle.metafile.outputs).every(
    output => output.imports.length === 0,
  ),
)
const pure = await build({
  absWorkingDir: root,
  entryPoints: [
    'packages/swap-protocol/src/index.ts',
    'packages/swap-protocol/src/negotiation.ts',
    'packages/swap-protocol/src/negotiation-journal.ts',
    'packages/swap-protocol/src/message-plugin.ts',
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outdir: 'unused',
  write: false,
  metafile: true,
})
assert.ok(
  !Object.keys(pure.metafile.inputs).some(input =>
    /src\/storage|node_modules\/level|packages\/wallet/.test(input),
  ),
  'Pure entry selected a storage adapter or custody',
)
const directory = await mkdtemp(join(tmpdir(), 'frank-negotiation-idb-'))
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/suite.js' ? 'text/javascript' : 'text/html',
  )
  response.end(
    request.url === '/suite.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><title>Disposable negotiation storage qualification</title>',
  )
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const executable =
  process.env.NEGOTIATION_STORE_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let child, socket, call
async function stop(signal = 'SIGTERM') {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(signal)
    await exited
  }
}
async function launch() {
  child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(directory, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error('Chrome startup timed out')),
      20_000,
    )
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stderr.on('data', data => {
      output += data.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Chrome exited ${code}`))
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const handler = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) handler?.reject(new Error(message.error.message))
    else handler?.resolve(message.result)
  }
  socket.onclose = () => {
    for (const handler of pending.values())
      handler.reject(new Error('Chrome connection closed'))
    pending.clear()
  }
  call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  return (await call('Browser.getVersion')).product
}
async function page() {
  const { targetId } = await call('Target.createTarget', { url: origin })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await call('Runtime.enable', {}, sessionId)
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await call(
      'Runtime.evaluate',
      { expression: 'location.origin', returnByValue: true },
      sessionId,
    )
    if (ready.result.value === origin) return sessionId
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Chrome page did not reach fixture origin')
}
async function evaluate(session, expression, awaitPromise = true) {
  const result = await call(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true },
    session,
  )
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
  return result.result.value
}
async function invoke(session, phase) {
  const result = await evaluate(
    session,
    `import(${JSON.stringify(
      `${origin}/suite.js`,
    )}).then(m => m.run(${JSON.stringify(phase)}))`,
  )
  console.log(JSON.stringify({ phase, ...result }))
  return result
}
async function barrier(session, expression) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await evaluate(session, expression)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Browser barrier not reached: ' + expression)
}
const timeout = setTimeout(() => {
  console.error('Negotiation browser qualification timed out')
  child?.kill('SIGTERM')
}, 180_000)
try {
  console.log(
    JSON.stringify({
      browser: await launch(),
      architecture: 'browser bundle excludes native/Node/Level/wallet',
    }),
  )
  await invoke(await page(), 'stage')
  await stop('SIGKILL')
  await launch()
  await invoke(await page(), 'reopen')
  const first = await page(),
    second = await page(),
    third = await page()
  await invoke(first, 'regressions')
  await invoke(first, 'coverage')
  await invoke(first, 'coverage-lost-ack')
  const initializers = await Promise.all([
    invoke(first, 'coverage-race-row'),
    invoke(second, 'coverage-race-position'),
  ])
  assert.ok(initializers.every(value => value.won))
  await invoke(first, 'coverage-race-check')
  const coverageCas = await Promise.all([
    invoke(first, 'coverage-cas-left'),
    invoke(second, 'coverage-cas-right'),
  ])
  assert.equal(coverageCas.filter(value => value.won).length, 1)
  await invoke(first, 'corruption')
  await invoke(first, 'independent-init')
  const outcomes = await Promise.all([
    invoke(first, 'independent-cas'),
    invoke(second, 'independent-cas'),
  ])
  assert.equal(outcomes.filter(value => value.won).length, 1)
  await invoke(first, 'page-capacity-init')
  const slots = await Promise.all([
    invoke(first, 'page-last-left'),
    invoke(second, 'page-last-right'),
  ])
  assert.equal(slots.filter(value => value.won).length, 1)
  assert.equal(slots.filter(value => value.capacity).length, 1)
  const creator = invoke(first, 'gap-create')
  await barrier(first, 'globalThis.negotiationTest.schemaReady === true')
  const reader = invoke(second, 'gap-read'),
    writer = invoke(third, 'gap-cas')
  await barrier(
    second,
    'navigator.locks.query().then(q => q.pending.filter(l => l.name === globalThis.negotiationTest.namespace).length === 2)',
  )
  assert.equal(
    await evaluate(second, 'globalThis.negotiationTest.completed === true'),
    false,
  )
  assert.equal(
    await evaluate(third, 'globalThis.negotiationTest.completed === true'),
    false,
  )
  await evaluate(first, 'globalThis.negotiationTest.releaseSchema()')
  await Promise.all([creator, reader, writer])
  await invoke(first, 'lost-ack')
  await invoke(first, 'close-wait')
  // Schema commits, but no metadata or first-row transaction has been acknowledged or begun.
  await evaluate(first, 'globalThis.negotiationTest.schemaReady = false')
  const incomplete = invoke(first, 'gap-kill-create').catch(error => ({
    interrupted: String(error),
  }))
  await barrier(first, 'globalThis.negotiationTest.schemaReady === true')
  await stop('SIGKILL')
  await incomplete
  await launch()
  await invoke(await page(), 'gap-kill-reopen')
} finally {
  clearTimeout(timeout)
  await stop()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
