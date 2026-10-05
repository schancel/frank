import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { QwenBotStateStore } from './qwen-bot-state'

it('real CLI process confirms only receipt fields from a BigInt-bearing send result, polls again, and handles a second input', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-receipt-process-'))
  const run = () => {
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        require.resolve('tsx/cjs'),
        join(__dirname, 'qwen-bot-process.fixture.ts'),
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
          QWEN_BOT_MODE: 'stub',
          QWEN_BOT_MAX_REPLIES: '0',
          QWEN_BOT_MAX_GREETINGS: '0',
          QWEN_BOT_IDLE_TIMEOUT_MS: '100',
          QWEN_BOT_POLL_INTERVAL_MS: '1',
          QWEN_BOT_MESSAGE_SINCE_MS: '0',
          QWEN_BOT_STATE_DIR: location,
          QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
          QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
          MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
          FRANK_NETWORK_TAG: 'fixture',
          CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
        },
      },
    )
    const summary = child.stdout
      .split('\n')
      .find(line => line.startsWith('QWEN_PROCESS_FIXTURE '))
    return {
      child,
      summary: summary
        ? JSON.parse(summary.slice('QWEN_PROCESS_FIXTURE '.length))
        : undefined,
    }
  }
  try {
    const first = run()
    expect({ status: first.child.status, ...first.summary }).toMatchObject({
      status: 0,
      generations: 2,
      sends: 2,
      closed: 1,
    })
    expect(first.summary.polls).toBeGreaterThanOrEqual(3)
    const state = new QwenBotStateStore(location)
    await state.Open()
    try {
      for (const [index, id] of ['first', 'second'].entries()) {
        const hash = createHash('sha256').update(id).digest('hex')
        const row = state.getResponse(hash)
        expect(row?.phase).toBe('confirmed')
        if (row?.phase !== 'confirmed')
          throw new Error('Expected confirmed fixture row')
        expect(row.receipt).toEqual({
          payloadHashHex: `reply-${index + 1}`,
          txHashes: [`tx-${index + 1}`],
        })
        expect(state.hasProcessed(hash)).toBe(true)
      }
      expect(state.getConversation('0x' + 'cd'.repeat(20))).toHaveLength(5)
    } finally {
      await state.Close()
    }
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
      closed: 1,
    })
    for (const result of [first, restart]) {
      expect(result.child.stdout + result.child.stderr).not.toContain(
        'PROCESS_PROMPT_SENTINEL',
      )
      expect(result.child.stderr).not.toContain('QWEN BOT FAILED')
    }
  } finally {
    rmSync(location, { recursive: true, force: true })
  }
}, 20000)

const fixtureHash = (id: string) =>
  createHash('sha256').update(id).digest('hex')
function runInbound(location: string, scenario: string, crash?: string) {
  return spawnSync(
    process.execPath,
    [
      '--require',
      require.resolve('tsx/cjs'),
      join(__dirname, 'qwen-bot-process.fixture.ts'),
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
        QWEN_BOT_MODE: 'stub',
        QWEN_BOT_MAX_REPLIES: '0',
        QWEN_BOT_MAX_GREETINGS: '0',
        QWEN_BOT_IDLE_TIMEOUT_MS: '100',
        QWEN_BOT_POLL_INTERVAL_MS: '1',
        QWEN_BOT_MESSAGE_SINCE_MS: '0',
        QWEN_BOT_STATE_DIR: location,
        QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
        QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
        MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
        FRANK_NETWORK_TAG: 'fixture',
        CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
        QWEN_PROCESS_SCENARIO: scenario,
        QWEN_PROCESS_CRASH: crash,
      },
    },
  )
}
function counters(child: ReturnType<typeof runInbound>) {
  const line = child.stdout
    .split('\n')
    .find(line => line.startsWith('QWEN_PROCESS_FIXTURE '))
  return line
    ? JSON.parse(line.slice('QWEN_PROCESS_FIXTURE '.length))
    : undefined
}

