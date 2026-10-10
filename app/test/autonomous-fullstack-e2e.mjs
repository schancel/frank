import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  open,
  stat,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const origin = process.env.ACCOUNT_APP_ORIGIN ?? 'http://localhost:8080'
const directory = await mkdtemp(join(tmpdir(), 'frank-e2e-run-'))
// Where screenshots go; defaults to a folder inside this run's temp directory.
const screenshotDir = resolve(
  process.env.E2E_SCREENSHOT_DIR ?? join(directory, 'screenshots'),
)
await mkdir(screenshotDir, { recursive: true })
// The demo launcher writes its logs under `<state dir>/logs`; the state dir defaults to ~/.frank-demo.
const logsDir = resolve(
  process.env.E2E_BACKEND_LOGS_DIR ??
    join(
      process.env.FRANK_DEMO_STATE_DIR ?? join(homedir(), '.frank-demo'),
      'logs',
    ),
)
// The fake chain started by `yarn demo --fake-chain`; only used to request simulated funds.
const fakeRpcUrl = process.env.E2E_FAKE_RPC_URL ?? 'http://127.0.0.1:8545'
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

async function getLogOffsets() {
  const offsets = new Map()
  try {
    const logFiles = await readdir(logsDir)
    for (const file of logFiles) {
      if (!file.endsWith('.log')) continue
      const s = await stat(join(logsDir, file))
      offsets.set(file, s.size)
    }
  } catch {}
  return offsets
}

