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

// #703/#778: the real CLI in canonical mode. Production code runs unmodified: configuration
// readers, installed directory (real Node stores behind the real directory client), typed wallet
// owner through the public bridge, shared producer and opener, both workflows and both Level
// roots. Only the relay is local: its Directory routes are a responder that stores and returns
// published heads, and the canonical inbox page read returns one prepared record. The typed
// owner has no funded inventory, so no payment is signed or sent: this proves sequencing, one
// inference, one retained envelope for the admitted sender and secret-free output, not delivery.
import { writeFileSync } from 'fs'
import { Transaction, Wallet, getBytes } from 'ethers'
import {
  cborMap,
  encodeFrame,
  paymentCommitment,
  recipientPayloadDigest,
  toHex,
} from '@frank/codec'
import {
  directMessageText,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import {
  prepareQwenPublicExport,
  readQwenBootstrapPolicy,
  type QwenPublicExportFile,
} from './qwen-bot-common'

function canonicalPreload(): string {
  const at = (file: string) => JSON.stringify(join(__dirname, file))
  const mailbox = JSON.stringify(
    join(__dirname, '../cashweb/relay/monad-mailbox-client.ts'),
  )
  return `
    const { readFileSync, existsSync } = require('fs')
    const counters = { generations: 0, pages: 0, directory: [], other: [] }
    process.on('exit', () =>
      console.log('QWEN_PROCESS_FIXTURE ' + JSON.stringify(counters)))
    // Local relay Directory routes: store and return published heads only.
    const heads = new Map(Object.entries(JSON.parse(
      readFileSync(process.env.QWEN_FIXTURE_HEADS, 'utf8'))))
    globalThis.fetch = async (url, init) => {
      const match = /^https:\\/\\/a\\.example\\/directory\\/v1\\/([^/]+)\\/([^/]+)\\/head$/.exec(url)
      if (!match) { counters.other.push(init.method + ' ' + url); throw new Error('unreachable') }
      counters.directory.push(init.method)
      const key = match[1] + '/' + match[2]
      if (init.method === 'PUT') heads.set(key, Buffer.from(init.body).toString('hex'))
      const head = heads.get(key)
      let sent = false
      return {
        url, status: head ? 200 : 404,
        headers: { get: name => name.toLowerCase() === 'content-type'
          ? 'application/vnd.frank.cbor'
          : name.toLowerCase() === 'x-frank-directory-evidence' ? 'fresh-current' : null },
        body: { getReader: () => ({
          read: async () => sent || !head ? { done: true }
            : ((sent = true), { done: false, value: new Uint8Array(Buffer.from(head, 'hex')) }),
          cancel: async () => undefined, releaseLock: () => undefined }) },
      }
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

describe('#703/#778 production CLI in canonical mode', () => {
  const NETWORK = 'monad-testnet'
  let location: string
  let bot: QwenPublicExportFile
  let ui: QwenPublicExportFile
  let turn: string

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
    QWEN_BOT_CANONICAL_POLICY_JSON: join(location, 'bootstrap-policy.json'),
    QWEN_BOT_CANONICAL_BUNDLE_JSON: join(location, 'approved-bundle.json'),
    MONAD_RPC_CHAIN: 'monad-testnet',
    QWEN_FIXTURE_HEADS: join(location, 'heads.json'),
    QWEN_FIXTURE_INBOX: join(location, 'inbox.json'),
    ...extra,
  })
  const run = (extra: Record<string, string | undefined> = {}) => {
    const child = spawnSync(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), '-e', canonicalPreload()],
      { encoding: 'utf8', timeout: 30000, env: env(extra) },
    )
    return { child, summary: counters(child) }
  }
  const withState = async <T>(
    use: (state: QwenBotStateStore) => Promise<T> | T,
  ): Promise<T> => {
    const state = new QwenBotStateStore(join(location, 'state'))
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
    const now = BigInt(Date.now()) * 1_000_000n
    const relayKey = Buffer.from(
      createMonadWalletMaterial(
        roots(1),
      ).canonicalRoles!.publicGenerationZeroPoints().auth,
    ).toString('hex')
    const tuple = (label: 'a' | 'b') => ({
      processId: `relay-${label}`,
      id: (label === 'a' ? '01' : '02').repeat(16),
      endpoint: `https://${label}.example`,
      key: relayKey,
      expiryNs: (now + 7_200_000_000_000n).toString(),
    })
    writeFileSync(
      join(location, 'bootstrap-policy.json'),
      JSON.stringify({
        version: 1,
        kind: 'directory-bootstrap-process-policy',
        networkTag: 'MONT',
        network: NETWORK,
        chainId: '10143',
        participants: ['relay-a', 'relay-b', 'bot'].map(processId => ({
          processId,
          origin: `https://${
            processId.slice(-1) === 't' ? 'bot' : processId.slice(-1)
          }.example`,
          trustReference: processId,
        })),
        relayTuples: [tuple('a'), tuple('b')],
        exportValidity: {
          issuedAtNs: (now - 60_000_000_000n).toString(),
          expiresAtNs: (now + 3_000_000_000_000n).toString(),
        },
        policyIdentity: 'aa'.repeat(32),
      }),
    )
    // The bot's export comes from the real CLI export path, as the operator would run it.
    const exported = run({
      QWEN_BOT_CANONICAL_EXPORT_JSON: join(location, 'bot-export.json'),
      QWEN_BOT_CANONICAL_HOME: 'relay-a',
      QWEN_FIXTURE_HEADS: (() => {
        writeFileSync(join(location, 'heads.json'), '{}')
        return join(location, 'heads.json')
      })(),
    })
    expect(exported.child.status).toBe(0)
    secrets(exported.child.stdout + exported.child.stderr)
    bot = JSON.parse(readFileSync(join(location, 'bot-export.json'), 'utf8'))
    const policy = readQwenBootstrapPolicy(
      join(location, 'bootstrap-policy.json'),
    )
    ui = prepareQwenPublicExport({
      roots: roots(1),
      policy,
      home: 'relay-a',
      nowNs: now,
    })
    const { processId: _process, ...relay } = tuple('a')
    writeFileSync(
      join(location, 'approved-bundle.json'),
      JSON.stringify({
        version: 1,
        kind: 'operator-approved-directory-bundle',
        bootstrapPolicyIdentity: policy.policyIdentity,
        participants: [],
        subjects: [['bot', bot] as const, ['ui', ui] as const].map(
          ([role, file]) => ({
            role,
            network: file.network,
            subjectP: file.subjectP,
            revisionZeroT1: file.revisionZeroT1,
            statement: file.statement,
            attestation: file.attestation,
            homeProcessId: file.homeProcessId,
            relay,
          }),
        ),
        bundleIdentity: 'bb'.repeat(32),
        expectedConfigurationIdentity: 'cc'.repeat(32),
      }),
    )
    // The typed UI account has published its own revision zero to the relay.
    writeFileSync(
      join(location, 'heads.json'),
      JSON.stringify({
        [`${NETWORK}/${ui.subjectP}`]: Buffer.from(
          ui.attestation,
          'base64url',
        ).toString('hex'),
      }),
    )
    // One canonical text from that account, sealed by the real producer for the bot.
    const stamp = (ns: bigint) => ({
      seconds: ns / 1_000_000_000n,
      nanoseconds: Number(ns % 1_000_000_000n),
    })
    const context = {
      now: stamp(now),
      relay: {
        relayId: new Uint8Array(Buffer.from(relay.id, 'hex')),
        endpoint: relay.endpoint,
        identity: {
          keyType: 1,
          keyBytes: new Uint8Array(Buffer.from(relay.key, 'hex')),
        },
        expiry: stamp(BigInt(relay.expiryNs)),
        unknownFields: new Map(),
      },
    }
    const current = async (file: QwenPublicExportFile, label: string) => {
      const store = await openNodeDirectoryStore({
        location: join(location, `scratch-${label}`),
        anchor: {
          network: NETWORK,
          subject: {
            keyType: 1,
            keyBytes: new Uint8Array(Buffer.from(file.subjectP, 'hex')),
          },
          revisionZero: new Uint8Array(Buffer.from(file.revisionZeroT1, 'hex')),
        },
        mode: { kind: 'new' },
      })
      try {
        return await store.enroll(
          [
            {
              statement: new Uint8Array(
                Buffer.from(file.statement, 'base64url'),
              ),
              attestation: new Uint8Array(
                Buffer.from(file.attestation, 'base64url'),
              ),
            },
          ],
          context,
        )
      } finally {
        await store.close()
      }
    }
    const botCurrent = await current(bot, 'bot'),
      uiCurrent = await current(ui, 'ui')
    const uiMaterial = createMonadWalletMaterial(roots(1))
    const sealed = prepareDirectMessage({
      network: NETWORK,
      senderCurrent: uiCurrent,
      recipientCurrent: botCurrent,
      messageId: new Uint8Array(16).fill(7),
      items: [directMessageText('PROCESS_PROMPT_SENTINEL')],
      roles: uiMaterial.canonicalRoles!.create(NETWORK, uiCurrent),
    })
    uiMaterial.dispose()
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

  it('writes a public-only export without opening state, a wallet or the relay', () => {
    expect(Object.keys(bot).sort()).toEqual(Object.keys(ui).sort())
    expect(bot.kind).toBe('public-revision-zero-export')
    for (const root of Object.values(domainVectors.vectors[0].outputs))
      expect(JSON.stringify(bot)).not.toContain(root)
    expect(existsSync(join(location, 'state'))).toBe(false)
    expect(existsSync(join(location, 'wallet'))).toBe(false)
  })

  it('opens state, then the directory, then the wallet, correlates, then answers one canonical text from the installed account with one inference and one retained envelope', async () => {
    const first = run()
    const output = first.child.stdout + first.child.stderr
    expect({ status: first.child.status, ...first.summary }).toMatchObject({
      status: 0,
      generations: 1,
      // The bot published its own revision zero and read its peer; nothing else was contacted.
      other: [],
    })
    expect(first.summary.directory[0]).toBe('PUT')
    const order = [
      '[bot] persisted state loaded',
      '[bot] canonical stamp account',
      '[bot] canonical wallet correlation complete',
      `[bot] response ${turn} held: intent-preparation-failed`,
    ].map(line => output.indexOf(line))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(output).toContain(
      `Bot Frank identity address: ${bot.authAddress.toLowerCase()}`,
    )
    secrets(output)
    const saved = await withState(state => {
      expect(state.getResponse(turn)).toMatchObject({
        phase: 'response-ready',
        senderAddress: ui.authAddress.toLowerCase(),
        senderPubKeyHex: ui.subjectP,
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
        senderSubject: bot.subjectP,
        recipientSubject: ui.subjectP,
        recipientT1: ui.revisionZeroT1,
      },
    })

    // Restart with the same record still in the relay inbox: no second inference or envelope.
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      other: [],
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(restart.child.stdout).toContain(
      '[bot] canonical wallet correlation complete',
    )
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
  }, 90000)

  it('SIGKILL right after the envelope is saved leaves one envelope that the restarted CLI reuses without inference', async () => {
    const killed = run({ QWEN_CANONICAL_CRASH: 'envelope' })
    expect(killed.child.signal).toBe('SIGKILL')
    const saved = await withState(state => state.getCoupling(turn))
    expect(saved?.phase).toBe('envelope-ready')
    const restart = run()
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      other: [],
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
  }, 90000)

  it('refuses to start when the approved bundle is missing, before opening any state', () => {
    rmSync(join(location, 'approved-bundle.json'))
    const refused = run()
    expect(refused.child.status).toBe(1)
    expect(refused.summary).toMatchObject({ generations: 0, pages: 0 })
    expect(existsSync(join(location, 'state'))).toBe(false)
    expect(existsSync(join(location, 'wallet'))).toBe(false)
  }, 60000)
})
