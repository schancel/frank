#!/usr/bin/env node
// Real-Chrome driver for the local stack (demo/local-stack/stack.mjs must be "up").
//
//   node demo/local-stack/drive.cjs export            fresh profile: onboard a disposable account,
//                                                     Settings -> Networking, export public evidence
//   node demo/local-stack/drive.cjs check             same profile: "Check installation", report panel
//   node demo/local-stack/drive.cjs address           same profile: print the account's public addresses
//   node demo/local-stack/drive.cjs chat "<text>"     same profile: open the bot chat, send, wait for a reply
//
// One Chrome at a time, a dedicated profile under the stack state directory, trusted only for the
// stack's own certificates. Backup shares exist only in this process's memory during onboarding and
// are never logged or captured; screenshots are taken only outside that phase.
// Set HEADFUL=1 to watch. Evidence goes to <state>/shots and <state>/logs/drive-*.json.
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict')
const { spawn, execFileSync } = require('child_process')
const repo = path.resolve(__dirname, '..', '..')
const { ownedProcesses } = require(path.join(repo, 'packages/frank-codec/browsercheck/check-chrome.js'))

const STATE = process.env.FRANK_STACK_DIR || '/private/tmp/frank-stack'
const APP = 'https://127.0.0.1:18440'
const profile = path.join(STATE, 'chrome-profile')
const shots = path.join(STATE, 'shots')
const [phase, ...rest] = process.argv.slice(2)
const delay = ms => new Promise(r => setTimeout(r, ms))

let child, owner, socket, exit, session, seq = 0, secretPhase = false
const pending = new Map()
const net = new Map() // requestId -> record
const consoleLines = []
const caught = []
const traceExceptions = async () => {
  if (!process.env.TRACE_EXCEPTIONS) return
  await rpc('Debugger.enable')
  await rpc('Debugger.setPauseOnExceptions', { state: 'all' })
}
const report = { phase, started: new Date().toISOString(), steps: [] }
const note = (name, detail) => {
  report.steps.push({ name, detail })
  console.log('ok - ' + name + (detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))))
}

const rpc = (method, params = {}, sid = session) =>
  new Promise((resolve, reject) => {
    const id = ++seq,
      t = setTimeout(() => {
        pending.delete(id)
        reject(Error('CDP timeout ' + method))
      }, 30000)
    pending.set(id, { resolve: v => (clearTimeout(t), resolve(v)), reject: e => (clearTimeout(t), reject(e)) })
    socket.send(JSON.stringify({ id, method, params, sessionId: sid }))
  })
