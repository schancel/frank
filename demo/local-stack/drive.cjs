#!/usr/bin/env node
// Real-Chrome driver for the local stack (demo/local-stack/stack.mjs must be "up").
//
//   node demo/local-stack/drive.cjs <profile> <step> [arguments]
//
//   onboard [a|b]                    fresh profile: create a disposable account through normal
//                                    onboarding on the app for relay-a (default) or relay-b; check that
//                                    messaging is on with no further step and the relay holds the entry
//   send <address> "<text>"          add the contact by address if needed, send one message
//   expect <address> "<text>"        open that chat and wait for a received message containing the text
//   ask <address> "<text>"           send, then wait for one reply
//   refused <address>                Add Contact with an address that cannot be messaged: nothing is paid
//   challenge <address> <dealer|player> <maxBet>   blackjack challenge from the composer's menu
//   play <address> <bot|turn>        press the blackjack buttons this account is offered. "bot": until
//                                    the hand is resolved. "turn": until it is the other person's turn.
//
// Options (environment): SPAM=1 (send/challenge/play: hammer Enter and double-click the paying
// control), BET=<amount> (play: the bet; default the form's suggestion), MOVES=<hit|stand|double,...>
// (play: the player's moves in order; default stand at 17 or more, else hit), HEADFUL=1,
// REPLY_TIMEOUT_MS, LABEL=<prefix for screenshots and the report file>.
//
// One Chrome at a time; each profile is a separate throwaway directory under the stack state, trusted
// only for the stack's own certificates. Backup shares exist only in this process's memory during
// onboarding and are never logged or captured; screenshots are taken only outside that phase.
// Evidence: <state>/shots and <state>/logs/drive-*.json.
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict')
const { spawn, execFileSync } = require('child_process')
const repo = path.resolve(__dirname, '..', '..')
const { ownedProcesses } = require(path.join(repo, 'packages/frank-codec/browsercheck/check-chrome.js'))

const STATE = process.env.FRANK_STACK_DIR || '/private/tmp/frank-stack/open'
const APPS = { a: 'https://127.0.0.1:18440', b: 'https://127.0.0.1:18441' }
const RELAY_PORTS = { a: 18098, b: 18099 }
const CHAIN = 'http://127.0.0.1:18546'
const STAMP_MON = 0.01
const [profileName, phase, ...rest] = process.argv.slice(2)
const profile = path.join(STATE, 'chrome-profiles', profileName || 'driven')
const shots = path.join(STATE, 'shots')
const accountFile = name => path.join(STATE, 'run', 'accounts', `${name}.json`)
// Every run's evidence has its own time in the name, so a later run never replaces an earlier one.
const runAt = new Date().toISOString().replace(/[:.]/g, '').slice(11, 17)
const label = (process.env.LABEL ? process.env.LABEL + '-' : '') + `${runAt}-${profileName}-${phase}`
const delay = ms => new Promise(r => setTimeout(r, ms))

