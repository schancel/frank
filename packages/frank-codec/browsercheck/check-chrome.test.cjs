const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter, once } = require('node:events')
const { PassThrough } = require('node:stream')
const { spawn } = require('node:child_process')
const {
  runChrome,
  ownedProcesses,
  corpusExpectation,
} = require('./check-chrome.js')

const expected = corpusExpectation()
const passing = () => ({
  ...structuredClone(expected),
  ok: true,
  failures: [],
  leakedNodeGlobals: [],
})

// Only native I/O is replaced: the real launcher runs startup -> navigation ->
// DOM validation -> explicit close -> native status -> ownership/profile cleanup.
function fixture(mode = 'pass', result = passing()) {
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  let alive = true,
    profile,
    removedWhileAlive = false
  const commands = [],
    logs = [],
    signals = []
  const exit = (code, signal = null) => {
    alive = false
    child.emit('exit', code, signal)
  }
  class Socket extends EventEmitter {
    constructor() {
      super()
      this.readyState = 1
    }
    addEventListener(...args) {
      this.on(...args)
    }
    close() {
      this.readyState = 3
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw)
      commands.push({ method, params })
      queueMicrotask(() => {
        if (mode === 'rpc-hang') return
        let value = {}
        if (method === 'Target.getTargets')
          value = {
            targetInfos: [
              { type: 'page', url: 'about:blank', targetId: 'owned' },
            ],
          }
        if (method === 'Target.attachToTarget') value = { sessionId: 'session' }
        if (method === 'Page.navigate') {
          if (mode === 'launcher-interrupt') return process.emit('SIGTERM')
          if (mode === 'navigation-error') value = { errorText: 'blocked' }
          if (mode === 'page-exception')
            return this.emit('message', {
              data: JSON.stringify({
                method: 'Runtime.exceptionThrown',
                params: { description: 'broken page' },
              }),
            })
          if (mode === 'cdp-close') return this.emit('close')
          if (mode === 'early-exit') return exit(0)
        }
        if (method === 'Runtime.evaluate') {
          value = {
            result: {
              value:
                mode === 'missing-result'
                  ? undefined
                  : mode === 'malformed'
                  ? '{'
                  : JSON.stringify(result),
            },
          }
          if (mode === 'evaluation-error')
            value.exceptionDetails = { text: 'exception' }
        }
        this.emit('message', { data: JSON.stringify({ id, result: value }) })
        if (method === 'Browser.close') {
          if (mode === 'close-timeout') return
          if (mode === 'signal') return exit(null, 'SIGTERM')
          if (mode === 'nonzero') return exit(7)
          exit(0)
        }
      })
    }
  }
  const native = {
    WebSocket: Socket,
    spawn(command, args, options) {
      assert.equal(command, '/fixture/chrome')
      assert.equal(options.detached, true)
      assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
      assert.ok(!args.includes('--dump-dom'))
      profile = args.find(a => a.startsWith('--user-data-dir=')).slice(16)
      assert.ok(fs.existsSync(profile))
      setImmediate(() => {
        if (mode === 'launch-error') {
          alive = false
          return child.emit('error', new Error('ENOENT'))
        }
        if (mode === 'startup-timeout') return
        if (mode === 'output-flood') {
          child.stdout.write(Buffer.alloc(100000, 120))
          child.stderr.write(Buffer.alloc(100000, 120))
        }
        const host =
          mode === 'remote-endpoint' ? 'example.invalid' : '127.0.0.1'
        child.stderr.write(
          `\nDevTools listening on ws://${host}:1234/devtools/browser/fixture\n`,
        )
      })
      return child
    },
    ownedProcesses() {
      return {
        members() {
          if (alive && !fs.existsSync(profile)) removedWhileAlive = true
          return alive ? [{ pid: child.pid }] : []
        },
        signal(signal) {
          signals.push(signal)
          exit(null, signal)
        },
      }
    },
  }
  return {
    commands,
    logs,
    signals,
    run: () =>
      runChrome(
        {
          chrome: '/fixture/chrome',
          page: '/fixture/full corpus.html',
          expected,
          timeoutMs: 150,
          log: line => logs.push(line),
        },
        native,
      ),
    cleaned() {
      assert.equal(removedWhileAlive, false)
      assert.equal(fs.existsSync(profile), false)
      assert.equal(alive, false)
    },
  }
}

