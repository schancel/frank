// Actual disposable Chrome + WASM + strict IndexedDB. Synthetic keys, simulated RPC.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: [new URL('./browser-entry.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, alias: { buffer: 'buffer/' } })
const wasm = await readFile(new URL('../solana-crypto-backend/generated/backend_bg.wasm', import.meta.url))
const server = createServer((request, response) => {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'")
  if (request.url === '/entry.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents) }
  else if (request.url === '/run.js') { response.setHeader('Content-Type', 'text/javascript'); response.end("import {runBrowserPaymentProof} from '/entry.js';window.result=runBrowserPaymentProof()") }
  else if (request.url === '/backend_bg.wasm') { response.setHeader('Content-Type', 'application/wasm'); response.end(wasm) }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><script type="module" src="/run.js"></script>') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const profile = await mkdtemp(join(tmpdir(), 'frank-solana-owner-browser-'))
const child = spawn(process.env.SOLANA_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 20000)
    child.once('error', reject)
    child.stderr.on('data', data => { log += data; const match = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (match) { clearTimeout(timer); resolve(match[1]) } })
  })
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let id = 0
  const pending = new Map()
  socket.onmessage = event => { const message = JSON.parse(event.data); const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result) } }
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params, sessionId })) })
  const { targetId } = await call('Target.createTarget', { url: `http://127.0.0.1:${server.address().port}` })
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
  await call('Runtime.enable', {}, sessionId)
  const evaluation = await call('Runtime.evaluate', { expression: 'new Promise((resolve,reject)=>{let elapsed=0;const timer=setInterval(()=>{if(window.result){clearInterval(timer);window.result.then(resolve,reject)}else if((elapsed+=20)>15000){clearInterval(timer);reject(Error("page timeout"))}},20)})', awaitPromise: true, returnByValue: true }, sessionId)
  assert(!evaluation.exceptionDetails, JSON.stringify(evaluation.exceptionDetails))
  const { wireProofMembers, ...result } = evaluation.result.value
  assert.deepEqual(result, { unsignedReview: true, unsignedDraftReopen: true, feeRiseRejectedBeforeSign: true, rentRiseRejectedBeforeSign: true, freshBlockhashWithinApproval: true, incomingForgeryRejected: true, incomingDurableOffline: true, incomingOriginalRetry: true, nativeSigned: true, splSigned: true, receivedDescriptors: 3, gatheredMembers: 2, splReceivedRespend: true, explicitAtaRent: true, needsNativeGas: true, verifiedReceivedAmount: '35', partialSafe: true, strictIndexedDb: true, revoked: true })
  const manifest = join(profile, 'owner-signed-members.json')
  await writeFile(manifest, JSON.stringify(wireProofMembers, null, 2) + '\n')
  console.log('PASS actual Chrome/WASM unsigned review/draft reopen/exact costs/fee and rent rise before sign/fresh approved blockhash, incoming forged rejection/offline durable claim/reopen/original retry/finalized credit, native multi-source gather/partial settlement/residual/replay, classic SPL ATA rent/received respend/gas, revoke')
  console.log(`Public synthetic signed-member manifest: ${manifest}`)
  console.log(`Disposable synthetic profile retained at ${profile}`)
} finally {
  socket?.close()
  child.kill('SIGTERM')
  server.close()
}
