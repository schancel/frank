/**
 * Real-Chrome qualification of the HTLC swap record store (storage/htlc-swap-browser.ts):
 *   node packages/swap-protocol/src/storage/htlc-swap-browser-test.mjs
 * NEGOTIATION_STORE_CHROME names another Chrome binary.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: [
    'packages/swap-protocol/src/storage/htlc-swap-browser-suite.ts',
  ],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
})
for (const input of Object.keys(bundle.metafile.inputs))
  assert.ok(
    !/packages\/wallet|node_modules\/level/.test(input),
    `Wallet or native import in the browser bundle: ${input}`,
  )

const directory = await mkdtemp(join(tmpdir(), 'frank-swap-htlc-browser-'))
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/suite.js' ? 'text/javascript' : 'text/html',
  )
  res.end(
    req.url === '/suite.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><title>Swap record storage qualification</title>',
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

async function invoke(session, phase, arg) {
  const result = await evaluate(
    session,
    `import(${JSON.stringify(
      `${origin}/suite.js`,
    )}).then(m => m.runHtlcSwapBrowserPhase(${JSON.stringify(
      phase,
    )}, ${JSON.stringify(arg)}))`,
  )
  console.log(JSON.stringify(result))
  return result
}

try {
  await launch()
  const first = await page()
  const created = await invoke(first, 'create')
  assert.deepEqual(created, { first: true, again: false, revision: 1 })

  // Four pages race one CAS at revision 1: exactly one wins.
  const pages = [first, await page(), await page(), await page()]
  const raced = await Promise.all(
    pages.map((session, i) => invoke(session, 'race', String(i).repeat(64))),
  )
  assert.equal(raced.filter(r => r.won).length, 1)
  const winner = raced.findIndex(r => r.won)
  await stop()

  // A new browser process on the same profile reads the committed record.
  await launch()
  const reopened = await invoke(await page(), 'reopen')
  assert.equal(reopened.revision, 2)
  assert.equal(reopened.record.role, 'B')
  assert.equal(reopened.record.fundingAuthorizedAt, 1_800_000_000)
  assert.deepEqual(reopened.record.xecSpend, {
    branch: 'claim',
    rawTx: '0200' + String(winner).repeat(64),
    txid: String(winner).repeat(64),
  })
  assert.deepEqual(reopened.listed, ['ab'.repeat(32)])
  assert.equal(reopened.otherRows, 0)
  assert.equal(reopened.stale, false)
  assert.match(reopened.invalid, /Invalid browser swap record namespace/)
  assert.ok(
    reopened.databases.includes(
      'frank-swap-htlc-v1-htlc_browser_qualification',
    ),
  )
  console.log('HTLC swap record browser storage: OK')
} finally {
  await stop()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
