/**
 * Drives the swap form in a real (headless) Chrome against a running app and relay on Monad
 * testnet: creates an account, waits for its main account to be funded, quotes, reviews,
 * confirms one small swap and waits for the result. It spends testnet funds.
 *
 *   ACCOUNT_APP_ORIGIN=http://localhost:<app port> E2E_SCREENSHOT_DIR=<dir> \
 *     SWAP_BROWSER_AMOUNT=0.01 node app/test/swap-browser.livecheck.mjs
 *
 * The account lives in a PERSISTENT Chrome profile, ~/.frank-e2e-browser/swap-browser
 * (E2E_PROFILE_DIR; see e2e-profile.mjs): the first run creates it, later runs open the same
 * account with whatever it still holds, so it needs funding only when it has run low and
 * nothing is lost with a discarded profile. It prints the account's main address and waits up
 * to ten minutes for it to hold more than the amount: when it does not already, send it a little
 * more than the amount plus about 0.06 MON for gas
 * (`node --import tsx packages/bot/demo/fund.ts <address> <MON>`). The last line names the
 * account, what it holds and the profile, which is never deleted. The browser helpers are those
 * of `autonomous-fullstack-e2e.mjs`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  open,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { accountLine, persistentProfile } from './e2e-profile.mjs'

const origin = process.env.ACCOUNT_APP_ORIGIN ?? 'http://localhost:8080'
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
      output += data
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
    pending.delete(message.id)
    if (message.error) {
      handler.reject(new Error(message.error.message))
    } else {
      handler.resolve(message.result)
    }
  }

  call = (method, params = {}, session = sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
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
    const desc =
      event.params.exceptionDetails?.exception?.description ||
      event.params.exceptionDetails?.text
    frontendErrors.push(`[EXCEPTION] ${desc}`)
    console.error(`🔴 FRONTEND EXCEPTION:`, desc)
  } else if (event.method === 'Runtime.consoleAPICalled') {
    const type = event.params.type
    const args = event.params.args
      .map(a => a.value ?? a.description ?? JSON.stringify(a))
      .join(' ')
    consoleLogs.push(`[${type}] ${args}`)
    if (type === 'error') {
      frontendErrors.push(`[CONSOLE_ERROR] ${args}`)
      console.error(`🔴 FRONTEND CONSOLE ERROR:`, args)
    } else if (type === 'warn') {
      frontendWarnings.push(`[CONSOLE_WARN] ${args}`)
    }
  } else if (event.method === 'Network.responseReceived') {
    const { status, url } = event.params.response
    const isExpected404 =
      status === 404 &&
      (url.includes('/metadata/') ||
        url.includes('/directory/v1/') ||
        url.includes('/favicon.ico'))
    const isExpected401 = status === 401 && url.includes('/capability')
    if (status >= 400 && !isExpected404 && !isExpected401) {
      networkFailures.push(`[HTTP ${status}] ${url}`)
      console.warn(`⚠️ HTTP ${status}: ${url}`)
    }
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
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
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
  const pageText = await evaluate(
    'document.body.innerText.slice(0, 1000)',
  ).catch(() => 'unknown')
  throw new Error(
    `Timeout waiting for [${
      description || expression
    }] after ${timeoutMs}ms. Page text:\n${pageText}`,
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

let accountAddress

/** Where the money is when the run ends, pass or fail. */
async function printAccount() {
  if (!accountAddress) return
  try {
    const held = await evaluate(
      `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => (await (await m.accountSession.getWallet()).getBalance()).toString())`,
    )
    console.log(accountLine(directory, accountAddress, held))
  } catch {
    console.log(`ACCOUNT ${accountAddress}: balance not read; its keys are in the persistent profile ${directory} (do not delete it)`)
  }
}

async function run() {
  await launch()
  const sessionModule = `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name)`
  if (profile.account) {
    // The profile already holds an account: open it, do not create another.
    await call('Page.navigate', { url: origin + '/#/wallet' })
    await until(
      `${sessionModule}.then(m => m.accountSession.getWallet()).then(w => !!w, () => false)`,
      60000,
      `the account saved in ${directory} to open (do not delete this profile while its account ${profile.account.receive} holds money; set E2E_PROFILE_DIR to use another)`,
    )
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
  await typeInput('[data-test="confirm-shares"]', shares.slice(0, 2).join('\n'))
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

  const session = `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name)`
  const main = await evaluate(
    `${session}.then(async m => (await (await m.accountSession.getWallet()).getReceiveAddress()).raw)`,
  )
  if (!profile.account) await profile.recordAccount({ receive: main })
  accountAddress = main
  console.log(
    `MAIN ACCOUNT ${main}  (${profile.account ? 'reused; it is funded only if it holds too little' : 'new: fund it now'})`,
  )

  await evaluate(`location.hash = '#/wallet/monad'`)
  await click('[data-testid="wallet-tab-swap"]')
  await until(
    `document.querySelector('[data-testid="evm-swap-panel"]')`,
    30000,
    'swap panel',
  )
  await until(
    `/Available: [0-9]/.test(document.querySelector('[data-testid="swap-pay-balance"]')?.innerText ?? '')`,
    60000,
    'balances read from the chain',
  )
  console.log('venue:', await t('swap-venue'), '|', await t('swap-venue-note'))
  console.log(
    'unfunded:',
    await t('swap-pay-balance'),
    '|',
    await t('swap-receive-balance'),
  )
  await captureScreenshot('swap_01_empty.png')

  await until(
    `(() => { document.querySelector('[data-testid="evm-swap-panel"]').dispatchEvent(new Event('pointerdown', { bubbles: true })); const m = /Available: ([0-9.]+)/.exec(document.querySelector('[data-testid="swap-pay-balance"]')?.innerText ?? ''); return m && parseFloat(m[1]) > ${Number(
      amount,
    )}; })()`,
    600000,
    'the main account to be funded',
  )
  console.log('funded:', await t('swap-pay-balance'))

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
    await evaluate(
      `document.querySelector('[data-testid="swap-result-explorer"]')?.href ?? null`,
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
}

run()
  .catch(async error => {
    console.error('FAILED', error?.message ?? error)
    await captureScreenshot('swap_failed.png').catch(() => undefined)
    console.log('frontend errors:', JSON.stringify(frontendErrors.slice(0, 10)))
    process.exitCode = 1
  })
  .finally(async () => {
    await printAccount()
    await stop()
  })
