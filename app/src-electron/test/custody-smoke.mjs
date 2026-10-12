import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../', import.meta.url))
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
  format: 'iife',
  globalName: 'custodyTests',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
  alias,
})

const executable = process.env.ELECTRON_SMOKE_EXECUTABLE
assert.ok(
  executable,
  'Set ELECTRON_SMOKE_EXECUTABLE to the built Frank app executable',
)
const directory = await mkdtemp(join(tmpdir(), 'frank-electron-custody-'))
console.log(`Synthetic profile retained at ${directory}`)
for (const phase of [
  'ui-create',
  'ui-reopen',
  'stage',
  'activate',
  'reopen',
  'regressions',
]) {
  const child = spawn(
    executable,
    [`--user-data-dir=${directory}`, '--remote-debugging-port=0'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let socket
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(
        () => reject(new Error('Electron startup timed out')),
        20000,
      )
      child.on('error', reject)
      child.stderr.on('data', data => {
        output += data
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
        if (match) {
          clearTimeout(timeout)
          resolve(match[1])
        }
      })
      child.once('exit', code => {
        clearTimeout(timeout)
        reject(new Error(`Electron exited ${code}: ${output}`))
      })
    })
    const port = new URL(endpoint).port
    let page
    for (let tries = 0; tries < 100; tries++) {
      const pages = await (
        await fetch(`http://127.0.0.1:${port}/json/list`)
      ).json()
      page = pages.find(p => p.type === 'page' && p.url.startsWith('file:'))
      if (page) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(page, 'Packaged file renderer exists')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = reject
    })
    let id = 0
    const pending = new Map()
    socket.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const handler = pending.get(message.id)
        pending.delete(message.id)
        message.error
          ? handler?.reject(new Error(message.error.message))
          : handler?.resolve(message.result)
      }
    }
    const evaluate = expression =>
      new Promise((resolve, reject) => {
        const next = ++id
        const timeout = setTimeout(() => {
          pending.delete(next)
          reject(new Error('Renderer evaluation timed out'))
        }, 30000)
        pending.set(next, {
          resolve: value => {
            clearTimeout(timeout)
            resolve(value)
          },
          reject: error => {
            clearTimeout(timeout)
            reject(error)
          },
        })
        socket.send(
          JSON.stringify({
            id: next,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
    await new Promise(resolve => setTimeout(resolve, 750))
    const runtime = await evaluate(
      '({ secure:isSecureContext, subtle:!!crypto.subtle, require:typeof require, badge:typeof window.badge?.updateBadge, text:document.body.innerText })',
    )
    assert.equal(runtime.result.value.secure, true)
    assert.equal(runtime.result.value.subtle, true)
    assert.equal(runtime.result.value.require, 'undefined')
    assert.equal(runtime.result.value.badge, 'function')
    if (phase === 'ui-create' || phase === 'ui-reopen') {
      socket.send(JSON.stringify({ id: ++id, method: 'Network.enable' }))
      socket.send(
        JSON.stringify({
          id: ++id,
          method: 'Network.setBlockedURLs',
          params: { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] },
        }),
      )
      const result = await evaluate(`(async () => {
        const wait = async selector => {
          for (let i = 0; i < 200; i++) {
            const node = document.querySelector(selector)
            if (node) return node
            await new Promise(r => setTimeout(r, 50))
          }
          throw new Error('Missing UI selector: ' + selector + '; UI: ' + document.body.innerText.replace(/fr1[a-z0-9]+/g, '[synthetic share]'))
        }
        const click = async selector => { (await wait(selector)).click(); await new Promise(r => setTimeout(r, 80)) }
        if (${JSON.stringify(phase)} === 'ui-create') {
          location.hash = '/setup'
          await click('[data-test="new-account"]')
          await click('[data-test="backup-policy"] .q-radio')
          if (document.querySelector('[data-test="backup-policy"] .q-radio').getAttribute('aria-checked') !== 'true') throw new Error('Radio selection did not update')
          const generate = await wait('[data-test="generate-backups"]')
          if (generate.disabled) throw new Error('Generate button disabled after radio selected')
          generate.closest('form').requestSubmit()
          const shares = []
          for (let i = 0; i < 3; i++) {
            shares.push((await wait('[data-test="backup-share"] textarea, textarea[data-test="backup-share"]')).value)
            await click('[data-test="next-share"]')
          }
          const input = await wait('[data-test="confirm-shares"] textarea, textarea[data-test="confirm-shares"]')
          input.value = shares.slice(0, 2).join('\\n'); input.dispatchEvent(new Event('input', {bubbles:true}))
          shares.fill('')
          const name = await wait('[data-test="display-name"] input, input[data-test="display-name"]')
          name.value = 'Electron synthetic account'; name.dispatchEvent(new Event('input', {bubbles:true}))
          await new Promise(r => setTimeout(r, 80))
          input.closest('form').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))
          await click('[data-test="activate-account"]')
        }
        location.hash = '/wallet'
        await wait('[data-test="wallet-menu-btn"]')
        for (let i = 0; i < 200 && location.hash.includes('/setup'); i++) await new Promise(r => setTimeout(r, 50))
        if (location.hash.includes('/setup')) throw new Error('Account did not activate into the app')
        return { accountReady: true, zeroFundsTest: true }
      })()`)
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description)
      console.log(JSON.stringify({ phase, ...result.result.value }))
      continue
    }
    await evaluate(
      "window.custodyFixture = document.createElement('iframe'); custodyFixture.srcdoc = '<!doctype html><title>Isolated custody fixture</title>'; document.body.append(custodyFixture); new Promise(resolve => custodyFixture.onload = resolve)",
    )
    const loaded = await evaluate(
      `custodyFixture.contentWindow.eval(${JSON.stringify(
        bundle.outputFiles[0].text + ';globalThis.custodyTests = custodyTests',
      )})`,
    )
    if (loaded.exceptionDetails)
      throw new Error(loaded.exceptionDetails.exception?.description)
    const result = await evaluate(
      `custodyFixture.contentWindow.custodyTests.run(${JSON.stringify(phase)})`,
    )
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description)
    console.log(JSON.stringify({ phase, ...result.result.value }))
  } finally {
    socket?.close()
    child.kill('SIGKILL')
    await exited
  }
}
