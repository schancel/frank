// Browser end-to-end check of the app against a running demo stack on Monad testnet.
//
// Required: ACCOUNT_APP_ORIGIN, E2E_PROFILE_DIR, E2E_BACKEND_LOGS_DIR and
// E2E_BROWSER_RESOLVER_RULES="MAP signet.mx 127.0.0.1, MAP relay.signet.mx 127.0.0.1".
// Root must separately admit the fixture servers/TLS and matching 10143 artifact.
//   terminal 1:  yarn demo                              (relay + every bot, real chain; starts the app too)
//   terminal 2:  node app/test/autonomous-fullstack-e2e.mjs
//
// It drives a real headless Chrome through account creation, funds the new account with a real
// transfer from FRANK_TEST_WALLET_JSON, a second funded testnet wallet (E2E_FUND_MON, default
// 0.2 MON, through packages/bot/demo/fund.ts, which refuses without that wallet; never the demo's
// own funding wallet, which only the running bot host may spend from), then Qwen (the answer's content is checked), a full blackjack hand
// to its outcome, the picture shop, quick sends across a reload, a native send and the other bots
// (each must answer with what that command produces). It exits non-zero if any scenario fails OR
// the browser logged an error, a request failed, or the relay/bot logs gained an error line.
// It spends real testnet funds (stamps, a bet and gas). The account lives in a PERSISTENT Chrome
// profile at the required explicit E2E_PROFILE_DIR (see e2e-profile.mjs):
// the first run creates it, later runs open the same account and fund it only when it holds
// less than E2E_FUND_MON, so funds stay in their owned profile. The
// native-send scenario pays the test wallet back rather than a dead address, and when the run
// ends (pass, failure or Ctrl-C) what the account holds above the test-account float (0.02 MON,
// TEST_ACCOUNT_FLOAT_WEI in packages/bot/demo/real-stack.ts) is sent back to the test wallet
// through the app's own send page; if that does not go through it stays in the account. One
// line says: funded X, returned Y, left Z in the profile and why. The profile is never deleted. Onboarding is only exercised when the profile is new: set
// E2E_PROFILE_DIR to a fresh directory to run it again.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  mkdir,
  writeFile,
  readdir,
  stat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  persistentProfile, testFunds, browserFixture, readPublicAccount, monWei,
  absoluteFixturePath, appendEvidence, evidenceUrl, scanBackendLog,
} from './e2e-profile.mjs'

const { origin, resolverArgument } = browserFixture()
// Both final hosts must resolve to admitted fixture addresses, even for a loopback app.
const logsDir = absoluteFixturePath(process.env.E2E_BACKEND_LOGS_DIR, 'E2E_BACKEND_LOGS_DIR')
const profile = await persistentProfile('autonomous-fullstack-e2e')
const directory = profile.directory
// Where screenshots go; defaults to a folder inside the profile directory.
const screenshotDir = resolve(
  process.env.E2E_SCREENSHOT_DIR ?? join(directory, 'screenshots'),
)
await mkdir(screenshotDir, { recursive: true })
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const fundMon = process.env.E2E_FUND_MON ?? '0.2'
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
      appendEvidence(frontendWarnings, '[CONSOLE WARNING; private body omitted]')
    }
  } else if (event.method === 'Network.responseReceived') {
    const { status, url } = event.params.response
    const unverified404 =
      status === 404 &&
      (url.includes('/metadata/') ||
        url.includes('/directory/v1/'))
    if (unverified404) appendEvidence(unverifiedLookups, `[HTTP 404; republication not verified] ${evidenceUrl(url)}`)
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
  if (await evaluate(`!!document.querySelector('[data-test="backup-share"], [data-test="confirm-shares"], input[type="password"]')`))
    throw new Error('Sensitive account screen screenshot omitted')
  const { data } = await call('Page.captureScreenshot', { format: 'png' })
  const filepath = join(screenshotDir, filename)
  await writeFile(filepath, Buffer.from(data, 'base64'))
  console.log(`📸 Screenshot saved: ${filename}`)
  return filepath
}

async function getLogOffsets() {
  const offsets = new Map()
  try {
    const logFiles = await readdir(logsDir)
    if (logFiles.length > 200) throw new Error('Fixture log inventory exceeds its bound')
    for (const file of logFiles) {
      if (!file.endsWith('.log')) continue
      const s = await stat(join(logsDir, file))
      offsets.set(file, s.size)
    }
  } catch { throw new Error('Explicit fixture log inventory could not be read') }
  return offsets
}

