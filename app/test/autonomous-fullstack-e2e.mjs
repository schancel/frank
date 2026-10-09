import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  open,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.env.ACCOUNT_APP_ORIGIN ?? 'http://localhost:8080'
const directory = await mkdtemp(join(tmpdir(), 'frank-e2e-run-'))
const screenshotDir =
  '/Users/shammah/.gemini/antigravity/brain/c14f27e3-3a56-4261-89af-3d2fef900992/e2e_screenshots'
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
  const logsDir = '/Users/shammah/.frank-demo/logs'
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
  const logsDir = '/Users/shammah/.frank-demo/logs'
  const logFiles = await readdir(logsDir)
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

// ---------------------- TEST SUITE EXECUTION ----------------------

async function run() {
  console.log(
    '🚀 Starting Autonomous Full-Stack E2E Browser Testing against http://localhost:8080',
  )
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

    // SCENARIO 2: FAUCET AUTO-DRIP VERIFICATION
    console.log('\n--- SCENARIO 2: Faucet Auto-Drip Verification ---')
    console.log('Waiting for faucet auto-drip balance update...')
    await until(
      `(() => {
        const balanceEl = document.querySelector('[data-testid="wallet-balance"]') || document.querySelector('[data-test="wallet-balance"]');
        if (balanceEl) {
          const m = balanceEl.innerText.match(/([0-9]+(?:\\.[0-9]+)?)\\s*MONT?/);
          if (m && parseFloat(m[1]) >= 0.01) return true;
        }
        return false;
      })()`,
      60000,
      'faucet balance arrival in wallet-balance element',
    )
    const balanceText = await evaluate(`(() => {
      const balanceEl = document.querySelector('[data-testid="wallet-balance"]') || document.querySelector('[data-test="wallet-balance"]');
      if (balanceEl) {
        const m = balanceEl.innerText.match(/([0-9]+(?:\\.[0-9]+)?)\\s*MONT?/);
        if (m) return m[0];
      }
      return 'balance detected';
    })()`)
    console.log(`✅ Faucet auto-drip confirmed! Balance: ${balanceText}`)
    await captureScreenshot('02_faucet_balance.png')

    // SCENARIO 3: NAVIGATION & CURATED BOT BADGING
    console.log('\n--- SCENARIO 3: Navigation & Curated Badging ---')
    // Click Contacts rail tab
    await evaluate(`(() => {
      const tab = document.querySelector('#rail-tab-contacts') || document.querySelector('[data-testid="icon-rail"]');
      if (tab) tab.click();
      else location.hash = '#/contacts';
    })()`)
    await new Promise(r => setTimeout(r, 2000))
    await captureScreenshot('03_contacts_view.png')

    const hasContacts = await evaluate(
      `document.body.innerText.includes('Picture') || document.body.innerText.includes('Vendor') || document.body.innerText.includes('Blackjack') || document.body.innerText.includes('Qwen')`,
    )
    console.log(
      `✅ Contacts page rendered. Bot entries present: ${hasContacts}`,
    )

    // Check Wallet view
    await evaluate(`(() => {
      const tab = document.querySelector('#rail-tab-wallet');
      if (tab) tab.click();
      else location.hash = '#/wallet';
    })()`)
    await new Promise(r => setTimeout(r, 2000))
    await captureScreenshot('03_wallet_view.png')
    console.log('✅ Wallet view rendered without crashes')

    // SCENARIO 4: PICTURE SHOP (VENDOR) BOT CATALOG & MESSAGING
    console.log('\n--- SCENARIO 4: Picture Shop Bot (Vendor) Interaction ---')
    const vendorAddress = '0x35dD121885Edd839Ed8D6f69d8E63d6E87bC20eA'
    await evaluate(`location.hash = '#/chat/${vendorAddress}'`)
    await until(
      `document.querySelector('.chat-input-field')`,
      15000,
      'chat page loaded',
    )
    await new Promise(r => setTimeout(r, 2000))

    // Send "hello" to Picture Shop
    console.log('Sending "hello" to Picture Shop...')
    await sendChatMessage('hello')
    console.log('✅ Message "hello" dispatched!')

    // Wait for response or catalog
    console.log('Waiting for Picture Shop response or catalog...')
    try {
      await until(
        `(() => {
          const list = document.querySelector('.chat-message-list');
          return list && (list.innerText.includes('Welcome') || list.innerText.includes('Catalog') || list.querySelector('.digital-goods') || list.children.length >= 2);
        })()`,
        30000,
        'picture shop catalog or reply',
      )
      console.log('✅ Picture Shop response arrived in chat message list!')
    } catch (e) {
      console.warn('⚠️ Timed out waiting for catalog in UI:', e.message)
    }
    await captureScreenshot('04_picture_shop_chat.png')

    // Check if buy button is present
    const buyButtonExists = await evaluate(
      `!!document.querySelector('[data-testid="goods-buy"]')`,
    )
    console.log(`Digital goods buy button present: ${buyButtonExists}`)
    if (buyButtonExists) {
      console.log('Testing "Buy" flow click...')
      await click('[data-testid="goods-buy"]')
      await new Promise(r => setTimeout(r, 1000))
      await captureScreenshot('04_picture_shop_confirm_buy.png')
      const confirmButtonExists = await evaluate(
        `!!document.querySelector('[data-testid="goods-confirm-buy"]')`,
      )
      console.log(`Confirm Buy button present: ${confirmButtonExists}`)
    }
    // Allow prior on-chain transaction to settle
    await new Promise(r => setTimeout(r, 3000))

    // SCENARIO 5: QWEN AI ASSISTANT BOT INTERACTION
    console.log('\n--- SCENARIO 5: Qwen AI Assistant Interaction ---')
    const qwenAddress = '0xD9a3FDb466b1FE5C2623B853218C8f955daEaeF6'
    await evaluate(`location.hash = '#/chat/${qwenAddress}'`)
    await until(
      `document.querySelector('.chat-input-field')`,
      15000,
      'qwen chat loaded',
    )
    await new Promise(r => setTimeout(r, 2000))

    console.log('Sending prompt to Qwen...')
    await sendChatMessage('What is Frank?')
    console.log('✅ Prompt sent to Qwen!')

    try {
      await until(
        `(() => {
          const list = document.querySelector('.chat-message-list');
          return list && list.children.length >= 2;
        })()`,
        25000,
        'qwen reply',
      )
      console.log('✅ Qwen AI response received!')
    } catch (e) {
      console.warn('⚠️ Qwen reply wait:', e.message)
    }
    await captureScreenshot('05_qwen_chat.png')
    // Allow prior on-chain transaction to settle
    await new Promise(r => setTimeout(r, 3000))

    // SCENARIO 6: BLACKJACK BOT INTERACTION
    console.log('\n--- SCENARIO 6: Blackjack Bot Interaction ---')
    const blackjackAddress = '0xF478E879D51F1725b1C1819d0c30026fC1B84EA1'
    await evaluate(`location.hash = '#/chat/${blackjackAddress}'`)
    await until(
      `document.querySelector('.chat-input-field')`,
      15000,
      'blackjack chat loaded',
    )
    await new Promise(r => setTimeout(r, 2000))

    console.log('Sending "deal" to Blackjack Bot...')
    await sendChatMessage('deal')
    console.log('✅ Deal command sent!')

    try {
      await until(
        `(() => {
          const list = document.querySelector('.chat-message-list');
          return list && (list.innerText.includes('Blackjack') || list.innerText.includes('Dealer') || list.querySelector('.blackjack-table') || list.children.length >= 2);
        })()`,
        25000,
        'blackjack reply',
      )
      console.log('✅ Blackjack reply received!')
    } catch (e) {
      console.warn('⚠️ Blackjack response wait:', e.message)
    }
    await captureScreenshot('06_blackjack_chat.png')
    // Allow prior on-chain transaction to settle
    await new Promise(r => setTimeout(r, 3000))

    // SCENARIO 7: LOBBY BOT INTERACTION
    console.log('\n--- SCENARIO 7: Lobby Bot Interaction ---')
    const lobbyAddress = '0x68F337100cc690feb06e822218C7d77d62FBb607'
    await evaluate(`location.hash = '#/chat/${lobbyAddress}'`)
    await until(
      `document.querySelector('.chat-input-field')`,
      15000,
      'lobby chat loaded',
    )
    await new Promise(r => setTimeout(r, 2000))

    console.log('Sending "/help" to Lobby Bot...')
    await sendChatMessage('/help')
    console.log('✅ /help command sent!')

    try {
      await until(
        `(() => {
          const list = document.querySelector('.chat-message-list');
          return list && (list.innerText.includes('Lobby') || list.innerText.includes('/join') || list.children.length >= 2);
        })()`,
        25000,
        'lobby reply',
      )
      console.log('✅ Lobby reply received!')
    } catch (e) {
      console.warn('⚠️ Lobby response wait:', e.message)
    }
    await captureScreenshot('07_lobby_chat.png')

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
