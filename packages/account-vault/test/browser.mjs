import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Use already installed build tooling; no browser automation/runtime dependency is required.
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const root = fileURLToPath(new URL('../../../', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'frank-vault-browser-'))
const executable = process.env.VAULT_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const bundle = await build({
  entryPoints: [join(root, 'packages/account-vault/test/suite.ts')], bundle: true, format: 'esm', write: false,
  platform: 'browser', target: 'chrome120', metafile: true,
  alias: { '@frank/domain-roots': join(root, 'packages/domain-roots/src/index.ts') },
})
// Ensure reusable external tooling never redirects local package imports into another worktree.
for (const input of Object.keys(bundle.metafile.inputs)) {
  const absolute = resolve(input)
  if (absolute.includes('/packages/') && !['account-vault', 'domain-roots'].some(name => absolute.startsWith(join(root, 'packages', name) + '/'))) {
    throw new Error(`Dependency boundary escaped the vault and registry: ${input}`)
  }
}
const manifest = JSON.parse(await readFile(join(root, 'packages/account-vault/package.json'), 'utf8'))
if (JSON.stringify(Object.keys(manifest.exports)) !== '["."]' || JSON.stringify(Object.keys(manifest.dependencies)) !== '["@frank/domain-roots"]') {
  throw new Error('Vault facade/dependency boundary changed')
}
console.log(JSON.stringify({ architecture: 'facade-only exports; own-tree registry dependency; no app/wallet/ceremony imports' }))
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/suite.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/suite.js' ? bundle.outputFiles[0].text : '<!doctype html><title>Vault fixture</title>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let child, socket
async function stop() {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exiting = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exiting
  }
}
async function launch(phase) {
  child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error('Chrome startup timed out')), 20000)
    child.once('error', reject)
    child.stderr.on('data', data => {
      output += data.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
    })
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}`)) })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const handler = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) handler?.reject(new Error(message.error.message))
      else handler?.resolve(message.result)
    }
  }
  socket.onclose = () => {
    for (const handler of pending.values()) handler.reject(new Error('Chrome connection closed'))
    pending.clear()
  }
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const version = await call('Browser.getVersion')
  const { targetId } = await call('Target.createTarget', { url: origin })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  await call('Runtime.enable', {}, sessionId)
  // The origin must be committed before importing the fixture.
  for (let tries = 0; tries < 100; tries++) {
    const ready = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }, sessionId)
    if (ready.result.value === origin) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const result = await call('Runtime.evaluate', {
    expression: `import(${JSON.stringify(`${origin}/suite.js`)}).then(m => m.run(${JSON.stringify(phase)}))`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  console.log(JSON.stringify({ browser: version.product, phase, ...result.result.value }))
  await stop()
}
const timeout = setTimeout(() => { console.error('Browser tests timed out'); child?.kill('SIGTERM') }, 120000)
try {
  await launch('create')
  // A new OS process, JS heap, and WebCrypto context opens the same profile and origin.
  await launch('reopen')
  await launch('regressions')
} finally {
  clearTimeout(timeout)
  await stop()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
