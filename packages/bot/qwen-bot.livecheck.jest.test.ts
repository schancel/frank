import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
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

// #703: the real CLI in canonical reply mode. The existing process fixture still supplies the
// local mailbox/identity/prompt stand-ins, but the canonical composition, typed wallet owner,
// shared producer, directory admission, workflow and both Level roots are the production ones.
// The typed owner has no funded inventory here, so no payment is signed or sent: this proves
// startup sequencing, one inference, one retained envelope and secret-free output, not delivery.
import { writeFileSync } from 'fs'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'

const CANONICAL_BOT = '0x' + 'ab'.repeat(20)
const CANONICAL_PEER = '0x' + 'cd'.repeat(20)
const CANONICAL_RELAY = 'http://127.0.0.1:8098'
const packages = join(__dirname, '..')

function directoryModuleSource(): string {
  const abs = (path: string) => JSON.stringify(join(packages, path))
  return `
    const { mkdtempSync, rmSync } = require('fs')
    const { tmpdir } = require('os')
    const { join } = require('path')
    const { createMonadWalletMaterial } = require(${abs(
      'wallet/monad-wallet-material.ts',
    )})
    const { openNodeDirectoryStore } = require(${abs(
      'directory-admission/src/node.ts',
    )})
    const vectors = require(${abs('domain-roots/vectors/domain-roots-v1.json')})
    const roots = index => {
      const one = purpose => ({
        registry: 'frank-domain-roots-v1',
        purpose,
        bytes: new Uint8Array(Buffer.from(vectors.vectors[index].outputs[purpose], 'hex')),
      })
      return {
        evm: one('evm-wallet'),
        authentication: one('identity-authentication'),
        messaging: one('messaging-encryption'),
      }
    }
    exports.openQwenCanonicalDirectory = async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'qwen-cli-directory-'))
      const enroll = async (index, binding) => {
        const material = createMonadWalletMaterial(roots(index))
        const tuple = label => ({
          processId: label,
          origin: 'https://' + label + '.example',
          tuple: {
            relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
            endpoint: 'https://' + label + '.example',
            identity: {
              keyType: 1,
              keyBytes: material.canonicalRoles.publicGenerationZeroPoints().auth,
            },
            expiry: { seconds: 3700n, nanoseconds: 0 },
            unknownFields: new Map(),
          },
        })
        const input = {
          networkTag: 'MONT',
          network: 'monad-testnet',
          chainId: 10143n,
          issuedAt: { seconds: 100n, nanoseconds: 0 },
          expiresAt: { seconds: 3700n, nanoseconds: 0 },
          now: { seconds: 100n, nanoseconds: 0 },
          relayA: tuple('a'),
          relayB: tuple('b'),
          subjectBinding: binding,
        }
        const exported = material.canonicalRoles.prepareRevisionZero(input)
        const store = await openNodeDirectoryStore({
          location: join(scratch, binding),
          anchor: {
            network: 'monad-testnet',
            subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
            revisionZero: exported.t1,
          },
          mode: { kind: 'new' },
        })
        const current = await store.enroll(
          [{ statement: exported.statement, attestation: exported.attestation }],
          { now: input.now, relay: binding === 'A' ? input.relayA.tuple : input.relayB.tuple },
        )
        material.dispose()
        return { store, current }
      }
      const sender = await enroll(0, 'A'), recipient = await enroll(1, 'B')
      return {
        currents: async peer =>
          peer.toLowerCase() === ${JSON.stringify(CANONICAL_PEER)}
            ? { senderCurrent: sender.current, recipientCurrent: recipient.current }
            : undefined,
        close: async () => {
          await sender.store.close()
          await recipient.store.close()
          rmSync(scratch, { recursive: true, force: true })
        },
      }
    }
  `
}

