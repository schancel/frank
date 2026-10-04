/* eslint-env node */
// A page result alone is not success: require bounded startup, execution, explicit
// close, clean native exit, and cleanup of only this launcher's disposable state.
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert/strict')
const { spawn, execFileSync } = require('child_process')
const { pathToFileURL } = require('url')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// The caller has just spawned a detached child: POSIX gives it a new group whose
// ID is its PID. That owned group survives leader exit; it is not rediscovered
// from a live leader. Retire the group permanently once observed empty, so a
// subsequently reused group ID cannot acquire ownership. Remember individual
// descendants by PID + birth time across exec/reparenting. Never kill by name.
function ownedProcesses(
  pid,
  readTable = () =>
    execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    }).toString(),
) {
  const known = new Map()
  let groupOwned = true
  function members() {
    const rows = readTable()
      .trim()
      .split('\n')
      .map(line => {
        const [, id, parent, group, born] =
          /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim()) || []
        return { pid: +id, parent: +parent, group: +group, born }
      })
    assert.ok(
      rows.length &&
        rows.every(
          row =>
            Number.isSafeInteger(row.pid) &&
            row.pid > 0 &&
            Number.isSafeInteger(row.parent) &&
            row.parent >= 0 &&
            Number.isSafeInteger(row.group) &&
            row.group >= 0 &&
            row.born,
        ),
      'unusable process table; ownership absence cannot be established',
    )
    if (!rows.some(row => row.group === pid)) groupOwned = false
    let changed
    do {
      changed = false
      for (const row of rows) {
        // Never reacquire a recycled PID, including the original group leader.
        if (known.has(row.pid)) continue
        const parent = rows.find(p => p.pid === row.parent)
        if (
          (groupOwned && row.group === pid) ||
          (parent && known.get(parent.pid) === parent.born)
        ) {
          known.set(row.pid, row.born)
          changed = true
        }
      }
    } while (changed)
    return rows.filter(row => known.get(row.pid) === row.born)
  }
  return {
    members,
    signal(signal) {
      for (const row of members().reverse()) {
        try {
          process.kill(row.pid, signal)
        } catch (e) {
          if (e.code !== 'ESRCH') throw e
        }
      }
    },
  }
}

function corpusExpectation() {
  const vectors = path.resolve(
    __dirname,
    '../../..',
    'docs/protocol/cbor/vectors',
  )
  const read = name =>
    JSON.parse(fs.readFileSync(path.join(vectors, name + '.json')))
  const counts = (name, retain = true) => {
    const cases = read(name).cases
    const count = { total: cases.length, accepted: 0, rejected: 0 }
    if (retain) count.retained = 0
    for (const c of cases)
      count[
        { accept: 'accepted', reject: 'rejected', retain: 'retained' }[
          c.expectation
        ]
      ]++
    return count
  }
  return {
    typescript: counts('manifest'),
    rust: counts('rust-origin'),
    registration: counts('account-registration', false),
    forum: { total: read('forum-content-read').frames.length },
    interoperability: { hostileCases: read('manifest').cases.length },
  }
}