it('production CLI retains B behind held A across an empty-mailbox restart while independent C completes', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-process-'))
  try {
    const first = runInbound(location, 'held')
    expect({ status: first.status, ...counters(first) }).toMatchObject({
      status: 0,
      generations: 2,
      sends: 1,
    })
    let state = new QwenBotStateStore(location)
    await state.Open()
    try {
      expect(state.getResponse(fixtureHash('first'))?.phase).toBe(
        'model-started',
      )
      expect(state.getResponse(fixtureHash('other'))?.phase).toBe('confirmed')
      // Read the durable boundary directly so the exact regression runs on pre-inbox code.
      const retained = await (state as any).db
        .get('inbox:v1:' + fixtureHash('second'))
        .catch(() => undefined)
      expect(retained && JSON.parse(retained)).toMatchObject({
        phase: 'pending',
        payloadHashHex: fixtureHash('second'),
      })
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        fixtureHash('second'),
      ])
      expect(state.getInboxScan().origin).toBe(0)
    } finally {
      await state.Close()
    }
    const second = runInbound(location, 'empty')
    expect({ status: second.status, ...counters(second) }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
    })
    state = new QwenBotStateStore(location)
    await state.Open()
    try {
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        fixtureHash('second'),
      ])
    } finally {
      await state.Close()
    }
    for (const result of [first, second]) {
      expect(result.stdout + result.stderr).not.toMatch(
        /PROCESS_PROMPT_SENTINEL|MODEL_BODY_SENTINEL/,
      )
    }
  } finally {
    rmSync(location, { recursive: true, force: true })
  }
}, 20000)