async function inspectBackendLogs(startOffsets = new Map()) {
  const logFiles = await readdir(logsDir).catch(() => {
    // Without the logs the "no backend errors" claim cannot be made: that is a failure, not a pass.
    throw new Error('Explicit fixture log inventory unavailable; backend errors not verified')
  })
  const backendErrors = []
  if (logFiles.length > 200) return ['fixture log inventory exceeds its bound']
  for (const file of logFiles) {
    if (!file.endsWith('.log')) continue
    const filePath = join(logsDir, file)
    const st = await stat(filePath)
    const startOffset = startOffsets.get(file) ?? 0
    if (st.size === startOffset) continue
    for (const line of await scanBackendLog(filePath, startOffset)) appendEvidence(backendErrors, line)
  }
  return backendErrors
}

async function stop() {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await ended
  }
}

const results = []

/** Runs one scenario; a failure is recorded and the run continues with the next one. */
async function scenario(name, body) {
  console.log(`\n--- SCENARIO ${name} ---`)
  try {
    const detail = await body()
    results.push([name, 'PASS', detail ?? ''])
    console.log(`✅ ${name}: ${detail ?? ''}`)
  } catch (err) {
    results.push([name, 'FAIL', 'scenario did not complete; private error body omitted'])
    console.error(
      `❌ ${name}: scenario did not complete; private error body omitted`,
    )
    await captureScreenshot(
      `fail_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.png`,
    ).catch(() => {})
  }
}

function messageCount() {
  return evaluate(
    `document.querySelectorAll('.chat-message-list .q-message').length`,
  )
}

/** Opens a conversation the way a user does: from the chat list, by the peer's name. A fresh demo
 * has fresh bot addresses, so nothing here is addressed by a hard-coded one. */
async function openConversation(name) {
  await evaluate(`location.hash = '#/chat'`)
  await until(
    `[...document.querySelectorAll('#rail-panel-chats .q-item')].some(e => e.innerText.trim().startsWith(${JSON.stringify(
      name,
    )}))`,
    30000,
    `conversation with ${name} in the chat list`,
  )
  await evaluate(
    `[...document.querySelectorAll('#rail-panel-chats .q-item')].find(e => e.innerText.trim().startsWith(${JSON.stringify(
      name,
    )})).click()`,
  )
  await until(
    `location.hash.length > '#/chat/'.length && document.querySelector('.chat-input-field')`,
    15000,
    `${name} chat opened`,
  )
  await new Promise(r => setTimeout(r, 1500))
  return evaluate('location.hash')
}

/** Sends in the open chat; milliseconds from pressing send until it shows as sent, and until the
 * peer's reply is on screen (undefined when it did not happen in time). */
async function timedSend(text, timeoutMs) {
  const before = await messageCount()
  await typeInput('.chat-input-field input, .chat-input-field textarea', text)
  await click('.chat-send-btn')
  const start = Date.now()
  let shown, sent, reply
  while (Date.now() - start < timeoutMs && reply === undefined) {
    const now = await evaluate(
      `(() => { const l = document.querySelector('.chat-message-list'); return { n: l.querySelectorAll('.q-message').length, sending: l.innerText.includes('Sending') } })()`,
    )
    if (shown === undefined && now.n > before) shown = Date.now() - start
    if (shown !== undefined && sent === undefined && !now.sending)
      sent = Date.now() - start
    if (sent !== undefined && now.n >= before + 2) reply = Date.now() - start
    await new Promise(r => setTimeout(r, 100))
  }
  console.log(`"${text}": sent ${sent} ms, reply ${reply} ms`)
  return { sent, reply }
}

// Funding from the test wallet when the account is low, and sending what is left above the
// float back when the run ends, on pass, failure and Ctrl-C (e2e-profile.mjs).
const funds = testFunds({
  repoRoot,
  directory,
  profile,
  page: { evaluate, typeInput, click, until },
  stop,
})

/** Text of the newest message received in the open conversation. */
function lastReceivedText() {
  return evaluate(
    `(() => { const all = [...document.querySelectorAll('.chat-message-list .q-message-received')]; return all.length ? all[all.length - 1].innerText.replace(/\\s+/g, ' ').trim() : '' })()`,
  )
}

// ---------------------- TEST SUITE EXECUTION ----------------------

