/** Offline real-App interaction fixture. See messaging-baseline/README.md for boundaries. */
import assert from 'node:assert/strict'
import ts from 'typescript'
import { runPairing } from './messaging-baseline/pairing.mjs'
import { runHistory } from './messaging-baseline/history.mjs'
import { OwnedProcesses } from './messaging-baseline/processes.mjs'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  symlink,
  rm,
  readdir,
  realpath,
} from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPwaPreviewServer } from '../../scripts/serve-pwa.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '../../..')
const args = process.argv.slice(2)
const option = (name, fallback) =>
  args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback
const ref = option('source-ref', 'HEAD')
const scenario = option('scenario', 'queue-route')
assert.ok(
  ['queue-route', 'history-desktop', 'history-narrow', 'pairing-pin'].includes(
    scenario,
  ),
  'Unknown scenario',
)
const out = resolve(
  option('out', join(tmpdir(), `messaging-baseline-evidence-${randomUUID()}`)),
)
const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
  cwd: repository,
  encoding: 'utf8',
}).trim()
const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
assert.ok(
  existsSync(chrome),
  'Set CHROME_BIN to an installed Chrome/Chromium executable; runner never installs dependencies',
)
const owned = await mkdtemp(join(tmpdir(), 'messaging-browser-fixture-'))
const ownership = randomUUID()
await writeFile(join(owned, '.owner'), ownership)
await mkdir(out, { recursive: true })
const tree = join(owned, 'source')
await mkdir(tree)
const processes = new OwnedProcesses()
let browser, socket, server
const report = {
  sourceSha: sha,
  scenario,
  fixtureHash: '',
  mode: 'SPA with synthetic session/wallet service boundaries',
  browser: '',
  limitations: [
    'No real financial construction, settlement or live RPC latency',
    'Synthetic messaging readiness; not directory-startup or custody proof',
    'Browser app surface; not native extension or Safari',
  ],
  blockedRequests: [],
  consoleErrors: [],
  runtimeErrors: [],
  metrics: {},
  passed: false,
}
async function command(program, params, options = {}) {
  const child = processes.spawn(program, params, {
    cwd: tree,
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = createWriteStream(join(out, 'build.log'), { flags: 'a' })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', resolve)
  })
  log.end()
  assert.equal(code, 0, `${program} failed; see ${join(out, 'build.log')}`)
}
let closing
function cleanup() {
  return (closing ??= cleanupOwned())
}
async function cleanupOwned() {
  socket?.close()
  await processes.stopAll()
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  assert.equal(await readFile(join(owned, '.owner'), 'utf8'), ownership)
  await rm(owned, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130))
  })
