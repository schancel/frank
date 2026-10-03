import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const packages = [
  'account-vault',
  'account-recovery',
  'domain-roots',
  'codex32',
]
const alias = Object.fromEntries(
  packages.map(name => [
    `@frank/${name}`,
    join(root, 'packages', name, 'src/index.ts'),
  ]),
)
for (const leaf of ['bech32', 'convert-bits'])
  alias[`@frank/nakamoto/${leaf}`] = join(
    root,
    'packages/nakamoto/src',
    `${leaf}.ts`,
  )
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['app/src/accounts/custody/test/suite.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
  alias,
})
for (const input of Object.keys(bundle.metafile.inputs)) {
  const absolute = resolve(root, input)
  assert.ok(
    absolute.startsWith(join(root, 'app/src/accounts/custody/')) ||
      packages.some(name =>
        absolute.startsWith(join(root, 'packages', name, 'src/')),
      ) ||
      /^packages\/nakamoto\/src\/(bech32|base32|convert-bits|encoding-error)\.ts$/.test(
        input,
      ) ||
      absolute.includes('/node_modules/@noble/hashes/'),
    `Dependency escaped custody facade: ${input}`,
  )
}
assert.ok(
  Object.values(bundle.metafile.outputs).every(
    output => output.imports.length === 0,
  ),
)
console.log(
  'architecture: own-tree custody/recovery/vault/registry and pure encoding leaves; self-contained browser bundle',
)

const directory = await mkdtemp(join(tmpdir(), 'frank-custody-browser-'))
const server = createServer((request, response) => {
  response.setHeader(
    'Content-Type',
    request.url === '/suite.js' ? 'text/javascript' : 'text/html',
  )
  response.end(
    request.url === '/suite.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><title>Custody fixture</title>',
  )
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const executable =
  process.env.CUSTODY_CHROME ??
  process.env.VAULT_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let child, socket
async function stop(signal = 'SIGTERM') {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(signal)
    await exited
  }
}
async function launch(phase, signal) {
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
      20000,
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
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const version = await call('Browser.getVersion')
  const { targetId } = await call('Target.createTarget', { url: origin })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await call('Runtime.enable', {}, sessionId)
  for (let tries = 0; tries < 100; tries++) {
    const ready = await call(
      'Runtime.evaluate',
      { expression: 'location.origin', returnByValue: true },
      sessionId,
    )
    if (ready.result.value === origin) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const result = await call(
    'Runtime.evaluate',
    {
      expression: `import(${JSON.stringify(
        `${origin}/suite.js`,
      )}).then(m => m.run(${JSON.stringify(phase)}))`,
      awaitPromise: true,
      returnByValue: true,
    },
    sessionId,
  )
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
  console.log(
    JSON.stringify({ browser: version.product, phase, ...result.result.value }),
  )
  await stop(signal)
}
const timeout = setTimeout(() => {
  console.error('Custody browser tests timed out')
  child?.kill('SIGTERM')
}, 120000)
try {
  await launch('stage', 'SIGKILL')
  await launch('activate', 'SIGKILL')
  await launch('reopen')
  await launch('regressions')
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