let child, owner, socket, exit, session, seq = 0, secretPhase = false, APP
const pending = new Map()
const net = new Map() // requestId -> record
const consoleLines = []
const report = { profile: profileName, phase, args: rest, started: new Date().toISOString(), steps: [] }
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
const wait = async (fn, what, ms = 45000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await delay(150)
  }
  throw Error('timeout ' + what)
}
const has = sel => ev(`!!document.querySelector(${JSON.stringify(sel)})`)
const text = sel => ev(`(document.querySelector(${JSON.stringify(sel)})?.innerText ?? '').trim()`)
const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('missing '+${JSON.stringify(sel)});e.click()})()`)
const input = (sel, value) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
const shot = async name => {
  if (secretPhase) return
  const file = path.join(shots, `${label}-${name}.png`)
  fs.writeFileSync(file, Buffer.from((await rpc('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  console.log('   shot ' + file)
}
const key = async (name, code) => {
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code })
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code })
}
const centre = expression => ev(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
/** A real double click at an element's centre: two presses within the double-click interval. */
const doubleClick = async expression => {
  await ev(`(${expression}).scrollIntoView({block:'center'})`)
  await delay(400)
  const at = await centre(expression)
  const hit = await ev(`(()=>{const e=${expression};const t=document.elementFromPoint(${'${at.x}'},${'${at.y}'});return !!t&&(e===t||e.contains(t))})()`.replace('${at.x}', at.x).replace('${at.y}', at.y))
  if (!hit) throw Error('the control to double-click is covered or off screen')
  for (const [type, clickCount] of [['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2]]) await rpc('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount })
}

// ------------------------------------------------------------------ chain (public data only)
const chain = async (method, params = []) => (await (await fetch(CHAIN, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
const head = async () => Number(await chain('eth_blockNumber'))
const mon = wei => Number(BigInt(wei)) / 1e18
const balance = async address => mon(await chain('eth_getBalance', [address, 'latest']))
/** Every value transfer in blocks (from, to]. */
async function transfers(fromBlock, toBlock) {
  const out = []
  for (let b = fromBlock + 1; b <= toBlock; b++) for (const tx of (await chain('eth_getBlockByNumber', ['0x' + b.toString(16), true])).transactions) out.push({ block: b, from: tx.from.toLowerCase(), to: (tx.to ?? '').toLowerCase(), mon: mon(tx.value), hash: tx.hash })
  return out
}
/**
 * What the accounts this stack knows paid since `fromBlock`. A stamp is paid from single-use
 * accounts that the owner's main account funded first, so ownership is read from the chain: an
 * address a known main account sent money to belongs to that owner. `stamps` are the payments
 * those single-use accounts made to anyone else.
 */
async function ledger(fromBlock) {
  const known = {}
  const dir = path.join(STATE, 'run', 'accounts')
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) known[JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).fund.toLowerCase()] = file.replace(/\.json$/, '')
  const bots = path.join(STATE, 'run', 'bot-accounts.json')
  if (fs.existsSync(bots)) for (const [kind, bot] of Object.entries(JSON.parse(fs.readFileSync(bots, 'utf8')))) known[bot.fund.toLowerCase()] = kind + '-bot'
  const all = await transfers(0, await head())
  const ownerOf = { ...known }
  for (const t of all) if (known[t.from] && !ownerOf[t.to] && t.mon > 0) ownerOf[t.to] = known[t.from]
  const stamps = {}
  for (const t of all) {
    if (t.block <= fromBlock || known[t.from] || !ownerOf[t.from] || ownerOf[t.to] === ownerOf[t.from] || t.mon === 0) continue
    ;(stamps[ownerOf[t.from]] ??= []).push(+t.mon.toFixed(6))
  }
  const sum = Object.fromEntries(Object.entries(stamps).map(([who, values]) => [who, +values.reduce((a, b) => a + b, 0).toFixed(6)]))
  return { sinceBlock: fromBlock, head: await head(), stamps, paidInStamps: sum }
}
const me = () => JSON.parse(fs.readFileSync(accountFile(profileName), 'utf8'))

// ------------------------------------------------------------------ Chrome
async function launch() {
  fs.mkdirSync(shots, { recursive: true })
  const flags = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'stack.mjs'), 'chrome-args', profileName]).toString())
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
    if (m.method === 'Network.responseReceived' && net.has(q.requestId)) Object.assign(net.get(q.requestId), { status: q.response.status })
    if (m.method === 'Network.loadingFailed' && net.has(q.requestId)) Object.assign(net.get(q.requestId), { failed: q.errorText, cors: q.corsErrorStatus?.corsError ?? null, blocked: q.blockedReason ?? null })
    if (m.method === 'Runtime.consoleAPICalled' && !secretPhase) consoleLines.push({ t: Date.now(), level: q.type, text: q.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) })
    if (m.method === 'Runtime.exceptionThrown' && !secretPhase) consoleLines.push({ t: Date.now(), level: 'exception', text: String(q.exceptionDetails.exception?.description || q.exceptionDetails.text).slice(0, 500) })
    if (m.method === 'Log.entryAdded' && !secretPhase) consoleLines.push({ t: Date.now(), level: 'log:' + q.entry.level, text: (q.entry.text + ' ' + (q.entry.url ?? '')).slice(0, 500) })
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
/** Requests the page made to the relays, without capability tokens. */
const relayRequests = since =>
  [...net.values()]
    .filter(r => r.t >= since && /^https:\/\/127\.0\.0\.1:1844[34]\//.test(r.url) && !/\/chain-rpc\//.test(r.url))
    .map(r => ({ method: r.method, url: r.url, status: r.status ?? null, failed: r.failed ?? null, cors: r.cors ?? null }))

// ------------------------------------------------------------------ the app
const banner = () => text('[data-testid=mailbox-status]')
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
  await input('[data-test=display-name] input, input[data-test=display-name]', profileName)
  await click('[data-test=verify-backups]')
  await wait(() => has('[data-test=activate-account]'), 'pending activation')
  await click('[data-test=activate-account]')
  await wait(() => has('#rail-tab-wallet'), 'authenticated app')
  secretPhase = false
  note('disposable account created through normal onboarding')
}
async function resume() {
  APP = APPS[me().app]
  await rpc('Page.navigate', { url: APP + '/' })
  await wait(async () => (await has('#rail-tab-wallet')) || (await has('[data-test=new-account]')), 'app start')
  if (!(await has('#rail-tab-wallet'))) throw Error(`profile "${profileName}" has no signed-in account; run "onboard" first`)
  await delay(1500)
}
const fieldBeside = testid => ev(`(()=>{const b=document.querySelector('[data-testid=${testid}]');const f=b?.closest('.q-field');return (f?.querySelector('textarea,input')?.value ?? '').trim()})()`)
async function addresses() {
  await ev('location.hash = "#/wallet"')
  await wait(async () => /^0x[0-9a-fA-F]{40}$/.test(await fieldBeside('wallet-copy-address')), 'wallet address')
  const address = await fieldBeside('wallet-copy-address')
  await shot('wallet')
  await ev('location.hash = "#/receive"')
  await wait(async () => /^0x[0-9a-fA-F]{40}$/.test(await fieldBeside('receive-copy-address')), 'receive address')
  return { address, fund: await fieldBeside('receive-copy-address') }
}
const composer = '.q-footer textarea'
const inChat = async address => (await ev('location.hash')).toLowerCase().includes('/chat/' + address.toLowerCase()) && (await has(composer))
/** Opens the chat with `address`: from the contact list when it is a contact, else through Add Contact. */
async function openChat(address) {
  const book = await ev(`Object.keys(document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value.contacts.contacts).map(a => a.toLowerCase())`)
  if (book.includes(address.toLowerCase())) {
    await ev(`location.hash = ${JSON.stringify('#/chat/' + address)}`)
    await wait(() => inChat(address), 'the chat to open')
    await delay(1500)
    return 'contact'
  }
  await ev('location.hash = "#/add-contact"')
  await wait(() => has('.q-card input'), 'Add Contact page')
  await ev('document.querySelector(".q-card input").focus()')
  await rpc('Input.insertText', { text: address })
  const add = `[...document.querySelectorAll('.q-card__actions button')].find(b => b.innerText.trim().toLowerCase() === 'add')`
  await wait(async () => (await ev(`(()=>{const b=${add};return !!b && !b.disabled})()`)) || (await has('[data-test=contact-lookup-reason]')) || /not found|no account/i.test(await text('.q-card')), 'the address lookup to finish', 30000)
  await delay(400)
  await shot('add-contact')
  if (!(await ev(`(()=>{const b=${add};return !!b && !b.disabled})()`))) return { refused: (await text('[data-test=contact-lookup-reason]')) || (await text('.q-card')).replace(/\s*\n\s*/g, ' | ') }
  await ev(`${add}.click()`)
  await wait(() => inChat(address), 'the chat to open after Add', 20000).catch(async () => {
    await ev(`location.hash = ${JSON.stringify('#/chat/' + address)}`)
    await wait(() => inChat(address), 'the chat to open')
  })
  await delay(800)
  return 'added'
}
const bubbles = () => ev(`[...document.querySelectorAll('.q-message')].map(e=>({sent:e.classList.contains('q-message-sent'),sending:!!e.querySelector('[data-testid=outgoing-sending]'),failed:!!e.querySelector('[data-testid=outgoing-failed]'),paymentPending:!!e.querySelector('[data-testid=outgoing-payment-pending]'),text:(e.querySelector('[data-testid=chat-message-body]')?.innerText ?? e.innerText).trim().replace(/\\s*\\n\\s*/g,' | ').slice(0,400)}))`)
async function typeAndSend(message, spam) {
  await ev(`document.querySelector(${JSON.stringify(composer)}).focus()`)
  await rpc('Input.insertText', { text: message })
  await delay(300)
  if (!spam) return key('Enter', 13)
  // Hostile: a double click on Send, then Enter eight times.
  await doubleClick(`document.querySelector('.q-footer button[aria-label="Send message"]')`)
  await ev(`document.querySelector(${JSON.stringify(composer)}).focus()`)
  for (let i = 0; i < 8; i++) {
    await key('Enter', 13)
    await delay(40)
  }
}
/** Waits until the newest sent bubble with `message` is neither sending nor failed. */
async function sentAndSettled(message, ms = 90000) {
  const mine = async () => (await bubbles()).filter(b => b.sent && b.text.includes(message))
  await wait(async () => (await mine()).length > 0, 'the sent bubble', 30000)
  await wait(async () => (await mine()).every(b => !b.sending && !b.paymentPending) || (await mine()).some(b => b.failed), 'the message to be accepted', ms)
  const result = await mine()
  if (result.some(b => b.failed)) throw Error('the message failed: ' + JSON.stringify(result))
  return result
}

// ------------------------------------------------------------------ blackjack
/** The newest blackjack bubble that shows a hand: its lines, status and the buttons offered. */
const hand = () =>
  ev(`(()=>{const all=[...document.querySelectorAll('.blackjack-hand')];const live=all.filter(e=>e.querySelector('[data-testid=blackjack-status]'));const e=live[live.length-1];if(!e)return {bubbles:all.length};
    const q=t=>e.querySelector('[data-testid='+t+']')?.innerText.trim()??null;
    return {bubbles:all.length,line:q('blackjack-line'),text:e.innerText.trim().replace(/\\s*\\n\\s*/g,' | ').slice(0,500),status:q('blackjack-status'),problem:q('blackjack-problem'),outcome:q('blackjack-outcome'),payout:q('blackjack-payout'),refunded:q('blackjack-refunded'),amountError:q('blackjack-amount-error'),
      amount:e.querySelector('[data-testid=blackjack-bet-amount],[data-testid=blackjack-accept-max]')?.value??null,
      buttons:[...e.querySelectorAll('button[data-testid]')].map(b=>({id:b.getAttribute('data-testid').replace('blackjack-',''),label:b.innerText.trim(),disabled:b.disabled}))}})()`)
const handButton = id => `(()=>{const live=[...document.querySelectorAll('.blackjack-hand')].filter(e=>e.querySelector('[data-testid=blackjack-status]'));return live[live.length-1].querySelector('[data-testid=blackjack-${id}]')})()`
const WAITING = ['Waiting for the other side to accept.', 'Waiting for the bet.', 'Waiting for the dealer.', "Waiting for the player's move.", 'Waiting for the dealer to reveal and pay.']

const phases = {
  async onboard(app = 'a') {
    if (!APPS[app]) throw Error('usage: onboard [a|b]')
    if (fs.existsSync(profile)) throw Error(`${profile} already exists; "onboard" starts from a fresh profile`)
    APP = APPS[app]
    const since = Date.now()
    await launch()
    await onboard()
    // No Settings step: the account publishes its own entry and messaging turns on by itself.
    const found = await addresses()
    const relay = `http://127.0.0.1:${RELAY_PORTS[app]}/directory/v1/monad-testnet/address/${found.address}`
    let status
    await wait(async () => (status = (await fetch(relay)).status) === 200, 'the relay to hold this account\'s entry', 60000).catch(() => {})
    const entry = await fetch(relay)
    note('the relay holds the entry this account published itself', { url: relay, status: entry.status, subject: entry.headers.get('x-frank-directory-subject'), evidence: entry.headers.get('x-frank-directory-evidence'), bytes: (await entry.arrayBuffer()).byteLength })
    assert.equal(status, 200, 'the account did not publish its directory entry')
    fs.mkdirSync(path.dirname(accountFile(profileName)), { recursive: true })
    fs.writeFileSync(accountFile(profileName), JSON.stringify({ ...found, app }, null, 2))
    note('account addresses (public)', { messageAt: found.address, fundAt: found.fund, app: APP })
    await click('#rail-tab-contacts')
    await delay(2500)
    // The relay's default contacts are in the contact book (Ctrl/Cmd+K); the sidebar lists chats.
    const book = await ev(`Object.keys(document.querySelector('#q-app').__vue_app__.config.globalProperties.$pinia.state.value.contacts.contacts).map(a => a.toLowerCase())`)
    const bots = fs.existsSync(path.join(STATE, 'run', 'bot-accounts.json')) ? JSON.parse(fs.readFileSync(path.join(STATE, 'run', 'bot-accounts.json'), 'utf8')) : {}
    note('messaging state right after onboarding', { banner: (await banner()) || '(none: messaging is on)', visitedSettings: [...net.values()].some(r => /#\/settings/.test(r.url)), contactBook: book, botsInContactBook: Object.fromEntries(Object.entries(bots).map(([kind, bot]) => [kind, book.includes(bot.address.toLowerCase())])) })
    await shot('02-home')
    note('requests to the relays during onboarding', relayRequests(since).filter(r => /directory|relay\/v1|curated/.test(r.url)))
    assert.equal(await banner(), '', 'messaging is not on after onboarding')
  },
  /** Debugging aid: open a route and print the page text (and the value of an expression). */
  async look(route = '#/', expression) {
    await launch()
    await resume()
    await ev(`location.hash = ${JSON.stringify(route)}`)
    await delay(Number(process.env.LOOK_MS ?? 3000))
    await shot('look')
    note('page text', (await ev('document.body.innerText')).replace(/\s*\n\s*/g, ' | ').slice(0, 2000))
    if (expression) note('expression', await ev(expression))
  },
  async send(address, message) {
    await launch()
    await resume()
    const opened = await openChat(address)
    if (opened.refused) throw Error('cannot message that address: ' + opened.refused)
    const block = await head(),
      before = await balance(me().fund)
    await typeAndSend(message, !!process.env.SPAM)
    const result = await sentAndSettled(message)
    await delay(3000)
    await shot('sent')
    const paid = await ledger(block)
    note('message sent', { contact: opened, bubbles: result.length, spam: !!process.env.SPAM, accountBefore: before, accountAfter: await balance(me().fund), ...paid })
    report.sentBubbles = result.length
    report.stampsPaid = paid.stamps[profileName] ?? []
    if (result.length !== 1) throw Error(`expected one sent bubble, saw ${result.length}`)
    if (Math.abs((paid.paidInStamps[profileName] ?? 0) - STAMP_MON) > 1e-9) throw Error('expected exactly one stamp of ' + STAMP_MON + ' MON, the chain shows ' + JSON.stringify(paid.stamps[profileName] ?? []))
  },
  async expect(address, message) {
    await launch()
    await resume()
    const opened = await openChat(address)
    if (opened.refused) throw Error('cannot open that chat: ' + opened.refused)
    await wait(async () => (await bubbles()).some(b => !b.sent && b.text.includes(message)), 'the message from ' + address, 60000)
    await shot('received')
    const got = (await bubbles()).filter(b => !b.sent && b.text.includes(message))
    note('message received', { contact: opened, copies: got.length, text: got[0].text })
    if (got.length !== 1) throw Error(`expected the message once, saw it ${got.length} times`)
  },
  async ask(address, message) {
    await launch()
    await resume()
    const opened = await openChat(address)
    if (opened.refused) throw Error('cannot message that address: ' + opened.refused)
    const before = (await bubbles()).filter(b => !b.sent).length
    const block = await head()
    await typeAndSend(message, !!process.env.SPAM)
    await sentAndSettled(message)
    await shot('asked')
    await wait(async () => (await bubbles()).filter(b => !b.sent).length > before, 'a reply', Number(process.env.REPLY_TIMEOUT_MS ?? 180000))
    await delay(6000)
    const after = await bubbles()
    await shot('answered')
    const replies = after.filter(b => !b.sent).slice(before)
    note('reply received', { contact: opened, replies: replies.map(b => b.text), ...(await ledger(block)) })
    if (replies.length !== 1) throw Error(`expected one reply, saw ${replies.length}`)
  },
  async refused(address) {
    await launch()
    await resume()
    const block = await head(),
      before = await balance(me().fund)
    const opened = await openChat(address)
    await delay(2500)
    const paid = await ledger(block)
    note('address that cannot be messaged', { result: opened, accountBefore: before, accountAfter: await balance(me().fund), transfersSince: (await transfers(block, await head())).length, ...paid })
    if (!opened.refused) throw Error('the address was accepted as a contact')
    if ((await balance(me().fund)) !== before) throw Error('money moved')
  },
  async challenge(address, role, maxBet) {
    if (role !== 'dealer' && role !== 'player') throw Error('usage: challenge <address> <dealer|player> <maxBet>')
    await launch()
    await resume()
    const opened = await openChat(address)
    if (opened.refused) throw Error('cannot message that address: ' + opened.refused)
    const block = await head(),
      spendable = await balance(me().fund)
    const count = (await hand()).bubbles
    // The composer's existing message-type menu.
    await click('.q-footer button[aria-haspopup=menu]')
    await wait(() => has('[data-testid=blackjack-menu-item]'), 'the message-type menu')
    await shot('menu')
    await click('[data-testid=blackjack-menu-item]')
    await wait(() => has('[data-testid=blackjack-challenge-form]'), 'the challenge form')
    const form = () => ev(`(()=>{const f=document.querySelector('[data-testid=blackjack-challenge-form]');return {limit:f.querySelector('[data-testid=blackjack-challenge-limit]').innerText.trim(),error:f.querySelector('[data-testid=blackjack-challenge-error]')?.innerText.trim()??'',sendDisabled:f.querySelector('[data-testid=blackjack-challenge-send]').disabled}})()`)
    const pick = which => ev(`(()=>{const f=document.querySelector('[data-testid=blackjack-challenge-form]');f.querySelectorAll('.q-radio')[${which === 'dealer' ? 0 : 1}].click()})()`)
    const typeMax = async amount => {
      await ev(`(()=>{const i=document.querySelector('[data-testid=blackjack-challenge-max]');i.focus();i.select()})()`)
      await rpc('Input.insertText', { text: amount })
      await delay(300)
    }
    await wait(async () => !/…/.test((await form()).limit), 'the balance to load', 30000)
    // What each role may offer, and that an amount above it cannot be sent.
    const limits = {}
    for (const which of ['dealer', 'player']) {
      await pick(which)
      await delay(200)
      await typeMax('1000')
      limits[which] = await form()
    }
    await pick(role)
    await typeMax(maxBet)
    await delay(200)
    await shot('form')
    const ready = await form()
    note('challenge form', { role, maxBet, spendableOnChain: spendable, dealerLimit: limits.dealer, playerLimit: limits.player, ready })
    if (!limits.dealer.sendDisabled || !limits.player.sendDisabled) throw Error('an amount above the limit could be sent')
    if (ready.sendDisabled) throw Error('the challenge cannot be sent: ' + ready.error)
    if (process.env.SPAM) {
      await doubleClick(`document.querySelector('[data-testid=blackjack-challenge-send]')`)
      for (let i = 0; i < 8; i++) {
        await key('Enter', 13)
        await delay(40)
      }
    } else await click('[data-testid=blackjack-challenge-send]')
    await wait(async () => (await hand()).bubbles > count, 'the challenge bubble', 60000)
    await wait(async () => (await bubbles()).every(b => !b.sending), 'the challenge to be accepted', 90000)
    await delay(3000)
    await shot('sent')
    const paid = await ledger(block)
    note('challenge sent', { hand: await hand(), newBubbles: (await hand()).bubbles - count, ...paid })
    if ((await hand()).bubbles - count !== 1) throw Error('more than one challenge was sent')
    if (Math.abs((paid.paidInStamps[profileName] ?? 0) - STAMP_MON) > 1e-9) throw Error('expected exactly one ordinary stamp, the chain shows ' + JSON.stringify(paid.stamps[profileName] ?? []))
    fs.rmSync(path.join(STATE, 'run', 'hand-resolved'), { force: true })
  },
  async play(address, mode = 'bot') {
    if (mode !== 'bot' && mode !== 'turn') throw Error('usage: play <address> <bot|turn>')
    await launch()
    await resume()
    const opened = await openChat(address)
    if (opened.refused) throw Error('cannot open that chat: ' + opened.refused)
    const block = Number(process.env.SINCE_BLOCK ?? (await head()))
    const moves = (process.env.MOVES ?? '').split(',').filter(Boolean)
    const actions = []
    await wait(async () => (await hand()).line, 'a blackjack hand in this chat', Number(process.env.HAND_TIMEOUT_MS ?? 120000))
    // The chat renders its newest bubbles last: give a hand that is still open time to appear
    // before taking an earlier, finished one for the current hand.
    await wait(async () => { const s = await hand(); return s.line && !(s.outcome || s.refunded) }, 'an open hand', 15000).catch(() => {})
    await delay(1500)
    await shot('hand')
    let state, quiet = 0, n = 0
    const end = Date.now() + Number(process.env.PLAY_TIMEOUT_MS ?? 300000)
    for (;;) {
      if (Date.now() > end) throw Error('the hand did not get further: ' + JSON.stringify(state))
      state = await hand()
      if (state.outcome || state.refunded) break
      const offered = (state.buttons ?? []).filter(b => !b.disabled).map(b => b.id)
      const sending = (await bubbles()).some(b => b.sending)
      if (!offered.length || sending) {
        // Nothing to press. In "turn" mode stop once the hand plainly waits for the other side.
        quiet = !sending && WAITING.includes(state.status) ? quiet + 1 : 0
        if (mode === 'turn' && quiet >= 8) break
        await delay(500)
        continue
      }
      quiet = 0
      let choice
      if (offered.includes('accept')) choice = 'accept'
      else if (offered.includes('bet')) choice = 'bet'
      else if (offered.includes('pay')) choice = 'pay'
      else if (offered.includes('hit') || offered.includes('stand')) {
        const total = Number(/Player: [^(]*\((\d+)\)/.exec(state.text)?.[1] ?? 0)
        const wanted = moves.shift() ?? (total >= 17 ? 'stand' : 'hit')
        choice = offered.includes(wanted) ? wanted : 'stand'
      } else {
        // Only "return the bet" is offered while the dealer's own step is still being sent.
        await delay(500)
        continue
      }
      if (choice === 'bet' && process.env.BET) {
        await ev(`(()=>{const i=${handButton('bet-amount')};i.focus();i.select()})()`)
        await rpc('Input.insertText', { text: process.env.BET })
        await delay(300)
        state = await hand()
        if (state.buttons.find(b => b.id === 'bet').disabled) throw Error('that bet cannot be placed: ' + state.amountError)
      }
      const paying = ['bet', 'pay', 'double'].includes(choice)
      actions.push({ pressed: choice, label: state.buttons.find(b => b.id === choice).label, amount: state.amount, state: state.text.slice(0, 200), spam: !!process.env.SPAM && paying })
      await shot(`${++n}-before-${choice}`)
      const before = state.bubbles
      if (process.env.SPAM && paying) {
        await doubleClick(handButton(choice))
        for (let i = 0; i < 8; i++) {
          await key('Enter', 13)
          await delay(40)
        }
      } else await ev(`${handButton(choice)}.click()`)
      await wait(async () => (await hand()).bubbles > before, `the "${choice}" message bubble`, 60000)
      await delay(700)
    }
    // A message this account is still sending (a dealer's reveal, say) must be accepted before the
    // window closes; its payment is only then on the chain.
    await wait(async () => (await bubbles()).every(b => !b.sending && !b.paymentPending), 'messages still being sent', 120000)
    await delay(4000)
    state = await hand()
    await ev(`(()=>{const all=[...document.querySelectorAll('.blackjack-hand')];all[all.length-1].scrollIntoView({block:'center'})})()`)
    await delay(300)
    await shot('end')
    const resolved = !!(state.outcome || state.refunded)
    if (resolved) fs.writeFileSync(path.join(STATE, 'run', 'hand-resolved'), '')
    const all = await ev(`[...document.querySelectorAll('.q-message')].filter(e=>e.querySelector('.blackjack-hand')).map(e=>(e.classList.contains('q-message-sent')?'sent: ':'received: ')+e.querySelector('[data-testid=blackjack-line]').innerText.trim())`)
    report.hand = { resolved, actions, final: state, bubbles: all, ...(await ledger(block)) }
    note(resolved ? 'hand resolved' : 'waiting for the other side', report.hand)
    if (mode === 'bot' && !resolved) throw Error('the hand did not resolve')
  },
}

;(async () => {
  let failed = false
  try {
    if (!profileName || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(profileName) || !phases[phase]) throw Error('usage: drive.cjs <profile> ' + Object.keys(phases).join('|') + ' [arguments]')
    await phases[phase](...rest)
  } catch (e) {
    failed = true
    report.failure = String((e && e.stack) || e).slice(0, 2000)
    console.error('FAILURE', report.failure)
    if (socket?.readyState === 1 && !secretPhase) {
      await shot('failure').catch(() => {})
      report.failureRoute = await ev('location.hash').catch(() => '?')
      report.failureText = await ev('document.body.innerText.slice(0, 1500)').catch(() => '?')
    }
  } finally {
    await close().catch(e => console.error('close failed', String(e)))
    report.console = consoleLines.slice(-200)
    report.network = relayRequests(0).filter(r => r.status !== 200 || !/inbox|topics/.test(r.url)).slice(-200)
    fs.mkdirSync(path.join(STATE, 'logs'), { recursive: true })
    const out = path.join(STATE, 'logs', `drive-${label}.json`)
    fs.writeFileSync(out, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ PASS: !failed, report: out, chromeExit: report.chromeExit, chromeProcessesLeft: report.chromeProcessesLeft }))
    process.exit(failed ? 1 : 0)
  }
})()
