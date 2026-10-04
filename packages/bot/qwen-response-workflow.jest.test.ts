import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  QwenBotStateStore,
  QwenResponseContext,
  QwenResponseRow,
} from './qwen-bot-state'
import { QwenResponseWorkflow } from './qwen-response-workflow'

const PEER = '0x52908400098527886E0F7030069857D2E4169EE7'
const context: QwenResponseContext = {
  botAddress: 'bot',
  fundingAddress: 'funding',
  networkTag: 'fixture',
  relayBaseUrl: 'http://127.0.0.1:1',
  stampValueWei: '1',
}
const input = {
  payloadHashHex: '01',
  senderAddress: PEER,
  senderPubKeyHex: '02',
  prompt: 'PROMPT_SENTINEL',
}
const receipt = { payloadHashHex: '03', txHashes: ['tx-fixture'] }
type ResponseBatch = (
  operations: Array<{ type: string; key: string; value: string }>,
  options: { sync: boolean },
) => Promise<void>
type ResponseDatabase = { batch: ResponseBatch }
let location: string
let state: QwenBotStateStore
let logs: string[]

beforeEach(async () => {
  location = mkdtempSync(join(tmpdir(), 'qwen-response-'))
  state = new QwenBotStateStore(location)
  await state.Open()
  logs = []
  jest.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(JSON.stringify(args))
  })
  jest.spyOn(console, 'warn').mockImplementation((...args) => {
    logs.push(JSON.stringify(args))
  })
})

afterEach(async () => {
  jest.restoreAllMocks()
  await state.Close()
  rmSync(location, { recursive: true, force: true })
})

async function reopen() {
  await state.Close()
  state = new QwenBotStateStore(location)
  await state.Open()
}

function workflow(overrides: Partial<QwenResponseContext> = {}) {
  const reply = jest.fn(async () => ({
    content: 'REPLY_SENTINEL',
    reasoning: 'REASONING_SENTINEL',
  }))
  const send = jest.fn(async () => receipt)
  return {
    reply,
    send,
    run: new QwenResponseWorkflow({
      state,
      context: { ...context, ...overrides },
      systemPrompt: 'SYSTEM_SENTINEL',
      generator: { reply },
      send,
    }),
  }
}

it('retains one conversation and bounded terminal records across 32/64 turns and reopen', async () => {
  for (const total of [32, 64]) {
    const current = workflow()
    for (let turn = total - 32; turn < total; turn++) {
      await current.run.respond({
        ...input,
        payloadHashHex: turn.toString(16).padStart(4, '0'),
      })
    }
    await reopen()
    const rows = Array.from(
      { length: total },
      (_, turn) => state.getResponse(turn.toString(16).padStart(4, '0'))!,
    )
    const retainedHistory = rows.reduce(
      (count, row) =>
        count +
        ((row as unknown as { proposedHistory?: unknown[] }).proposedHistory
          ?.length ?? 0),
      0,
    )
    expect(retainedHistory).toBe(0)
    expect(state.getConversation(PEER)).toHaveLength(2 * total + 1)
    const firstSize = JSON.stringify(rows[0]).length
    const replay = workflow()
    for (const row of rows) {
      expect(row).not.toHaveProperty('response')
      expect(JSON.stringify(row)).toHaveLength(firstSize)
      expect(await replay.run.resume(row.payloadHashHex)).toBe('duplicate')
      expect(state.hasProcessed(row.payloadHashHex)).toBe(true)
    }
    expect(replay.reply).not.toHaveBeenCalled()
    expect(replay.send).not.toHaveBeenCalled()
  }
})

it.each([
  'model-started',
  'response-ready',
  'send-started',
  'confirmed',
] as const)(
  'failed %s write cannot publish success or cause an unsafe second effect',
  async phase => {
    const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batch = db.batch.bind(db)
    const batchSpy = jest.spyOn(db, 'batch').mockImplementation(((
      operations: Array<{ type: string; key: string; value: string }>,
      options: { sync: boolean },
    ) => {
      if (JSON.parse(operations[0].value).phase === phase)
        return Promise.reject(new Error('DISK_ERROR_BODY_SENTINEL'))
      return batch(operations, options)
    }) as typeof db.batch)
    const first = workflow()
    await expect(first.run.respond(input)).rejects.toThrow('persistence failed')
    expect(first.send).toHaveBeenCalledTimes(phase === 'confirmed' ? 1 : 0)
    expect(state.hasProcessed(input.payloadHashHex)).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    expect(state.getResponse(input.payloadHashHex)?.phase).toBe(
      {
        'model-started': undefined,
        'response-ready': 'model-started',
        'send-started': 'response-ready',
        'confirmed': 'send-started',
      }[phase],
    )
    // The current process fails closed after any uncertain write, even on another peer.
    await expect(
      first.run.respond({
        ...input,
        payloadHashHex: '04',
        senderAddress: 'other',
      }),
    ).rejects.toThrow('storage unavailable')
    batchSpy.mockRestore()
    await reopen()
    expect(state.hasProcessed(input.payloadHashHex)).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    const restart = workflow()
    if (phase !== 'model-started') {
      const result = await restart.run.resume(input.payloadHashHex)
      expect(result).toBe(phase === 'send-started' ? 'confirmed' : 'held')
      expect(restart.reply).not.toHaveBeenCalled()
      expect(restart.send).toHaveBeenCalledTimes(
        phase === 'send-started' ? 1 : 0,
      )
    }
    expect(logs.join()).not.toContain('SENTINEL')
  },
)

it('commits receipt, history and processed marker in one fsynced batch; replay has no effects', async () => {
  const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
  const batchSpy = jest.spyOn(db, 'batch')
  const first = workflow()
  expect(await first.run.respond(input)).toBe('confirmed')
  expect(batchSpy).toHaveBeenLastCalledWith(
    [
      expect.objectContaining({ type: 'put', key: 'response:v1:01' }),
      expect.objectContaining({
        type: 'put',
        key: `conversation:${PEER.toLowerCase()}`,
      }),
      { type: 'put', key: 'processed:01', value: '1' },
    ],
    { sync: true },
  )
  expect(state.getResponse('01')).toMatchObject({ phase: 'confirmed', receipt })
  const saved = state.getResponse('01') as Extract<
    QwenResponseRow,
    { phase: 'confirmed' }
  >
  saved.receipt.txHashes.push('mutation')
  expect(state.getResponse('01')).toMatchObject({ receipt })
  expect(saved).not.toHaveProperty('proposedHistory')
  expect(state.getConversation(PEER)?.[0].content).toBe('SYSTEM_SENTINEL')
  await reopen()
  const restart = workflow()
  expect(await restart.run.respond(input)).toBe('duplicate')
  expect(await restart.run.resume('01')).toBe('duplicate')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.getConversation(PEER)).toEqual([
    { role: 'system', content: 'SYSTEM_SENTINEL' },
    { role: 'user', content: 'PROMPT_SENTINEL' },
    { role: 'assistant', content: 'REPLY_SENTINEL' },
  ])
  expect(logs.join()).not.toContain('SENTINEL')
})

