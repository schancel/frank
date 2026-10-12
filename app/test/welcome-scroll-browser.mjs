// Real Quasar layout regression using a fresh, unfunded browser profile.
// Start the app separately, then: node app/test/welcome-scroll-browser.mjs http://localhost:38659
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const origin = new URL(process.argv[2] ?? 'http://localhost:38659')
assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname))
assert.equal(origin.protocol, 'http:')
const directory = await mkdtemp(join(tmpdir(), 'frank-welcome-browser-'))
const chrome = spawn(
  process.env.WELCOME_CHROME ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-pipe',
    `--user-data-dir=${directory}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
)
let sequence = 0
let buffer = ''
const pending = new Map()
chrome.stdio[4].on('data', data => {
  buffer += data.toString()
  for (;;) {
    const end = buffer.indexOf('\0')
    if (end < 0) break
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    const promise = pending.get(message.id)
    if (promise) {
      pending.delete(message.id)
      if (message.error) promise.reject(new Error(message.error.message))
      else promise.resolve(message.result)
    }
  }
})
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    chrome.stdio[3].write(
      JSON.stringify({ id, method, params, sessionId }) + '\0',
    )
  })
}
const timeout = setTimeout(() => chrome.kill('SIGTERM'), 60000)
chrome.once('exit', () => {
  for (const promise of pending.values())
    promise.reject(new Error('Welcome test browser exited'))
})
try {
  const { targetId } = await call('Target.createTarget', {
    url: 'about:blank',
  })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  async function evaluate(expression) {
    const result = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text)
    return result.result.value
  }
  await call('Page.navigate', { url: `${origin.origin}/#/welcome` }, sessionId)
  let mounted = false
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      mounted = await evaluate(
        "Boolean(document.querySelector('.welcome-page'))",
      )
      if (mounted) break
    } catch {
      // Navigation replaces the initial blank execution context.
    }
  }
  assert.ok(mounted, 'Welcome must mount')
  for (const width of [1800, 390]) {
    await call(
      'Emulation.setDeviceMetricsOverride',
      { width, height: 700, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    await evaluate('new Promise(r => setTimeout(r, 500))')
    const before = await evaluate(`(() => {
      const page = document.querySelector('.welcome-page')
      page.scrollTop = 0
      return { drawerY: document.querySelector('.drawer-header-item').getBoundingClientRect().y,
        overflowing: page.scrollHeight > page.clientHeight }
    })()`)
    assert.equal(
      before.overflowing,
      true,
      `${width}: main page must own its overflowing content`,
    )
    await call(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: width - 100, y: 350, deltaX: 0, deltaY: 300 },
      sessionId,
    )
    await evaluate('new Promise(r => setTimeout(r, 300))')
    const after = await evaluate(`({
      pageScroll: document.querySelector('.welcome-page').scrollTop,
      bodyScroll: window.scrollY,
      drawerY: document.querySelector('.drawer-header-item').getBoundingClientRect().y,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
    })`)
    assert.ok(after.pageScroll > 0, `${width}: main content must scroll`)
    assert.equal(after.bodyScroll, 0, `${width}: body must remain anchored`)
    assert.equal(
      after.drawerY,
      before.drawerY,
      `${width}: sidebar must remain anchored`,
    )
    assert.ok(
      after.documentHeight <= after.viewportHeight,
      `${width}: no outer scrollbar`,
    )
    console.log(JSON.stringify({ width, ...after }))
  }
} finally {
  clearTimeout(timeout)
  await call('Browser.close').catch(() => undefined)
}
