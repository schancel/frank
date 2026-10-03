// Owned isolated Chromium integration, not a general browser certificate verifier.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const { spawn, execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '../../../..')
const aliases = {
  '@frank/codec': path.join(root, 'packages/frank-codec/src/index.ts'),
  '@frank/directory-admission/browser': path.join(
    root,
    'packages/directory-admission/src/browser.ts',
  ),
}
class CDP {
  constructor(socket) {
    this.socket = socket
    this.next = 0
    this.pending = new Map()
    this.onBinding = () => {}
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.bindingCalled')
        Promise.resolve(this.onBinding(message)).catch(() => {})
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Owned browser disconnected'))
      }
      this.pending.clear()
    })
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP operation timed out'))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, replMode: true },
      sessionId,
    )
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          'Browser evaluation failed',
      )
    return result.result.value
  }
}
async function launch(chromium, profile, spki) {
  const child = spawn(
    chromium,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--ignore-certificate-errors-spki-list=${spki}`,
      'about:blank',
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  console.log(`Demo admission Chrome PID ${child.pid}`)
  let socket
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Chromium startup timeout'))
      }, 15000)
      child.stderr.on('data', chunk => {
        text = (text + chunk).slice(-4096)
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Chromium exited before debugger'))
      })
    })
    socket = new WebSocket(endpoint)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    return { child, cdp: new CDP(socket) }
  } catch (error) {
    socket?.close()
    await stop({ child })
    throw error
  }
}
async function stop(browser) {
  if (!browser) return
  if (browser.child.exitCode === null && browser.child.signalCode === null) {
    const exited = new Promise(resolve => browser.child.once('exit', resolve))
    const timer = setTimeout(() => browser.child.kill('SIGKILL'), 5000)
    if (browser.cdp) browser.cdp.send('Browser.close').catch(() => {})
    else browser.child.kill('SIGKILL')
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
  const members = () =>
    execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(
        ([, group, state]) =>
          Number(group) === browser.child.pid && !state.startsWith('Z'),
      )
  if (members().length) {
    try {
      process.kill(-browser.child.pid, 'SIGKILL')
    } catch (error) {
      if (
        error.code !== 'ESRCH' &&
        !(error.code === 'EPERM' && !members().length)
      )
        throw error
    }
    for (let i = 0; members().length; i++) {
      if (i >= 100) throw new Error('Owned browser descendants did not exit')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  browser.cdp?.socket.close()
}
async function page(browser, bundle, script, continuityFile) {
  const { cdp } = browser
  const { targetId } = await cdp.send('Target.createTarget', {
    url: bundle.trustInputs.endpoint + '/fixture/proof',
  })
  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await cdp.send('Runtime.enable', {}, sessionId)
  for (let i = 0; ; i++) {
    if (
      (await cdp.evaluate(sessionId, 'location.origin').catch(() => '')) ===
      new URL(bundle.trustInputs.endpoint).origin
    )
      break
    if (i >= 100) throw new Error('Controlled fixture origin did not load')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await cdp.evaluate(sessionId, script)
  if (!continuityFile) return sessionId
  await cdp.send(
    'Runtime.addBinding',
    { name: 'saveDemoContinuity' },
    sessionId,
  )
  cdp.onBinding = async event => {
    if (
      event.sessionId !== sessionId ||
      event.params.name !== 'saveDemoContinuity'
    )
      return
    const { id, record } = JSON.parse(event.params.payload)
    try {
      assert.equal(typeof record, 'string')
      assert.ok(record.length <= 8192)
      const replacement = fs.existsSync(continuityFile)
      const target = replacement ? continuityFile + '.pending' : continuityFile
      const fd = fs.openSync(target, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, record)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      if (replacement) fs.renameSync(target, continuityFile)
      const parent = fs.openSync(path.dirname(continuityFile), 'r')
      try {
        fs.fsyncSync(parent)
      } finally {
        fs.closeSync(parent)
      }
      await cdp.evaluate(
        sessionId,
        `continuityAcks.get(${JSON.stringify(id)}).resolve()`,
      )
    } catch {
      await cdp
        .evaluate(
          sessionId,
          `continuityAcks.get(${JSON.stringify(
            id,
          )}).reject(new Error('External continuity save failed'))`,
        )
        .catch(() => {})
    }
  }
  await cdp.evaluate(
    sessionId,
    'globalThis.continuityAcks = new Map(); globalThis.saveRecord = record => new Promise((resolve,reject) => { const id = continuityAcks.size; continuityAcks.set(id, {resolve,reject}); saveDemoContinuity(JSON.stringify({id,record})); })',
  )
  return sessionId
}
const summarized = `current => {
  const hex = bytes => Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return {
    kind: current.kind, head: hex(current.evidence.hash), statement: hex(current.evidence.statement), attestation: hex(current.evidence.attestation),
    message: hex(current.messageKey.keyBytes), stamp: hex(current.stampKey.keyBytes), previous: current.previousStamp ? hex(current.previousStamp.keyBytes) : null,
    revision: String(current.revision), generations: current.generations.map(String),
    accepted: current.status.accepted, retained: current.status.retained, charged: current.status.chargedBytes,
    checkpoint: JSON.parse(DemoDirectory.continuityJSON(installation, current.status.checkpoint)).checkpoint
  };
}`
async function main() {
  const inputPath = process.argv[2],
    chromium = process.argv[3]
  if (
    !inputPath ||
    !path.isAbsolute(chromium || '') ||
    fs.statSync(inputPath).size > 1048576
  )
    throw new Error('Bounded scenario and absolute Chromium path required')
  const inputFd = fs.openSync(
    inputPath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  )
  let scenario
  try {
    if (!fs.fstatSync(inputFd).isFile())
      throw new Error('Regular bounded scenario required')
    const bytes = Buffer.alloc(1048577)
    let length = 0
    while (length < bytes.length) {
      const count = fs.readSync(
        inputFd,
        bytes,
        length,
        bytes.length - length,
        null,
      )
      if (!count) break
      length += count
    }
    if (length > 1048576) throw new Error('Bounded scenario required')
    scenario = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    )
  } finally {
    fs.closeSync(inputFd)
  }
  const node = await esbuild.build({
    entryPoints: [path.join(__dirname, 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    alias: aliases,
  })
  const facade = new Module(
    path.join(__dirname, 'in-memory-fixture.cjs'),
    module,
  )
  facade.filename = path.join(__dirname, 'in-memory-fixture.cjs')
  facade.paths = Module._nodeModulePaths(__dirname)
  facade._compile(node.outputFiles[0].text, facade.filename)
  const now = BigInt(scenario.nowNs)
  const bundle = facade.exports.reopenBundle(scenario.bundle, now)
  const installed = facade.exports.parseTrust(scenario.installed)
  assert.deepEqual(
    installed,
    bundle.trustInputs,
    'Independent browser trust installation',
  )
  await facade.exports.checkNode(scenario.bundle, now)
  const built = await esbuild.build({
    entryPoints: [path.join(__dirname, 'browser-admission.ts')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'DemoDirectory',
    write: false,
    metafile: true,
    alias: aliases,
  })
  assert.ok(
    !Object.keys(built.metafile.inputs).some(file =>
      /(?:\/node\.ts|\/admission\.ts|\/storage\/level\.ts|\/provision\.ts|\/https-fixture\.ts)$/.test(
        file,
      ),
    ),
    'Browser consumes no Node adapter or fixture internals',
  )
  const owned = fs.mkdtempSync(
    path.join(os.tmpdir(), 'frank-demo-admission-browser-'),
  )
  const profile = path.join(owned, 'profile'),
    continuityFile = path.join(owned, 'continuity.json')
  let browser
  let interrupted = false
  const onSignal = () => {
    interrupted = true
    stop(browser).catch(() => {})
  }
  const checkInterrupted = () => {
    if (interrupted) throw new Error('Owned browser proof interrupted')
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, onSignal)
  try {
    browser = await launch(chromium, profile, bundle.tls.leafSpkiSha256)
    checkInterrupted()
    let session = await page(
      browser,
      bundle,
      built.outputFiles[0].text,
      continuityFile,
    )
    const setup = `globalThis.installation = ${JSON.stringify({
      manifestIdentity: bundle.manifestIdentity,
      trustInputs: {
        ...installed,
        bindingExpiryNs: installed.bindingExpiryNs.toString(),
      },
      witnessHex: bundle.witnessHex,
    })}; installation.trustInputs.bindingExpiryNs = BigInt(installation.trustInputs.bindingExpiryNs); globalThis.nowNs = BigInt(${JSON.stringify(
      scenario.nowNs,
    )}); globalThis.candidates = ${JSON.stringify(
      scenario.candidates,
    )}.map(c=>({statement:DemoDirectory.exactHex(c.statement,c.statement.length/2),attestation:DemoDirectory.exactHex(c.attestation,c.attestation.length/2)})); globalThis.summarize = ${summarized};`
    await browser.cdp.evaluate(session, setup)
    const peer = await page(
      browser,
      bundle,
      built.outputFiles[0].text,
      undefined,
    )
    await browser.cdp.evaluate(peer, setup)
    const peerOpen = name =>
      `DemoDirectory.openDemoBrowserAdmission({name:${JSON.stringify(
        name,
      )},installation,nowNs,mode:{kind:'new'},saveContinuity:async()=>{throw new Error('Unexpected peer checkpoint writer')}})`
    await browser.cdp.evaluate(
      peer,
      "Object.defineProperty(navigator,'locks',{configurable:true,value:undefined})",
    )
    await assert.rejects(
      () => browser.cdp.evaluate(peer, peerOpen('no-locks')),
      /ownership unavailable/,
      'missing WebLocks must reject before store opening',
    )
    await browser.cdp.evaluate(peer, 'delete navigator.locks')
    await browser.cdp.evaluate(
      session,
      `globalThis.delaySave = true;
       globalThis.store = await DemoDirectory.openDemoBrowserAdmission({name:'explicit-demo',installation,nowNs,mode:{kind:'new'},saveContinuity:async record=>{
         if(delaySave){globalThis.saveStarted=true;await new Promise(resolve=>{globalThis.releaseSave=resolve})}
         await saveRecord(record)
       }})`,
    )
    await assert.rejects(
      () => browser.cdp.evaluate(peer, peerOpen('different-db')),
      /ownership unavailable/,
      'second tab/different database must reject while first owner is active',
    )
    await browser.cdp.evaluate(
      session,
      'globalThis.pendingEnrollment=store.enroll(candidates,nowNs); pendingEnrollment.catch(()=>{}); true',
    )
    for (
      let i = 0;
      !(await browser.cdp.evaluate(session, 'globalThis.saveStarted === true'));
      i++
    ) {
      if (i >= 100)
        throw new Error('Delayed external checkpoint save did not start')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await browser.cdp.evaluate(
      session,
      'globalThis.closeFinished=false; globalThis.pendingClose=store.close().then(()=>{closeFinished=true}); true',
    )
    await assert.rejects(
      () => browser.cdp.evaluate(peer, peerOpen('different-db')),
      /ownership unavailable/,
      'delayed save and pending close must retain continuity ownership',
    )
    assert.equal(await browser.cdp.evaluate(session, 'closeFinished'), false)
    await browser.cdp.evaluate(session, 'delaySave=false; releaseSave(); true')
    const current = await browser.cdp.evaluate(
      session,
      'summarize(await pendingEnrollment)',
    )
    assert.deepEqual(current, scenario.expected)
    await browser.cdp.evaluate(session, 'pendingClose')
    await browser.cdp.evaluate(
      peer,
      `globalThis.peerStore=await ${peerOpen(
        'different-db',
      )}; await peerStore.close()`,
    )
    const continuity = fs.readFileSync(continuityFile, 'utf8')
    await browser.cdp.evaluate(
      session,
      `globalThis.store=await DemoDirectory.openDemoBrowserAdmission({name:'explicit-demo',installation,nowNs,mode:{kind:'reopen',continuity:${JSON.stringify(
        continuity,
      )}},saveContinuity:saveRecord});
      globalThis.nativeClose=IDBDatabase.prototype.close;
      IDBDatabase.prototype.close=function(){throw new Error('Injected store close failure')}`,
    )
    await assert.rejects(
      () => browser.cdp.evaluate(session, 'store.close()'),
      /Injected store close failure/,
      'injected native store close failure must reach the adapter caller',
    )
    await browser.cdp.evaluate(
      session,
      'IDBDatabase.prototype.close=nativeClose',
    )
    await assert.rejects(
      () => browser.cdp.evaluate(peer, peerOpen('after-close-retry')),
      /ownership unavailable/,
      'failed store close must retain continuity ownership until retry',
    )
    await browser.cdp.evaluate(session, 'store.close()')
    await browser.cdp.evaluate(
      peer,
      `globalThis.peerStore=await ${peerOpen(
        'after-close-retry',
      )}; await peerStore.close()`,
    )
    await stop(browser)
    await facade.exports.checkNode(scenario.bundle, now)
    checkInterrupted()
    browser = await launch(chromium, profile, bundle.tls.leafSpkiSha256)
    checkInterrupted()
    session = await page(
      browser,
      bundle,
      built.outputFiles[0].text,
      continuityFile,
    )
    await browser.cdp.evaluate(session, setup)
    await browser.cdp.evaluate(
      session,
      `globalThis.store = await DemoDirectory.openDemoBrowserAdmission({name:'explicit-demo',installation,nowNs,mode:{kind:'reopen',continuity:${JSON.stringify(
        continuity,
      )}},saveContinuity:saveRecord})`,
    )
    assert.deepEqual(
      await browser.cdp.evaluate(
        session,
        'summarize(await store.current(nowNs))',
      ),
      scenario.expected,
    )
    await assert.rejects(() =>
      browser.cdp.evaluate(session, 'store.current(nowNs-1n)'),
    )
    await browser.cdp.evaluate(session, 'store.close()')
    await assert.rejects(() =>
      browser.cdp.evaluate(
        session,
        `DemoDirectory.openDemoBrowserAdmission({name:'absent-store',installation,nowNs,mode:{kind:'reopen',continuity:${JSON.stringify(
          continuity,
        )}},saveContinuity:saveRecord})`,
      ),
    )
    await browser.cdp.evaluate(
      session,
      `globalThis.store = await DemoDirectory.openDemoBrowserAdmission({name:'explicit-demo',installation,nowNs,mode:{kind:'reopen',continuity:${JSON.stringify(
        continuity,
      )}},saveContinuity:saveRecord});
       globalThis.conflict = ${JSON.stringify(scenario.conflict)};
       conflict = {statement:DemoDirectory.exactHex(conflict.statement, conflict.statement.length/2),attestation:DemoDirectory.exactHex(conflict.attestation,conflict.attestation.length/2)};`,
    )
    await assert.rejects(
      () => browser.cdp.evaluate(session, 'store.advance([conflict],nowNs)'),
      /fork/i,
      'authenticated fork must reject a usable current result',
    )
    assert.deepEqual(
      JSON.parse(fs.readFileSync(continuityFile, 'utf8')).checkpoint,
      scenario.expectedFork,
    )
    await browser.cdp.evaluate(session, 'store.close()')
    const forkContinuity = fs.readFileSync(continuityFile, 'utf8')
    await browser.cdp.evaluate(
      session,
      `globalThis.store = await DemoDirectory.openDemoBrowserAdmission({name:'explicit-demo',installation,nowNs,mode:{kind:'reopen',continuity:${JSON.stringify(
        forkContinuity,
      )}},saveContinuity:saveRecord})`,
    )
    await assert.rejects(
      () => browser.cdp.evaluate(session, 'store.current(nowNs)'),
      /fork/i,
      'reopened quarantined store must reject a usable current result',
    )
    await browser.cdp.evaluate(session, 'store.close()')
    console.log(
      JSON.stringify({
        ok: true,
        browser: 'real-chromium-indexeddb',
        transport: 'strict-node-preflight-isolated-leaf-spki',
        restart: true,
        missingReopen: true,
        clockRollback: true,
        durableQuarantine: true,
        exclusiveContinuityOwner: true,
        twoTabsDifferentDatabaseNames: true,
        delayedSaveCloseDrain: true,
        failedCloseRetainsUntilRetry: true,
        missingWebLocksFailClosed: true,
        failedOpenReleases: true,
        crossLanguage: 'matches-node-signed-scenario',
      }),
    )
  } finally {
    await stop(browser)
    for (const signal of signals) process.off(signal, onSignal)
    fs.rmSync(owned, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
