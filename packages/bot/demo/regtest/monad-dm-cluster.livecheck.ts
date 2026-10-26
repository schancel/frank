/**
 * Direct messages on three real relays that share one FoundationDB store and one NATS bus (HA
 * plan step 6, docs/plans/relay-ha-cluster.md), with real wallets paying real stamps on the local
 * Monad network (monad-solonet). Not part of CI.
 *
 *   yarn --cwd packages/bot regtest:monad-dm-cluster
 *
 * The relays are the cluster lab of backend/labs/compose.cluster.yml (FoundationDB, NATS, MinIO
 * and three relays, configured by its lab-init from cluster/relay.toml.in) under their own Compose
 * project (FRANK_DM_LAB_PROJECT, default frank-ha-dm) and subnet (FRANK_DM_LAB_SUBNET, default
 * 10.89.183), which this check starts, built from this checkout, and removes with its volumes.
 * compose.cluster-replicas.yml publishes each relay on 127.0.0.1 (18301 to 18303). The lab's
 * nginx proxy is not started: wallets reach the relays through this check's own routing proxy on
 * 127.0.0.1:18300, the origin every relay advertises, so each step can choose which replica
 * answers which request. Everything the wallets publish (directory entries, profiles) is in the
 * shared store, so any replica may take it.
 *
 * Checked, each against the shared store:
 *   1. a paid message sent through A arrives on the recipient's websocket held on B;
 *   2. concurrent messages (FRANK_DM_LAB_BURST) to one recipient through A, B and C get strictly increasing times,
 *      and reading them back page by page, each page from another replica, skips nothing;
 *   3. one request sent to A and B at once is kept once;
 *   4. a mailbox challenge issued by A is accepted once on B and refused when replayed;
 *   5. A killed while admitting a paid message: the wallet's retry goes to B, and the message is
 *      kept once with its payment made once (twice, killed before and after A answers);
 *   6. with NATS stopped, a message is still kept and the reader catches up from its cursor;
 *   7. a message near the largest a client can seal (512 KiB of ciphertext) reads back unchanged from another
 *      replica (split rows in FoundationDB: direct messages do not use the S3 store yet;
 *      FRANK_DM_LAB_LARGE=0 skips it).
 *
 * FRANK_DM_LAB_BURST (default 60) sets step 2's burst; keep it moderate, every message there is
 * checked against solonet.
 */
import assert from 'assert'
import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import net from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { randomBytes } from 'crypto'

import { parseEther } from 'ethers'

import type { RealWallet } from '../real-stack'
import { MONAD_REGTEST_MIN_STAMP_WEI, MonadRegtest, startMonadRegtest } from './monad-regtest'
import { openMonadWallet } from './monad-wallets'
import type { RegtestStack } from './regtest-stack'
import { sleep } from './regtest-chain'
import { evmPaymentFloorWei } from '@frank/wallet/chain/payment-floor'

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..')
const LABS = join(REPO_ROOT, 'backend', 'labs')
const PROJECT = process.env.FRANK_DM_LAB_PROJECT ?? 'frank-ha-dm'
const SUBNET = process.env.FRANK_DM_LAB_SUBNET ?? '10.89.183'
const PROXY_PORT = 18300
const ENDPOINT = `http://127.0.0.1:${PROXY_PORT}`
const RELAYS = { a: 18301, b: 18302, c: 18303 } as const
type Relay = keyof typeof RELAYS
const ALL: Relay[] = ['a', 'b', 'c']
const FUND_WEI = parseEther('50')
const BURST = Number(process.env.FRANK_DM_LAB_BURST ?? 60)
/** Near the most a client seals into one direct message: the codec bounds its ciphertext at
 * 512 KiB (MAX_CIPHERTEXT_BYTES), padding included. Four times one stored value, so it is split.
 * The relay's own 8 MiB request bound is checked in its unit tests. */
