import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.env.ACCOUNT_APP_ORIGIN ?? 'http://127.0.0.1:9699'
const directory = await mkdtemp(join(tmpdir(), 'frank-699-browser-'))
const executable =
  process.env.CUSTODY_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
let child, socket, call, sessionId
let events = []
const allEvents = []
async function stop() {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM')
    await ended
  }
}
async function launch(profile = 'first') {
  events = []
  child = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(directory, profile)}`,
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
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
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
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      events.push(message)
      allEvents.push(message)
      return
    }
    const handler = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) handler?.reject(new Error(message.error.message))
    else handler?.resolve(message.result)
  }
  call = (method, params = {}, tab = sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId: tab }))
    })
  const { targetId } = await call(
    'Target.createTarget',
    { url: 'about:blank' },
    undefined,
  )
  sessionId = (
    await call('Target.attachToTarget', { targetId, flatten: true }, undefined)
  ).sessionId
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Network.enable')
  await call('Page.navigate', { url: origin + '/#/setup' })
  await until(
    `document.querySelector('[data-test="new-account"]') || document.querySelector('[data-test="activate-account"]') || document.querySelector('[data-test="account-error"]')`,
  )
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
  return result.result.value
}
async function until(expression) {
  for (let n = 0; n < 200; n++) {
    if (await evaluate(expression)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const errors = events
    .filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params.exceptionDetails.exception?.description)
  errors.push(
    ...events
      .filter(
        e =>
          e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error',
      )
      .flatMap(e => e.params.args.map(a => a.description ?? a.value)),
  )
  throw new Error(
    'Browser condition timed out: ' +
      expression +
      '\n' +
      errors.join('\n') +
      '\n' +
      (await evaluate('document.body.innerText.slice(0,1500)')),
  )
}
const selector = name => `[data-test="${name}"]`
async function click(name) {
  await evaluate(
    `document.querySelector(${JSON.stringify(selector(name))}).click()`,
  )
  await new Promise(resolve => setTimeout(resolve, 30))
}
async function input(name, value) {
  await evaluate(
    `(() => { const root = document.querySelector(${JSON.stringify(
      selector(name),
    )}); const el = root.matches('input,textarea') ? root : root.querySelector('input,textarea'); const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(
      value,
    )}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`,
  )
}
async function key(key, code, windowsVirtualKeyCode) {
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode,
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode,
  })
}
async function exportStorage() {
  return evaluate(
    `Promise.all((await indexedDB.databases()).map(info => new Promise((resolve,reject) => { const request=indexedDB.open(info.name); request.onerror=()=>reject(request.error); request.onsuccess=()=> { const db=request.result; const names=Array.from(db.objectStoreNames); if(!names.length){db.close();resolve([]);return} const tx=db.transaction(names); Promise.all(names.map(name=>new Promise(done=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>done(r.result)}))).then(rows=>{db.close();resolve(rows)}) } }))).then(rows=>JSON.stringify({rows, localStorage: {...localStorage}, state: document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value, url:location.href},(_key,value)=>ArrayBuffer.isView(value)?new TextDecoder().decode(value):value))`,
  )
}
try {
  await launch()
  console.log(
    'Fresh browser loaded:',
    await evaluate(
      `document.querySelector('[data-test="account-status"]').textContent`,
    ),
  )
  assert.equal(
    await evaluate(`document.body.innerText.includes('BIP39')`),
    false,
  )
  await evaluate(`document.querySelector('[data-test="new-account"]').focus()`)
  await key('Enter', 'Enter', 13)
  await until(`document.querySelector('[data-test="backup-policy"]')`)
  assert.equal(await evaluate(`document.activeElement.id`), 'account-heading')
  assert.equal(
    await evaluate(
      `document.querySelector('[data-test="account-status"]').getAttribute('aria-live')`,
    ),
    'polite',
  )
  assert.equal(
    await evaluate(
      `document.querySelector('[data-test="generate-backups"]').disabled`,
    ),
    true,
  )
  await evaluate(
    `document.querySelector('[data-test="backup-policy"] [role="radio"]').focus()`,
  )
  await key(' ', 'Space', 32)
  await until(
    `!document.querySelector('[data-test="generate-backups"]').disabled`,
  )
  await evaluate(
    `(() => { document.querySelector('[data-test="generate-backups"]').click(); document.querySelector('[data-test="generate-backups"]').click() })()`,
  )
  await until(`document.querySelector('[data-test="backup-share"]')`)
  const shares = []
  for (let i = 0; i < 3; i++) {
    shares.push(
      await evaluate(
        `document.querySelector('[data-test="backup-share"]').value`,
      ),
    )
    await click('next-share')
  }
  const descriptor = await evaluate(
    `document.querySelector('[data-test="public-descriptor"]').value`,
  )
  await click('descriptor-saved')
  await click('confirm-backups')
  await input('confirm-shares', shares.slice(0, 2).join('\n'))
  await input('display-name', 'Synthetic account')
  await click('verify-backups')
  await until(`document.querySelector('[data-test="activate-account"]')`)
  await stop()
  sessionId = undefined
  await launch()
  assert.equal(await evaluate(`location.hash`), '#/setup')
  assert.equal(
    await evaluate(
      `!!document.querySelector('[data-test="activate-account"]')`,
    ),
    true,
  )
  console.log('Pending restart requires explicit activation: pass')
  await click('activate-account')
  await until(`location.hash === '#/wallet'`)
  console.log('Create, exact confirmation, stage and explicit activation: pass')
  const identifiers = await evaluate(
    `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => { const w = await m.accountSession.getWallet(); return { identity: w.identity.displayAddress, receive: (await w.getReceiveAddress()).raw, descriptor: m.accountStatus.account.descriptor }; })`,
  )
  assert.notEqual(identifiers.identity, identifiers.receive)
  assert.equal(identifiers.descriptor, descriptor)
  if (process.env.ACCOUNT_FAKE_DEMO === 'true') {
    const rpc = async (method, params) => {
      const response = await fetch('http://127.0.0.1:9701', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const body = await response.json()
      assert.equal(body.error, undefined)
      return body.result
    }
    assert.equal(
      BigInt(await rpc('eth_getBalance', [identifiers.receive, 'latest'])),
      0n,
    )
    await evaluate(`document.querySelector('#rail-tab-wallet').click()`)
    await until(`document.querySelector('[data-test="demo-fund"]')`)
    await click('demo-fund')
    await until(
      `document.querySelector('[data-test="fund-status"]').textContent.includes('Simulated credit confirmed')`,
    )
    assert.equal(
      BigInt(await rpc('eth_getBalance', [identifiers.receive, 'latest'])),
      1000000000000000000n,
    )
    assert.equal(
      BigInt(await rpc('eth_getBalance', [identifiers.identity, 'latest'])),
      0n,
    )
    const recipient = '0x1111111111111111111111111111111111111111'
    await evaluate(`location.hash='#/send'`)
    await until(`document.querySelector('[data-test="send-address-input"]')`)
    await input('send-address-input', recipient)
    await input('send-amount-input', '0.01')
    await click('send-review-button')
    await until(`document.querySelector('[data-test="review-confirm-button"]')`)
    await click('review-confirm-button')
    await until(`location.hash !== '#/send'`)
    assert.equal(
      BigInt(await rpc('eth_getBalance', [recipient, 'latest'])) >=
        10000000000000000n,
      true,
    )
    console.log(
      'Real fake demo: zero activation, explicit EVM-only funding, refreshed balance and native Send: pass',
    )
  } else {
    assert.equal(
      allEvents.some(e =>
        e.params?.request?.url?.includes('/_ctl/demo-funding'),
      ),
      false,
    )
  }
  const exported = await evaluate(
    `Promise.all((await indexedDB.databases()).map(info => new Promise((resolve,reject) => { const request=indexedDB.open(info.name); request.onerror=()=>reject(request.error); request.onsuccess=()=> { const db=request.result; const names=Array.from(db.objectStoreNames); if(!names.length){db.close();resolve([]);return} const tx=db.transaction(names); Promise.all(names.map(name=>new Promise(done=>{const r=tx.objectStore(name).getAll();r.onsuccess=()=>done(r.result)}))).then(rows=>{db.close();resolve(rows)}) } }))).then(rows=>JSON.stringify({rows, localStorage: {...localStorage}, url:location.href}))`,
  )
  for (const share of shares) {
    assert.equal(exported.includes(share), false)
    assert.equal(JSON.stringify(allEvents).includes(share), false)
  }
  await stop()
  sessionId = undefined
  await launch()
  const reopened = await evaluate(
    `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m => { const w=await m.accountSession.getWallet(); return {identity:w.identity.displayAddress,receive:(await w.getReceiveAddress()).raw,descriptor:m.accountStatus.account.descriptor}; })`,
  )
  assert.deepEqual(reopened, identifiers)
  console.log(
    'Browser process restart preserves identity and encrypted account: pass',
  )
  await stop()
  sessionId = undefined
  await launch('restore')
  await click('restore-account')
  await input('restore-descriptor', 'frankdesc1invalid')
  await click('pin-descriptor')
  await until(`document.querySelector('[data-test="account-error"]')`)
  assert.equal(
    await evaluate(`!!document.querySelector('[data-test="confirm-shares"]')`),
    false,
  )
  for (const invalid of [[shares[0]], shares, [shares[0], shares[0]]]) {
    await click('restore-account')
    await input('restore-descriptor', descriptor)
    await click('pin-descriptor')
    await until(`document.querySelector('[data-test="confirm-shares"]')`)
    await input('confirm-shares', invalid.join('\n'))
    await input('display-name', 'Synthetic invalid restore')
    await click('verify-backups')
    await until(`document.querySelector('[data-test="account-error"]')`)
    assert.equal(
      await evaluate(
        `!!document.querySelector('[data-test="activate-account"]')`,
      ),
      false,
    )
    assert.equal(
      await evaluate(
        `!!document.querySelector('[data-test="confirm-shares"]')`,
      ),
      false,
    )
    assert.equal(await evaluate(`document.activeElement.id`), 'account-heading')
  }
  console.log(
    'Real keyboard selection/focus/live status, double-submit guard and bounded restore rejection: pass',
  )
  await click('restore-account')
  await input('restore-descriptor', descriptor)
  await click('pin-descriptor')
  await until(`document.querySelector('[data-test="confirm-shares"]')`)
  await input('confirm-shares', shares.slice(1).join('\n'))
  await input('display-name', 'Restored synthetic account')
  await click('verify-backups')
  await until(`document.querySelector('[data-test="activate-account"]')`)
  await click('activate-account')
  await until(`location.hash === '#/wallet'`)
  const restored = await evaluate(
    `import(performance.getEntriesByType('resource').find(e => e.name.includes('/src/accounts/session.ts')).name).then(async m=>{const w=await m.accountSession.getWallet();return {identity:w.identity.displayAddress,receive:(await w.getReceiveAddress()).raw,descriptor:m.accountStatus.account.descriptor};})`,
  )
  assert.deepEqual(restored, identifiers)
  console.log(
    'Independent profile descriptor-pinned restore and identifier equivalence: pass',
  )
  await stop()
  sessionId = undefined
  await launch('legacy')
  const legacyPhrase =
    'test test test test test test test test test test test junk'
  const enteredPhrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  const legacyBlob = JSON.stringify({
    seedPhrase: legacyPhrase,
    seedConfirmedAt: 123,
    xPrivKey: { sentinel: 'LEGACY-QUARANTINE-SENTINEL' },
  })
  const walletRow = operation =>
    `new Promise((resolve,reject)=>{const r=indexedDB.open('level-js-vuex-store');r.onsuccess=()=>{const db=r.result;const tx=db.transaction('vuex-store',${JSON.stringify(
      operation === 'read' ? 'readonly' : 'readwrite',
    )});const store=tx.objectStore('vuex-store');const request=${
      operation === 'read'
        ? "store.get(new TextEncoder().encode('wallet'))"
        : 'store.put(new TextEncoder().encode(' +
          JSON.stringify(legacyBlob) +
          "),new TextEncoder().encode('wallet'))"
    };request.onsuccess=()=>resolve(request.result instanceof Uint8Array ? new TextDecoder().decode(request.result) : request.result);tx.oncomplete=()=>db.close();tx.onerror=()=>reject(tx.error)}})`
  await evaluate(walletRow('write'))
  await call('Page.reload')
  await until(`document.querySelector('[data-test="replace-ack"]')`)
  assert.equal(
    await evaluate(
      `document.querySelector('[data-test="new-account"]').disabled`,
    ),
    true,
  )
  await click('replace-ack')
  await click('legacy-recovery')
  await input('legacy-phrase', 'not a valid phrase')
  await click('identify-legacy')
  await until(`document.querySelector('[data-test="account-error"]')`)
  assert.equal(
    await evaluate(`!!document.querySelector('[data-test="legacy-phrase"]')`),
    false,
  )
  await click('legacy-recovery')
  await input('legacy-phrase', enteredPhrase)
  await click('identify-legacy')
  await until(`document.querySelector('[data-test="backup-policy"]')`)
  assert.equal(
    await evaluate(
      `document.body.innerText.includes('no funds, history or remote keys are migrated')`,
    ),
    true,
  )
  // Cancel clears the locally identified phrase/address and no state has changed.
  await click('cancel-ceremony')
  assert.equal(await evaluate(walletRow('read')), legacyBlob)
  await click('legacy-recovery')
  await input('legacy-phrase', enteredPhrase)
  await click('identify-legacy')
  await until(`document.querySelector('[data-test="backup-policy"]')`)
  await evaluate(
    `document.querySelectorAll('[data-test="backup-policy"] [role="radio"]')[1].click()`,
  )
  await click('generate-backups')
  await until(`document.querySelector('[data-test="backup-share"]')`)
  const migrationShares = []
  for (let i = 0; i < 5; i++) {
    migrationShares.push(
      await evaluate(
        `document.querySelector('[data-test="backup-share"]').value`,
      ),
    )
    await click('next-share')
  }
  await click('descriptor-saved')
  await click('confirm-backups')
  await input('confirm-shares', migrationShares.slice(0, 3).join('\n'))
  await input('display-name', 'Migrated synthetic account')
  await click('verify-backups')
  await until(`document.querySelector('[data-test="activate-account"]')`)
  await click('activate-account')
  await until(`location.hash === '#/wallet'`)
  assert.equal(await evaluate(walletRow('read')), legacyBlob)
  const migrationExport = await exportStorage()
  for (const secret of [enteredPhrase, ...migrationShares]) {
    assert.equal(migrationExport.includes(secret), false)
    assert.equal(JSON.stringify(allEvents).includes(secret), false)
  }
  assert.equal(
    JSON.stringify(
      events.filter(
        e =>
          e.method.startsWith('Network.') ||
          e.method === 'Runtime.consoleAPICalled',
      ),
    ).includes(legacyPhrase),
    false,
  )
  console.log(
    'Explicit legacy local validation, cancel, full 3-of-5 migration and byte-identical quarantine: pass',
  )
  console.log('Evidence profiles:', directory)
} finally {
  await stop()
}