const ev = async expression => {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300))
  return r.result.value
}
const wait = async (fn, label, ms = 45000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await delay(150)
  }
  throw Error('timeout ' + label)
}
const has = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`)
const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').trim()`)
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('missing '+${JSON.stringify(sel)});e.click()})()`)
const input = (sel, value) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
const shot = async name => {
  if (secretPhase) return
  name = (process.env.SHOT_PREFIX || '') + name
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from((await rpc('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  console.log('   shot ' + path.join(shots, name + '.png'))
}

async function launch() {
  fs.mkdirSync(shots, { recursive: true })
  const flags = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'stack.mjs'), 'chrome-args', profile]).toString())
  const binary = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  child = spawn(binary, [...(process.env.HEADFUL ? [] : ['--headless=new']), ...flags, '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  owner = ownedProcesses(child.pid)
  owner.members()
  child.on('exit', (code, signal) => (exit = { code, signal }))
  let endpoint,
    tail = ''
  child.stderr.on('data', d => {
    tail = (tail + d).slice(-65536)
    endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(tail)?.[1]
  })
  await wait(() => endpoint, 'devtools endpoint')
  socket = new WebSocket(endpoint)
  socket.onmessage = e => {
    const m = JSON.parse(e.data),
      p = pending.get(m.id)
    const q = m.params
    if (m.method === 'Network.requestWillBeSent') net.set(q.requestId, { t: Date.now(), method: q.request.method, url: q.request.url, type: q.type })
    if (m.method === 'Network.responseReceived' && net.has(q.requestId)) Object.assign(net.get(q.requestId), { status: q.response.status, contentType: q.response.headers['content-type'] ?? q.response.headers['Content-Type'], acao: q.response.headers['access-control-allow-origin'] ?? null })
    if (m.method === 'Network.loadingFailed' && net.has(q.requestId)) Object.assign(net.get(q.requestId), { failed: q.errorText, cors: q.corsErrorStatus?.corsError ?? null, blocked: q.blockedReason ?? null })
    if (m.method === 'Runtime.consoleAPICalled' && !secretPhase) consoleLines.push({ t: Date.now(), level: q.type, text: q.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) })
    if (m.method === 'Runtime.exceptionThrown' && !secretPhase) consoleLines.push({ t: Date.now(), level: 'exception', text: String(q.exceptionDetails.exception?.description || q.exceptionDetails.text).slice(0, 500) })
    if (m.method === 'Log.entryAdded' && !secretPhase) consoleLines.push({ t: Date.now(), level: 'log:' + q.entry.level, text: (q.entry.text + ' ' + (q.entry.url ?? '')).slice(0, 500) })
    if (m.method === 'Debugger.paused') {
      // TRACE_EXCEPTIONS=1: record caught exceptions too (never during the backup ceremony).
      if (!secretPhase && q.data?.description) caught.push({ t: Date.now(), text: String(q.data.description).slice(0, 600), at: (q.callFrames[0]?.url ?? '').split('/').pop() + ':' + q.callFrames[0]?.location.lineNumber })
      socket.send(JSON.stringify({ id: ++seq, method: 'Debugger.resume', sessionId: session }))
    }
    if (p) {
      pending.delete(m.id)
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  }
  await wait(() => socket.readyState === 1, 'devtools socket')
  const target = (await rpc('Target.getTargets', {}, undefined)).targetInfos.find(t => t.type === 'page')
  session = (await rpc('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined)).sessionId
  for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await rpc(domain + '.enable')
  await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  console.log(JSON.stringify({ chromePid: child.pid, profile }))
}
async function close() {
  if (socket?.readyState === 1) {
    await rpc('Browser.close', {}, undefined).catch(() => {})
    await wait(() => exit, 'chrome exit', 15000).catch(() => {})
  }
  socket?.close()
  if (owner?.members().length) {
    owner.signal('SIGTERM')
    await delay(1500)
    if (owner.members().length) owner.signal('SIGKILL')
    await delay(500)
  }
  report.chromeExit = exit
  report.chromeProcessesLeft = owner ? owner.members().length : 0
}

/** Requests the page made to the stack's relay/bot fronts, with the CORS outcome Chrome reported. */
const stackRequests = since =>
  [...net.values()]
    .filter(r => r.t >= since && /^https:\/\/127\.0\.0\.1:1844[345]\//.test(r.url))
    .map(r => ({ method: r.method, url: r.url.replace(/\/cap\/[^/]+\//, '/cap/(capability)/'), status: r.status ?? null, contentType: r.contentType ?? null, allowOrigin: r.acao ?? null, failed: r.failed ?? null, cors: r.cors ?? null }))

async function onboard() {
  await rpc('Page.navigate', { url: APP + '/' })
  await wait(() => has('[data-test=new-account]'), 'onboarding landing')
  note('app loaded over HTTPS', { title: await ev('document.title'), secureContext: await ev('isSecureContext'), origin: await ev('location.origin') })
  await shot('01-onboarding')
  await click('[data-test=new-account]')
  await wait(() => has('[data-test=backup-policy]'), 'backup policy')
  secretPhase = true
  await click('[data-test=backup-policy] .q-radio')
  await click('[data-test=generate-backups]')
  const shareSel = '[data-test=backup-share] textarea, textarea[data-test=backup-share]'
  await wait(() => has(shareSel), 'backup shares')
  const shares = []
  for (let i = 0; i < 3; i++) {
    shares.push(await ev(`document.querySelector(${JSON.stringify(shareSel)}).value`))
    await click('[data-test=next-share]')
    await delay(150)
  }
  await wait(() => has('[data-test=public-descriptor] input, input[data-test=public-descriptor]'), 'descriptor')
  await click('[data-test=descriptor-saved]')
  await click('[data-test=confirm-backups]')
  await input('[data-test=confirm-shares] textarea, textarea[data-test=confirm-shares]', shares.slice(0, 2).join('\n'))
  shares.fill('')
  await input('[data-test=display-name] input, input[data-test=display-name]', 'Local stack tester')
  await click('[data-test=verify-backups]')
  await wait(() => has('[data-test=activate-account]'), 'pending activation')
  await click('[data-test=activate-account]')
  await wait(() => has('#rail-tab-wallet'), 'authenticated app')
  secretPhase = false
  note('disposable account created through normal onboarding')
  await delay(1500)
  await shot('02-authenticated')
}
async function resume() {
  await rpc('Page.navigate', { url: APP + '/' })
  await wait(async () => (await has('#rail-tab-wallet')) || (await has('[data-test=new-account]')), 'app start')
  if (!(await has('#rail-tab-wallet'))) throw Error('the profile has no signed-in account; run "export" first')
  note('existing account resumed from the profile', { route: await ev('location.hash') })
  await delay(1500)
}
async function openNetworking() {
  await ev('location.hash = "#/settings"')
  await wait(() => has('[data-test=directory-provisioning]'), 'Settings -> Networking panel')
  await delay(500)
}
const panel = () =>
  ev(`(()=>{const q=s=>document.querySelector(s)?.innerText.trim()??null;return {
    status:q('[data-test=directory-provisioning-status]'),
    reason:q('[data-test=directory-provisioning-reason]'),
    relayA:q('[data-test=directory-participant-relay-a]'),
    relayB:q('[data-test=directory-participant-relay-b]'),
    bot:q('[data-test=directory-participant-bot]'),
    peerAddress:q('[data-test=directory-peer-address]'),
    exportError:q('[data-test=directory-export-error]')}})()`)
const walletAddress = () => ev(`(()=>{const b=document.querySelector('[data-testid=wallet-copy-address]');const f=b?.closest('.q-field');return (f?.querySelector('textarea,input')?.value ?? '').trim()})()`)
const showPanel = async name => {
  await ev('document.querySelector("[data-test=directory-provisioning]").scrollIntoView({block:"start"})')
  await delay(250)
  await shot(name)
}

/** Settings panel -> bot address -> Add Contact -> chat: the path a person takes. Returns the address. */
async function openPeerChat() {
  await openNetworking()
  // After a reload the app resumes messaging on its own only if this device completed an
  // explicit Check before. Give that a moment, and press Check only if it did not happen.
  await wait(async () => (await panel()).peerAddress, 'messaging resumed after reload', 15000).catch(() => {})
  let state = await panel()
  note('panel after reload, before any action', state)
  report.resumedWithoutCheck = !!state.peerAddress
  if (!state.peerAddress) {
    await click('[data-test=directory-check]')
    await delay(300)
    await wait(async () => !(await ev('document.querySelector("[data-test=directory-check]").disabled')), 'check to finish', 90000)
    state = await panel()
    note('panel after pressing Check', state)
  }
  const peer = /0x[0-9a-fA-F]{40}/.exec(state.peerAddress ?? '')?.[0]
  if (!peer) throw Error('messaging is not ready: ' + JSON.stringify(state))
  // The path a person takes: Add Contact with the address the panel shows, then open the chat.
  await ev('location.hash = "#/add-contact"')
  await wait(() => has('.q-card input'), 'Add Contact page')
  await ev('document.querySelector(".q-card input").focus()')
  await rpc('Input.insertText', { text: peer })
  const addButton = `[...document.querySelectorAll('.q-card__actions button')].find(b => b.innerText.trim().toLowerCase() === 'add')`
  await wait(() => ev(`(()=>{const b=${addButton};return !!b && !b.disabled})()`), 'Add enabled for the installed bot address', 30000)
  await shot('08a-add-contact')
  await ev(`${addButton}.click()`)
  await delay(1500)
  note('after Add Contact', { route: await ev('location.hash') })
  if (!(await ev('location.hash')).toLowerCase().includes(peer.toLowerCase())) await ev(`location.hash = ${JSON.stringify('#/chat/' + peer)}`)
  await wait(() => has('.q-footer textarea, textarea[placeholder]'), 'chat composer')
  await delay(1000)
  return peer
}

const phases = {
  async export() {
    if (fs.existsSync(profile) && !process.env.REUSE_PROFILE) throw Error(`${profile} already exists; "export" starts from a fresh profile (run stack.mjs up, or set REUSE_PROFILE=1 to export from the existing account)`)
    await launch()
    if (process.env.REUSE_PROFILE) await resume()
    else await onboard()
    await openNetworking()
    note('Settings -> Networking before any action', await panel())
    await showPanel('03-networking-before-export')
    const since = Date.now()
    await traceExceptions()
    await click('[data-test=directory-export]')
    await wait(async () => (await has('[data-test=directory-export-text]')) || (await has('[data-test=directory-export-error]')), 'export result')
    const state = await panel()
    if (state.exportError) throw Error('export refused: ' + state.exportError)
    const exported = await ev('document.querySelector("[data-test=directory-export-text]").value')
    const file = JSON.parse(exported)
    assert.equal(file.kind, 'public-revision-zero-export')
    const download = await ev('(()=>{const a=document.querySelector("[data-test=directory-export-download]");return {name:a.getAttribute("download"),sameAsText:decodeURIComponent(a.getAttribute("href").split(",")[1])===document.querySelector("[data-test=directory-export-text]").value}})()')
    assert.deepEqual(download, { name: 'frank-ui-public-export.json', sameAsText: true })
    const out = path.join(STATE, 'operator', 'frank-ui-public-export.json')
    fs.writeFileSync(out, exported)
    note('public evidence exported', { out, subjectP: file.subjectP, authAddress: file.authAddress, home: file.homeProcessId, policy: file.bootstrapPolicyIdentity })
    note('requests to relay/bot fronts during export (expected: none)', stackRequests(since))
    await showPanel('04-networking-exported')
  },
  async check() {
    await launch()
    await resume()
    await openNetworking()
    note('panel on open (automatic state)', await panel())
    await showPanel('05-networking-before-check')
    const since = Date.now()
    await traceExceptions()
    await click('[data-test=directory-check]')
    await delay(300)
    await wait(async () => (await text('[data-test=directory-provisioning-status]')) !== 'Checking…' && !(await ev('document.querySelector("[data-test=directory-check]").disabled')), 'check to finish', 90000)
    const state = await panel()
    note('panel after "Check installation"', state)
    note('requests to relay/bot fronts during the check', stackRequests(since))
    await showPanel('06-networking-after-check')
    report.panel = state
  },
  async address() {
    await launch()
    await resume()
    await ev('location.hash = "#/wallet"')
    await wait(() => has('[data-testid=wallet-copy-address]'), 'wallet page')
    await wait(async () => /^0x[0-9a-fA-F]{40}$/.test(await walletAddress()), 'wallet address')
    await delay(1500)
    const shown = await walletAddress()
    const balance = await text('[data-testid=wallet-balance]')
    await shot('07-wallet')
    // The Wallet page shows the identity address; the account that holds and spends funds is the
    // one the Receive page shows. Fund that one.
    await ev('location.hash = "#/receive"')
    const receive = () => ev(`(()=>{const b=document.querySelector('[data-testid=receive-copy-address]');const f=b?.closest('.q-field');return (f?.querySelector('textarea,input')?.value ?? '').trim()})()`)
    await wait(async () => /^0x[0-9a-fA-F]{40}$/.test(await receive()), 'receive address')
    const address = await receive()
    await shot('07b-receive')
    fs.writeFileSync(path.join(STATE, 'operator', 'ui-wallet-address.txt'), address + '\n')
    note('wallet addresses (public)', { fundThis: address, walletPageShows: shown, balance })
  },
  async chat(message = 'Hello from the local stack. Reply with one short sentence.') {
    await launch()
    await resume()
    const peer = await openPeerChat()
    const composer = '.q-footer textarea, textarea[placeholder]'
    await shot('08-chat-open')
    const bubbles = () => ev(`[...document.querySelectorAll('.q-message')].map(e=>({sent:e.classList.contains('q-message-sent'),text:e.innerText.trim().slice(0,400)}))`)
    const before = await bubbles()
    const since = Date.now()
    await traceExceptions()
    await ev(`document.querySelector(${JSON.stringify(composer)}).focus()`)
    await rpc('Input.insertText', { text: message })
    await delay(300)
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await delay(4000)
    await shot('09-chat-sent')
    note('bubbles shortly after send', await bubbles())
    let replied = true
    await wait(async () => (await bubbles()).filter(b => !b.sent).length > before.filter(b => !b.sent).length, 'a reply bubble', Number(process.env.REPLY_TIMEOUT_MS ?? 180000)).catch(() => (replied = false))
    await delay(3000)
    const after = await bubbles()
    await shot('10-chat-after-wait')
    note('bubbles at the end', after)
    note('page text at the end', (await ev('document.querySelector(".q-page-container")?.innerText ?? ""')).slice(0, 1200))
    note('requests to relay/bot fronts during chat', stackRequests(since).filter(r => !/topics|chain-rpc\/.*\/cap\//.test(r.url)))
    report.replied = replied
    report.replyCount = after.filter(b => !b.sent).length - before.filter(b => !b.sent).length
    if (!replied) throw Error('no reply bubble appeared')
  },
  // Blackjack against the installed dealer. `plan` is a comma list, one entry per hand:
  //   basic (hit below 17, else stand) | stand | double (double if offered, else basic)
  // or one hostile case: spam (Enter-spam and double-click on Bet), limits (below/above the table).
  // Other options: BJ_BET (MON, default 0.1), BJ_PAUSE_AFTER_BET=<file> (after the bet message is
  // accepted, create <file>.waiting and wait until <file> exists before watching for the deal).
  async blackjack(plan = 'basic,double,basic') {
    await launch()
    await resume()
    const dealer = await openPeerChat()
    const chain = async (method, params) => (await (await fetch('http://127.0.0.1:18546', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
    const mon = async address => Number(BigInt(await chain('eth_getBalance', [address, 'latest']))) / 1e18
    const player = fs.readFileSync(path.join(STATE, 'operator', 'ui-wallet-address.txt'), 'utf8').trim()
    const bankroll = JSON.parse(fs.readFileSync(path.join(STATE, 'bot', 'bankroll.json'), 'utf8')).address
    const balances = async () => ({ player: await mon(player), bankroll: await mon(bankroll), dealer: await mon(dealer) })
    const moves = () => ev(`[...document.querySelectorAll('.blackjack-move')].map(e=>e.innerText.trim().replace(/\\s*\\n\\s*/g,' | ').slice(0,500))`)
    const last = () => ev(`(()=>{const all=[...document.querySelectorAll('.blackjack-move')];const e=all[all.length-1];if(!e)return null;return {count:all.length,text:e.innerText.trim().replace(/\\s*\\n\\s*/g,' | '),buttons:[...e.querySelectorAll('button')].filter(b=>!b.closest('.blackjack-bet-control')).map(b=>({label:b.innerText.trim(),disabled:b.disabled})),bet:!!e.querySelector('.blackjack-bet-control')}})()`)
    // Where a hand is started: the composer's message-type menu (default, works in any chat), or
    // BJ_VIA=inline for the bet box inside the newest dealer bubble.
    const viaMenu = process.env.BJ_VIA !== 'inline'
    const betForm = viaMenu ? `document.querySelector('[data-testid=blackjack-dialog] .blackjack-bet-control')` : `(()=>{const all=[...document.querySelectorAll('.blackjack-bet-control')];return all[all.length-1]})()`
    const openBet = async () => {
      if (!viaMenu || (await has('[data-testid=blackjack-dialog]'))) return
      await click('.q-footer button[aria-haspopup=menu]')
      await wait(() => has('[data-testid=blackjack-menu-item]'), 'the message-type menu')
      await shot('20a-blackjack-menu')
      await click('[data-testid=blackjack-menu-item]')
      await wait(() => has('[data-testid=blackjack-dialog] .blackjack-bet-control'), 'the bet dialog')
      await delay(400)
    }
    const betState = () => ev(`(()=>{const f=${betForm};if(!f)return null;return {amount:f.querySelector('input[type=text]').value,hint:f.querySelector('.q-field__bottom')?.innerText.trim()??'',status:f.querySelector('[data-testid=blackjack-bet-status]').innerText.trim(),submit:f.querySelector('[data-testid=blackjack-bet-submit]').innerText.trim(),submitDisabled:f.querySelector('[data-testid=blackjack-bet-submit]').disabled,confirmDisabled:f.querySelector('[data-testid=blackjack-bet-confirm]').getAttribute('aria-disabled')}})()`)
    const typeBet = async amount => {
      await ev(`(()=>{const i=${betForm}.querySelector('input[type=text]');i.focus();i.select()})()`)
      await rpc('Input.insertText', { text: amount })
      await delay(300)
    }
    const tick = () => ev(`(()=>{const c=${betForm}.querySelector('[data-testid=blackjack-bet-confirm]');if(c.getAttribute('aria-checked')!=='true')c.click()})()`)
    const wagerTransfers = async sinceBlock => {
      // Count on chain: transfers from the player's account to the dealer since `sinceBlock`.
      const head = Number(await chain('eth_blockNumber', []))
      let n = 0
      for (let b = sinceBlock + 1; b <= head; b++) for (const tx of (await chain('eth_getBlockByNumber', ['0x' + b.toString(16), true])).transactions) if (tx.from.toLowerCase() === player.toLowerCase() && (tx.to ?? '').toLowerCase() === dealer.toLowerCase()) n++
      return n
    }
    // A fresh chat shows the dealer's welcome; a longer one shows its newest bubbles.
    await wait(() => has('.blackjack-move'), 'dealer welcome or an earlier hand', 90000)
    await delay(1500)
    await shot('20-blackjack-welcome')
    note('dealer welcome', { moves: await moves(), betBoxShown: await has('.blackjack-bet-control'), contact: await text('.q-header') })
    note('inline bet box in the newest bubble', await has('.blackjack-move .blackjack-bet-control'))
    await openBet()
    await shot('20b-blackjack-bet-dialog')
    note('bet control', { via: viaMenu ? 'composer menu' : 'inline', ...(await betState()) })
    report.hands = []
    let n = 0
    for (const step of plan.split(',')) {
      n++
      const before = await balances()
      const block = Number(await chain('eth_blockNumber', []))
      const movesBefore = (await moves()).length
      await openBet()
      if (step === 'limits') {
        const results = {}
        for (const amount of ['0.001', '5', '0', '-1', 'abc']) {
          await typeBet(amount)
          results[amount] = await betState()
        }
        await shot(`2${n}-blackjack-limits`)
        await delay(2500)
        note('bets outside the table limits', { results, transfers: await wagerTransfers(block), balancesUnchanged: JSON.stringify(await balances()) === JSON.stringify(before) })
        await typeBet(process.env.BJ_BET ?? '0.1')
        continue
      }
      await typeBet(process.env.BJ_BET ?? '0.1')
      await tick()
      await delay(300)
      const ready = await betState()
      if (ready.submitDisabled) throw Error('bet cannot be submitted: ' + JSON.stringify(ready))
      if (step === 'spam') {
        // Double-click the button, then hammer Enter in the amount field.
        const box = await ev(`(()=>{const r=${betForm}.querySelector('[data-testid=blackjack-bet-submit]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        for (const type of ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mousePressed' ? 1 : 1 })
        await ev(`(()=>{const f=${betForm};const i=f?.querySelector('input[type=text]');i&&i.focus()})()`).catch(() => {})
        for (let i = 0; i < 8; i++) {
          await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
          await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
          await delay(40)
        }
      } else await ev(`${betForm}.querySelector('[data-testid=blackjack-bet-submit]').click()`)
      const hand = { n, step, before, actions: [] }
      report.hands.push(hand)
      // The chat renders a bounded window of bubbles, so watch the newest one, not the count.
      await wait(async () => /^Your (bet|hand):/.test((await last())?.text ?? ''), 'the bet message bubble', 60000)
      await delay(1500)
      await shot(`2${n}a-blackjack-bet`)
      if (process.env.BJ_PAUSE_AFTER_BET) {
        // Let the bet reach the relay, then hand control to whoever is breaking things.
        await wait(async () => (await wagerTransfers(block)) >= 1, 'the wager transfer on chain', 60000)
        await delay(Number(process.env.BJ_PAUSE_SETTLE_MS ?? 0))
        fs.writeFileSync(process.env.BJ_PAUSE_AFTER_BET + '.waiting', '')
        note('paused after the bet; waiting for ' + process.env.BJ_PAUSE_AFTER_BET, await last())
        await wait(() => fs.existsSync(process.env.BJ_PAUSE_AFTER_BET), 'resume file', 600000)
        fs.rmSync(process.env.BJ_PAUSE_AFTER_BET)
      }
      // Play until the hand resolves.
      const resolved = s => /Dealer's hand:/.test(s?.text ?? '')
      let guard = 0, doubled = false
      for (;;) {
        await wait(async () => { const s = await last(); return resolved(s) || s?.buttons.some(b => !b.disabled) }, 'the deal or the next card', Number(process.env.BJ_TIMEOUT_MS ?? 120000))
        const s = await last()
        if (resolved(s)) break
        if (++guard > 12) throw Error('hand did not resolve')
        const total = Number(/Your hand:[^(]*\((\d+)/.exec(s.text)?.[1] ?? 0)
        const dealerLow = /Dealer shows: [2-6][^0-9]/.test(s.text)
        const offered = s.buttons.filter(b => !b.disabled).map(b => b.label.toLowerCase())
        const want = step === 'hit2' && hand.actions.length === 0 && total <= 11 ? 'hit' : step === 'double' && !doubled && offered.some(l => l.startsWith('double')) ? 'double' : step === 'stand' || total >= 17 || (total >= 12 && dealerLow) ? 'stand' : 'hit'
        const label = offered.find(l => l.startsWith(want)) ?? offered.find(l => l.startsWith('stand'))
        if (!label) throw Error('no usable action among ' + JSON.stringify(s.buttons))
        if (want === 'double') doubled = true
        hand.actions.push({ state: s.text.slice(0, 160), offered, chose: label })
        await shot(`2${n}b-blackjack-dealt-${hand.actions.length}`)
        const cards = t => /Your hand:[^|]*/.exec(t?.text ?? '')?.[0]
        const clickAction = wanted => ev(`(()=>{const all=[...document.querySelectorAll('.blackjack-move')];const b=[...all[all.length-1].querySelectorAll('button')].find(b=>!b.closest('.blackjack-bet-control')&&!b.disabled&&b.innerText.trim().toLowerCase()===${JSON.stringify(wanted)});if(!b)return false;b.click();return true})()`)
        await clickAction(label)
        if (step === 'hit2' && want === 'hit' && hand.actions.length === 1) {
          // Hostile: a second click on Hit before the dealer has answered the first.
          const tries = []
          for (const ms of [150, 1500, 3000]) {
            await delay(ms)
            const now = await last()
            if (resolved(now) || cards(now) !== cards(s)) break
            tries.push({ afterMs: ms, buttons: now.buttons, clicked: await clickAction(label) })
          }
          hand.secondHitAttempts = tries
        }
        await wait(async () => { const t = await last(); return resolved(t) || (want === 'hit' && cards(t) !== cards(s)) }, 'the dealer to answer the move', Number(process.env.BJ_TIMEOUT_MS ?? 120000))
        await delay(500)
      }
      await delay(4000) // payout confirmation
      const end = await last()
      await ev(`(()=>{const all=[...document.querySelectorAll('.blackjack-move')];all[all.length-1].scrollIntoView({block:'center'})})()`)
      await delay(300)
      await shot(`2${n}c-blackjack-resolved`)
      const after = await balances()
      Object.assign(hand, { result: end.text.slice(0, 420), after, wagerTransfers: await wagerTransfers(block), playerDelta: +(after.player - before.player).toFixed(6), bankrollDelta: +(after.bankroll - before.bankroll).toFixed(6), dealerDelta: +(after.dealer - before.dealer).toFixed(6), fair: /Verified fair/.test(end.text) ? 'verified fair' : /Verification failed/.test(end.text) ? 'FAILED' : 'not shown' })
      note(`hand ${n} (${step})`, hand)
    }
    note('all blackjack bubbles', await moves())
  },
}

;(async () => {
  let failed = false
  try {
    if (!phases[phase]) throw Error('usage: drive.cjs ' + Object.keys(phases).join('|'))
    await phases[phase](...rest)
  } catch (e) {
    failed = true
    report.failure = String((e && e.stack) || e).slice(0, 2000)
    console.error('FAILURE', report.failure)
    if (socket?.readyState === 1 && !secretPhase) {
      await shot('failure-' + phase).catch(() => {})
      report.failureRoute = await ev('location.hash').catch(() => '?')
      report.failureText = await ev('document.body.innerText.slice(0, 1500)').catch(() => '?')
    }
  } finally {
    await close().catch(e => console.error('close failed', String(e)))
    report.console = consoleLines.slice(-200)
    if (caught.length) report.caughtExceptions = caught.slice(-100)
    report.network = stackRequests(0)
    const out = path.join(STATE, 'logs', process.env.DRIVE_REPORT || `drive-${phase}.json`)
    fs.writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ PASS: !failed, report: out, chromeExit: report.chromeExit, chromeProcessesLeft: report.chromeProcessesLeft }))
    process.exit(failed ? 1 : 0)
  }
})()