test('full committed corpus, explicit close, native exit and disposable cleanup', async () => {
  const f = fixture()
  assert.deepEqual(await f.run(), passing())
  assert.equal(f.commands.at(-1).method, 'Browser.close')
  assert.equal(
    f.commands.find(c => c.method === 'Page.navigate').params.url,
    'file:///fixture/full%20corpus.html',
  )
  assert.deepEqual(f.signals, [])
  f.cleaned()
})

for (const [mode, error] of [
  ['launch-error', /ENOENT/],
  ['launcher-interrupt', /launcher interrupted/],
  ['startup-timeout', /timeout during startup/],
  ['rpc-hang', /timeout/],
  ['missing-result', /timeout during page/],
  ['close-timeout', /timeout during close/],
  ['signal', /unexpected Chrome exit/],
  ['nonzero', /unexpected Chrome exit/],
  ['early-exit', /unexpected Chrome exit/],
  ['remote-endpoint', /loopback/],
  ['navigation-error', /blocked/],
  ['page-exception', /page exception/],
  ['cdp-close', /CDP closed/],
  ['evaluation-error', /evaluation failed/],
  ['malformed', /JSON/],
])
  test(`fails closed: ${mode}`, async () => {
    const f = fixture(mode)
    await assert.rejects(f.run(), error)
    f.cleaned()
  })

for (const [name, mutate] of [
  [
    'ok false',
    r => {
      r.ok = false
    },
  ],
  [
    'failure despite ok',
    r => {
      r.failures.push('failed')
    },
  ],
  [
    'Node global',
    r => {
      r.leakedNodeGlobals.push('process')
    },
  ],
  [
    'partial historical count',
    r => {
      r.typescript.total--
    },
  ],
  [
    'wrong historical outcome',
    r => {
      r.typescript.rejected--
    },
  ],
  [
    'missing Rust corpus',
    r => {
      delete r.rust
    },
  ],
  [
    'partial registration',
    r => {
      r.registration.total--
    },
  ],
  [
    'partial Forum',
    r => {
      r.forum.total--
    },
  ],
  [
    'partial interoperability',
    r => {
      r.interoperability.hostileCases--
    },
  ],
])
  test(`rejects result: ${name}`, async () => {
    const result = passing()
    mutate(result)
    const f = fixture('pass', result)
    await assert.rejects(f.run())
    assert.ok(!f.commands.some(c => c.method === 'Browser.close'))
    f.cleaned()
  })

test('native diagnostics are retained and bounded without hiding startup', async () => {
  const f = fixture('output-flood')
  await f.run()
  assert.ok(f.logs.join('\n').length < 140000)
  assert.equal(
    f.logs.filter(l => l.includes('further output truncated')).length,
    2,
  )
  f.cleaned()
})

test('real ownership includes descendants, not an unrelated sibling', async () => {
  const args = ['-e', 'setInterval(()=>{},1000)']
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const c = require('node:child_process').spawn(process.execPath,
      ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'})
    process.send(c.pid)
    c.on('exit', () => process.exit(0))
    process.on('SIGTERM', () => c.kill('SIGTERM'))
  `,
    ],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  )
  const sibling = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
  })
  const childExit = once(child, 'exit'),
    siblingExit = once(sibling, 'exit')
  try {
    const [descendant] = await once(child, 'message')
    const owner = ownedProcesses(child.pid)
    assert.ok(owner.members().some(p => p.pid === child.pid))
    assert.ok(owner.members().some(p => p.pid === descendant))
    assert.ok(!owner.members().some(p => p.pid === sibling.pid))
    owner.signal('SIGTERM')
    await childExit
    assert.deepEqual(owner.members(), [])
    process.kill(sibling.pid, 0)
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    sibling.kill('SIGTERM')
    await Promise.all([childExit, siblingExit])
  }
})