it.each(['page', 'model', 'confirmation'])(
  'SIGKILL immediately after synced %s commit survives without Close/flush',
  async boundary => {
    const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-kill-'))
    try {
      const killed = runInbound(location, 'one', boundary)
      expect(killed.signal).toBe('SIGKILL')
      const state = new QwenBotStateStore(location)
      await state.Open()
      try {
        expect(state.getInboxScan().revision).toBe(1)
        expect(state.pendingInbox()).toHaveLength(boundary === 'page' ? 1 : 0)
        expect(state.getResponse(fixtureHash('first'))?.phase).toBe(
          boundary === 'page'
            ? undefined
            : boundary === 'model'
            ? 'model-started'
            : 'confirmed',
        )
        expect(state.hasProcessed(fixtureHash('first'))).toBe(
          boundary === 'confirmation',
        )
      } finally {
        await state.Close()
      }
      const restarted = runInbound(location, 'empty')
      expect({
        status: restarted.status,
        ...counters(restarted),
      }).toMatchObject({
        status: 0,
        generations: boundary === 'page' ? 1 : 0,
        sends: boundary === 'page' ? 1 : 0,
      })
      const replay = runInbound(location, 'one')
      expect({ status: replay.status, ...counters(replay) }).toMatchObject({
        status: 0,
        generations: 0,
        sends: 0,
      })
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  },
  20000,
)

it('a competing CLI process cannot open the same Level root or run another drain', async () => {
  const location = mkdtempSync(join(tmpdir(), 'qwen-inbound-lock-'))
  const state = new QwenBotStateStore(location)
  await state.Open()
  try {
    const child = runInbound(location, 'one')
    expect({ status: child.status, ...counters(child) }).toMatchObject({
      status: 1,
      generations: 0,
      sends: 0,
    })
  } finally {
    await state.Close()
    rmSync(location, { recursive: true, force: true })
  }
})

// #703/#778: the real CLI in canonical mode on the open directory. Production code runs
// unmodified: roots loader, typed wallet owner through the public bridge, the shared open
// directory over real Node admission stores, shared producer and opener, both workflows and both
// Level roots. Only the relay is local: its directory routes are the shared fake relay (kept in
// a file so it survives a restart of the bot), and the canonical inbox page read returns one
// prepared record. The sender is a second real typed wallet in this test process with its own
// stores; all it does is publish its own entry. Nothing about it is configured in the bot. The
// typed owner has no funded inventory, so no payment is signed or sent: this proves sequencing,
// one inference, one retained envelope for the verified sender and secret-free output, not
// delivery.
import { chmodSync, statSync, writeFileSync } from 'fs'
import { Transaction, Wallet, getBytes } from 'ethers'
import {
  cborMap,
  encodeFrame,
  fromHex,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
} from '@frank/codec'
import {
  directMessageText,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import { directoryAddress } from '@frank/cashweb/relay/open-directory'
import {
  createFakeRelay,
  testAccount,
} from '@frank/cashweb/relay/open-directory-fake-relay.testutil'
import { createCanonicalMessageRoles } from '@frank/wallet/chain/monad-chain'
import type { MonadRootBundle } from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import { openQwenCanonicalWallet, openQwenDirectory } from './qwen-bot-common'

const RELAY = 'https://a.example'

function canonicalPreload(): string {
  const at = (file: string) => JSON.stringify(join(__dirname, file))
  const mailbox = at('../cashweb/relay/monad-mailbox-client.ts')
  const fakeRelay = at('../cashweb/relay/open-directory-fake-relay.testutil.ts')
  return `
    const { readFileSync, existsSync, writeFileSync } = require('fs')
    const counters = { generations: 0, pages: 0, directory: [], down: 0, other: [] }
    process.on('exit', () =>
      console.log('QWEN_PROCESS_FIXTURE ' + JSON.stringify(counters)))
    // The relay's open directory routes. Its stored entries live in a file, as a relay's would
    // across a restart of the bot.
    const relay = require(${fakeRelay}).createFakeRelay({ endpoint: ${JSON.stringify(
    RELAY,
  )} })
    const relayFile = process.env.QWEN_FIXTURE_RELAY
    if (existsSync(relayFile))
      relay.replicate(JSON.parse(readFileSync(relayFile, 'utf8'))
        .map(hex => new Uint8Array(Buffer.from(hex, 'hex'))))
    let down = Number(process.env.QWEN_FIXTURE_RELAY_DOWN_FOR || 0)
    globalThis.fetch = async (url, init) => {
      const path = url.slice(${JSON.stringify(RELAY)}.length)
      if (!url.startsWith(${JSON.stringify(
        RELAY,
      )} + '/') || !/^\\/(relay|directory)\\/v1\\//.test(path)) {
        counters.other.push(init.method + ' ' + url)
        throw new Error('unreachable')
      }
      if (down > 0) { down--; counters.down++; throw new Error('unreachable') }
      const forged = process.env.QWEN_FIXTURE_FORGED
      relay.tamper = forged
        ? at => at.endsWith('/' + process.env.QWEN_FIXTURE_FORGED_SUBJECT + '/head')
          ? new Uint8Array(Buffer.from(forged, 'hex')) : undefined
        : undefined
      const response = await relay.fetch(url, init)
      counters.directory.push(init.method + ' ' + path)
      if (init.method === 'PUT' && response.status === 200)
        writeFileSync(relayFile, JSON.stringify([...relay.subjects()]
          .flatMap(subject => relay.chain(subject))
          .map(bytes => Buffer.from(bytes).toString('hex'))))
      return response
    }
    // The canonical inbox page read is the only replaced production function.
    const realMailbox = require(${mailbox})
    require.cache[require.resolve(${mailbox})].exports = {
      ...realMailbox,
      fetchCanonicalInboxPage: async () => {
        counters.pages++
        const file = process.env.QWEN_FIXTURE_INBOX
        if (!file || !existsSync(file)) return { records: [] }
        return { records: JSON.parse(readFileSync(file, 'utf8')).map(r => ({
          delivery: new Uint8Array(Buffer.from(r.delivery, 'hex')),
          context: new Uint8Array(Buffer.from(r.context, 'hex')),
          submissionIdentity: 'ab'.repeat(32),
          timestampMs: 1000,
        })) }
      },
    }
    const reply = require(${at('qwen-reply.ts')})
    require.cache[require.resolve(${at('qwen-reply.ts')})].exports = {
      ...reply,
      createQwenReplyGenerator: config => {
        const generator = reply.createQwenReplyGenerator(config)
        return { ...generator, reply: async history => {
          counters.generations++
          return generator.reply(history)
        } }
      },
    }
    if (process.env.QWEN_CANONICAL_CRASH === 'envelope') {
      const { QwenBotStateStore } = require(${at('qwen-bot-state.ts')})
      const save = QwenBotStateStore.prototype.saveCoupling
      QwenBotStateStore.prototype.saveCoupling = async function (...args) {
        const result = await save.apply(this, args)
        process.kill(process.pid, 'SIGKILL')
        return result
      }
    }
    require(${at('qwen-bot.livecheck.ts')})
  `
}

describe('#703/#778 production CLI in canonical mode on the open directory', () => {
  const NETWORK = 'monad-testnet'
  let location: string
  let botSubject: string
  let botAddress: string
  let sender: { subject: string; address: string; t1: string }
  let turn: string
  let firstStart: ReturnType<typeof run>

  const roots = (index: number): MonadRootBundle => {
    const outputs = domainVectors.vectors[index].outputs
    const one = <
      P extends
        | 'evm-wallet'
        | 'identity-authentication'
        | 'messaging-encryption',
    >(
      purpose: P,
    ) => ({
      registry: 'frank-domain-roots-v1' as const,
      purpose,
      bytes: getBytes(`0x${outputs[purpose]}`),
    })
    return {
      evm: one('evm-wallet'),
      authentication: one('identity-authentication'),
      messaging: one('messaging-encryption'),
    }
  }
  /** Everything canonical mode is configured with: a roots path, a relay, state directories. */
  const env = (extra: Record<string, string | undefined> = {}) => ({
    PATH: process.env.PATH,
    TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
    QWEN_BOT_MODE: 'stub',
    QWEN_BOT_MAX_REPLIES: '1',
    QWEN_BOT_IDLE_TIMEOUT_MS: '300',
    QWEN_BOT_POLL_INTERVAL_MS: '1',
    QWEN_BOT_MESSAGE_SINCE_MS: '0',
    QWEN_BOT_STATE_DIR: join(location, 'state'),
    QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
    QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
    QWEN_BOT_CANONICAL_ROOTS_JSON: join(location, 'roots.json'),
    E2E_DEMO_RELAY_URL: RELAY,
    MONAD_RPC_CHAIN: 'monad-testnet',
    QWEN_FIXTURE_RELAY: join(location, 'relay.json'),
    QWEN_FIXTURE_INBOX: join(location, 'inbox.json'),
    ...extra,
  })
  function run(
    extra: Record<string, string | undefined> = {},
    timeout = 30000,
  ) {
    const child = spawnSync(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), '-e', canonicalPreload()],
      { encoding: 'utf8', timeout, env: env(extra) },
    )
    return { child, summary: counters(child) }
  }
  const withState = async <T>(
    use: (state: QwenBotStateStore) => Promise<T> | T,
    directory = join(location, 'state'),
  ): Promise<T> => {
    const state = new QwenBotStateStore(directory)
    await state.Open()
    try {
      return await use(state)
    } finally {
      await state.Close()
    }
  }
  const secrets = (output: string) => {
    expect(output).not.toContain('PROCESS_PROMPT_SENTINEL')
    for (const index of [0, 1])
      for (const root of Object.values(domainVectors.vectors[index].outputs))
        expect(output).not.toContain(root)
    expect(output).not.toContain('QWEN BOT FAILED')
  }
  const relayEntries = (): Uint8Array[] =>
    (
      JSON.parse(readFileSync(join(location, 'relay.json'), 'utf8')) as string[]
    ).map(fromHex)
  const headOf = (subject: string) => `/directory/v1/${NETWORK}/${subject}/head`

  beforeEach(async () => {
    location = mkdtempSync(join(tmpdir(), 'qwen-canonical-cli-'))
    writeFileSync(
      join(location, 'roots.json'),
      JSON.stringify({
        registry: 'frank-domain-roots-v1',
        roots: domainVectors.vectors[0].outputs,
      }),
      { mode: 0o600 },
    )
    // First start of the real CLI: it publishes its own entry and finds an empty inbox.
    firstStart = run()
    expect(firstStart.child.status).toBe(0)
    const relay = createFakeRelay({ endpoint: RELAY })
    relay.replicate(relayEntries())
    expect([...relay.subjects()]).toHaveLength(1)
    botSubject = [...relay.subjects()][0]
    botAddress = directoryAddress(botSubject)!

    // An unrelated typed account publishes its own entry to the same relay. That is all.
    const wallet = await openQwenCanonicalWallet({
      chain: {
        networkId: 'monad-testnet',
        rpcChain: 'monad-testnet',
        chainId: 10143,
        relayBaseUrl: RELAY,
        networkTag: 'MONT',
        stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
        defaultStampValueWei: 32n,
        defaultTopicVoteValueWei: 1n,
        subAccountPoolSize: 2,
        walletStorageLocation: join(location, 'sender-wallet'),
      },
      roots: roots(1),
    })
    const directory = openQwenDirectory({
      wallet,
      networkTag: 'MONT',
      relayBaseUrl: RELAY,
      location: join(location, 'sender-directory'),
      fetch: relay.fetch,
    })
    let sealed
    let botCurrent
    try {
      await directory.publish()
      const senderCurrent = await directory.selfCurrent()
      // The sender knows only the bot's key; the bot's entry comes from the relay.
      botCurrent = (await directory.peerCurrent(botSubject))!
      sender = {
        subject: wallet.subject,
        address: wallet.identityAddress,
        t1: toHex(senderCurrent.evidence.hash),
      }
      // One canonical text from that account, sealed by the real producer for the bot.
      const roles = createCanonicalMessageRoles(wallet.handle, senderCurrent)
      try {
        sealed = prepareDirectMessage({
          network: NETWORK,
          senderCurrent,
          recipientCurrent: botCurrent,
          messageId: new Uint8Array(16).fill(7),
          items: [directMessageText('PROCESS_PROMPT_SENTINEL')],
          roles,
        })
      } finally {
        roles.dispose()
      }
    } finally {
      await directory.close()
      await wallet.close()
    }
    writeFileSync(
      join(location, 'relay.json'),
      JSON.stringify(
        [...relay.subjects()]
          .flatMap(subject => relay.chain(subject))
          .map(toHex),
      ),
    )
    const digest = recipientPayloadDigest(NETWORK, sealed.payload)
    turn = toHex(digest)
    const raw = await new Wallet('0x' + '00'.repeat(31) + '01').signTransaction(
      {
        type: 2,
        chainId: 10143n,
        nonce: 0,
        gasLimit: 50000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
        value: 32n,
        to: '0x' + '11'.repeat(20),
        data: '0x504f4e4402' + toHex(paymentCommitment(digest, 0)),
      },
    )
    const tx = Transaction.from(raw)
    const delivery = encodeFrame(
      { typeId: 1, schemaVersion: 1, minReaderVersion: 1 },
      cborMap([
        [0, NETWORK],
        [
          1,
          cborMap([
            [0, 1],
            [1, botCurrent.stampKey.keyBytes],
          ]),
        ],
        [2, sealed.payload],
        [3, digest],
        [
          4,
          [
            cborMap([
              [0, 0],
              [1, getBytes(tx.hash!)],
              [2, getBytes('0x' + tx.value.toString(16).padStart(64, '0'))],
              [3, getBytes('0x' + '11'.repeat(20))],
              [4, paymentCommitment(digest, 0)],
            ]),
          ],
        ],
      ]),
    )
    writeFileSync(
      join(location, 'inbox.json'),
      JSON.stringify([
        { delivery: toHex(delivery), context: toHex(sealed.context) },
      ]),
    )
  }, 60000)
  afterEach(() => rmSync(location, { recursive: true, force: true }))

  it('publishes its own self-signed entry on first start from a roots path, a relay and state directories alone', () => {
    const output = firstStart.child.stdout + firstStart.child.stderr
    // Asked the relay who it is, found no entry for its key, signed and stored revision zero.
    expect(firstStart.summary.directory).toEqual([
      'GET /relay/v1/info',
      `GET ${headOf(botSubject)}`,
      `PUT ${headOf(botSubject)}`,
    ])
    expect(firstStart.summary.other).toEqual([])
    const order = [
      '[bot] persisted state loaded',
      '[bot] canonical stamp account',
      '[bot] directory entry published',
      '[bot] canonical wallet correlation complete',
      'Polling the canonical inbox',
    ].map(line => output.indexOf(line))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(output).toContain(`Bot Frank identity address: ${botAddress}`)
    expect(
      JSON.parse(readFileSync(join(location, 'handoff.json'), 'utf8')),
    ).toEqual({ address: botAddress })
    secrets(output)
  })

  it('opens state, then the wallet, adopts its entry, correlates, then answers one canonical text from a sender it was never told about with one inference and one retained envelope', async () => {
    const first = run()
    const output = first.child.stdout + first.child.stderr
    expect({ status: first.child.status, ...first.summary }).toMatchObject({
      status: 0,
      generations: 1,
    })
    // Besides the directory routes, the only requests are the wallet funding its own inventory
    // through the relay's RPC proxy, which is down here: no message was submitted.
    expect(first.summary.other.length).toBeGreaterThan(0)
    for (const request of first.summary.other)
      expect(request).toContain(`${RELAY}/chain-rpc/`)
    // Its own entry is adopted from the relay, not signed again; the sender's entry is read
    // from the relay by the key the envelope names.
    expect(first.summary.directory).toEqual([
      'GET /relay/v1/info',
      `GET ${headOf(botSubject)}`,
      `GET ${headOf(sender.subject)}`,
    ])
    const order = [
      '[bot] persisted state loaded',
      '[bot] canonical stamp account',
      '[bot] directory entry published',
      '[bot] canonical wallet correlation complete',
      `[bot] response ${turn} held: inventory-unavailable`,
    ].map(line => output.indexOf(line))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    secrets(output)
    const saved = await withState(state => {
      expect(state.getResponse(turn)).toMatchObject({
        phase: 'response-ready',
        senderAddress: sender.address,
        senderPubKeyHex: sender.subject,
      })
      expect(state.pendingInbox()).toEqual([])
      expect(state.hasProcessed(turn)).toBe(false)
      return state.getCoupling(turn)
    })
    expect(saved).toMatchObject({
      phase: 'envelope-ready',
      binding: {
        network: NETWORK,
        chainId: '10143',
        senderSubject: botSubject,
        recipientSubject: sender.subject,
        recipientT1: sender.t1,
      },
    })

    // Restart with the same record still in the relay inbox: no second inference or envelope.
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(restart.child.stdout).toContain(
      '[bot] canonical wallet correlation complete',
    )
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
    expect(relayEntries()).toHaveLength(2)
  }, 90000)

  it('gives no reply and pays nothing when the entry served for the sender is signed by another key', async () => {
    const mallory = testAccount(41)
    const seconds = BigInt(Math.floor(Date.now() / 1000))
    const forged = mallory.sign({
      network: NETWORK,
      revision: 0n,
      predecessor: null,
      issuedAt: { seconds: seconds - 60n, nanoseconds: 0 },
      expiresAt: { seconds: seconds + 86_400n, nanoseconds: 0 },
      relay: createFakeRelay({ endpoint: RELAY }).binding,
      claimSubject: sender.subject,
    })
    const refused = run({
      QWEN_FIXTURE_FORGED: toHex(forged),
      QWEN_FIXTURE_FORGED_SUBJECT: sender.subject,
    })
    const output = refused.child.stdout + refused.child.stderr
    expect({ status: refused.child.status, ...refused.summary }).toMatchObject({
      status: 0,
      generations: 0,
      // Not even inventory funding was attempted.
      other: [],
    })
    expect(refused.summary.pages).toBeGreaterThan(0)
    expect(output).toContain(
      `[bot] directory entry of ${sender.address} not usable: invalid`,
    )
    secrets(output)
    await withState(state => {
      expect(state.getResponse(turn)).toBeUndefined()
      expect(state.getCoupling(turn)).toBeUndefined()
      // Imported, never opened, never answered.
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        turn,
      ])
    })
  }, 60000)

  it('SIGKILL right after the envelope is saved leaves one envelope that the restarted CLI reuses without inference', async () => {
    const killed = run({ QWEN_CANONICAL_CRASH: 'envelope' })
    expect(killed.child.signal).toBe('SIGKILL')
    const saved = await withState(state => state.getCoupling(turn))
    expect(saved?.phase).toBe('envelope-ready')
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
  }, 90000)

  it('keeps the peer denylist effective: a denylisted account with a valid entry is imported but never answered', async () => {
    const denied = run({ FRANK_BOT_PEER_DENYLIST: sender.address })
    expect({ status: denied.child.status, ...denied.summary }).toMatchObject({
      status: 0,
      generations: 0,
    })
    await withState(state => {
      expect(state.getResponse(turn)).toBeUndefined()
      expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
        turn,
      ])
    })
    secrets(denied.child.stdout + denied.child.stderr)
  }, 60000)

  it('reads no mail and answers nothing while its relay is down at startup, then starts and answers once the relay is back', async () => {
    // The relay never answers: the process keeps retrying and is stopped from outside.
    const waiting = run({ QWEN_FIXTURE_RELAY_DOWN_FOR: '1000' }, 6000)
    expect(waiting.child.status).not.toBe(0)
    expect(waiting.child.stderr).toContain(
      '[bot] directory entry not published: the relay could not be reached (unreachable); retrying in 1000 ms',
    )
    expect(waiting.child.stderr).toContain('retrying in 2000 ms')
    const stalled = waiting.child.stdout + waiting.child.stderr
    expect(stalled).not.toContain('directory entry published')
    expect(stalled).not.toContain('canonical wallet correlation')
    expect(stalled).not.toContain('Polling the canonical inbox')
    await withState(state => {
      // The waiting message was never read from the inbox, let alone answered.
      expect(state.pendingInbox()).toEqual([])
      expect(state.getResponse(turn)).toBeUndefined()
    })
    secrets(stalled)

    // The relay fails once more, then answers: one retry, then the normal start.
    const back = run({ QWEN_FIXTURE_RELAY_DOWN_FOR: '1' })
    expect({ status: back.child.status, ...back.summary }).toMatchObject({
      status: 0,
      down: 1,
      generations: 1,
    })
    expect(back.child.stderr).toContain(
      '[bot] directory entry not published: the relay could not be reached (unreachable); retrying in 1000 ms',
    )
    expect(back.child.stderr).not.toContain('retrying in 2000 ms')
    const order = [
      '[bot] directory entry published',
      '[bot] canonical wallet correlation complete',
      'Polling the canonical inbox',
    ].map(line => back.child.stdout.indexOf(line))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(back.child.stdout + back.child.stderr).toContain(
      `[bot] response ${turn} held: inventory-unavailable`,
    )
    secrets(back.child.stdout + back.child.stderr)
    expect((await withState(state => state.getResponse(turn)))?.phase).toBe(
      'response-ready',
    )
  }, 90000)

  it('creates its roots file (0600) on first run when the path is missing, logs only the path, and is the same account on the next start', () => {
    const rootsPath = join(location, 'fresh', 'roots.json')
    const fresh = {
      QWEN_BOT_CANONICAL_ROOTS_JSON: rootsPath,
      QWEN_BOT_STATE_DIR: join(location, 'fresh', 'state'),
      QWEN_BOT_WALLET_STATE_DIR: join(location, 'fresh', 'wallet'),
      QWEN_BOT_HANDOFF_JSON: join(location, 'fresh', 'handoff.json'),
      QWEN_FIXTURE_RELAY: join(location, 'fresh', 'relay.json'),
      QWEN_FIXTURE_INBOX: undefined,
    }
    const first = run(fresh)
    const output = first.child.stdout + first.child.stderr
    expect(first.child.status).toBe(0)
    expect(statSync(rootsPath).mode & 0o777).toBe(0o600)
    const contents = readFileSync(rootsPath, 'utf8')
    const created = Object.values(JSON.parse(contents).roots) as string[]
    expect(created).toHaveLength(3)
    expect(new Set(created).size).toBe(3)
    expect(output).toContain(
      `[bot] created canonical roots file at ${rootsPath}`,
    )
    for (const root of created) expect(output).not.toContain(root)
    // A new account, not the fixture one, with its own published entry.
    const address = JSON.parse(
      readFileSync(fresh.QWEN_BOT_HANDOFF_JSON, 'utf8'),
    ).address as string
    expect(address).not.toBe(botAddress)
    expect(first.summary.directory.map((r: string) => r.slice(0, 3))).toEqual([
      'GET',
      'GET',
      'PUT',
    ])

    // Next start: the file is reused untouched and the same entry is adopted.
    const second = run(fresh)
    const again = second.child.stdout + second.child.stderr
    expect(second.child.status).toBe(0)
    expect(readFileSync(rootsPath, 'utf8')).toBe(contents)
    expect(again).not.toContain('created canonical roots file')
    expect(again).toContain(`Bot Frank identity address: ${address}`)
    expect(second.summary.directory.map((r: string) => r.slice(0, 3))).toEqual([
      'GET',
      'GET',
    ])
    for (const root of created) expect(again).not.toContain(root)

    // An existing file that others can read is refused, never replaced.
    chmodSync(rootsPath, 0o644)
    const refused = run(fresh)
    expect(refused.child.status).toBe(1)
    expect(refused.child.stderr).toContain(
      'QWEN BOT REFUSING TO START: roots-file-permissions',
    )
    expect(refused.summary).toMatchObject({ generations: 0, pages: 0 })
    expect(refused.summary.directory).toEqual([])
    expect(readFileSync(rootsPath, 'utf8')).toBe(contents)
  }, 90000)

  it('refuses a relay URL that is not an HTTPS root origin before creating roots or opening any state', () => {
    for (const url of ['http://127.0.0.1:8098', `${RELAY}/path`, undefined]) {
      const refused = run({
        E2E_DEMO_RELAY_URL: url,
        QWEN_BOT_CANONICAL_ROOTS_JSON: join(location, 'unused', 'roots.json'),
        QWEN_BOT_STATE_DIR: join(location, 'unused', 'state'),
        QWEN_BOT_WALLET_STATE_DIR: join(location, 'unused', 'wallet'),
      })
      expect(refused.child.status).toBe(1)
      expect(refused.child.stderr).toContain(
        'QWEN BOT REFUSING TO START: relay-url-not-https-origin',
      )
      expect(refused.summary).toMatchObject({ generations: 0, pages: 0 })
    }
    expect(existsSync(join(location, 'unused'))).toBe(false)
  }, 60000)
})