async function runChrome(
  {
    chrome,
    page,
    expected = corpusExpectation(),
    timeoutMs = 90000,
    log = console.error,
  },
  native = { spawn, WebSocket: globalThis.WebSocket, ownedProcesses },
) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'frank-chrome-'))
  let child,
    owner,
    socket,
    exited,
    endpoint,
    closing = false,
    failure,
    result
  let stage = 'launch',
    serial = 0,
    timer,
    monitor
  const pending = new Map()
  let rejectFailure
  const failed = new Promise((_, reject) => {
    rejectFailure = reject
  })
  failed.catch(() => {
    /* Observed at every awaited lifecycle boundary below. */
  })
  const fail = error => {
    if (!failure) {
      failure = error instanceof Error ? error : new Error(error)
      rejectFailure(failure)
    }
  }
  const onTerm = () => fail('launcher interrupted: SIGTERM')
  const onInt = () => fail('launcher interrupted: SIGINT')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  const observe = (name, data = {}) =>
    log('chrome lifecycle: ' + JSON.stringify({ stage: name, ...data }))
  const wait = async predicate => {
    while (!predicate()) await Promise.race([delay(20), failed])
    if (failure) throw failure
    return predicate()
  }
  const rpc = (method, params = {}, sessionId) =>
    Promise.race([
      new Promise((resolve, reject) => {
        const id = ++serial
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      }),
      failed,
    ])
  try {
    child = native.spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--allow-file-access-from-files',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (child.pid) owner = native.ownedProcesses(child.pid)
    observe(stage, { pid: child.pid, profile })
    child.once('error', fail)
    child.once('exit', (code, signal) => {
      exited = { code, signal }
      observe('native-exit', exited)
      if (!closing || code !== 0 || signal)
        fail(`unexpected Chrome exit: ${JSON.stringify(exited)}`)
    })
    let stderrTail = ''
    for (const name of ['stdout', 'stderr']) {
      let remaining = 64 * 1024
      child[name].on('data', chunk => {
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining)
          remaining -= kept.length
          log(`chrome ${name}: ` + kept.toString())
          if (!remaining) log(`chrome ${name}: further output truncated`)
        }
        if (name !== 'stderr') return
        stderrTail = (stderrTail + chunk.toString()).slice(-8192)
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrTail)
        if (!match || endpoint) return
        try {
          const url = new URL(match[1])
          assert.equal(url.hostname, '127.0.0.1', 'CDP must bind IPv4 loopback')
          endpoint = url.href
        } catch (e) {
          fail(e)
        }
      })
    }
    timer = setTimeout(() => fail(`Chrome timeout during ${stage}`), timeoutMs)
    monitor = setInterval(() => {
      try {
        owner?.members()
      } catch (e) {
        fail(e)
      }
    }, 100)
    {
      stage = 'startup'
      await wait(() => endpoint)
      observe(stage, { endpoint })
      socket = new native.WebSocket(endpoint)
      socket.addEventListener('message', ({ data }) => {
        try {
          const message = JSON.parse(data)
          const call = pending.get(message.id)
          if (call) {
            pending.delete(message.id)
            message.error
              ? call.reject(new Error(JSON.stringify(message.error)))
              : call.resolve(message.result)
          } else if (message.method === 'Runtime.exceptionThrown') {
            fail('page exception: ' + JSON.stringify(message.params))
          }
        } catch (e) {
          fail(e)
        }
      })
      socket.addEventListener('error', () => {
        if (!closing) fail('CDP socket error')
      })
      socket.addEventListener('close', () => {
        if (!closing) fail('CDP closed before result')
      })
      await wait(() => socket.readyState === 1)
      const { targetInfos } = await rpc('Target.getTargets')
      const target = targetInfos.find(
        t => t.type === 'page' && t.url === 'about:blank',
      )
      assert.ok(target, 'missing fresh page target')
      const { sessionId } = await rpc('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })
      await rpc('Page.enable', {}, sessionId)
      await rpc('Runtime.enable', {}, sessionId)
      stage = 'page'
      const navigation = await rpc(
        'Page.navigate',
        { url: pathToFileURL(page).href },
        sessionId,
      )
      assert.ok(!navigation.errorText, navigation.errorText)
      observe(stage, { page })
      while (!result) {
        const observation = await rpc(
          'Runtime.evaluate',
          {
            expression: 'document.getElementById("result")?.textContent',
            returnByValue: true,
          },
          sessionId,
        )
        assert.ok(!observation.exceptionDetails, 'result evaluation failed')
        const text = observation.result?.value
        if (text && text !== 'running') result = JSON.parse(text)
        else await Promise.race([delay(20), failed])
      }
      assert.equal(result.ok, true, 'page assertions failed')
      assert.deepEqual(result.failures, [])
      assert.deepEqual(result.leakedNodeGlobals, [])
      for (const [corpus, counts] of Object.entries(expected))
        for (const [key, value] of Object.entries(counts))
          assert.equal(
            result[corpus]?.[key],
            value,
            `${corpus}.${key}: incomplete corpus`,
          )
      observe('result', { result })
      stage = 'close'
      closing = true
      // Chrome may disconnect before replying; native exit is authoritative.
      rpc('Browser.close').catch(fail)
      await wait(() => exited)
      assert.equal(exited.code, 0)
      assert.equal(exited.signal, null)
    }
  } catch (error) {
    failure = failure || error
  }
  try {
    clearTimeout(timer)
    clearInterval(monitor)
    socket?.close()
    for (const call of pending.values()) call.resolve({})
    let remaining = owner?.members() || []
    if (remaining.length) {
      owner.signal('SIGTERM')
      for (let i = 0; i < 20 && owner.members().length; i++) await delay(25)
      if (owner.members().length) owner.signal('SIGKILL')
      for (let i = 0; i < 40 && owner.members().length; i++) await delay(25)
      remaining = owner.members()
      if (!failure)
        failure = new Error('Chrome required forced process cleanup')
    }
    if (remaining.length)
      throw new Error(
        `owned Chrome processes remain; profile retained: ${profile}`,
      )
    fs.rmSync(profile, { recursive: true })
    observe('cleanup', { profile, ownedMembersAbsent: true })
  } finally {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
  }
  if (failure) throw failure
  return result
}

if (require.main === module) {
  const candidates = [
    process.env.FRANK_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  const chrome = candidates.find(p => fs.existsSync(p))
  if (!chrome) {
    console.error(
      'no Chrome/Chromium found (set FRANK_CHROME); real-browser check NOT run',
    )
    process.exitCode = 3
  } else {
    runChrome({
      chrome,
      page: path.resolve(__dirname, '../dist/browsercheck.html'),
    })
      .then(result => console.log('chrome check:', JSON.stringify(result)))
      .catch(error => {
        console.error(error)
        process.exitCode = 1
      })
  }
}
module.exports = { runChrome, ownedProcesses, corpusExpectation }
