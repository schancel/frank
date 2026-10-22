// Build first: yarn --cwd app build:pwa. Blank profile; no account or public network writes.
// node app/src/stores/chats-group-runtime.browser.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/pwa')
const vuePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules/vue/dist/vue.global.prod.js',
)
const requests = []
const { readdir } = await import('node:fs/promises')
const names = await readdir(join(root, 'assets'))
const vendor = names.find(n => n.startsWith('vendor-vue-') && n.endsWith('.js'))
const contacts = names.find(n => n.startsWith('contacts-') && n.endsWith('.js'))
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/groups/')) {
      requests.push({
        method: req.method,
        url: req.url,
        upstream: req.headers['x-group-upstream-relay'],
      })
      res.statusCode = 404
      res.setHeader('Content-Type', 'application/json')
      res.end('{}')
      return
    }
    const bytes =
      req.url === '/fixture-vue.js'
        ? await readFile(vuePath)
        : req.url === '/'
        ? Buffer.from(
            '<script src="/fixture-vue.js"></script><main id="host"></main>',
          )
        : await readFile(join(root, req.url))
    res.setHeader(
      'Content-Type',
      req.url === '/' ? 'text/html' : 'text/javascript',
    )
    res.end(bytes)
  } catch {
    res.statusCode = 404
    res.end()
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const directory = await mkdtemp(join(tmpdir(), 'frank-chat-list-layout-'))
const chrome = spawn(
  process.env.CHAT_LAYOUT_CHROME ??
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
let sequence = 0,
  buffer = ''
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
const timeout = setTimeout(() => chrome.kill('SIGTERM'), 30000)
chrome.once('exit', () => {
  for (const promise of pending.values())
    promise.reject(new Error('Layout browser exited'))
})
try {
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  const evaluate = async expression => {
    const result = await call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    )
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      )
    return result.result.value
  }

  await call('Page.navigate', { url: origin }, sessionId)
  await new Promise(resolve => setTimeout(resolve, 200))
  await evaluate(
    `globalThis.fetch=()=>Promise.reject(new Error('Network disabled by isolated group configuration probe'))`,
  )
  const result = await evaluate(`(async()=>{
    const vendor=await import('/assets/${vendor}');
    const contacts=await import('/assets/${contacts}');
    const createPinia=Object.values(vendor).find(value=>typeof value==='function' && /_s\\s*:\\s*new Map/.test(value.toString()));
    const useChatStore=Object.values(contacts).find(value=>typeof value==='function' && value.$id==='chats');
    if(!createPinia || !useChatStore)throw new Error('Could not find compiled Pinia/chat exports');
    const pinia=createPinia();
    const app=Vue.createApp({render:()=>null});app.use(pinia);
    const store=useChatStore(pinia);
    const home=${JSON.stringify(origin)};
    const removeOld=store.configureGroupHomeRelay(home);
    const configured=store.getGroupHomeRelay();
    const foreign=store.getGroupRelayClient('https://foreign.example');
    const clientReused=foreign===store.getGroupRelayClient('https://foreign.example');
    await foreign.getLatestEpoch('11'.repeat(32)).catch(()=>{});
    const homeAfterForeign=store.getGroupHomeRelay();
    const removeNew=store.configureGroupHomeRelay('https://replacement.example');removeOld();
    const replacement=store.getGroupHomeRelay();
    let finish;const original=store.createGroupConversationOnce;
    store.createGroupConversationOnce=()=>new Promise(resolve=>{finish=resolve});
    const pending=store.createGroupConversation({groupName:'held',memberAddresses:[]});
    await Promise.resolve();
    let duplicateError=null;
    try {await store.createGroupConversation({groupName:'duplicate',memberAddresses:[]})}catch(error){duplicateError=error.message}
    finish({id:'original-operation'});await pending;store.createGroupConversationOnce=original;
    removeNew();let cleanupError=null;try{store.getGroupHomeRelay()}catch(error){cleanupError=error.message}
    app.unmount();
    return {piniaPlugins:pinia._p.length,configured,clientReused,homeAfterForeign,replacement,duplicateError,cleanupError};
  })()`)
  console.log(JSON.stringify({ result, requests }, null, 2))
  assert.equal(result.configured, origin)
  assert.equal(result.clientReused, true)
  assert.equal(result.homeAfterForeign, origin)
  assert.equal(result.replacement, 'https://replacement.example')
  assert.equal(result.duplicateError, 'Group operation already in progress')
  assert.equal(result.cleanupError, 'Group messaging is not configured')
  assert.deepEqual(requests, [
    {
      method: 'GET',
      url: '/groups/' + '11'.repeat(32) + '/epochs',
      upstream: 'https://foreign.example',
    },
  ])
  console.log(
    'PASS: actual compiled production Pinia+chat store home, foreign routing, stale cleanup, and concurrent create exclusion',
  )
} finally {
  clearTimeout(timeout)
  chrome.kill('SIGTERM')
  await new Promise(resolve => server.close(resolve))
}