const LARGE_TEXT_BYTES = Number(process.env.FRANK_DM_LAB_LARGE_BYTES ?? 400_000)

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, { cwd: LABS, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} ${args.join(' ')} failed:\n${stderr.slice(-4000)}`))
      else resolveRun(stdout)
    })
  })
}

// ---------------------------------------------------------------------------------------------
// The lab: the cluster lab's FDB, NATS, MinIO and three relays in their own Compose project.

class Lab {
  constructor(readonly stateDir: string) {}

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // The relays advertise this check's proxy as their origin (and directory endpoint).
      FRANK_LAB_CLUSTER_PORT: String(PROXY_PORT),
      FRANK_LAB_CLUSTER_SUBNET: SUBNET,
      FRANK_LAB_RELAY_A_PORT: String(RELAYS.a),
      FRANK_LAB_RELAY_B_PORT: String(RELAYS.b),
      FRANK_LAB_RELAY_C_PORT: String(RELAYS.c),
      FRANK_LAB_SOLONET_RPC_URL: process.env.FRANK_DM_LAB_MONAD_RPC ?? 'http://host.docker.internal:48080',
    }
  }

  compose(...args: string[]): Promise<string> {
    return run(
      'docker',
      ['compose', '-p', PROJECT, '-f', 'compose.cluster.yml', '-f', 'compose.cluster-replicas.yml', ...args],
      this.env(),
    )
  }

  async up() {
    // lab-init provisions one session secret and one VAPID key for the whole cluster (a challenge
    // or cursor one replica issues is honoured by the others) and the relays' configuration, with
    // a checkpoint a few blocks behind solonet's head; fdb-init creates the database.
    await this.compose('up', '-d', '--build', '--wait', 'relay-a', 'relay-b', 'relay-c')
    await Promise.all(ALL.map(relay => waitForRelay(relay)))
  }

  async kill(relay: Relay, proxy: Proxy) {
    proxy.alive.delete(relay)
    await this.compose('kill', `relay-${relay}`)
  }

  async start(relay: Relay, proxy: Proxy) {
    await this.compose('start', `relay-${relay}`)
    await waitForRelay(relay)
    proxy.alive.add(relay)
  }

  logs(): Promise<string> {
    return this.compose('logs', '--no-color', 'relay-a', 'relay-b', 'relay-c')
  }

  down() {
    return this.compose('down', '--volumes', '--remove-orphans')
  }
}

async function waitForRelay(relay: Relay) {
  const base = `http://127.0.0.1:${RELAYS[relay]}`
  const deadline = Date.now() + 120_000
  for (;;) {
    try {
      const answer = await fetch(`${base}/chain-rpc/monad-regtest/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (typeof ((await answer.json()) as { result?: unknown }).result === 'string') return
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`relay ${relay} did not come up on ${base}`)
    await sleep(500)
  }
}

// ---------------------------------------------------------------------------------------------
// The routing proxy every wallet talks to.

interface Captured {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

function forward(relay: Relay, request: Captured, onSent?: () => void): Promise<Answer> {
  return new Promise((resolveForward, reject) => {
    const headers = { ...request.headers, host: `127.0.0.1:${RELAYS[relay]}` }
    const outgoing = http.request(
      { host: '127.0.0.1', port: RELAYS[relay], method: request.method, path: request.url, headers },
      response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolveForward({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
        response.on('error', reject)
      },
    )
    outgoing.on('error', reject)
    outgoing.end(request.body, () => onSent?.())
  })
}

const isDm = (url: string) => (url === '/message' || url.startsWith('/message/') || url.startsWith('/message?')) && !url.startsWith('/message/monad/topics')

/** Which replica answers: `route` picks for direct-message requests; the others take turns. */
class Proxy {
  private server: http.Server
  private sockets = new Set<net.Socket>()
  private turn = 0
  /** Direct-message HTTP requests; default: in turn A, B, C. */
  route: (request: Captured) => Relay = () => ALL[this.turn++ % ALL.length]
  /** Websocket upgrades. */
  wsRoute: Relay = 'a'
  /** Replicas that are up: the only ones requests other than direct messages go to. */
  readonly alive = new Set<Relay>(ALL)
  /** Lets a step take over one direct-message request (send it twice, kill a relay ...). */
  intercept?: (request: Captured) => Promise<Answer | undefined>
  private otherTurn = 0
  readonly served: Array<{ relay: Relay; method: string; url: string; status: number }> = []

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const request: Captured = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) }
        void this.answer(request).then(
          answer => {
            const headers = { ...answer.headers }
            delete headers['transfer-encoding']
            delete headers['content-length']
            delete headers.connection
            res.writeHead(answer.status, headers)
            res.end(answer.body)
          },
          () => {
            res.writeHead(502)
            res.end()
          },
        )
      })
    })
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (req, socket, head) => {
      const relay = this.wsRoute
      const upstream = net.connect(RELAYS[relay], '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]
          lines.push(`${name}: ${name.toLowerCase() === 'host' ? `127.0.0.1:${RELAYS[relay]}` : req.rawHeaders[i + 1]}`)
        }
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      const close = () => {
        upstream.destroy()
        socket.destroy()
      }
      upstream.on('error', close)
      socket.on('error', close)
      upstream.on('close', close)
      socket.on('close', close)
      this.served.push({ relay, method: 'WS', url: req.url ?? '', status: 101 })
    })
  }

  private async answer(request: Captured): Promise<Answer> {
    if (isDm(request.url)) {
      const taken = await this.intercept?.(request)
      if (taken) return taken
      const relay = this.route(request)
      const answer = await forward(relay, request)
      this.served.push({ relay, method: request.method, url: request.url, status: answer.status })
      return answer
    }
    // Chain reads and their capabilities belong to one replica's RPC gateway, not to the store.
    // Everything else the wallets publish (directory entries, profiles) is in the shared store,
    // so the replicas that are up take it in turn.
    const up = ALL.filter(relay => this.alive.has(relay))
    const relay = request.url.startsWith('/chain-rpc/') ? up[0] : up[this.otherTurn++ % up.length]
    const answer = await forward(relay, request)
    this.served.push({ relay, method: request.method, url: request.url, status: answer.status })
    return answer
  }

  listen(): Promise<void> {
    return new Promise(resolveListen => this.server.listen(PROXY_PORT, '127.0.0.1', () => resolveListen()))
  }

  close() {
    for (const socket of this.sockets) socket.destroy()
    return new Promise<void>(resolveClose => this.server.close(() => resolveClose()))
  }

  reset() {
    this.turn = 0
    this.route = () => ALL[this.turn++ % ALL.length]
    this.wsRoute = 'a'
    this.intercept = undefined
    this.served.length = 0
  }
}

// ---------------------------------------------------------------------------------------------

const isPut = (request: Captured) => request.method === 'PUT' && request.url.split('?')[0] === '/message'

/** The message arrived once, paid one stamp whose payments are mined, and the sender made no
 * second message (a fresh payment) for the same text. */
async function paidOnce(monad: MonadRegtest, to: RealWallet, digest: string, text: string, stampWei: bigint) {
  const got = await to.receive(message => message.payloadDigest === digest)
  // At least the stamp: a payment may empty a small stamp account rather than leave dust in it.
  assert.ok(got.stampValueWei >= stampWei, `the recipient was paid the stamp (${got.stampValueWei} < ${stampWei})`)
  assert.equal(new Set(got.stampPayments.map(p => p.txHash)).size, got.stampPayments.length, 'no payment counted twice')
  for (const payment of got.stampPayments) {
    const receipt = await monad.provider.waitForTransaction(payment.txHash, 1, 120_000)
    assert.equal(receipt?.status, 1, `stamp payment ${payment.txHash} mined`)
  }
  const scan = await to.chain.directMessages.scanAuthenticatedMailbox!({ wallet: to.handle, sinceMs: 0 })
  assert.equal(scan.records.filter(r => r.payloadDigest === digest).length, 1, 'one row for the message')
  const sameText = scan.records.filter(r => r.items.some(item => item.type === 'text' && item.text === text))
  assert.equal(sameText.length, 1, `one message with this text, not a second paid copy (${sameText.length})`)
  return { got, payments: got.stampPayments.length, paidWei: got.stampValueWei }
}

async function main() {
  const startedAt = Date.now()
  const monad = await startMonadRegtest()
  const stateDir = mkdtempSync(join(process.env.FRANK_DM_LAB_DIR ?? tmpdir(), 'frank-dm-lab-'))
  const lab = new Lab(stateDir)
  const proxy = new Proxy()
  const wallets: RealWallet[] = []
  let failed = false
  // A wallet library can throw outside any promise; the lab is still removed.
  process.once('uncaughtException', err => {
    console.error(err)
    const done = () => process.exit(1)
    if (process.env.FRANK_DM_LAB_KEEP === '1') done()
    else lab.down().then(done, done)
  })
  try {
    await proxy.listen()
    await lab.up()
    // One provisioned VAPID key: every replica serves the same push identity.
    const vapidKeys = await Promise.all(
      ALL.map(async relay => {
        const answer = await fetch(`http://127.0.0.1:${RELAYS[relay]}/push/vapid-public-key`)
        assert.equal(answer.status, 200, `relay ${relay} serves its VAPID key`)
        return answer.text()
      }),
    )
    assert.ok(vapidKeys.every(key => key === vapidKeys[0]), `one VAPID key: ${vapidKeys.join(' | ')}`)
    console.log(`lab up: relays A, B, C on ${ALL.map(r => RELAYS[r]).join(', ')} sharing FDB and NATS (project ${PROJECT}); proxy ${ENDPOINT}`)
    const stack: RegtestStack = {
      relayUrl: ENDPOINT,
      // One relay as far as the wallets can tell: the proxy in front of A, B and C.
      relayUrls: [ENDPOINT],
      chains: { [monad.chainIdentifier]: monad },
      stateDir,
      relayLogPath: '',
      stop: async () => {},
    }
    let stamp = MONAD_REGTEST_MIN_STAMP_WEI
    const floor = evmPaymentFloorWei(BigInt(await monad.provider.send('eth_gasPrice', [])))
    if (floor > stamp) stamp = floor

    const open = async (label: string) => {
      const wallet = await openMonadWallet(stack, label, { stampValueWei: stamp })
      wallets.push(wallet)
      return wallet
    }
    const alice = await open('alice')
    const bob = await open('bob')
    for (const wallet of [alice, bob]) await monad.fund(wallet.mainAccount, FUND_WEI)

    // 1. Paid on A, pushed on B's websocket.
    {
      proxy.route = () => 'a'
      proxy.wsRoute = 'b'
      const pushed: string[] = []
      const unsubscribe = bob.chain.directMessages.subscribeMailboxStream!({
        wallet: bob.handle,
        onRecord: record => pushed.push(record.payloadDigest),
        onError: err => console.warn(`bob's stream: ${err.message}`),
      })
      await sleep(3000)
      const text = 'paid on A, read on B'
      const digest = await alice.send(bob.address, [{ type: 'text', text }], stamp)
      const deadline = Date.now() + 30_000
      while (!pushed.includes(digest)) {
        if (Date.now() > deadline) throw new Error(`bob's websocket on B never pushed ${digest} (pushed ${pushed.join(', ')})`)
        await sleep(200)
      }
      unsubscribe()
      const { payments, paidWei } = await paidOnce(monad, bob, digest, text, stamp)
      const puts = proxy.served.filter(s => s.method === 'PUT' && s.url.split('?')[0] === '/message').map(s => s.relay)
      assert.ok(puts.length > 0 && puts.every(r => r === 'a'))
      assert.ok(proxy.served.some(s => s.method === 'WS' && s.relay === 'b'))
      console.log(`1. paid message ${digest} admitted on A was pushed on bob's websocket held on B; ${paidWei} wei for a ${stamp} wei stamp in ${payments} mined payment(s)`)
      proxy.reset()
    }

    // 2. A burst to one recipient through all three replicas.
    {
      const senders: RealWallet[] = []
      for (const label of ['carol', 'dave', 'erin', 'frank', 'grace']) senders.push(await open(label))
      // A first paid message makes each sender a contact, so the rest may be free.
      for (const sender of senders) await monad.fund(sender.mainAccount, FUND_WEI)
      for (const sender of senders) {
        // A fresh deposit may not be in the wallet's view yet; nothing is signed until it is.
        for (let tries = 0; ; tries++) {
          try {
            await sender.send(bob.address, [{ type: 'text', text: `${sender.label} says hello` }], stamp)
            break
          } catch (err) {
            if (tries >= 20 || (err as Error).name !== 'InsufficientStampFundsError') throw err
            await sleep(3000)
          }
        }
      }
      const before = new Set((await bob.chain.directMessages.scanAuthenticatedMailbox!({ wallet: bob.handle, sinceMs: 0 })).records.map(r => r.payloadDigest))
      const startedBurst = Date.now()
      const digests = await Promise.all(
        Array.from({ length: BURST }, (_, i) => senders[i % senders.length].send(bob.address, [{ type: 'text', text: `burst ${i}` }], 0n)),
      )
      assert.equal(new Set(digests).size, BURST)
      const putRelays = new Set(proxy.served.filter(s => s.method === 'PUT' && s.url.split('?')[0] === '/message').map(s => s.relay))
      assert.deepEqual([...putRelays].sort(), ['a', 'b', 'c'])
      console.log(`2. ${BURST} concurrent messages to bob from ${senders.length} senders through A, B and C admitted in ${Date.now() - startedBurst} ms`)
      // Read back page by page, each page from the next replica.
      const pages: Relay[] = []
      proxy.route = request => {
        const relay = ALL[pages.length % ALL.length]
        if (request.method === 'GET' && /^\/message\/(inbox|mailbox)\//.test(request.url)) pages.push(relay)
        return relay
      }
      const scan = await bob.chain.directMessages.scanAuthenticatedMailbox!({ wallet: bob.handle, sinceMs: 0 })
      assert.equal(scan.truncated, false)
      const burst = scan.records.filter(r => !before.has(r.payloadDigest))
      const missing = digests.filter(d => !burst.some(r => r.payloadDigest === d))
      assert.deepEqual(missing, [], 'pagination skipped nothing')
      const incoming = scan.records.filter(r => r.direction === 'incoming')
      for (let i = 1; i < incoming.length; i++) {
        assert.ok(incoming[i].receivedTime > incoming[i - 1].receivedTime, `times strictly increase at ${i}`)
      }
      const times = burst.map(r => r.receivedTime)
      assert.equal(new Set(times).size, BURST, 'no two messages share a delivery time')
      console.log(
        `   read back in ${pages.length} page(s) from ${[...new Set(pages)].join(', ')}: all ${BURST} present, ${incoming.length} incoming times strictly increasing (${times[0]}..${times[times.length - 1]})`,
      )
      proxy.reset()
    }

    // 3. One request to A and B at once.
    {
      const results: Array<{ relay: Relay; status: number }> = []
      proxy.intercept = async request => {
        if (!isPut(request)) return undefined
        proxy.intercept = undefined
        const [a, b] = await Promise.all([forward('a', request), forward('b', request)])
        results.push({ relay: 'a', status: a.status }, { relay: 'b', status: b.status })
        return a
      }
      const text = 'sent to A and B at once'
      const digest = await alice.send(bob.address, [{ type: 'text', text }], stamp)
      const { payments, paidWei } = await paidOnce(monad, bob, digest, text, stamp)
      assert.ok(results.every(r => r.status >= 200 && r.status < 300), `both replicas accepted: ${JSON.stringify(results)}`)
      console.log(`3. one request sent to A and B at once (${results.map(r => `${r.relay}:${r.status}`).join(', ')}) kept once; ${paidWei} wei in ${payments} mined payment(s)`)
      proxy.reset()
    }

    // 4. A challenge from A, used on B, replayed on C and on B.
    {
      const reads: Captured[] = []
      proxy.route = request => {
        if (request.method === 'POST' && request.url.startsWith('/message/auth/')) return 'a'
        if (request.method === 'GET' && /^\/message\/(inbox|mailbox)\//.test(request.url)) {
          reads.push(request)
          return 'b'
        }
        return 'a'
      }
      await bob.chain.directMessages.fetchSince({ wallet: bob.handle, sinceMs: Date.now() - 60_000 })
      assert.ok(reads.length > 0, 'bob read his mailbox')
      const first = reads[0]
      const onB = proxy.served.find(s => s.method === 'GET' && s.url === first.url && s.relay === 'b')
      assert.equal(onB?.status, 200, 'B accepted the challenge A issued')
      const replayC = await forward('c', first)
      const replayB = await forward('b', first)
      assert.equal(replayC.status, 401, `replay on C refused (${replayC.status})`)
      assert.equal(replayB.status, 401, `replay on B refused (${replayB.status})`)
      console.log(`4. challenge issued by A accepted on B (200); the same request replayed on C: ${replayC.status}, on B: ${replayB.status}`)
      proxy.reset()
    }

    // 5. A killed mid-admission; the retry goes to B.
    for (const when of ['before A answers', 'after A committed, its answer lost'] as const) {
      let killed = false
      proxy.route = () => (killed ? 'b' : 'a')
      proxy.intercept = async request => {
        if (killed || !isPut(request)) return undefined
        killed = true
        if (when === 'before A answers') {
          // The request has reached A; whether A commits before it dies is up to the race.
          await new Promise<void>(resolveSent => {
            forward('a', request, () => resolveSent()).catch(() => undefined)
          })
          await sleep(5)
          await lab.kill('a', proxy)
        } else {
          const answer = await forward('a', request)
          assert.ok(answer.status < 300, `A accepted before it was killed (${answer.status})`)
          await lab.kill('a', proxy)
        }
        return { status: 502, headers: {}, body: Buffer.alloc(0) }
      }
      const text = `A killed ${when}`
      const digest = await alice.send(bob.address, [{ type: 'text', text }], stamp)
      const { payments, paidWei } = await paidOnce(monad, bob, digest, text, stamp)
      const retries = proxy.served.filter(s => s.method === 'PUT' && s.url.split('?')[0] === '/message' && s.relay === 'b')
      assert.ok(retries.length >= 1, 'the retry went to B')
      console.log(`5. A killed ${when}: the wallet's retry was answered by B (${retries.map(r => r.status).join(', ')}); one row, ${paidWei} wei for a ${stamp} wei stamp in ${payments} mined payment(s), no second copy`)
      proxy.reset()
      await lab.start('a', proxy)
    }

    // 6. NATS down: kept, not announced; the reader catches up from its cursor.
    {
      proxy.route = () => 'a'
      proxy.wsRoute = 'b'
      const pushed: string[] = []
      const unsubscribe = bob.chain.directMessages.subscribeMailboxStream!({
        wallet: bob.handle,
        onRecord: record => pushed.push(record.payloadDigest),
      })
      await sleep(3000)
      await lab.compose('stop', 'nats')
      const digest = await alice.send(bob.address, [{ type: 'text', text: 'sent while NATS is down' }], 0n)
      await sleep(3000)
      assert.ok(!pushed.includes(digest), 'nothing announced it while NATS was down')
      proxy.route = () => 'c'
      const got = await bob.receive(message => message.payloadDigest === digest, 30_000)
      assert.equal(got.payloadDigest, digest)
      console.log(`6. with NATS stopped, ${digest} was kept by A and bob caught up from his cursor on C`)
      await lab.compose('start', 'nats')
      // The bus comes back for later messages. Each relay reconnects on its own backoff, and a
      // hint published before both A and B are back is lost (the reader's cursor covers it), so
      // send a new message every few seconds until one is pushed.
      proxy.route = () => 'a'
      const restartedAt = Date.now()
      let after: string | undefined
      for (let n = 1; ; n++) {
        const digest = await alice.send(bob.address, [{ type: 'text', text: `NATS is back ${n}` }], 0n)
        const waitUntil = Date.now() + 5000
        while (!pushed.includes(digest) && Date.now() < waitUntil) await sleep(250)
        if (pushed.includes(digest)) {
          after = digest
          break
        }
        if (Date.now() - restartedAt > 90_000) throw new Error('no push within 90 s after NATS came back')
      }
      unsubscribe()
      console.log(`   NATS back: ${after} pushed on B again ${Math.round((Date.now() - restartedAt) / 1000)} s after the restart`)
      proxy.reset()
    }

    // 7. A message near the largest a client can seal, kept in FoundationDB as split rows until the
    // large-value store of step 4 holds it in S3.
    if (process.env.FRANK_DM_LAB_LARGE !== '0') {
      proxy.route = () => 'a'
      // A text item holds at most 256 KiB, so the message is many of them.
      const tag = randomBytes(8).toString('hex')
      const texts = Array.from({ length: Math.ceil(LARGE_TEXT_BYTES / 200_000) }, (_, i) => `${tag} ${i} ` + 'x'.repeat(200_000))
      const digest = await alice.send(bob.address, texts.map(text => ({ type: 'text' as const, text })), 0n)
      const put = proxy.served.find(s => s.method === 'PUT' && s.url.split('?')[0] === '/message')
      proxy.route = () => 'b'
      const got = await bob.receive(message => message.payloadDigest === digest, 60_000)
      const items = got.items.flatMap(item => (item.type === 'text' ? [item.text] : []))
      assert.deepEqual(items, texts, 'the large message reads back byte for byte on B')
      const bytes = texts.reduce((sum, text) => sum + text.length, 0)
      console.log(`7. a message of ${texts.length} text items, ${bytes} bytes (request ${put?.status}), admitted on A read back unchanged on B`)
      proxy.reset()
    }

    console.log(`   one VAPID key on every replica: ${vapidKeys[0].slice(0, 60)}`)
    console.log(`Monad DM cluster: OK (${Math.round((Date.now() - startedAt) / 1000)} s)`)
  } catch (err) {
    failed = true
    throw err
  } finally {
    for (const wallet of wallets) await wallet.close().catch(() => undefined)
    if (failed || process.env.FRANK_DM_LAB_LOGS === '1') {
      const logs = await lab.logs().catch(err => String(err))
      const path = join(stateDir, '..', `${PROJECT}-relays.log`)
      writeFileSync(path, logs)
      console.error(`relay logs: ${path}`)
    }
    await proxy.close()
    if (process.env.FRANK_DM_LAB_KEEP !== '1') {
      await lab.down().catch(err => console.error(`could not remove the lab: ${err}`))
      rmSync(stateDir, { recursive: true, force: true })
    }
    await monad.stop()
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
