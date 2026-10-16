import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: [
    'packages/wallet/storage/authoritative-pool-mutations.browser-suite.ts',
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  define: { global: 'globalThis' },
  inject: [
    'packages/cashweb/relay/storage/outgoing-application-intent.browser-globals.mjs',
  ],
  // Production's fs path is Node-only. Fail if browser qualification ever reaches it.
  plugins: [
    {
      name: 'forbid-node-fs',
      setup(builder) {
        builder.onResolve({ filter: /^fs$/ }, () => ({
          path: 'fs',
          namespace: 'forbidden-node',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'forbidden-node' }, () => ({
          contents: 'throw new Error("Node filesystem reached in browser")',
          loader: 'js',
        }))
      },
    },
  ],
  write: false,
  metafile: true,
  alias: {
    path: 'path-browserify',
    '@frank/nakamoto': './packages/nakamoto/src/index.ts',
    '@frank/crypto-box': './packages/crypto-box/src/index.ts',
    '@frank/codec': './packages/frank-codec/src/index.ts',
  },
})
assert.ok(
  Object.values(bundle.metafile.outputs).every(
    (output) => output.imports.length === 0
  )
)
const directory = await mkdtemp(join(tmpdir(), 'frank-authoritative-pool-idb-'))
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/suite.js' ? 'text/javascript' : 'text/html'
  )
  response.end(
    request.url === '/suite.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><title>Disposable authoritative pool qualification</title>'
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const executable =
  process.env.INTENT_STORE_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let child, socket, call
async function stop(signal = 'SIGTERM') {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
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
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error('Chrome startup timed out')),
      20_000
    )
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stderr.on('data', (data) => {
      output += data.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.once('exit', (code) => {
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
  socket.onmessage = (event) => {
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
      sessionId
    )
    if (ready.result.value === origin) return sessionId
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Chrome page did not reach fixture origin')
}
async function invoke(session, phase) {
  const result = await call(
    'Runtime.evaluate',
    {
      expression: `import(${JSON.stringify(
        `${origin}/suite.js`
      )}).then(m => m.run(${JSON.stringify(phase)}))`,
      awaitPromise: true,
      returnByValue: true,
    },
    session
  )
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
    )
  console.log(JSON.stringify({ phase, ...result.result.value }))
  return result.result.value
}
const timeout = setTimeout(() => {
  console.error('HD pool browser qualification timed out')
  child?.kill('SIGTERM')
}, 120_000)
try {
  console.log(
    JSON.stringify({
      browser: await launch(),
      architecture:
        'production strict Level pool with Web Locks in independent Chrome pages',
    })
  )
  const first = await page()
  await invoke(first, 'seed')
  const second = await page()
  await Promise.all([invoke(first, 'capture'), invoke(second, 'capture')])
  const race = await Promise.all([
    invoke(first, 'race-a'),
    invoke(second, 'race-b'),
  ])
  assert.equal(race.filter((result) => result.won).length, 1)
  assert.ok(race.every((result) => result.revision === 2))
  await Promise.all([invoke(first, 'close'), invoke(second, 'close')])
  await stop('SIGKILL')
  await launch()
  await invoke(await page(), 'reopen')
} finally {
  clearTimeout(timeout)
  await stop()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