async function inspectBackendLogs(startOffsets = new Map()) {
  const logFiles = await readdir(logsDir).catch(() => {
    console.warn(`⚠️ No backend logs at ${logsDir}; set E2E_BACKEND_LOGS_DIR`)
    return []
  })
  const backendErrors = []
  for (const file of logFiles) {
    if (!file.endsWith('.log')) continue
    const filePath = join(logsDir, file)
    const st = await stat(filePath)
    const startOffset = startOffsets.get(file) ?? 0
    if (st.size <= startOffset) continue
    const handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(st.size - startOffset)
    await handle.read(buffer, 0, buffer.length, startOffset)
    await handle.close()
    const content = buffer.toString('utf8')
    const lines = content.split('\n')
    for (const line of lines) {
      if (
        line.includes('ERROR') ||
        line.includes('panic') ||
        line.includes('unhandledRejection')
      ) {
        backendErrors.push(`[${file}] ${line}`)
      }
    }
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
    results.push([name, 'FAIL', err.message.split('\n')[0]])
    console.error(
      `❌ ${name}: ${err.message.split('\n').slice(0, 3).join(' ')}`,
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

/** Fake chain only: asks the launcher's local funding service for 1 simulated MON at `address`
 * (what `packages/bot/demo/fund-demo.ts` does). False when there is no such service. */
async function demoCredit(address) {
  try {
    const url = `${fakeRpcUrl}/_ctl/demo-funding`
    const capability = await (await fetch(url)).json()
    if (capability?.kind !== 'frank-simulated-ledger-v1') return false
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-frank-demo-funding': capability.token,
      },
      body: JSON.stringify({
        evmReceiveAddress: address,
        amountWei: capability.amountWei,
      }),
    })
    return response.ok
  } catch {
    return false
  }
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

    // SCENARIO 2: what a new account has, with no manual step
    await scenario('2 new user funds', async () => {
      const ids = await evaluate(
        `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => { const w = await m.accountSession.getWallet(); return { profile: w.identity.address.raw, receive: (await w.getReceiveAddress()).raw } })`,
      )
      console.log(`profile ${ids.profile}  receive ${ids.receive}`)
      await evaluate(`location.hash = '#/wallet'`)
      // The faucet pays the profile address today: shown as cordoned, not spendable.
      await until(
        `/cordoned/.test(document.querySelector('[data-testid="wallet-balance"]')?.innerText ?? '') || parseFloat(document.querySelector('[data-testid="wallet-balance"]')?.innerText ?? '0') > 0`,
        60000,
        'any funds shown on the wallet page',
      )
      const shown = await evaluate(
        `document.querySelector('[data-testid="wallet-balance"]').innerText.replace(/\\s+/g, ' ').trim()`,
      )
      await captureScreenshot('02_wallet_new_user.png')
      const spendable = BigInt(
        await evaluate(
          `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => (await (await m.accountSession.getWallet()).getBalance()).toString())`,
        ),
      )
      let note = `wallet page shows "${shown}"; spendable ${spendable} wei`
      if (spendable === 0n) {
        // Nothing reaches the receive address on its own. With the fake chain, credit it
        // explicitly (the documented fund-demo step) so the remaining scenarios can run.
        const credited = await demoCredit(ids.receive)
        if (!credited)
          throw new Error(
            `${note}; no fake-chain funding service at ${fakeRpcUrl}`,
          )
        await until(
          `parseFloat(document.querySelector('[data-testid="wallet-balance"]')?.innerText ?? '0') >= 1`,
          30000,
          'simulated credit on the wallet page',
        )
        await captureScreenshot('02_wallet_after_simulated_credit.png')
        throw new Error(
          `${note}. NOT spendable without a manual step; continued after an explicit simulated credit of the receive address`,
        )
      }
      return note
    })

    // SCENARIO 3: Qwen, with timings
    await scenario('3 qwen', async () => {
      await openConversation('Qwen')
      const timings = []
      for (let i = 1; i <= 3; i++)
        timings.push(await timedSend(`What is Frank? (${i})`, 40000))
      await captureScreenshot('03_qwen.png')
      if (timings.some(t => t.reply === undefined))
        throw new Error('no reply: ' + JSON.stringify(timings))
      return timings
        .map(t => `sent ${t.sent} ms, reply ${t.reply} ms`)
        .join('; ')
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
          )})); return { copies: mine.length, sending: mine.some(e => e.innerText.includes('Sending')), failed: mine.some(e => /Failed to send/.test(e.innerText)) } })()`,
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
          `!/Failed to send/.test(document.querySelector('.chat-message-list').innerText)`,
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
      const recipient = '0x1111111111111111111111111111111111111111'
      await evaluate(`location.hash = '#/wallet'`)
      await new Promise(r => setTimeout(r, 1000))
      await evaluate(`location.hash = '#/send'`)
      await typeInput('[data-test="send-address-input"]', recipient)
      await typeInput('[data-test="send-amount-input"]', '0.01')
      await click('[data-test="send-review-button"]')
      // The confirm button is busy until the fee estimate arrives; a click before that is lost.
      await until(
        `(() => { const b = document.querySelector('[data-test="review-confirm-button"]'); return b && !b.disabled && !b.classList.contains('q-btn--loading') && !b.querySelector('.q-spinner') })()`,
        15000,
        'confirm button ready',
      )
      await new Promise(r => setTimeout(r, 500))
      await click('[data-test="review-confirm-button"]')
      await until(
        `location.hash !== '#/send' || /included|unresolved|pending|reverted/i.test(document.querySelector('[data-test="native-operation-outcome"]')?.innerText ?? '')`,
        30000,
        'native transfer outcome',
      )
      await new Promise(r => setTimeout(r, 1500))
      await captureScreenshot('07_native_send.png')
      const outcome = await evaluate(
        `location.hash !== '#/send' ? 'returned to ' + location.hash : document.querySelector('[data-test="native-operation-outcome"]').innerText.replace(/\\n+/g, ' | ')`,
      )
      await openConversation('Qwen')
      const paid = await timedSend('paid message after a native send', 40000)
      if (paid.sent === undefined)
        throw new Error('paid message after the native send was not sent')
      if (!/^returned/.test(outcome)) {
        if (!/Payment included/.test(outcome)) throw new Error(outcome)
        throw new Error(
          `funds moved and a paid message works, but the page stays on: ${outcome}`,
        )
      }
      return outcome
    })

    // SCENARIO 8: the other hosted bots
    for (const [name, text] of [
      ['Lobby', '/help'],
      ['Satoshi Dice', '/roll 0.01'],
      ['RPS Arena', '/rps'],
    ]) {
      await scenario(`8 ${name} "${text}"`, async () => {
        await openConversation(name)
        const t = await timedSend(text, 25000)
        await captureScreenshot(
          `08_${name.toLowerCase().replace(/[^a-z]+/g, '_')}.png`,
        )
        if (t.reply === undefined)
          throw new Error(`sent in ${t.sent} ms, no reply in 25 s`)
        return `reply in ${t.reply} ms`
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
    }

    if (networkFailures.length === 0) {
      console.log('🏆 ZERO NETWORK ERRORS: PASS')
    } else {
      console.error('❌ ZERO ERROR POLICY FAILED: Encountered network failures')
    }

    if (backendLogs.length === 0) {
      console.log('🏆 ZERO BACKEND ERRORS: PASS')
    } else {
      console.error('❌ ZERO ERROR POLICY FAILED: Encountered backend errors')
    }
  } catch (err) {
    console.error('❌ E2E TEST RUNNER ERROR:', err)
    if (frontendErrors.length) console.error('Frontend errors:', frontendErrors)
    if (networkFailures.length)
      console.error('Network failures:', networkFailures)
    try {
      await captureScreenshot('failure_state.png')
    } catch {}
    process.exitCode = 1
  } finally {
    await stop()
  }
}

await run()