async function run() {
  console.log(
    `🚀 Starting Autonomous Full-Stack E2E Browser Testing against ${origin}`,
  )
  console.log(`Screenshots: ${screenshotDir}\nBackend logs: ${logsDir}`)
  const startTime = Date.now()
  const logOffsets = await getLogOffsets()

  try {
    await launch()

    if (profile.account) {
      // The profile already holds an account: open it, do not create another.
      console.log(`\n--- SCENARIO 1: reusing the account in ${directory} ---`)
      await call('Page.navigate', { url: origin + '/#/wallet' })
      await profile.recordAccount(await readPublicAccount({ evaluate, until }))
      results.push([
        '1 onboarding',
        'NOT_RUN_REUSED',
        `not run: reused the account ${profile.account.receive} in ${directory}`,
      ])
    } else {
      // SCENARIO 1: ONBOARDING & ACCOUNT CREATION
      console.log('\n--- SCENARIO 1: Onboarding & Account Creation ---')
      await call('Page.navigate', { url: origin + '/#/setup' })
      await until(
        `document.querySelector('[data-test="new-account"]')`,
        20000,
        'setup page loaded',
      )
      console.log('✅ Setup page mounted')

      // Click New Account
      await click('[data-test="new-account"]')
      await until(
        `document.querySelector('[data-test="backup-policy"]')`,
        10000,
        'backup policy choice',
      )

      // Focus radio and press Space to select default policy
      await evaluate(
        `document.querySelector('[data-test="backup-policy"] [role="radio"]').focus()`,
      )
      await key(' ', 'Space', 32)
      await until(
        `!document.querySelector('[data-test="generate-backups"]').disabled`,
        5000,
        'generate button enabled',
      )

      // Double click to trigger form submit
      await evaluate(`(() => {
      document.querySelector('[data-test="generate-backups"]').click();
      document.querySelector('[data-test="generate-backups"]').click();
    })()`)

      // Collect 3 shares
      await until(
        `document.querySelector('[data-test="backup-share"]')`,
        10000,
        'backup shares presented',
      )
      const shares = []
      for (let i = 0; i < 3; i++) {
        const shareVal = await getValue('[data-test="backup-share"]')
        shares.push(shareVal)
        await click('[data-test="next-share"]')
      }
      console.log(`✅ Generated ${shares.length} Codex32 backup shares`)

      // Confirm shares and enter display name
      await until(
        `document.querySelector('[data-test="confirm-shares"]')`,
        10000,
        'confirm shares view',
      )
      await typeInput(
        '[data-test="confirm-shares"]',
        shares.slice(0, 2).join('\n'),
      )
      await typeInput('[data-test="display-name"]', 'Autonomous Tester')
      await click('[data-test="verify-backups"]')

      await until(
        `document.querySelector('[data-test="activate-account"]')`,
        15000,
        'activate account ready',
      )
      console.log('✅ Backups verified successfully. Activating account...')
      await click('[data-test="activate-account"]')

      await until(
        `location.hash !== '#/setup'`,
        15000,
        'navigated away from setup',
      )
      console.log(
        `✅ Account activated! Landed on ${await evaluate('location.hash')}`,
      )
      await new Promise(r => setTimeout(r, 2000))
      await captureScreenshot('01_account_created.png')

      results.push([
        '1 onboarding',
        'PASS',
        'landed on ' + (await evaluate('location.hash')),
      ])

      await profile.recordAccount(await readPublicAccount({ evaluate, until }))
    }

    // SCENARIO 2: what a new account has, with no manual step
    await scenario('2 new user funds', async () => {
      const ids = await readPublicAccount({ evaluate, until })
      await profile.recordAccount(ids)
      console.log(`profile ${ids.profile}  receive ${ids.receive}`)
      await evaluate(`location.hash = '#/wallet'`)
      // Read the exact available title; shortened or unknown presentation is not a spending cap.
      const appeared = await until(
        `(() => { const value = document.querySelector('[data-testid="wallet-available"] span[title]')?.getAttribute('title'); return /^\\d+(?:\\.\\d+)? MONT$/.test(value ?? '') && !/^0(?:\\.0+)? MONT$/.test(value) })()`,
        60000,
        'any funds shown on the wallet page',
      ).then(
        () => true,
        () => false,
      )
      const shown = await evaluate(
        `(document.querySelector('[data-testid="wallet-balance"]')?.innerText ?? '(no balance element)').replace(/\\s+/g, ' ').trim()`,
      )
      await captureScreenshot('02_wallet_new_user.png')
      const spendable = await funds.spendable()
      const owned = await funds.owned()
      let note = `wallet page shows "${shown}"${
        appeared ? '' : ' (nothing arrived within 60 s of creating the account)'
      }; owned ${owned} wei; available ${spendable} wei`
      if (spendable < 100000000000000000n) {
        const transfer = await funds.ensure(monWei(fundMon))
        console.log(transfer)
        await until(
          `(() => { const value = document.querySelector('[data-testid="wallet-available"] span[title]')?.getAttribute('title'); return /^\\d+(?:\\.\\d+)? MONT$/.test(value ?? '') && !/^0(?:\\.0+)? MONT$/.test(value) })()`,
          60000,
          'the transfer shown on the wallet page',
        )
        await captureScreenshot('02_wallet_after_funding.png')
        throw new Error(
          `${note}. A new account cannot pay for anything on its own; continued after funding its receive address with ${fundMon} MON`,
        )
      }
      return note
    })

    // SCENARIO 3: Qwen, with timings
    await scenario('3 qwen', async () => {
      await openConversation('Qwen')
      const timings = []
      for (let i = 1; i <= 3; i++)
        // One question at a time, waiting past the bot's own allowance (45 s a model call, three
        // tries), so the next received message is the answer to this question and no other.
        timings.push(await timedSend(`What is Frank? (${i})`, 150000))
      await captureScreenshot('03_qwen.png')
      if (timings.some(t => t.reply === undefined))
        throw new Error('no reply: ' + JSON.stringify(timings))
      // The answer must be an answer to the question: either the labelled offline stub echoing
      // it, or a model's sentence about Frank. "Slow down", an error line or an empty bubble fail.
      const answer = await lastReceivedText()
      const stub = answer.includes('[STUB -- no model, offline canned reply]')
      if (
        stub
          ? !answer.includes('What is Frank?')
          : !(answer.length >= 20 && /frank/i.test(answer))
      )
        throw new Error(
          `Qwen's reply does not answer the question: ${JSON.stringify(
            answer.slice(0, 160),
          )}`,
        )
      return (
        timings.map(t => `sent ${t.sent} ms, reply ${t.reply} ms`).join('; ') +
        `; ${stub ? 'stub' : 'model'} answer: ${JSON.stringify(
          answer.slice(0, 80),
        )}`
      )
    })

    // SCENARIO 4: blackjack against the hosted dealer, from the dealer's own challenge card
    await scenario('4 blackjack', async () => {
      await openConversation('Blackjack')
      await captureScreenshot('04_blackjack_challenge.png')
      await typeInput('[data-testid="blackjack-bet-amount"]', '0.02')
      await click('[data-testid="blackjack-bet"]')
      await until(
        `document.querySelector('[data-testid="blackjack-stand"], [data-testid="blackjack-outcome"]')`,
        45000,
        'cards dealt',
      )
      await captureScreenshot('04_blackjack_dealt.png')
      for (let step = 0; step < 6; step++) {
        if (
          await evaluate(
            `!!document.querySelector('[data-testid="blackjack-outcome"]')`,
          )
        )
          break
        const total = await evaluate(
          `(() => { const m = [...document.querySelectorAll('[data-testid="blackjack-line"]')].map(e => e.innerText).reverse().find(t => /^Player:/.test(t)); return m ? Number(/\\((\\d+)\\)/.exec(m)?.[1] ?? 0) : 0 })()`,
        )
        const move = total > 0 && total < 12 ? 'hit' : 'stand'
        const before = await messageCount()
        await click(`[data-testid="blackjack-${move}"]`)
        await until(
          `document.querySelectorAll('.chat-message-list .q-message').length >= ${
            before + 2
          }`,
          45000,
          `dealer answer to ${move}`,
        )
        await new Promise(r => setTimeout(r, 800))
        await captureScreenshot(`04_blackjack_${step + 1}_${move}.png`)
      }
      const outcome = await evaluate(
        `[...document.querySelectorAll('[data-testid="blackjack-outcome"], [data-testid="blackjack-payout"]')].map(e => e.innerText).join(' ')`,
      )
      if (!outcome) throw new Error('hand did not reach an outcome')
      // A finished hand states who won (or a push); anything else is not an outcome.
      if (!/win|won|lose|lost|push|bust|blackjack/i.test(outcome))
        throw new Error(
          `the hand ended without a result: ${JSON.stringify(outcome)}`,
        )
      return outcome
    })

    // SCENARIO 5: picture shop catalog and the Buy flow up to confirmation
    await scenario('5 vendor', async () => {
      await openConversation('Picture Shop')
      await new Promise(r => setTimeout(r, 1500))
      await captureScreenshot('05_picture_shop.png')
      const state = await evaluate(
        `({ catalog: !!document.querySelector('.digital-goods'), buy: !!document.querySelector('[data-testid="goods-buy"]'), rawJson: document.querySelector('.chat-message-list').innerText.includes('"type":"digital-goods"') })`,
      )
      if (state.rawJson)
        throw new Error('the catalog is shown as raw JSON text')
      if (!state.buy) throw new Error('no catalog with a Buy button')
      await click('[data-testid="goods-buy"]')
      await until(
        `document.querySelector('[data-testid="goods-confirm-buy"]')`,
        10000,
        'confirm buy',
      )
      await captureScreenshot('05_picture_shop_confirm_buy.png')
      return 'catalog rendered; Buy reaches confirmation'
    })

    // SCENARIO 6: two bots in quick succession, reload mid-send, recover, send again
    await scenario('6 quick sends and reload', async () => {
      const tag = Date.now() % 100000
      const qwen = await openConversation('Qwen')
      await sendChatMessage(`quick A ${tag}`)
      const lobby = await openConversation('Lobby')
      await sendChatMessage(`quick B ${tag}`)
      await call('Page.reload', {})
      await new Promise(r => setTimeout(r, 6000))
      const settled = async (target, text) => {
        await evaluate(`location.hash = ${JSON.stringify(target)}`)
        await until(
          `document.querySelector('.chat-input-field')`,
          15000,
          'chat after reload',
        )
        await new Promise(r => setTimeout(r, 1500))
        return evaluate(
          `(() => { const l = document.querySelector('.chat-message-list'); const mine = [...l.querySelectorAll('.q-message-sent')].filter(e => e.innerText.includes(${JSON.stringify(
            text,
          )})); return { copies: mine.length, sending: mine.some(e => e.innerText.includes('Sending')), failed: mine.some(e => e.querySelector('[data-testid="outgoing-failed"]') !== null) } })()`,
        )
      }
      let a = await settled(qwen, `quick A ${tag}`)
      await captureScreenshot('06_after_reload_qwen.png')
      const b = await settled(lobby, `quick B ${tag}`)
      await captureScreenshot('06_after_reload_lobby.png')
      for (const [name, state] of [
        ['Qwen', a],
        ['Lobby', b],
      ]) {
        if (state.copies !== 1)
          throw new Error(`${name}: ${state.copies} copies after reload`)
        if (state.sending)
          throw new Error(`${name}: still "Sending" after reload`)
      }
      // A send the reload caught after its payment was recorded shows "Payment pending, will
      // retry" and finishes on its own; later sends in that chat wait behind it.
      const pendingSince = Date.now()
      let pendingNote = ''
      if (
        await evaluate(
          `location.hash = ${JSON.stringify(
            qwen,
          )}, new Promise(r => setTimeout(() => r(/Payment pending/.test(document.querySelector('.chat-message-list')?.innerText ?? '')), 2500))`,
        )
      ) {
        await until(
          `!/Payment pending/.test(document.querySelector('.chat-message-list').innerText)`,
          300000,
          'the pending payment of the interrupted message to settle',
        )
        pendingNote = `; the interrupted Qwen message stayed "Payment pending" for ${Math.round(
          (Date.now() - pendingSince) / 1000,
        )} s before it was delivered`
        a = await settled(qwen, `quick A ${tag}`)
      }
      await evaluate(`location.hash = ${JSON.stringify(lobby)}`)
      await until(
        `document.querySelector('.chat-input-field')`,
        15000,
        'lobby chat',
      )
      await new Promise(r => setTimeout(r, 1500))
      // An interrupted message is offered for resend; resend the one still open (Lobby).
      if (b.failed) {
        await evaluate(
          `[...document.querySelectorAll('.chat-message-list .q-btn')].find(e => e.innerText.includes('replay'))?.click()`,
        )
        await until(
          `document.querySelector('.chat-message-list [data-testid="outgoing-failed"]') === null`,
          30000,
          'resend',
        )
      }
      await evaluate(`location.hash = ${JSON.stringify(qwen)}`)
      await until(
        `document.querySelector('.chat-input-field')`,
        15000,
        'qwen chat',
      )
      await new Promise(r => setTimeout(r, 1500))
      const again = await timedSend(`after reload ${tag}`, 40000)
      await captureScreenshot('06_send_again.png')
      if (again.reply === undefined)
        throw new Error('no reply to a send after reload')
      return `after reload: Qwen ${JSON.stringify(a)}, Lobby ${JSON.stringify(
        b,
      )}; resend and a new send both delivered${pendingNote}`
    })

    // SCENARIO 7: native send from the wallet page, then a paid message
    await scenario('7 native send', async () => {
      // To the wallet that funds this account, so the amount comes straight back.
      const recipient = (await funds.testWallet()).address
      const receipt = await funds.sendFromPage(recipient, '0.01')
      await captureScreenshot('07_native_send.png')
      await openConversation('Qwen')
      const paid = await timedSend('paid message after a native send', 40000)
      if (paid.sent === undefined)
        throw new Error('paid message after the native send was not sent')
      return `recipient credit verified for original ${receipt.operationId}; automatic navigation not assessed by this receipt check`
    })

    // SCENARIO 8: the other hosted bots
    // Each must answer with what its command produces, not just with something.
    for (const [name, text, expected] of [
      ['Lobby', '/help', /Lobby Group Chat Commands/i],
      ['Satoshi Dice', '/roll 0.01', /roll|dice|win|lose|lost|won/i],
      ['RPS Arena', '/rps', /rock|paper|scissors/i],
    ]) {
      await scenario(`8 ${name} "${text}"`, async () => {
        await openConversation(name)
        const t = await timedSend(text, 25000)
        await captureScreenshot(
          `08_${name.toLowerCase().replace(/[^a-z]+/g, '_')}.png`,
        )
        if (t.reply === undefined)
          throw new Error(`sent in ${t.sent} ms, no reply in 25 s`)
        const answer = await lastReceivedText()
        if (!expected.test(answer))
          throw new Error(
            `the reply is not an answer to "${text}": ${JSON.stringify(
              answer.slice(0, 160),
            )}`,
          )
        return `reply in ${t.reply} ms: ${JSON.stringify(answer.slice(0, 60))}`
      })
    }

    console.log('\n================ SCENARIO RESULTS ================')
    for (const [name, verdict, detail] of results)
      console.log(`${verdict.padEnd(4)} ${name}: ${detail}`)
    if (results.some(r => r[1] === 'FAIL')) process.exitCode = 1

    // ZERO ERROR TOLERANCE AUDIT
    console.log(
      '\n================ ZERO ERROR TOLERANCE AUDIT ================',
    )
    console.log(
      `Frontend Unhandled Exceptions / Console Errors: ${frontendErrors.length}`,
    )
    if (frontendErrors.length > 0) {
      console.error('Frontend Errors:\n', frontendErrors.join('\n'))
    }

    console.log(`Network HTTP >= 400 Failures: ${networkFailures.length}`)
    if (unverifiedLookups.length)
      console.log(`Directory/metadata absence observed ${unverifiedLookups.length} times; fresh-backend republication NOT VERIFIED by this journey`)
    if (networkFailures.length > 0) {
      console.warn('Network Failures:\n', networkFailures.join('\n'))
    }

    const backendLogs = await inspectBackendLogs(logOffsets)
    console.log(`Backend Errors in logs: ${backendLogs.length}`)
    if (backendLogs.length > 0) {
      console.warn('Backend Errors:\n', backendLogs.slice(-10).join('\n'))
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`\n🎉 E2E Test Run Finished in ${duration}s!`)

    if (frontendErrors.length === 0) {
      console.log('🏆 ZERO FRONTEND ERRORS: PASS')
    } else {
      console.error(
        '❌ ZERO ERROR POLICY FAILED: Encountered frontend exceptions/errors',
      )
      process.exitCode = 1
    }

    if (networkFailures.length === 0) {
      console.log('🏆 ZERO NETWORK ERRORS: PASS')
    } else {
      console.error('❌ ZERO ERROR POLICY FAILED: Encountered network failures')
      process.exitCode = 1
    }

    if (backendLogs.length === 0) {
      console.log('🏆 ZERO BACKEND ERRORS: PASS')
    } else {
      console.error('❌ ZERO ERROR POLICY FAILED: Encountered backend errors')
      process.exitCode = 1
    }
    console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E OK')
  } catch (err) {
    console.error('❌ E2E TEST RUNNER ERROR: private error body omitted')
    if (frontendErrors.length) console.error('Frontend errors:', frontendErrors)
    if (networkFailures.length)
      console.error('Network failures:', networkFailures)
    try {
      await captureScreenshot('failure_state.png')
    } catch {}
    process.exitCode = 1
  } finally {
    if (socket) await funds.finish()
    await stop()
  }
}

await run()