it('holds a send-started crash, blocks later turns for that peer across casing, and lets another peer progress', async () => {
  await state.beginResponse({ ...input, context })
  await state.saveResponse('01', 'REPLY_SENTINEL', [
    { role: 'assistant', content: 'REPLY_SENTINEL' },
  ])
  await state.startResponseSend('01')
  await reopen()
  const restart = workflow()
  expect(await restart.run.resume('01')).toBe('held')
  expect(
    await restart.run.respond({
      ...input,
      payloadHashHex: '04',
      senderAddress: PEER.toLowerCase(),
    }),
  ).toBe('held')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.hasProcessed('04')).toBe(false)
  expect(
    await restart.run.respond({
      ...input,
      payloadHashHex: '05',
      senderAddress: 'other',
    }),
  ).toBe('confirmed')
  expect(restart.send).toHaveBeenCalledTimes(1)
  expect(state.getConversation(PEER)).toBeUndefined()
  expect(logs.join()).toContain('send-outcome-unknown')
  expect(logs.join()).toContain('earlier-turn-unresolved')
  expect(logs.join()).not.toContain('SENTINEL')
})

it('holds a saved response if the sending account or policy changes', async () => {
  await state.beginResponse({ ...input, context })
  await state.saveResponse('01', 'REPLY_SENTINEL', [])
  await reopen()
  const restart = workflow({ fundingAddress: 'different-funding-account' })
  expect(await restart.run.resume('01')).toBe('held')
  expect(restart.reply).not.toHaveBeenCalled()
  expect(restart.send).not.toHaveBeenCalled()
  expect(state.getResponse('01')?.phase).toBe('response-ready')
  expect(logs.join()).toContain('account-or-send-context-changed')
})

it('recognizes legacy processed records without generating a new workflow', async () => {
  state.addProcessed('01')
  await reopen()
  const current = workflow()
  expect(await current.run.respond(input)).toBe('duplicate')
  expect(current.reply).not.toHaveBeenCalled()
  expect(current.send).not.toHaveBeenCalled()
  expect(state.getResponse('01')).toBeUndefined()
})

it.each(['response-ready', 'send-started', 'confirmed'] as const)(
  'a lost %s commit acknowledgement never publishes volatile success',
  async phase => {
    const db = (state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batch = db.batch.bind(db)
    const batchSpy = jest.spyOn(db, 'batch').mockImplementation((async (
      operations,
      options,
    ) => {
      await batch(operations, options)
      if (JSON.parse(operations[0].value).phase === phase)
        throw new Error('lost disk acknowledgement')
    }) as typeof db.batch)
    const first = workflow()
    await expect(first.run.respond(input)).rejects.toThrow('persistence failed')
    expect(state.hasProcessed('01')).toBe(false)
    expect(state.getConversation(PEER)).toBeUndefined()
    batchSpy.mockRestore()
    await reopen()
    expect(state.getResponse('01')?.phase).toBe(phase)
    const restart = workflow()
    expect(await restart.run.resume('01')).toBe(
      {
        'response-ready': 'confirmed',
        'send-started': 'held',
        'confirmed': 'duplicate',
      }[phase],
    )
    expect(restart.reply).not.toHaveBeenCalled()
    expect(restart.send).toHaveBeenCalledTimes(
      phase === 'response-ready' ? 1 : 0,
    )
  },
)

it.each(['response-ready', 'send-started'] as const)(
  'retains %s after a process is killed without Close or flush',
  async phase => {
    await state.Close()
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        require.resolve('tsx/cjs'),
        '-e',
        `
        const { QwenBotStateStore } = require(${JSON.stringify(
          join(__dirname, 'qwen-bot-state.ts'),
        )});
        (async () => {
          const state = new QwenBotStateStore(${JSON.stringify(location)});
          await state.Open();
          await state.beginResponse(${JSON.stringify({ ...input, context })});
          await state.saveResponse('01', 'REPLY_SENTINEL', [{ role: 'assistant', content: 'REPLY_SENTINEL' }]);
          ${
            phase === 'send-started'
              ? "await state.startResponseSend('01');"
              : ''
          }
          process.kill(process.pid, 'SIGKILL');
        })().catch(() => process.exit(2));
      `,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
        },
      },
    )
    state = new QwenBotStateStore(location)
    await state.Open()
    expect({
      status: child.status,
      signal: child.signal,
      stderr: child.stderr,
    }).toEqual({
      status: null,
      signal: 'SIGKILL',
      stderr: '',
    })
    expect(state.getResponse('01')?.phase).toBe(phase)
    const restart = workflow()
    expect(await restart.run.resume('01')).toBe(
      phase === 'response-ready' ? 'confirmed' : 'held',
    )
    expect(restart.reply).not.toHaveBeenCalled()
    expect(restart.send).toHaveBeenCalledTimes(
      phase === 'response-ready' ? 1 : 0,
    )
  },
)