try {
  const archive = execFileSync('git', ['archive', sha], {
    cwd: repository,
    maxBuffer: 256 * 1024 * 1024,
  })
  execFileSync('tar', ['-x', '-C', tree], { input: archive })
  // Isolate workspace links so --source-ref never imports a newer workspace through the
  // installed node_modules tree. External package bytes are shared; workspace bytes are not.
  const modules = join(tree, 'node_modules')
  await mkdir(modules)
  const workspaceNames = new Map()
  for (const entry of await readdir(join(tree, 'packages'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue
    try {
      const dir = join(tree, 'packages', entry.name)
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
      workspaceNames.set(pkg.name, dir)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const linkModules = async (source, destination) => {
    if (!existsSync(source)) return
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.name.startsWith('@')) {
        await mkdir(join(destination, entry.name), { recursive: true })
        for (const child of await readdir(join(source, entry.name))) {
          const name = entry.name + '/' + child
          await symlink(
            workspaceNames.get(name) ?? join(source, name),
            join(destination, name),
          )
        }
      } else {
        await symlink(
          workspaceNames.get(entry.name) ?? join(source, entry.name),
          join(destination, entry.name),
        )
      }
    }
  }
  await linkModules(join(repository, 'node_modules'), modules)
  const installationRoot = dirname(
    await realpath(join(repository, 'node_modules')),
  )
  // Preserve package-local installed versions; only workspace links redirect to the snapshot.
  for (const relative of [
    'app',
    ...[...workspaceNames.values()].map(path => path.slice(tree.length + 1)),
  ]) {
    await linkModules(
      existsSync(join(repository, relative, 'node_modules'))
        ? join(repository, relative, 'node_modules')
        : join(installationRoot, relative, 'node_modules'),
      join(tree, relative, 'node_modules'),
    )
  }
  const fixture = join(here, 'messaging-baseline')
  const names = [
    'boot.ts',
    'runtime.ts',
    'session.ts',
    'identity.ts',
    'pairing-runtime.ts',
    'pairing-adapter.ts',
  ]
  const hash = createHash('sha256')
  hash.update(await readFile(fileURLToPath(import.meta.url)))
  hash.update(await readFile(join(fixture, 'processes.mjs')))
  hash.update(await readFile(join(fixture, 'history.mjs')))
  hash.update(await readFile(join(fixture, 'pairing.mjs')))
  for (const name of names) hash.update(await readFile(join(fixture, name)))
  report.fixtureHash = hash.digest('hex')
  await cp(fixture, join(tree, 'app/test/browser/messaging-baseline'), {
    recursive: true,
  })
  for (const path of [
    'app/src/accounts/session',
    'app/src/utils/identity-session',
    'app/src-bex/runtime-adapter',
  ])
    await cp(join(tree, path + '.ts'), join(tree, path + '.original.ts'))
  await rename(
    join(tree, 'app/quasar.config.js'),
    join(tree, 'app/quasar.baseline-original.js'),
  )
  await writeFile(
    join(tree, 'app/src/boot/messaging-baseline.ts'),
    "export { default } from '../../test/browser/messaging-baseline/boot'\n",
  )
  await writeFile(
    join(tree, 'app/quasar.config.js'),
    `import original from './quasar.baseline-original.js';
import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
export default async ctx => { const config=await original(ctx); config.boot.push('messaging-baseline');
const prior=config.build.extendViteConf; config.build.extendViteConf=function(vite) { prior?.call(this,vite);
vite.plugins.unshift({name:'test-only-synthetic-session',enforce:'pre',load(id){
const replacements={ [path.join(root,'src/accounts/session.ts')]: 'session.ts', [path.join(root,'src/utils/identity-session.ts')]: 'identity.ts', ${
      scenario === 'pairing-pin'
        ? "[path.join(root,'src-bex/runtime-adapter.ts')]: 'pairing-adapter.ts'"
        : ''
    } };
const name=replacements[id]; if(!name) return null;
// Resolve relative fixture imports from the fixture directory, not the substituted production id.
return fs.readFileSync(path.join(root,'test/browser/messaging-baseline',name),'utf8').replace(/from (['"])(\\.[^'"]+)\\1/g,(_all,q,rel)=>'from '+q+path.resolve(root,'test/browser/messaging-baseline',rel)+q);
}}); }; return config; };
`,
  )
  server = createPwaPreviewServer(() => join(tree, 'app/dist/spa'))
  const serve = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    if (req.url === '/fixture/pairing-focus') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<!doctype html><title>Owned focus target</title><p>Disposable pairing focus target</p><input aria-label="Synthetic receiver input">',
      )
      return
    }
    if (
      [
        '/fixture/profiles/curated-defaults',
        '/profiles/curated-defaults',
      ].includes(req.url)
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ entries: [] }))
      return
    }
    serve(req, res)
  })
  server.prependListener('request', (_req, res) =>
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'",
    ),
  )
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await command('yarn', ['prepare:packages'], { cwd: join(tree, 'app') })
  const sourceConfig = ts.readConfigFile(
    join(tree, 'app/tsconfig.json'),
    ts.sys.readFile,
  )
  assert.equal(
    sourceConfig.error,
    undefined,
    'Cannot read source TypeScript configuration',
  )
  await writeFile(
    join(tree, 'app/tsconfig.baseline.json'),
    JSON.stringify({
      extends: './tsconfig.json',
      include: [
        ...sourceConfig.config.include,
        'test/browser/messaging-baseline/*.ts',
      ],
    }),
  )
  if (args.includes('--typecheck'))
    await command('yarn', ['tsc', '--noEmit', '-p', 'tsconfig.baseline.json'], {
      cwd: join(tree, 'app'),
    })
  await command('yarn', ['quasar', 'build', '-m', 'spa'], {
    cwd: join(tree, 'app'),
    env: {
      PATH: process.env.PATH,
      HOME: owned,
      NODE_ENV: 'production',
      QCLI_MONAD_RELAY_BASE_URL: origin + '/fixture',
      QCLI_MONAD_SUB_ACCOUNT_POOL_SIZE: '0',
    },
  })
  browser = processes.spawn(
    chrome,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(owned, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const endpoint = await new Promise((resolve, reject) => {
    let buf = ''
    const timeout = setTimeout(
      () => reject(new Error('Chrome startup timeout')),
      20000,
    )
    browser.once('error', reject)
    browser.stderr.on('data', chunk => {
      buf += chunk
      const found = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
      if (found) {
        clearTimeout(timeout)
        resolve(found[1])
      }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  let next = 0,
    session
  const pending = new Map()
  const call = (method, params = {}, sessionId = session) =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('CDP timeout: ' + method))
      }, 45000)
      pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      )
    })
  socket.onmessage = event => {
    const m = JSON.parse(event.data)
    if (m.id) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p?.reject(new Error(m.error.message)) : p?.resolve(m.result)
      return
    }
    if (m.method === 'Fetch.requestPaused') {
      const url = m.params.request.url
      const allowed = url.startsWith(origin + '/')
      if (!allowed) report.blockedRequests.push(url.split('?')[0])
      void call(
        allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        {
          requestId: m.params.requestId,
          ...(allowed ? {} : { errorReason: 'BlockedByClient' }),
        },
        m.sessionId,
      ).catch(() => {
        // The target may close while interception replies are in flight.
      })
    }
    if (m.method === 'Runtime.exceptionThrown')
      report.runtimeErrors.push(
        m.params.exceptionDetails.exception?.description ??
          m.params.exceptionDetails.text,
      )
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      report.consoleErrors.push(
        m.params.args.map(a => a.value ?? a.description).join(' '),
      )
  }
  report.browser = (await call('Browser.getVersion', {}, undefined)).product
  const { targetId } = await call(
    'Target.createTarget',
    { url: 'about:blank' },
    undefined,
  )
  session = (
    await call('Target.attachToTarget', { targetId, flatten: true }, undefined)
  ).sessionId
  for (const domain of ['Runtime', 'Page', 'Network', 'Fetch'])
    await call(domain + '.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: scenario === 'history-narrow' ? 390 : 1280,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const containmentScript = `window.__baselineMetrics={longtasks:[],marks:[],frames:[]};
new PerformanceObserver(list=>window.__baselineMetrics.longtasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
window.WebSocket=class {constructor(){throw Error('Fixture blocks WebSocket')}};window.EventSource=class {constructor(){throw Error('Fixture blocks EventSource')}};
document.addEventListener('keydown',e=>{if(e.key==='Enter')window.__baselineMetrics.marks.push({kind:'enter',time:performance.now()})},true);`
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source:
      containmentScript +
      (scenario === 'pairing-pin' ? "window.__pairingMode='tab';" : ''),
  })
  const evaluate = async expression => {
    const r = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
      )
    return r.result.value
  }
  const until = async (expression, timeout = 30000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await evaluate(expression)) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error(
      `Timed out: ${expression}\n${await evaluate(
        'document.body.innerText.slice(0,2500)',
      )}`,
    )
  }
  const openPairingPage = async (mode, sharedContext = false) => {
    // Separate disposable storage prevents cross-tab account-election from impersonating
    // real extension storage in this simulated page-host test. All contexts die with Chrome.
    const browserContextId = sharedContext
      ? undefined
      : (await call('Target.createBrowserContext', {}, null)).browserContextId
    const { targetId: ownedTarget } = await call(
      'Target.createTarget',
      { url: 'about:blank', browserContextId },
      null,
    )
    const { sessionId } = await call(
      'Target.attachToTarget',
      { targetId: ownedTarget, flatten: true },
      null,
    )
    const pageCall = (method, params = {}) => call(method, params, sessionId)
    for (const domain of ['Runtime', 'Page', 'Network', 'Fetch'])
      await pageCall(domain + '.enable')
    await pageCall('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await pageCall('Page.addScriptToEvaluateOnNewDocument', {
      source:
        containmentScript +
        'window.__pairingMode=' +
        JSON.stringify(mode) +
        ';',
    })
    const pageEvaluate = async expression => {
      const result = await pageCall('Runtime.evaluate', {
        expression,
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
    const pageUntil = async expression => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        if (await pageEvaluate(expression)) return
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(
        'Pairing target timed out: ' +
          expression +
          '\n' +
          (await pageEvaluate('document.body.innerText.slice(0,2500)')),
      )
    }
    return {
      targetId: ownedTarget,
      call: pageCall,
      evaluate: pageEvaluate,
      until: pageUntil,
    }
  }
  if (scenario === 'pairing-pin') {
    report.mode =
      'SPA sender page with simulated extension APIs; not installed extension or Safari'
    await runPairing({
      main: { targetId, call, evaluate, until },
      openPage: openPairingPage,
      origin,
      report,
    })
  } else {
    await call('Page.navigate', {
      url: origin + '/#/chat/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    await until(
      'window.__messagingBaseline?.state.ready && document.querySelector(".chat-message-list")',
    )
    await until(
      'document.querySelector(".chat-footer textarea, .chat-footer [contenteditable=true]")',
    )
    await evaluate(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
  }
  if (scenario === 'queue-route') {
    const text = 'Fixture queued message'
    await evaluate(
      `(()=>{const el=document.querySelector('.chat-footer textarea, .chat-footer [contenteditable=true]');el.focus();if(el.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(
        text,
      )});el.dispatchEvent(new Event('input',{bubbles:true}))}else{el.textContent=${JSON.stringify(
        text,
      )};el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(
        text,
      )}}))}const obs=new MutationObserver(()=>{if(document.querySelector('.chat-message-list')?.textContent.includes(${JSON.stringify(
        text,
      )})){window.__baselineMetrics.queuedDom=performance.now();requestAnimationFrame(()=>window.__baselineMetrics.queuedFrame=performance.now());obs.disconnect()}});obs.observe(document.querySelector('.chat-message-list'),{childList:true,subtree:true,characterData:true})})()`,
    )
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    })
    await until(
      "window.__baselineMetrics.queuedFrame && window.__messagingBaseline.state.sends.some(s=>s.text === 'Fixture queued message')",
    )
    assert.equal(
      await evaluate(
        "window.__messagingBaseline.messageState('Fixture queued message').status",
      ),
      'pending',
    )
    const sendSlot = await evaluate(
      "window.__messagingBaseline.state.sends.findIndex(s=>s.text === 'Fixture queued message')",
    )
    await new Promise(r => setTimeout(r, 2000))
    assert.equal(
      await evaluate(
        `window.__messagingBaseline.state.sends[${sendSlot}].released`,
      ),
      undefined,
      'Synthetic service must still be held',
    )
    const navigate = async (control, route, content) => {
      return evaluate(`new Promise((resolve,reject)=>{
      const tab=document.querySelector(${JSON.stringify(control)});
      if(!tab){reject(Error('Navigation control missing'));return}
      const start=performance.now();let settled=false;
      const timer=setTimeout(()=>{finish();reject(Error('Route content timeout'))},20000);
      const observer=new MutationObserver(check);
      function finish(){settled=true;clearTimeout(timer);observer.disconnect();window.removeEventListener('hashchange',check)}
      function check(){const el=document.querySelector(${JSON.stringify(
        content,
      )});if(!settled && location.hash.includes(${JSON.stringify(
        route,
      )}) && el?.getBoundingClientRect().width>0){finish();requestAnimationFrame(()=>resolve(performance.now()-start))}}
      observer.observe(document.body,{childList:true,subtree:true,attributes:true});window.addEventListener('hashchange',check);tab.click();check();
    })`)
    }
    const forumRouteMs = await navigate(
      '#rail-tab-forum',
      '/forum',
      '.forum-feed-container',
    )
    const conversationRouteMs = await navigate(
      '#rail-tab-chats',
      '/chat/',
      '.chat-message-list',
    )
    assert.equal(
      await evaluate(
        "window.__messagingBaseline.messageState('Fixture queued message')?.status",
      ),
      'pending',
      'Message must remain pending through delayed service and navigation',
    )
    assert.equal(
      await evaluate(
        "window.__messagingBaseline.state.sends.filter(s=>s.text === 'Fixture queued message').length",
      ),
      1,
      'Exactly one matching send must be submitted',
    )
    await evaluate(`window.__messagingBaseline.release(${sendSlot})`)
    await until(
      "window.__messagingBaseline.messageState('Fixture queued message')?.status === 'confirmed'",
    )
    report.metrics = await evaluate(
      `(()=>{const m=window.__baselineMetrics;const enter=m.marks.find(x=>x.kind==='enter').time;return {enterToQueuedDomMs:m.queuedDom-enter,enterToQueuedFrameMs:m.queuedFrame-enter,conversationRouteFrameMs:${conversationRouteMs},forumRouteFrameMs:${forumRouteMs},maxInteractionLongTaskMs:Math.max(0,...m.longtasks.filter(t=>t.start+t.duration>=enter).map(t=>t.duration)),longtasks:m.longtasks.filter(t=>t.start+t.duration>=enter),startupLongtasks:m.longtasks.filter(t=>t.start+t.duration<enter),syntheticService:window.__messagingBaseline.state.sends}})()`,
    )
  } else if (scenario.startsWith('history-')) {
    try {
      await runHistory({ evaluate, call, report })
    } finally {
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      await writeFile(
        join(out, 'history.png'),
        Buffer.from(shot.data, 'base64'),
      )
    }
  }
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(
    join(out, 'queued-route.png'),
    Buffer.from(shot.data, 'base64'),
  )
  assert.equal(
    report.runtimeErrors.length,
    0,
    JSON.stringify(report.runtimeErrors),
  )
  assert.equal(
    report.consoleErrors.length,
    0,
    JSON.stringify(report.consoleErrors),
  )
  assert.equal(
    report.blockedRequests.length,
    0,
    'Unexpected external network attempt',
  )
  // Negative control: browser policy must stop the URL before any external connection.
  const appErrorCount = report.consoleErrors.length
  const isolation = await evaluate(
    "(async()=>{const violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.blockedURI));let rejected=false;try{await fetch('https://offline-probe.invalid/must-not-connect')}catch{rejected=true}await new Promise(r=>setTimeout(r,50));return {rejected,violations}})()",
  )
  assert.ok(
    isolation.rejected &&
      isolation.violations.some(url =>
        url.startsWith('https://offline-probe.invalid'),
      ),
    'Offline CSP negative control did not block',
  )
  report.containmentConsole = report.consoleErrors.splice(appErrorCount)
  report.offlineIsolation = isolation
  if (scenario !== 'queue-route')
    assert.deepEqual(
      report.history.failures,
      [],
      'History geometry regressions; see report.history',
    )
  report.passed = true
} catch (error) {
  report.failure = String(error.stack ?? error)
  console.error(report.failure)
  process.exitCode = 1
} finally {
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  await cleanup()
  console.log(`Evidence: ${out}`)
}
