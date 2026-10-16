import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ['packages/swap-protocol/src/storage/execution-browser-suite.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  metafile: true,
})

const stackState = {
  holds: new Set(),
  xecReserved: new Set(),
  evmReserved: new Set(),
  xecBroadcasts: [],
  evmBroadcasts: [],
  fundingConfirmations: 2,
  settlementConfirmations: 0,
}

const directory = await mkdtemp(join(tmpdir(), 'frank-swap-exec-browser-'))
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/stack') {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      const { action, payload } = JSON.parse(body || '{}')
      res.setHeader('Content-Type', 'application/json')
      if (action === 'acquire-hold') {
        stackState.holds.add(payload.operationId)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (action === 'release-hold') {
        stackState.holds.delete(payload.operationId)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (action === 'xec-reserve') {
        stackState.xecReserved.add(payload.swapId)
        res.end(
          JSON.stringify({
            inputs: [
              {
                txid: '11'.repeat(32),
                vout: 0,
                valueSats: (BigInt(payload.principalSats) + 500n).toString(),
              },
            ],
            feeSats: '500',
            fundingTxHex: '02000000xecfund',
            fundingTxid: 'aa'.repeat(32),
            claimTxHex: '02000000xecclaim',
            claimTxid: 'bb'.repeat(32),
            refundTxHex: '02000000xecrefund',
            refundTxid: 'cc'.repeat(32),
          }),
        )
        return
      }
      if (action === 'evm-reserve') {
        stackState.evmReserved.add(payload.swapId)
        res.end(
          JSON.stringify({
            input: {
              address: '0x' + '22'.repeat(20),
              nonce: 9,
              feeBudgetWei: '21000000000000',
            },
            fundingTxHex: '0x02evmfund',
            fundingTxHash: '0x' + 'dd'.repeat(32),
            claimTxHex: '0x02evmclaim',
            claimTxHash: '0x' + 'ee'.repeat(32),
            refundTxHex: '0x02evmrefund',
            refundTxHash: '0x' + 'ff'.repeat(32),
          }),
        )
        return
      }
      if (action === 'xec-broadcast') {
        stackState.xecBroadcasts.push(payload.txHex)
        res.end(JSON.stringify({ txid: 'aa'.repeat(32) }))
        return
      }
      if (action === 'evm-broadcast') {
        stackState.evmBroadcasts.push(payload.txHex)
        res.end(JSON.stringify({ txHash: '0x' + 'dd'.repeat(32) }))
        return
      }
      if (action === 'xec-observe-funding' || action === 'evm-observe-funding') {
        res.end(
          JSON.stringify({
            status:
              stackState.fundingConfirmations >= 10 ? 'final' : 'included',
            confirmations: stackState.fundingConfirmations,
          }),
        )
        return
      }
      if (
        action === 'xec-observe-settlement' ||
        action === 'evm-observe-settlement'
      ) {
        const claimed =
          stackState.xecBroadcasts.includes('02000000xecclaim') ||
          stackState.evmBroadcasts.includes('0x02evmclaim')
        res.end(
          JSON.stringify({
            effect: claimed ? 'claim' : 'none',
            status: !claimed
              ? 'unseen'
              : stackState.settlementConfirmations >= 10
              ? 'final'
              : 'included',
            confirmations: claimed ? stackState.settlementConfirmations : 0,
          }),
        )
        return
      }
      if (action === 'xec-release') {
        stackState.xecReserved.delete(payload.swapId)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (action === 'evm-release') {
        stackState.evmReserved.delete(payload.swapId)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (action === 'advance-confirmations') {
        stackState.fundingConfirmations = payload.fundingConfirmations
        stackState.settlementConfirmations = payload.settlementConfirmations
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.statusCode = 400
      res.end(JSON.stringify({ error: 'Unknown action' }))
    })
    return
  }

  res.setHeader(
    'Content-Type',
    req.url === '/suite.js' ? 'text/javascript' : 'text/html',
  )
  res.end(
    req.url === '/suite.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><title>Swap execution browser local stack</title>',
  )
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const executable =
  process.env.NEGOTIATION_STORE_CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let child, socket, call
async function stop(signal = 'SIGTERM') {
  socket?.close()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(signal)
    await exited
  }
}

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
      `--user-data-dir=${join(directory, 'profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const endpoint = await new Promise((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(
      () => reject(new Error('Chrome startup timed out')),
      20_000,
    )
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.stderr.on('data', data => {
      output += data.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      reject(new Error(`Chrome exited ${code}`))
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
    if (!message.id) return
    const handler = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) handler?.reject(new Error(message.error.message))
    else handler?.resolve(message.result)
  }
  socket.onclose = () => {
    for (const handler of pending.values())
      handler.reject(new Error('Chrome connection closed'))
    pending.clear()
  }
  call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  return (await call('Browser.getVersion')).product
}

async function page() {
  const { targetId } = await call('Target.createTarget', { url: origin })
  const { sessionId } = await call('Target.attachToTarget', {
    targetId,
    flatten: true,
  })
  await call('Runtime.enable', {}, sessionId)
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await call(
      'Runtime.evaluate',
      { expression: 'location.origin', returnByValue: true },
      sessionId,
    )
    if (ready.result.value === origin) return sessionId
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Chrome page did not reach fixture origin')
}

async function evaluate(session, expression, awaitPromise = true) {
  const result = await call(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true },
    session,
  )
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    )
  return result.result.value
}

async function invoke(session, phase) {
  const result = await evaluate(
    session,
    `import(${JSON.stringify(
      `${origin}/suite.js`,
    )}).then(m => m.runExecutionBrowserPhase(${JSON.stringify(phase)}))`,
  )
  console.log(JSON.stringify(result))
  return result
}

try {
  // Phase 1: launch Chrome, prepare & fund swap against local HTTP stack
  await launch()
  const session1 = await page()
  const res1 = await invoke(session1, 'prepare-and-fund')
  assert.equal(res1.preparedPhase, 'prepared')
  assert.equal(res1.fundedPhase, 'funding')
  assert.equal(stackState.holds.size, 1)
  assert.deepEqual(stackState.xecBroadcasts, ['02000000xecfund'])
  assert.deepEqual(stackState.evmBroadcasts, ['0x02evmfund'])
  await stop()

  // Phase 2: relaunch Chrome on the same profile, verify durable state survived process restart,
  // advance local stack to 10-block finality, claim, and verify hold release
  await launch()
  const session2 = await page()
  const res2 = await invoke(session2, 'reopen-and-complete')
  assert.equal(res2.restoredPhase, 'funding')
  assert.equal(res2.completedPhase, 'complete')
  assert.equal(res2.retentionReleased, true)
  assert.equal(stackState.holds.size, 0)
  assert.equal(stackState.xecReserved.size, 0)
  assert.equal(stackState.evmReserved.size, 0)
  assert.deepEqual(stackState.xecBroadcasts, [
    '02000000xecfund',
    '02000000xecclaim',
  ])
  assert.deepEqual(stackState.evmBroadcasts, [
    '0x02evmfund',
    '0x02evmclaim',
  ])
} finally {
  await stop()
  await new Promise(resolve => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