// ---------------------------------------------------------------------------------------------
// #703: exact outbound envelope / wallet attempt coupling.
//
// These fixtures use the real shared producer (prepareDirectMessage), real Node directory
// admission over signed public evidence, the real canonical wallet client with its Level pool,
// bundle owner and attempt journal, and the real transport status decoder behind an injected
// fetch. Chain balances/fees are offline stubs and the relay is a local responder: this is not
// deployed payment, finality or relay-validity proof.
// ---------------------------------------------------------------------------------------------
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { JsonRpcProvider, getBytes } from 'ethers'
import {
  directMessageText,
  openDirectMessage,
  prepareDirectMessage,
} from '@frank/cashweb/relay/canonical-dm'
import {
  restoreCanonicalRequest,
  type CanonicalFetch,
} from '@frank/cashweb/relay/canonical-dm-transport'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import { MonadSubAccountPool } from '@frank/wallet/monad-account-pool'
import { SubAccountLeaseManager } from '@frank/wallet/monad-account-lease'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import { MonadChangePool } from '@frank/wallet/monad-change-pool'
import { MonadCanonicalStampClient } from '@frank/wallet/monad-stamp-client'
import type { PublicRevisionZeroInput } from '@frank/wallet/monad-wallet-handle'
import {
  canonicalWalletPublicBinding,
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import { LevelChangePoolStore } from '@frank/wallet/storage/level-change-pool-store'
import { LevelSubAccountPoolStore } from '@frank/wallet/storage/level-sub-account-pool-store'
import {
  openExistingPoolMonadTopicOwner,
  type MonadWalletOperationAdmission,
} from '@frank/wallet/storage/monad-wallet-bundle'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import type { QwenCanonicalSender } from './qwen-response-workflow'
import {
  QWEN_COUPLING_MAX_COUNT,
  QWEN_COUPLING_MAX_PAYLOAD_BYTES,
  qwenCouplingPrepared,
  type QwenCouplingRow,
} from './qwen-bot-state'

const NETWORK = 'monad-testnet'
const CANONICAL_STAMP_WEI = 32n
const canonicalContext: QwenResponseContext = {
  ...context,
  stampValueWei: CANONICAL_STAMP_WEI.toString(),
}
type RelayMode = 'delivered' | 'dead' | 'retained' | 'unreachable'

function fixtureRoots(index: number): MonadRootBundle {
  const outputs = domainVectors.vectors[index].outputs
  const root = <
    P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption',
  >(
    purpose: P,
  ) => ({
    registry: 'frank-domain-roots-v1' as const,
    purpose,
    bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

/** Opens (or reopens) both real Level roots under `root`. Directory admission is re-derived
 * from the same signed public evidence in a scratch store on every open. */
export async function openCanonicalFixture(
  root: string,
  options: { kill?: string; walletRoot?: string } = {},
) {
  const eventsPath = join(root, 'events.log')
  const record = (event: string) => appendFileSync(eventsPath, event + '\n')
  const dieAt = (point: string) => {
    if (options.kill === point) process.kill(process.pid, 'SIGKILL')
  }
  const material = createMonadWalletMaterial(fixtureRoots(0)),
    peer = createMonadWalletMaterial(fixtureRoots(1))
  const publicInput = (
    m: typeof material,
    subjectBinding: 'A' | 'B',
  ): PublicRevisionZeroInput => {
    const tuple = (label: string) => ({
      processId: label,
      origin: `https://${label}.example`,
      tuple: {
        relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
        endpoint: `https://${label}.example`,
        identity: {
          keyType: 1,
          keyBytes: m.canonicalRoles!.publicGenerationZeroPoints().auth,
        },
        expiry: { seconds: 3700n, nanoseconds: 0 },
        unknownFields: new Map(),
      },
    })
    return {
      networkTag: 'MONT',
      network: NETWORK,
      chainId: 10143n,
      issuedAt: { seconds: 100n, nanoseconds: 0 },
      expiresAt: { seconds: 3700n, nanoseconds: 0 },
      now: { seconds: 100n, nanoseconds: 0 },
      relayA: tuple('a'),
      relayB: tuple('b'),
      subjectBinding,
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-canonical-directory-'))
  const enroll = async (
    m: typeof material,
    binding: 'A' | 'B',
    label: string,
  ) => {
    const exported = m.canonicalRoles!.prepareRevisionZero(
      publicInput(m, binding),
    )
    const directory = await openNodeDirectoryStore({
      location: join(scratch, label),
      anchor: {
        network: NETWORK,
        subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
        revisionZero: exported.t1,
      },
      mode: { kind: 'new' },
    })
    const current = await directory.enroll(
      [{ statement: exported.statement, attestation: exported.attestation }],
      {
        now: exported.configuration.now,
        relay:
          binding === 'A'
            ? exported.configuration.relayA.tuple
            : exported.configuration.relayB.tuple,
      },
    )
    return { directory, current }
  }
  const sender = await enroll(material, 'A', 'sender'),
    recipient = await enroll(peer, 'B', 'recipient')

  const walletRoot = options.walletRoot ?? join(root, 'wallet')
  mkdirSync(walletRoot, { recursive: true })
  const subStore = new LevelSubAccountPoolStore(walletRoot),
    changeStore = new LevelChangePoolStore(walletRoot)
  await subStore.Open()
  await changeStore.Open()
  const pool = new MonadSubAccountPool({
      keyring: material.keyring,
      store: subStore,
    }),
    changePool = new MonadChangePool({
      keyring: material.changeKeyring,
      store: changeStore,
    })
  pool.ensureSize(4)
  await pool.flush()
  const leaseManager = new SubAccountLeaseManager(pool)
  let enclosed = false
  let queue: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(
    operation: (admission: MonadWalletOperationAdmission) => Promise<T>,
    canonical = true,
  ): Promise<T> => {
    const result = queue.then(async () => {
      enclosed = true
      try {
        return await (canonical
          ? walletState.runCanonicalOperation(operation)
          : walletState.runOperation(operation))
      } finally {
        enclosed = false
      }
    })
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  const walletState = await openExistingPoolMonadTopicOwner({
    encloseFinancialOperation: operation => exclusive(operation, false),
    location: walletRoot,
    pool,
    changePool,
    leaseManager,
    subKeyring: material.keyring,
    changeKeyring: material.changeKeyring,
    canonicalBinding: canonicalWalletPublicBinding(material, NETWORK, 10143n),
    stampReferencesLeaseIndex: () => false,
    assertEnclosingAdmission: () => {
      if (!enclosed) throw new Error('missing outer owner admission')
    },
  })
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 10143, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  ;(
    provider as unknown as {
      _perform: (request: { method: string }) => Promise<unknown>
    }
  )._perform = async request => {
    if (request.method === 'getBalance') return 1000000000n
    if (request.method === 'getTransactionCount') return 0
    if (request.method === 'estimateGas') return 50000n
    throw new Error(`unexpected canonical provider ${request.method}`)
  }
  const client = new MonadCanonicalStampClient({
    pool,
    changePool,
    leaseManager,
    provider,
    httpClient: {
      submitRawTransaction: async () => {
        throw new Error('the bot never broadcasts')
      },
      getTransactionReceipt: async () => {
        throw new Error('the bot never reads receipts')
      },
    },
    walletState,
    canonicalRoles: material.canonicalRoles!,
    installedNetworkTag: 'MONT',
    relayBaseUrl: 'https://a.example',
    runCanonicalExclusive: exclusive,
  })

  // Crash points at the wallet's own durable barriers.
  const journal = walletState.canonicalJournal!
  const after = <T extends object, K extends keyof T>(
    target: T,
    method: K,
    point: string,
  ) => {
    const original = (target[method] as unknown as Function).bind(target)
    ;(target[method] as unknown) = async (...args: unknown[]) => {
      const result = await original(...args)
      dieAt(point)
      return result
    }
  }
  after(journal, 'prepareIntent', 'intent-durable')
  after(journal, 'checkpointSignedMember', 'signature-checkpoint')
  after(journal, 'promoteIntent', 'promoted')
  after(journal, 'recordTerminal', 'terminal-recorded')
  after(journal, 'completeCleanup', 'cleanup')
  after(journal, 'acknowledge', 'acknowledged')
  after(client, 'prepareIntent', 'lease-reserved')
  const sign = MonadAccountTxSigner.prototype.signFrozenUnsigned
  const signFrozenUnsigned = async function (
    this: MonadAccountTxSigner,
    input: Parameters<typeof sign>[0],
  ) {
    const signed = await sign.call(this, input)
    record(`sign:${createHash('sha256').update(signed.rawTx).digest('hex')}`)
    return signed
  }
  MonadAccountTxSigner.prototype.signFrozenUnsigned = signFrozenUnsigned

  const state = new QwenBotStateStore(join(root, 'bot'))
  await state.Open()
  after(state, 'saveResponse', 'response-saved')
  after(state, 'saveCoupling', 'envelope-saved')
  after(state, 'linkCoupling', 'intent-linked')
  after(state, 'commitCouplingTerminal', 'final-batch')

  const relay: { mode: RelayMode; bodies: Uint8Array[] } = {
    mode: 'delivered',
    bodies: [],
  }
  const fetch: CanonicalFetch = async (url, input) => {
    const body = new Uint8Array(input.body!)
    relay.bodies.push(body)
    record(`put:${createHash('sha256').update(body).digest('hex')}`)
    if (relay.mode === 'unreachable') throw new Error('RELAY_ERROR_SENTINEL')
    const identity = restoreCanonicalRequest({
      body,
      contentType: input.headers['Content-Type'],
    }).identity
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        phase: relay.mode,
        identity,
        ...(relay.mode === 'delivered'
          ? { mailbox_committed_at_ms: 1234 }
          : relay.mode === 'dead'
          ? { reason: 'expired' }
          : {}),
      }),
    )
    // The relay has durably accepted; the response has not reached the wallet yet.
    dieAt('network-accepted')
    let sent = false
    return {
      url,
      status: relay.mode === 'retained' ? 202 : 200,
      headers: {
        get: name =>
          name.toLowerCase() === 'content-type' ? 'application/json' : null,
      },
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true }
              : ((sent = true), { done: false, value: bytes }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      },
    }
  }
  const canonical: QwenCanonicalSender = {
    wallet: client,
    currents: async () => ({
      senderCurrent: sender.current,
      recipientCurrent: recipient.current,
    }),
    seal: (row, currents) => {
      record('seal')
      const sealed = prepareDirectMessage({
        network: NETWORK,
        senderCurrent: currents.senderCurrent,
        recipientCurrent: currents.recipientCurrent,
        messageId: new Uint8Array(randomBytes(16)),
        items: [directMessageText(row.response)],
        roles: material.canonicalRoles!.create(NETWORK, currents.senderCurrent),
      })
      return {
        payload: sealed.payload,
        context: sealed.context,
        t3: sealed.t3,
        messageId: sealed.messageId,
        contentDigest: sealed.contentDigest,
      }
    },
    overrides: {
      gasLimit: 60000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      chainId: 10143n,
    },
    fetch,
  }
  const reply = async () => {
    record('reply')
    return { content: 'REPLY_SENTINEL', reasoning: 'REASONING_SENTINEL' }
  }
  const run = new QwenResponseWorkflow({
    state,
    context: canonicalContext,
    systemPrompt: 'SYSTEM_SENTINEL',
    generator: { reply },
    canonical,
  })
  return {
    root,
    state,
    run,
    canonical,
    client,
    journal,
    pool,
    relay,
    walletState,
    material,
    events: () =>
      existsSync(eventsPath)
        ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)
        : [],
    /** The recipient opens the exact retained bytes with its own role keys. */
    openAsRecipient: (coupling: QwenCouplingRow) => {
      if (!('binding' in coupling)) throw new Error('sealed bytes discarded')
      const prepared = qwenCouplingPrepared(coupling.binding)
      const opened = openDirectMessage({
        mode: 'receive',
        network: NETWORK,
        payload: prepared.payload,
        context: prepared.context,
        roles: peer.canonicalRoles!.create(NETWORK, recipient.current),
        senderCurrent: sender.current,
        recipientCurrent: recipient.current,
      })
      return Buffer.from(opened.content).toString('latin1')
    },
    exclusive,
    close: async () => {
      MonadAccountTxSigner.prototype.signFrozenUnsigned = sign
      await queue
      await state.Close()
      await walletState.close()
      await subStore.Close()
      await changeStore.Close()
      await sender.directory.close()
      await recipient.directory.close()
      provider.destroy()
      material.dispose()
      peer.dispose()
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}
type CanonicalFixture = Awaited<ReturnType<typeof openCanonicalFixture>>

/** Child-process entry: one production respond() over real stores, killed at one barrier. */
export async function runCanonicalChild(): Promise<void> {
  const fixture = await openCanonicalFixture(process.env.QWEN_CANONICAL_ROOT!, {
    kill: process.env.QWEN_CANONICAL_KILL,
  })
  fixture.relay.mode = (process.env.QWEN_CANONICAL_RELAY ??
    'delivered') as RelayMode
  const outcome = await fixture.run.respond(input)
  console.log(`CHILD_OUTCOME ${outcome}`)
  // No Close: the parent reopens whatever a killed or abandoned process left behind.
  process.kill(process.pid, 'SIGKILL')
}

function count(events: string[], prefix: string): number {
  return events.filter(event => event.startsWith(prefix)).length
}
function distinct(events: string[], prefix: string): number {
  return new Set(events.filter(event => event.startsWith(prefix))).size
}

describe('#703 canonical outbound coupling', () => {
  let root: string
  let fixture: CanonicalFixture | undefined
  const open = async (options: { walletRoot?: string } = {}) => {
    fixture = await openCanonicalFixture(root, options)
    return fixture
  }
  const reopenAll = async (options: { walletRoot?: string } = {}) => {
    await fixture?.close()
    return open(options)
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-'))
  })
  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
    rmSync(root, { recursive: true, force: true })
  })

  it('binds one saved result to one sealed envelope and one wallet attempt, and commits the terminal batch from durable delivered evidence', async () => {
    const f = await open()
    const db = (f.state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batchSpy = jest.spyOn(db, 'batch')
    let sealedText: string | undefined
    const commit = f.state.commitCouplingTerminal.bind(f.state)
    jest
      .spyOn(f.state, 'commitCouplingTerminal')
      .mockImplementation(async (hash, terminal) => {
        // The wallet's terminal evidence is already durable before Qwen consumes it.
        expect(f.journal.getAll()[0].terminal).toMatchObject({
          phase: 'delivered',
        })
        sealedText = f.openAsRecipient(f.state.getCoupling(hash)!)
        return commit(hash, terminal)
      })
    expect(await f.run.respond(input)).toBe('confirmed')
    expect(sealedText).toContain('REPLY_SENTINEL')
    const terminalBatch = batchSpy.mock.calls.find(([operations]) =>
      operations.some(operation => operation.key === 'processed:01'),
    )!
    expect(terminalBatch).toEqual([
      [
        expect.objectContaining({ type: 'put', key: 'response:v1:01' }),
        expect.objectContaining({
          type: 'put',
          key: `conversation:${PEER.toLowerCase()}`,
        }),
        { type: 'put', key: 'processed:01', value: '1' },
        expect.objectContaining({ type: 'put', key: 'coupling:v1:01' }),
      ],
      { sync: true },
    ])
    const row = f.state.getResponse('01') as Extract<
      QwenResponseRow,
      { phase: 'confirmed' }
    >
    const coupling = f.state.getCoupling('01')!
    expect(coupling.phase).toBe('settled')
    expect(coupling).not.toHaveProperty('binding')
    if (coupling.phase !== 'settled') throw new Error('expected settled')
    expect(coupling.terminal).toMatchObject({
      outcome: 'delivered',
      mailboxCommittedAtMs: 1234,
    })
    expect(row.receipt).toEqual({
      payloadHashHex: coupling.terminal.payloadHashHex,
      txHashes: coupling.terminal.txHashes,
    })
    expect(coupling.terminal.txHashes).toHaveLength(1)
    // Wallet evidence is retired only after the Qwen batch; one account was spent.
    expect(f.journal.getAll()).toEqual([])
    expect(f.journal.getIntents()).toEqual([])
    expect(f.client.wasAcknowledged(coupling.attemptRef)).toBe(true)
    expect(f.pool.records().map(record => record.status)).toEqual([
      'spent',
      'available',
      'available',
      'available',
    ])
    const events = f.events()
    expect(count(events, 'reply')).toBe(1)
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'sign:')).toBe(1)
    expect(count(events, 'put:')).toBe(1)
    expect(f.state.getConversation(PEER)).toEqual([
      { role: 'system', content: 'SYSTEM_SENTINEL' },
      { role: 'user', content: 'PROMPT_SENTINEL' },
      { role: 'assistant', content: 'REPLY_SENTINEL' },
    ])
    // Neither the coupling record nor any log line carries plaintext.
    expect(JSON.stringify(f.state.allCouplings())).not.toContain('SENTINEL')
    expect(logs.join()).not.toContain('SENTINEL')

    const again = await reopenAll()
    expect(await again.run.recover()).toBeUndefined()
    expect(await again.run.respond(input)).toBe('duplicate')
    expect(await again.run.resume('01')).toBe('duplicate')
    expect(again.events()).toEqual(events)
  }, 30000)

  it.each(['retained', 'unreachable'] as const)(
    'retries only the original exact request after a %s submission, across restart',
    async mode => {
      let f = await open()
      f.relay.mode = mode
      expect(await f.run.respond(input)).toBe('held')
      const first = f.relay.bodies[0]
      const saved = f.state.getCoupling('01')!
      expect(saved.phase).toBe('intent-linked')
      expect(f.journal.getAll()[0].terminal).toBeNull()
      expect(f.state.getResponse('01')?.phase).toBe('response-ready')
      expect(f.state.hasProcessed('01')).toBe(false)
      expect(await f.run.resume('01')).toBe('held')
      f = await reopenAll()
      expect(await f.run.recover()).toBeUndefined()
      expect(f.state.getCoupling('01')).toEqual(saved)
      f.relay.mode = 'delivered'
      expect(await f.run.resume('01')).toBe('confirmed')
      expect(f.relay.bodies).toHaveLength(1)
      expect(Buffer.from(f.relay.bodies[0]).equals(Buffer.from(first))).toBe(
        true,
      )
      const events = f.events()
      expect(count(events, 'put:')).toBe(3)
      expect(distinct(events, 'put:')).toBe(1)
      expect(count(events, 'seal')).toBe(1)
      expect(count(events, 'reply')).toBe(1)
      expect(distinct(events, 'sign:')).toBe(1)
      expect(logs.join()).toContain(
        mode === 'retained'
          ? 'relay-retained-delivery-pending'
          : 'send-outcome-unknown',
      )
      expect(logs.join()).not.toContain('SENTINEL')
    },
    30000,
  )

  it('keeps a dead outcome held and never builds a replacement envelope or payment', async () => {
    let f = await open()
    f.relay.mode = 'dead'
    expect(await f.run.respond(input)).toBe('held')
    expect(f.state.getResponse('01')?.phase).toBe('response-ready')
    expect(f.state.hasProcessed('01')).toBe(false)
    expect(f.state.getConversation(PEER)).toBeUndefined()
    expect(f.state.getCoupling('01')).toMatchObject({
      terminal: { outcome: 'dead', reason: 'expired' },
    })
    f = await reopenAll()
    f.relay.mode = 'delivered'
    expect(await f.run.recover()).toBeUndefined()
    expect(await f.run.resume('01')).toBe('held')
    expect(await f.run.respond(input)).toBe('held')
    // The peer stays ordered behind the dead turn.
    expect(await f.run.respond({ ...input, payloadHashHex: '04' })).toBe('held')
    const events = f.events()
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'put:')).toBe(1)
    expect(count(events, 'reply')).toBe(1)
    expect(f.pool.records().map(record => record.status)).toEqual([
      'retired',
      'available',
      'available',
      'available',
    ])
    expect(logs.join()).toContain('delivery-dead')
    expect(logs.join()).toContain('earlier-turn-unresolved')
  }, 30000)

  it('serializes concurrent resumes into one envelope, one attempt and one terminal batch', async () => {
    const f = await open()
    await f.state.beginResponse({ ...input, context: canonicalContext })
    await f.state.saveResponse('01', 'REPLY_SENTINEL', [
      { role: 'assistant', content: 'REPLY_SENTINEL' },
    ])
    const outcomes = await Promise.all([
      f.run.resume('01'),
      f.run.resume('01'),
      f.run.resume('01'),
    ])
    expect(outcomes.sort()).toEqual(['confirmed', 'duplicate', 'duplicate'])
    const events = f.events()
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'put:')).toBe(1)
    expect(count(events, 'sign:')).toBe(1)
    expect(f.state.getConversation(PEER)).toHaveLength(1)
  }, 30000)

  it('repairs a missing link from the exact saved bytes when the link write failed after the wallet intent became durable', async () => {
    let f = await open()
    const db = (f.state as unknown as { openedDb: ResponseDatabase }).openedDb
    const batch = db.batch.bind(db)
    const batchSpy = jest.spyOn(db, 'batch').mockImplementation(((
      operations: Array<{ type: string; key: string; value: string }>,
      options: { sync: boolean },
    ) => {
      if (JSON.parse(operations[0].value).phase === 'intent-linked')
        return Promise.reject(new Error('DISK_ERROR_BODY_SENTINEL'))
      return batch(operations, options)
    }) as typeof db.batch)
    await expect(f.run.respond(input)).rejects.toThrow('persistence failed')
    batchSpy.mockRestore()
    // The wallet retains the pre-sign intent; nothing was leased, signed or sent.
    expect(f.journal.getIntents()).toHaveLength(1)
    expect(f.pool.getRecord(0)?.status).toBe('available')
    expect(f.state.getCoupling('01')?.phase).toBe('envelope-ready')
    await expect(f.run.resume('01')).rejects.toThrow('storage unavailable')
    expect(count(f.events(), 'sign:')).toBe(0)
    const attemptRef = f.journal.getIntents()[0].attemptRef
    f = await reopenAll()
    expect(await f.run.recover()).toBeUndefined()
    expect(f.state.getCoupling('01')).toMatchObject({
      phase: 'intent-linked',
      attemptRef,
    })
    expect(count(f.events(), 'put:')).toBe(0)
    expect(await f.run.resume('01')).toBe('confirmed')
    const events = f.events()
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'reply')).toBe(1)
    expect(count(events, 'put:')).toBe(1)
    expect(f.journal.getIntents()).toEqual([])
    expect(logs.join()).not.toContain('SENTINEL')
  }, 30000)

  it('holds every canonical send while the wallet retains a record no workflow owns', async () => {
    const f = await open()
    const currents = (await f.canonical.currents(undefined as never))!
    const foreign = f.canonical.seal({ response: 'foreign' } as never, currents)
    await f.client.prepareIntent({
      prepared: f.client.bindPrepared({
        payload: foreign.payload,
        context: foreign.context,
        stampValueWei: CANONICAL_STAMP_WEI,
        economicBinding: Uint8Array.of(1),
      }),
      consumerId: 'another-workflow',
      stampValueWei: CANONICAL_STAMP_WEI,
      ...currents,
      overrides: f.canonical.overrides,
      onIntentDurable: async () => undefined,
    })
    const before = f.events()
    expect(await f.run.recover()).toBe('wallet-correlation-hold')
    expect(await f.run.respond(input)).toBe('held')
    expect(f.state.getResponse('01')?.phase).toBe('response-ready')
    expect(f.state.getCoupling('01')).toBeUndefined()
    // The model result is saved once; no envelope, signature or request followed.
    expect(f.events()).toEqual([...before, 'reply'])
    expect(logs.join()).toContain('wallet-correlation-hold')
  }, 30000)

  it('holds a linked turn whose wallet attempt is missing instead of preparing another', async () => {
    let f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    const before = f.events()
    // Same account and bot state, but a wallet root that never recorded the attempt.
    f = await reopenAll({ walletRoot: join(root, 'other-wallet') })
    f.relay.mode = 'delivered'
    expect(await f.run.recover()).toBe('wallet-attempt-missing')
    expect(await f.run.resume('01')).toBe('held')
    expect(f.events()).toEqual(before)
    expect(f.journal.getIntents()).toEqual([])
    expect(f.journal.getAll()).toEqual([])
    expect(f.state.getCoupling('01')?.phase).toBe('intent-linked')
    expect(logs.join()).toContain('wallet-attempt-missing')
  }, 30000)

  it('holds a saved envelope when the stamp policy changes, without sealing again', async () => {
    let f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    const before = f.events()
    f = await reopenAll()
    const changed = new QwenResponseWorkflow({
      state: f.state,
      context: { ...canonicalContext, stampValueWei: '33' },
      systemPrompt: 'SYSTEM_SENTINEL',
      generator: { reply: jest.fn() },
      canonical: f.canonical,
    })
    expect(await changed.resume('01')).toBe('held')
    expect(f.events()).toEqual(before)
    expect(logs.join()).toContain('account-or-send-context-changed')
  }, 30000)

  it('holds before any wallet intent when inventory preparation fails, then continues with the same envelope', async () => {
    const f = await open()
    f.canonical.prepareInventory = async () => {
      throw new Error('FUNDING_ERROR_SENTINEL')
    }
    expect(await f.run.respond(input)).toBe('held')
    const saved = f.state.getCoupling('01')
    expect(saved?.phase).toBe('envelope-ready')
    expect(f.journal.getIntents()).toEqual([])
    f.canonical.prepareInventory = async () => undefined
    expect(await f.run.resume('01')).toBe('confirmed')
    const events = f.events()
    expect(count(events, 'seal')).toBe(1)
    expect(count(events, 'reply')).toBe(1)
    expect(count(events, 'put:')).toBe(1)
    expect(logs.join()).toContain('inventory-unavailable')
    expect(logs.join()).not.toContain('SENTINEL')
  }, 30000)

  it('holds an oversize sealed reply before any durable or wallet effect instead of throwing', async () => {
    const f = await open()
    await f.state.beginResponse({ ...input, context: canonicalContext })
    await f.state.saveResponse(
      '01',
      // Within the producer's text limit, but its sealed frame exceeds the coupling bound.
      'A'.repeat(QWEN_COUPLING_MAX_PAYLOAD_BYTES - 100),
      [],
    )
    expect(await f.run.resume('01')).toBe('held')
    expect(await f.run.resume('01')).toBe('held')
    expect(f.state.getCoupling('01')).toBeUndefined()
    expect(f.state.getResponse('01')?.phase).toBe('response-ready')
    expect(f.journal.getIntents()).toEqual([])
    expect(count(f.events(), 'put:')).toBe(0)
    expect(count(f.events(), 'sign:')).toBe(0)
    // The store itself is still usable for other turns.
    expect(
      await f.run.respond({
        ...input,
        payloadHashHex: '06',
        senderAddress: 'other',
      }),
    ).toBe('confirmed')
    expect(logs.join()).toContain('reply-exceeds-coupling-bounds')
  }, 30000)

  it('applies backpressure instead of evicting a retained envelope when the coupling store is full', async () => {
    const f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    const binding = (
      f.state.getCoupling('01') as Extract<
        QwenCouplingRow,
        { phase: 'intent-linked' }
      >
    ).binding
    const envelope = {
      messageIdHex: '00'.repeat(16),
      t3Hex: '00'.repeat(32),
      contentDigestHex: '00'.repeat(32),
      stampValueWei: '32',
    }
    const seed = async (index: number) => {
      const hash = (0x1000 + index).toString(16)
      await f.state.beginResponse({
        payloadHashHex: hash,
        senderAddress: `peer-${index}`,
        senderPubKeyHex: '02',
        context: canonicalContext,
      })
      await f.state.saveResponse(hash, 'REPLY_SENTINEL', [])
      return f.state.saveCoupling(hash, envelope, {
        ...binding,
        payloadHex: binding.payloadHex + index.toString(16).padStart(4, '0'),
      })
    }
    for (let index = 1; index < QWEN_COUPLING_MAX_COUNT; index++)
      expect(await seed(index)).toBe('saved')
    expect(await seed(QWEN_COUPLING_MAX_COUNT)).toBe('capacity')
    expect(f.state.allCouplings()).toHaveLength(QWEN_COUPLING_MAX_COUNT)
    expect(f.state.getCoupling('01')?.phase).toBe('intent-linked')
    // The same exact bytes can never be claimed by a second turn.
    await f.state.beginResponse({
      payloadHashHex: '2000',
      senderAddress: 'peer-duplicate',
      senderPubKeyHex: '02',
      context: canonicalContext,
    })
    await f.state.saveResponse('2000', 'REPLY_SENTINEL', [])
    await expect(
      f.state.saveCoupling('2000', envelope, binding),
    ).rejects.toThrow('Invalid Qwen coupling transition')
  }, 30000)

  it('leaves legacy model-started and send-started rows held and never couples them', async () => {
    const f = await open()
    await f.state.beginResponse({ ...input, context: canonicalContext })
    await f.state.beginResponse({
      ...input,
      payloadHashHex: '02',
      senderAddress: 'other',
      context: canonicalContext,
    })
    await f.state.saveResponse('02', 'REPLY_SENTINEL', [])
    await f.state.startResponseSend('02')
    expect(await f.run.resume('01')).toBe('held')
    expect(await f.run.resume('02')).toBe('held')
    expect(await f.run.recover()).toBeUndefined()
    expect(f.state.allCouplings()).toEqual([])
    expect(f.events()).toEqual([])
    expect(logs.join()).toContain('model-result-unknown')
    expect(logs.join()).toContain('send-outcome-unknown')
  }, 30000)

  it('retains an acknowledged turn behind an earlier unresolved attempt until the wallet frontier passes it', async () => {
    const f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    f.relay.mode = 'delivered'
    await f.state.beginResponse({
      payloadHashHex: '05',
      senderAddress: 'other',
      senderPubKeyHex: '02',
      context: canonicalContext,
    })
    await f.state.saveResponse('05', 'REPLY_SENTINEL', [])
    // Only the second turn is resumed, so the first stays unresolved in the wallet.
    expect(await f.run.resume('05')).toBe('confirmed')
    // Acknowledged out of order: the wallet still retains it, so Qwen keeps the exact link.
    const second = f.state.getCoupling('05')!
    expect(second.phase).toBe('terminal')
    expect(f.journal.getAll().map(a => a.acknowledged)).toEqual([false, true])
    expect(await f.run.recover()).toBeUndefined()
    expect(f.state.getCoupling('05')?.phase).toBe('terminal')
    f.relay.mode = 'delivered'
    expect(await f.run.resume('01')).toBe('confirmed')
    expect(await f.run.recover()).toBeUndefined()
    expect(f.state.allCouplings().map(c => c.phase)).toEqual([
      'settled',
      'settled',
    ])
    expect(f.journal.getAll()).toEqual([])
  }, 30000)

  it('keeps terminal records bounded across turns and reopen', async () => {
    let f = await open()
    for (const hash of ['0a', '0b', '0c'])
      expect(await f.run.respond({ ...input, payloadHashHex: hash })).toBe(
        'confirmed',
      )
    f = await reopenAll()
    expect(await f.run.recover()).toBeUndefined()
    const couplings = f.state.allCouplings()
    expect(couplings.map(c => c.phase)).toEqual([
      'settled',
      'settled',
      'settled',
    ])
    const size = JSON.stringify(couplings[0]).length
    for (const coupling of couplings) {
      expect(coupling).not.toHaveProperty('binding')
      expect(JSON.stringify(coupling)).toHaveLength(size)
    }
    expect(f.state.getConversation(PEER)).toHaveLength(7)
    expect(f.journal.getAll()).toEqual([])
    expect(count(f.events(), 'seal')).toBe(3)
    expect(distinct(f.events(), 'put:')).toBe(3)
  }, 30000)

  it.each([
    ['unknown field', (row: Record<string, unknown>) => ({ ...row, extra: 1 })],
    [
      'foreign consumer',
      (row: Record<string, unknown>) => ({ ...row, consumerId: 'other' }),
    ],
    [
      'unknown phase',
      (row: Record<string, unknown>) => ({ ...row, phase: 'sent' }),
    ],
    [
      'guessed attempt on an unlinked envelope',
      (row: Record<string, unknown>) => ({
        ...row,
        phase: 'envelope-ready',
      }),
    ],
  ])(
    'refuses to open a coupling record with %s',
    async (_name, corrupt) => {
      let f = await open()
      f.relay.mode = 'retained'
      expect(await f.run.respond(input)).toBe('held')
      const db = (
        f.state as unknown as {
          openedDb: {
            get(key: string): Promise<string>
            put(key: string, value: string): Promise<void>
          }
        }
      ).openedDb
      await db.put(
        'coupling:v1:01',
        JSON.stringify(corrupt(JSON.parse(await db.get('coupling:v1:01')))),
      )
      await f.close()
      fixture = undefined
      const reopened = new QwenBotStateStore(join(root, 'bot'))
      await expect(reopened.Open()).rejects.toThrow(
        'Invalid Qwen coupling record',
      )
    },
    30000,
  )

  it('refuses a coupling whose response row is absent or in a different phase', async () => {
    const f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    const db = (
      f.state as unknown as {
        openedDb: { del(key: string): Promise<void> }
      }
    ).openedDb
    await db.del('response:v1:01')
    await f.close()
    fixture = undefined
    await expect(
      new QwenBotStateStore(join(root, 'bot')).Open(),
    ).rejects.toThrow('Invalid Qwen coupling record')
  }, 30000)

  it('never lets the legacy send boundary claim a coupled turn', async () => {
    const f = await open()
    f.relay.mode = 'retained'
    expect(await f.run.respond(input)).toBe('held')
    const send = jest.fn(async () => receipt)
    const legacy = new QwenResponseWorkflow({
      state: f.state,
      context: canonicalContext,
      systemPrompt: 'SYSTEM_SENTINEL',
      generator: { reply: jest.fn() },
      send,
    })
    expect(await legacy.resume('01')).toBe('held')
    expect(send).not.toHaveBeenCalled()
    await expect(f.state.startResponseSend('01')).rejects.toThrow(
      'Invalid Qwen response transition',
    )
    expect(f.state.getResponse('01')?.phase).toBe('response-ready')
  }, 30000)

  // Real child termination without Close at each durable barrier, then both Level roots are
  // reopened in this process. Every point converges through exact retained bytes.
  it.each([
    ['response-saved', 'response-ready', undefined],
    ['envelope-saved', 'response-ready', 'envelope-ready'],
    ['intent-durable', 'response-ready', 'envelope-ready'],
    ['intent-linked', 'response-ready', 'intent-linked'],
    ['lease-reserved', 'response-ready', 'intent-linked'],
    ['signature-checkpoint', 'response-ready', 'intent-linked'],
    ['promoted', 'response-ready', 'intent-linked'],
    ['network-accepted', 'response-ready', 'intent-linked'],
    ['terminal-recorded', 'response-ready', 'intent-linked'],
    ['final-batch', 'confirmed', 'terminal'],
    ['cleanup', 'confirmed', 'terminal'],
    ['acknowledged', 'confirmed', 'terminal'],
  ] as const)(
    'SIGKILL after %s converges to one model result, one reply and one signed set',
    async (kill, responsePhase, couplingPhase) => {
      const child = spawnSync(
        process.execPath,
        [
          '--require',
          require.resolve('tsx/cjs'),
          '-e',
          `
          const noop = () => {};
          for (const name of ['it','test','describe','beforeEach','afterEach'])
            globalThis[name] = Object.assign(() => {}, { each: () => noop });
          require(${JSON.stringify(
            __filename,
          )}).runCanonicalChild().catch(error => {
            console.error(String(error && error.message));
            process.exit(2);
          });
        `,
        ],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: {
            PATH: process.env.PATH,
            TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
            QWEN_CANONICAL_ROOT: root,
            QWEN_CANONICAL_KILL: kill,
          },
        },
      )
      expect({
        status: child.status,
        signal: child.signal,
        stderr: child.stderr,
        outcome: child.stdout.includes('CHILD_OUTCOME'),
      }).toEqual({
        status: null,
        signal: 'SIGKILL',
        stderr: '',
        outcome: false,
      })
      expect(child.stdout + child.stderr).not.toContain('SENTINEL')

      const f = await open()
      expect(f.state.getResponse('01')?.phase).toBe(responsePhase)
      expect(f.state.getCoupling('01')?.phase).toBe(couplingPhase)
      const killed = f.events()
      // Startup correlation has no relay, signing, sealing or model effect.
      expect(await f.run.recover()).toBeUndefined()
      expect(f.events()).toEqual(killed)
      if (kill === 'intent-durable')
        expect(f.state.getCoupling('01')?.phase).toBe('intent-linked')
      const outcome =
        responsePhase === 'confirmed'
          ? await f.run.respond(input)
          : await f.run.resume('01')
      expect(outcome).toBe(
        responsePhase === 'confirmed' ? 'duplicate' : 'confirmed',
      )
      expect(await f.run.respond(input)).toBe('duplicate')

      const events = f.events()
      expect(count(events, 'reply')).toBe(1)
      expect(count(events, 'seal')).toBe(1)
      expect(distinct(events, 'sign:')).toBe(1)
      expect(distinct(events, 'put:')).toBe(1)
      // The relay sees a second PUT only when the first acceptance was never recorded.
      expect(count(events, 'put:')).toBe(kill === 'network-accepted' ? 2 : 1)
      const row = f.state.getResponse('01') as Extract<
        QwenResponseRow,
        { phase: 'confirmed' }
      >
      const coupling = f.state.getCoupling('01')!
      if (coupling.phase !== 'settled') throw new Error('expected settled')
      expect(row.receipt).toEqual({
        payloadHashHex: coupling.terminal.payloadHashHex,
        txHashes: coupling.terminal.txHashes,
      })
      expect(coupling.terminal.txHashes).toHaveLength(1)
      expect(f.state.hasProcessed('01')).toBe(true)
      expect(f.state.getConversation(PEER)).toEqual([
        { role: 'system', content: 'SYSTEM_SENTINEL' },
        { role: 'user', content: 'PROMPT_SENTINEL' },
        { role: 'assistant', content: 'REPLY_SENTINEL' },
      ])
      expect(f.journal.getIntents()).toEqual([])
      expect(f.journal.getAll()).toEqual([])
      expect(f.pool.records().map(record => record.status)).toEqual([
        'spent',
        'available',
        'available',
        'available',
      ])
      expect(logs.join()).not.toContain('SENTINEL')
    },
    60000,
  )
})
