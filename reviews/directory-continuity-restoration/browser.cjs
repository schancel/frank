const esbuild = require('esbuild')
const fs = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const os = require('os')
const http = require('http')
const { spawn, execFileSync } = require('child_process')
const assert = require('assert/strict')

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
  if (!browser) return
  const killGroup = () => killOwnedGroup(browser.process.pid)
  if (
    browser.process.exitCode === null &&
    browser.process.signalCode === null
  ) {
    const exited = new Promise(resolve => browser.process.once('exit', resolve))
    if (force) killGroup()
    else browser.cdp.send('Browser.close').catch(() => {})
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          killGroup()
        } catch (error) {
          reject(error)
        }
      }, 10000)
    })
    try {
      await Promise.race([exited, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  killGroup()
  await poll(
    () => liveGroupMembers(browser.process.pid).length === 0,
    'owned Chromium process group exit',
    10000,
  )
  browser.cdp.socket.close()
}
function liveGroupMembers(group) {
  return execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/))
    .filter(
      ([pid, pgid, state]) =>
        Number(pgid) === group && Number(pid) > 0 && !state.startsWith('Z'),
    )
    .map(([pid]) => Number(pid))
}
function killOwnedGroup(
  group,
  kill = process.kill,
  members = liveGroupMembers,
) {
  assert.ok(Number.isInteger(group) && group > 0, 'owned detached group ID')
  if (members(group).length === 0) return
  try {
    kill(-group, 'SIGKILL')
  } catch (error) {
    if (error.code === 'ESRCH') return
    // A macOS group can disappear between ps and kill after its leader exits.
    // Never swallow a permissions failure while any live member is still present.
    if (error.code === 'EPERM' && members(group).length === 0) return
    throw error
  }
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
async function main() {
  const root = path.resolve(__dirname, '../..')
  const chrome =
    process.env.FRANK_CHROME ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  assert.ok(existsSync(chrome), 'real Chromium required')
  const { outputFiles } = await esbuild.build({
    entryPoints: [path.join(__dirname, 'browser.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    write: false,
    alias: {
      '@frank/nakamoto': path.join(root, 'packages/nakamoto/src'),
      '@frank/crypto-box': path.join(root, 'packages/crypto-box/src/index.ts'),
      '@frank/codec': path.join(root, 'packages/frank-codec/src/index.ts'),
      '@frank/directory-admission': path.join(
        root,
        'packages/directory-admission/src/index.ts',
      ),
      '@frank/cashweb': path.join(root, 'packages/cashweb'),
    },
  })
  const server = http.createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/bundle.js' ? 'text/javascript' : 'text/html',
    )
    response.end(
      request.url === '/bundle.js'
        ? outputFiles[0].contents
        : '<!doctype html><script src="/bundle.js"></script>',
    )
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const profile = await fs.mkdtemp(
    path.join(os.tmpdir(), 'frank-directory-restoration-'),
  )
  let browser
  const outcomes = []
  try {
    browser = await launch(chrome, profile)
    let session = await tab(browser.cdp, origin)
    const call = async (action, seed = 100) => {
      const result = await browser.cdp.evaluate(
        session,
        `directoryTests.run(${JSON.stringify({ action, seed })})`,
      )
      assert.ok(result.ok)
      outcomes.push(result)
    }
    await call('init')
    await stop(browser)
    browser = await launch(chrome, profile)
    session = await tab(browser.cdp, origin)
    for (const action of ['read-failure', 'write-failure', 'older', 'fork'])
      await call(action)
    await stop(browser)
    browser = await launch(chrome, profile)
    session = await tab(browser.cdp, origin)
    await call('read-failure')
    await call('quarantine')
    await call('init', 101)
    await call('missing-checkpoint', 101)
    await call('init', 102)
    await call('missing-db', 102)
    console.log(
      JSON.stringify({
        ok: true,
        backend: 'real-chromium-indexeddb-localStorage',
        restarts: 2,
        outcomes,
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