function runCanonical(location: string, crash?: string) {
  const common = JSON.stringify(join(__dirname, 'qwen-bot-common.ts'))
  const child = spawnSync(
    process.execPath,
    [
      '--require',
      require.resolve('tsx/cjs'),
      '-e',
      `
      // Load the production composition (and its real wallet dependencies) first, then let the
      // unchanged process fixture overlay only its own legacy stand-ins on top of it.
      const real = require(${common})
      const filename = require.resolve(${common})
      let entry = require.cache[filename]
      Object.defineProperty(require.cache, filename, {
        configurable: true,
        enumerable: true,
        get: () => entry,
        set: value => {
          entry = { ...value, exports: { ...real, ...value.exports } }
        },
      })
      require(${JSON.stringify(join(__dirname, 'qwen-bot-process.fixture.ts'))})
      if (process.env.QWEN_CANONICAL_CRASH === 'envelope') {
        const { QwenBotStateStore } = require(${JSON.stringify(
          join(__dirname, 'qwen-bot-state.ts'),
        )})
        const save = QwenBotStateStore.prototype.saveCoupling
        QwenBotStateStore.prototype.saveCoupling = async function (...args) {
          const result = await save.apply(this, args)
          process.kill(process.pid, 'SIGKILL')
          return result
        }
      }
      `,
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        PATH: process.env.PATH,
        TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
        QWEN_BOT_MODE: 'stub',
        QWEN_BOT_MAX_REPLIES: '1',
        QWEN_BOT_MAX_GREETINGS: '0',
        QWEN_BOT_IDLE_TIMEOUT_MS: '300',
        QWEN_BOT_POLL_INTERVAL_MS: '1',
        QWEN_BOT_MESSAGE_SINCE_MS: '0',
        QWEN_BOT_STATE_DIR: location,
        QWEN_BOT_WALLET_STATE_DIR: join(location, 'wallet'),
        QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
        QWEN_BOT_CANONICAL_ROOTS_JSON: join(location, 'roots.json'),
        QWEN_BOT_CANONICAL_DIRECTORY_MODULE: join(location, 'directory.cjs'),
        E2E_DEMO_RELAY_URL: CANONICAL_RELAY,
        MONAD_RPC_CHAIN: 'monad-testnet',
        MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
        FRANK_NETWORK_TAG: 'MONT',
        CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
        QWEN_PROCESS_SCENARIO: 'empty',
        QWEN_CANONICAL_CRASH: crash,
      },
    },
  )
  return { child, summary: counters(child) }
}

describe('#703 production CLI in canonical reply mode', () => {
  let location: string
  const turn = fixtureHash('canonical-turn')
  const inbox = {
    botAddress: CANONICAL_BOT,
    networkTag: 'MONT',
    relayBaseUrl: CANONICAL_RELAY,
  }
  const withState = async <T>(
    use: (state: QwenBotStateStore) => Promise<T> | T,
  ): Promise<T> => {
    const state = new QwenBotStateStore(location)
    await state.Open()
    try {
      return await use(state)
    } finally {
      await state.Close()
    }
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
    writeFileSync(join(location, 'directory.cjs'), directoryModuleSource())
    // One admitted inbound turn, already durably imported (#704 owns import itself).
    await withState(async state => {
      await state.initializeInbox(inbox, 0)
      expect(
        await state.importInboxPage(inbox, 0, [
          {
            payloadHashHex: turn,
            encryptedPayloadHex: Buffer.from(
              `ciphertext:${CANONICAL_PEER}`,
            ).toString('hex'),
            timestamp: 1,
            networkTagHex: Buffer.from('MONT').toString('hex'),
          },
        ]),
      ).toBe('committed')
    })
  })
  afterEach(() => rmSync(location, { recursive: true, force: true }))

  const secrets = (output: string) => {
    expect(output).not.toContain('PROCESS_PROMPT_SENTINEL')
    for (const root of Object.values(domainVectors.vectors[0].outputs))
      expect(output).not.toContain(root)
    expect(output).not.toContain('QWEN BOT FAILED')
  }

  it('opens Qwen state before the canonical wallet, correlates before any reply effect, infers once and reuses the one retained envelope after restart', async () => {
    const first = runCanonical(location)
    const output = first.child.stdout + first.child.stderr
    expect({ status: first.child.status, ...first.summary }).toMatchObject({
      status: 0,
      generations: 1,
      // The legacy combined randomized send is never invoked for a canonical reply.
      sends: 0,
      closed: 1,
    })
    const order = [
      '[bot] persisted state loaded',
      '[bot] canonical stamp account',
      '[bot] canonical wallet correlation complete',
      `[bot] response ${turn} held: intent-preparation-failed`,
    ].map(line => output.indexOf(line))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    secrets(output)
    const saved = await withState(state => {
      expect(state.getResponse(turn)?.phase).toBe('response-ready')
      expect(state.pendingInbox()).toEqual([])
      expect(state.hasProcessed(turn)).toBe(false)
      return state.getCoupling(turn)
    })
    expect(saved).toMatchObject({
      phase: 'envelope-ready',
      binding: { network: 'monad-testnet', chainId: '10143' },
    })

    const restart = runCanonical(location)
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
      closed: 1,
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(restart.child.stdout).toContain(
      '[bot] canonical wallet correlation complete',
    )
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
  }, 90000)

  it('SIGKILL right after the envelope is saved leaves one envelope that the restarted CLI reuses without inference', async () => {
    const killed = runCanonical(location, 'envelope')
    expect(killed.child.signal).toBe('SIGKILL')
    const saved = await withState(state => state.getCoupling(turn))
    expect(saved?.phase).toBe('envelope-ready')
    const restart = runCanonical(location)
    expect({ status: restart.child.status, ...restart.summary }).toMatchObject({
      status: 0,
      generations: 0,
      sends: 0,
    })
    secrets(restart.child.stdout + restart.child.stderr)
    expect(await withState(state => state.getCoupling(turn))).toEqual(saved)
  }, 90000)
})
