/**
 * Drives the swap form in a real (headless) Chrome against a running app and relay on Monad
 * testnet: creates an account, waits for its main account to be funded, quotes, reviews,
 * confirms one small swap and waits for the result. It spends testnet funds.
 *
 *   ACCOUNT_APP_ORIGIN=http://localhost:<app port> E2E_SCREENSHOT_DIR=<dir> \
 *     SWAP_BROWSER_AMOUNT=0.01 node app/test/swap-browser.livecheck.mjs
 *
 * Required: explicit E2E_PROFILE_DIR and E2E_BROWSER_RESOLVER_RULES mapping BOTH
 * signet.mx and relay.signet.mx to admitted private fixtures (including a loopback app).
 * Root separately admits servers/TLS and the matching 10143 artifact.
 * The account lives in that PERSISTENT Chrome profile (see e2e-profile.mjs): the first run creates it, later runs open the same
 * account. When it holds less than the amount plus 0.06 MON for gas it is funded up to that
 * from the test wallet (FRANK_TEST_WALLET_JSON, through packages/bot/demo/fund.ts). When the run
 * ends (pass, failure or Ctrl-C) what it holds above the test-account float (0.02 MON) is sent
 * back to the test wallet through the app's send page, and one line says: funded X, returned Y,
 * left Z in the profile and why. The profile is never deleted. The browser helpers are those
 * of `autonomous-fullstack-e2e.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { fileURLToPath } from 'node:url'

import {
  persistentProfile,
  testFunds,
  browserFixture,
  readPublicAccount,
  monWei,
  appendEvidence,
  evidenceUrl,
} from './e2e-profile.mjs'

const { origin, resolverArgument } = browserFixture()
const profile = await persistentProfile('swap-browser')
const directory = profile.directory
// Where screenshots go; defaults to a folder inside the profile directory.
const screenshotDir = resolve(
  process.env.E2E_SCREENSHOT_DIR ?? join(directory, 'screenshots'),
)
await mkdir(screenshotDir, { recursive: true })

const executable =
  process.env.CUSTODY_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let child, socket, call, sessionId
const frontendErrors = []
const frontendWarnings = []
const networkFailures = []
const consoleLogs = []
const unverifiedLookups = []
let sequence = 0
const pending = new Map()

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
      resolverArgument,
      `--user-data-dir=${directory}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => reject(new Error('Chrome startup timeout')),
      20000,
    )
    child.once('error', reject)
    child.stderr.on('data', data => {
      output = (output + data).slice(-8192)
      const match = /DevTools listening on (ws:\/\/(\S+))/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })

  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })

  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      handleEvent(message)
      return
    }
    const handler = pending.get(message.id)
    if (!handler) return
    clearTimeout(handler.timer)
    pending.delete(message.id)
    if (message.error) {
      handler.reject(new Error('Browser protocol request failed; body omitted'))
    } else {
      handler.resolve(message.result)
    }
  }

  call = (method, params = {}, session = sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Browser protocol request timed out; body omitted'))
      }, 180000)
      pending.set(id, { resolve, reject, timer })
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(session ? { sessionId: session } : {}),
        }),
      )
    })

  await openTab()
}

function handleEvent(event) {
  if (event.method === 'Runtime.exceptionThrown') {
    appendEvidence(frontendErrors, '[FRONTEND EXCEPTION; private body omitted]')
  } else if (event.method === 'Runtime.consoleAPICalled') {
    const type = event.params.type
    appendEvidence(consoleLogs, '[console body omitted]')
    if (type === 'error') {
      appendEvidence(frontendErrors, '[CONSOLE ERROR; private body omitted]')
    } else if (type === 'warn') {
      appendEvidence(
        frontendWarnings,
        '[CONSOLE WARNING; private body omitted]',
      )
    }
  } else if (event.method === 'Network.responseReceived') {
    const { status, url } = event.params.response
    const unverified404 =
      status === 404 &&
      (url.includes('/metadata/') || url.includes('/directory/v1/'))
    if (unverified404)
      appendEvidence(
        unverifiedLookups,
        `[HTTP 404; republication not verified] ${evidenceUrl(url)}`,
      )
    else if (status >= 400 && !(status === 404 && url.endsWith('/favicon.ico')))
      appendEvidence(networkFailures, `[HTTP ${status}] ${evidenceUrl(url)}`)
  }
}

async function openTab() {
  const { targetId } = await call(
    'Target.createTarget',
    { url: 'about:blank' },
    undefined,
  )
  sessionId = (
    await call('Target.attachToTarget', { targetId, flatten: true }, undefined)
  ).sessionId
  await call('Runtime.enable')
  await call('Page.enable')
  await call('DOM.enable')
  await call('Network.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error('Browser evaluation failed; private exception body omitted')
  }
  return result.result.value
}

async function until(expression, timeoutMs = 25000, description = '') {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const val = await evaluate(`!!(${expression})`)
      if (val === true) return true
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(
    `Timeout waiting for [${
      description || 'UI state'
    }] after ${timeoutMs}ms; private page text omitted`,
  )
}

async function click(selector) {
  await until(
    `document.querySelector(${JSON.stringify(selector)})`,
    10000,
    `element exists: ${selector}`,
  )
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error("Element not found: " + ${JSON.stringify(
      selector,
    )});
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();
  })()`)
  await new Promise(r => setTimeout(r, 100))
}

async function key(k, code, windowsVirtualKeyCode) {
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: k,
    code,
    windowsVirtualKeyCode,
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: k,
    code,
    windowsVirtualKeyCode,
  })
}

async function typeInput(selector, value) {
  await until(
    `document.querySelector(${JSON.stringify(selector)})`,
    10000,
    `input exists: ${selector}`,
  )
  await evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    const el = root.matches('input,textarea') ? root : root.querySelector('input,textarea');
    if (!el) throw new Error("Input not found in: " + ${JSON.stringify(
      selector,
    )});
    const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
  await new Promise(r => setTimeout(r, 100))
}

async function sendChatMessage(text) {
  await typeInput('.chat-input-field input, .chat-input-field textarea', text)
  await evaluate(`(() => {
    const btn = document.querySelector('.chat-send-btn');
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      btn.click();
    }
  })()`)
  await new Promise(r => setTimeout(r, 500))
}

async function getValue(selector) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root) return '';
    const el = root.matches('input,textarea') ? root : root.querySelector('input,textarea') || root;
    return el.value ?? el.textContent ?? '';
  })()`)
}

async function captureScreenshot(filename) {
  if (
    await evaluate(
      `!!document.querySelector('[data-test="backup-share"], [data-test="confirm-shares"], input[type="password"]')`,
    )
  )
    throw new Error('Sensitive account screen screenshot omitted')
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  const filepath = join(screenshotDir, filename)
  await writeFile(filepath, Buffer.from(data, 'base64'))
  console.log(`📸 Screenshot saved: ${filename}`)
  return filepath
}

async function stop() {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await ended
  }
}

const amount = process.env.SWAP_BROWSER_AMOUNT ?? '0.01'
const text = selector =>
  evaluate(
    `document.querySelector(${JSON.stringify(
      selector,
    )})?.innerText?.replace(/\\s+/g, ' ').trim() ?? null`,
  )
const t = id => text(`[data-testid="${id}"]`)

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
// Funding from the test wallet when the account is low, and sending what is left above the
// float back when the run ends, on pass, failure and Ctrl-C (e2e-profile.mjs).
const funds = testFunds({
  repoRoot,
  directory,
  profile,
  page: { evaluate, typeInput, click, until },
  stop,
})

async function run() {
  await launch()
  if (profile.account) {
    // The profile already holds an account: open it, do not create another.
    await call('Page.navigate', { url: origin + '/#/wallet' })
    await profile.recordAccount(await readPublicAccount({ evaluate, until }))
  } else {
    await call('Page.navigate', { url: origin + '/#/setup' })
    await until(
      `document.querySelector('[data-test="new-account"]')`,
      30000,
      'setup page',
    )
    await click('[data-test="new-account"]')
    await until(
      `document.querySelector('[data-test="backup-policy"]')`,
      10000,
      'backup policy',
    )
    await evaluate(
      `document.querySelector('[data-test="backup-policy"] [role="radio"]').focus()`,
    )
    await key(' ', 'Space', 32)
    await until(
      `!document.querySelector('[data-test="generate-backups"]').disabled`,
      5000,
      'generate enabled',
    )
    await evaluate(`(() => {
    document.querySelector('[data-test="generate-backups"]').click();
    document.querySelector('[data-test="generate-backups"]').click();
  })()`)
    await until(
      `document.querySelector('[data-test="backup-share"]')`,
      10000,
      'shares',
    )
    const shares = []
    for (let i = 0; i < 3; i++) {
      shares.push(await getValue('[data-test="backup-share"]'))
      await click('[data-test="next-share"]')
    }
    await until(
      `document.querySelector('[data-test="confirm-shares"]')`,
      10000,
      'confirm',
    )
    await typeInput(
      '[data-test="confirm-shares"]',
      shares.slice(0, 2).join('\n'),
    )
    await typeInput('[data-test="display-name"]', 'Swap Browser Check')
    await click('[data-test="verify-backups"]')
    await until(
      `document.querySelector('[data-test="activate-account"]')`,
      15000,
      'activate',
    )
    await click('[data-test="activate-account"]')
    await until(`location.hash !== '#/setup'`, 20000, 'left setup')
    await new Promise(r => setTimeout(r, 2000))
  }

  const identity = await readPublicAccount({ evaluate, until })
  await profile.recordAccount(identity)
  console.log(
    `MAIN ACCOUNT ${identity.receive}  (${profile.fresh ? 'new' : 'reused'})`,
  )
  // The swap amount plus gas for the moves and the swap; funded only when it holds less.
  const needWei = monWei(amount) + monWei('0.06')
  const funded = await funds.ensure(needWei)
  console.log(funded ?? 'the account already holds enough: not funded')

  await evaluate(`location.hash = '#/wallet/monad'`)
  await click('[data-testid="wallet-tab-swap"]')
  await until(
    `document.querySelector('[data-testid="evm-swap-panel"]')`,
    30000,
    'swap panel',
  )
  await until(
    `/^\\d+(?:\\.\\d+)?$/.test(document.querySelector('[data-testid="swap-pay-balance"]')?.getAttribute('title') ?? '')`,
    60000,
    'balances read from the chain',
  )
  console.log('venue:', await t('swap-venue'), '|', await t('swap-venue-note'))
  console.log(
    'initial:',
    await t('swap-pay-balance'),
    '|',
    await t('swap-receive-balance'),
  )
  await captureScreenshot('swap_01_empty.png')

  await typeInput('[data-testid="swap-pay-amount"]', amount)
  await until(
    `document.querySelector('[data-testid="swap-details"]')`,
    30000,
    'a quote',
  )
  for (const id of [
    'swap-receive-amount',
    'swap-rate',
    'swap-price-impact',
    'swap-pool-fee',
    'swap-minimum-received',
    'swap-network-fee',
  ])
    console.log(`${id}:`, await t(id))
  console.log('fee line present:', (await t('swap-interface-fee')) !== null)
  console.log(
    'token options:',
    await evaluate(
      `(() => { document.querySelector('[data-testid="swap-receive-token"]').click(); return new Promise(r => setTimeout(() => { const o = [...document.querySelectorAll('.q-menu .q-item')].map(e => e.innerText.trim()); document.body.click(); r(o.join(' / ')) }, 500)) })()`,
    ),
  )
  await new Promise(r => setTimeout(r, 500))
  await key('Escape', 'Escape', 27)
  await captureScreenshot('swap_02_quote.png')

  await until(
    `!document.querySelector('[data-testid="swap-review-btn"]')?.disabled`,
    30000,
    'review enabled',
  )
  await click('[data-testid="swap-review-btn"]')
  await until(
    `document.querySelector('[data-testid="swap-review"]')`,
    30000,
    'review card',
  )
  console.log('review:', await t('swap-review-summary'))
  console.log('move line:', await t('swap-review-move'))
  await captureScreenshot('swap_03_review.png')

  await click('[data-testid="swap-confirm-btn"]')
  await until(
    `document.querySelector('[data-testid="swap-progress"]') || document.querySelector('[data-testid="swap-result"]') || document.querySelector('[data-testid="swap-problem"]')`,
    30000,
    'progress',
  )
  console.log('progress:', await t('swap-progress'))
  await captureScreenshot('swap_04_progress.png')
  await until(
    `document.querySelector('[data-testid="swap-result"]') || (document.querySelector('[data-testid="swap-problem"]') && !document.querySelector('[data-testid="swap-progress"]'))`,
    150000,
    'a result',
  )
  console.log('problem:', await t('swap-problem'))
  console.log('result:', await t('swap-result'))
  console.log(
    'explorer:',
    evidenceUrl(
      await evaluate(
        `document.querySelector('[data-testid="swap-result-explorer"]')?.href ?? null`,
      ),
    ),
  )
  await captureScreenshot('swap_05_result.png')

  await click('[data-testid="wallet-tab-balance"]')
  await new Promise(r => setTimeout(r, 4000))
  console.log('activity:', await t('wallet-activity-list'))
  console.log('USDC row:', await t('wallet-token-item-usdc'))
  await evaluate(
    `document.querySelector('[data-testid="wallet-activity-card"]')?.scrollIntoView({ block: 'center' })`,
  )
  await captureScreenshot('swap_06_wallet.png')
  console.log('frontend errors:', JSON.stringify(frontendErrors.slice(0, 10)))
  if (unverifiedLookups.length)
    console.log(
      `Directory/metadata absence observed ${unverifiedLookups.length} times; fresh-backend republication NOT VERIFIED by this journey`,
    )
  if (frontendErrors.length || networkFailures.length) process.exitCode = 1
}

run()
  .catch(async error => {
    console.error(
      'FAILED: browser journey did not complete; private error body omitted',
    )
    await captureScreenshot('swap_failed.png').catch(() => undefined)
    console.log('frontend errors:', JSON.stringify(frontendErrors.slice(0, 10)))
    process.exitCode = 1
  })
  .finally(async () => {
    if (socket) await funds.finish()
    await stop()
  })
