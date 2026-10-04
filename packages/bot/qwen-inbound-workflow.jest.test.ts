import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
  signEcdsa,
} from '@frank/nakamoto'
import { MockMailboxRelay } from '@frank/cashweb/relay/monad-mailbox-mock-relay.testutil'
import {
  QwenBotStateStore,
  QWEN_INBOX_MAX_BYTES,
  QWEN_INBOX_MAX_COUNT,
} from './qwen-bot-state'
import { QwenInboundWorkflow } from './qwen-inbound-workflow'
import { QwenResponseWorkflow } from './qwen-response-workflow'

// Authenticated mailbox requests and real Level are production code. Content/model/payment
// fixtures let faults be counted without plaintext, credentials, funds or external services.
jest.mock('@frank/cashweb/relay/monad-message-envelope', () => ({
  ...jest.requireActual('@frank/cashweb/relay/monad-message-envelope'),
  parseEnvelope: (bytes: Buffer) => {
    const [peer, recipient, kind] = bytes.toString().split('|')
    return kind === 'unsupported'
      ? undefined
      : { from: peer, to: recipient, kind }
  },
  tryDecryptEnvelope: ({ envelope }: any) =>
    envelope.kind === 'undecryptable'
      ? undefined
      : envelope.kind === 'empty'
      ? ''
      : 'PROMPT_SENTINEL',
}))
jest.mock('./qwen-prompt', () => ({
  ...jest.requireActual('./qwen-prompt'),
  extractPromptText: (text: string) => text || undefined,
}))

const BOT = '0x' + 'ab'.repeat(20)
const PEER = '0x' + 'cd'.repeat(20)
const OTHER = '0x' + 'ef'.repeat(20)
const context = {
  botAddress: BOT,
  networkTag: 'fixture',
  relayBaseUrl: 'http://127.0.0.1:8098',
}
const responseContext = { ...context, fundingAddress: BOT, stampValueWei: '1' }
const hash = (id: string | number) =>
  createHash('sha256').update(String(id)).digest('hex')
const input = (id: string | number, peer = PEER, kind = 'valid') => ({
  payloadHashHex: hash(id),
  timestamp: 10,
  networkTagHex: Buffer.from('fixture').toString('hex'),
  encryptedPayloadHex: Buffer.from(`${peer}|${BOT}|${kind}`).toString('hex'),
})
let location: string
let state: QwenBotStateStore
let relay: MockMailboxRelay
let workflow: QwenInboundWorkflow
let generate: jest.Mock
let send: jest.Mock
let keyLookup: jest.Mock
let policy: jest.Mock
let budget: jest.Mock
let logs: jest.SpyInstance[]
const privateKey = privateKeyFromSecretBytes(new Uint8Array(32).fill(8), true)
if (!privateKey.ok) throw new Error('fixture key')
const publicKey = publicFromPrivate(privateKey.value)
if (!publicKey.ok) throw new Error('fixture public key')

function makeRelay(maxUsedChallenges = 1000) {
  const result = new MockMailboxRelay({
    networkTag: Buffer.from('fixture'),
    maxUsedChallenges,
  })
  result.registerProfile(BOT, publicKey.value.compressed)
  return result
}
function makeWorkflow() {
  const responses = new QwenResponseWorkflow({
    state,
    context: responseContext,
    systemPrompt: 'system',
    generator: { reply: generate },
    send,
  })
  workflow = new QwenInboundWorkflow({
    state,
    context,
    responses,
    privateKey: null as any,
    senderKey: keyLookup,
    peerBlockReason: policy,
    reserveReply: budget,
    auth: {
      recipient: BOT,
      relayBaseUrl: context.relayBaseUrl,
      http: request => relay.http(request),
      retry: { maxAttempts: 1 },
      signDigest: digest => {
        const signed = signEcdsa(privateKey.value, digest)
        if (!signed.ok) throw new Error('fixture signature')
        return signed.value
      },
    },
  })
}
async function reopen() {
  await state.Close()
  state = new QwenBotStateStore(location)
  await state.Open()
  makeWorkflow()
}
function add(id: string | number, peer = PEER, kind = 'valid') {
  const row = input(id, peer, kind)
  relay.addMessage({
    recipient: BOT,
    timestamp: row.timestamp,
    payloadHash: Buffer.from(row.payloadHashHex, 'hex'),
    encryptedPayload: Buffer.from(row.encryptedPayloadHex, 'hex'),
    networkTag: Buffer.from('fixture'),
  })
}
beforeEach(async () => {
  location = mkdtempSync(join(tmpdir(), 'qwen-inbox-'))
  state = new QwenBotStateStore(location)
  await state.Open()
  await state.initializeInbox(context, 0)
  relay = makeRelay()
  generate = jest.fn(async () => ({
    content: 'REPLY_SENTINEL',
    reasoning: 'REASONING_SENTINEL',
  }))
  send = jest.fn(async () => ({
    payloadHashHex: 'outgoing',
    txHashes: ['tx'],
  }))
  keyLookup = jest.fn(async () => Buffer.from('fixture-key'))
  policy = jest.fn(async () => undefined)
  budget = jest.fn(() => true)
  logs = ['log', 'warn', 'error'].map(method =>
    jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
  )
  makeWorkflow()
})
afterEach(async () => {
  await state.Close()
  logs.forEach(log => log.mockRestore())
  rmSync(location, { recursive: true, force: true })
})

it('retains held peer B, allows C, and reopens without duplicating any owned phase', async () => {
  await state.importInboxPage(
    context,
    0,
    [input('a'), input('b'), input('c', OTHER)],
    'opaque/%?unchanged',
  )
  generate.mockRejectedValueOnce(new Error('PROVIDER_BODY_SENTINEL'))
  expect(await workflow.drain(10)).toBe(1)
  expect(state.getResponse(hash('a'))?.phase).toBe('model-started')
  expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
    hash('b'),
  ])
  await reopen()
  expect(await workflow.drain(10)).toBe(0)
  expect(generate).toHaveBeenCalledTimes(2)
  expect(send).toHaveBeenCalledTimes(1)
  expect(state.getInboxScan().cursor).toBe('opaque/%?unchanged')
  await state.importInboxPage(context, 1, [
    input('a'),
    input('b'),
    input('c', OTHER),
  ])
  expect(state.pendingInbox()).toHaveLength(1)
})

it.each(['during', 'after'])(
  'finishes a timestamp group larger than a poll budget, discovering a lower hash arriving %s the sweep exactly once',
  async timing => {
    for (let i = 0; i < 251; i++) add(i)
    await workflow.import()
    expect(state.pendingInbox()).toHaveLength(200)
    const cursor = state.getInboxScan().cursor
    expect(cursor).toBeTruthy()
    const late = {
      recipient: BOT,
      timestamp: 10,
      payloadHash: Buffer.alloc(32),
      encryptedPayload: Buffer.from(`${OTHER}|${BOT}|valid`),
      networkTag: Buffer.from('fixture'),
    }
    if (timing === 'during') relay.addMessage(late)
    await reopen()
    await workflow.import()
    expect(state.pendingInbox()).toHaveLength(251)
    expect(state.getInboxScan().cursor).toBeUndefined()
    // Lower than every fixture hash: a late equal-timestamp row sorts behind the old boundary.
    if (timing === 'after') relay.addMessage(late)
    await workflow.import()
    await workflow.import()
    expect(state.pendingInbox()).toHaveLength(252)
    await workflow.import()
    expect(state.pendingInbox()).toHaveLength(252)
    const queries = relay.log
      .filter(row => row.route === 'inbox')
      .map(row => row.query)
    expect(queries.some(query => query.cursor === cursor)).toBe(true)
    expect(
      queries.every(
        query =>
          query.since === '0' &&
          query.limit === '100' &&
          query.max_bytes === '4210688',
      ),
    ).toBe(true)
  },
)

it('repeated authentication rejection has one bounded fallback and no provider-body or credential persistence', async () => {
  await state.importInboxPage(context, 0, [input('a')], 'stale')
  relay.inject(
    'challenge',
    { status: 401, body: { error: 'PROVIDER_BODY_SENTINEL' } },
    { status: 401, body: { error: 'PROVIDER_BODY_SENTINEL' } },
  )
  await expect(workflow.import()).rejects.toThrow(
    'Qwen inbox read failed; retained inputs and checkpoint preserved',
  )
  expect(relay.log).toHaveLength(2)
  expect(state.getInboxScan().cursor).toBeUndefined()
  expect(state.pendingInbox()).toHaveLength(1)
  await expect(
    state.initializeInbox(
      {
        ...context,
        relayBaseUrl: 'http://user:CREDENTIAL_SENTINEL@127.0.0.1:8098',
      },
      0,
    ),
  ).rejects.toThrow('Invalid Qwen inbox context')
  expect(JSON.stringify(state.getInboxScan())).not.toMatch(
    /CREDENTIAL_SENTINEL|PROVIDER_BODY_SENTINEL/,
  )
  expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toMatch(
    /CREDENTIAL_SENTINEL|PROVIDER_BODY_SENTINEL/,
  )
})

it('preserves a committed partial timestamp group on a later-page rate cap and resumes it', async () => {
  relay = makeRelay(1)
  for (let i = 0; i < 101; i++) add(i)
  await expect(workflow.import()).rejects.toThrow('inbox read failed')
  expect(state.pendingInbox()).toHaveLength(100)
  const previous = state.getInboxScan()
  await reopen()
  expect(state.getInboxScan()).toEqual(previous)
  // A new epoch rejects the old token; bounded no-token replay retains the first page.
  relay = makeRelay()
  for (let i = 0; i < 101; i++) add(i)
  await workflow.import()
  await workflow.import()
  expect(state.pendingInbox()).toHaveLength(101)
})

it('falls back once for stale saved tokens and does not swallow a no-token authentication rejection', async () => {
  await state.importInboxPage(context, 0, [input('retained')], 'stale-token')
  relay.inject('challenge', {
    status: 400,
    body: { error: 'invalid_mailbox_cursor' },
  })
  add('new')
  await workflow.import()
  expect(state.pendingInbox()).toHaveLength(2)
  expect(state.getInboxScan().origin).toBe(0)
  relay.inject('challenge', {
    status: 401,
    body: { error: 'mailbox_auth_failed' },
  })
  await expect(workflow.import()).rejects.toThrow('inbox read failed')
  expect(state.pendingInbox()).toHaveLength(2)
})

it.each(['key', 'policy', 'budget', 'quota'] as const)(
  'keeps %s deferrals across reopen and processes them once when eligible',
  async reason => {
    await state.importInboxPage(context, 0, [
      input('a'),
      input('b'),
      input('c', OTHER),
    ])
    if (reason === 'key')
      keyLookup.mockRejectedValue(new Error('KEY_PROVIDER_BODY_SENTINEL'))
    if (reason === 'policy') policy.mockResolvedValue('automated')
    if (reason === 'budget') budget.mockReturnValue(false)
    expect(await workflow.drain(reason === 'quota' ? 0 : 10)).toBe(0)
    expect(state.pendingInbox()).toHaveLength(3)
    await reopen()
    keyLookup.mockResolvedValue(Buffer.from('fixture-key'))
    policy.mockResolvedValue(undefined)
    budget.mockReturnValue(true)
    expect(await workflow.drain(10)).toBe(3)
    expect(state.pendingInbox()).toHaveLength(0)
    await reopen()
    expect(await workflow.drain(10)).toBe(0)
    expect(generate).toHaveBeenCalledTimes(3)
  },
)

it('a transient first-peer lookup cannot let its second admitted turn overtake it', async () => {
  await state.importInboxPage(context, 0, [
    input('a'),
    input('b'),
    input('c', OTHER),
  ])
  keyLookup.mockRejectedValueOnce(new Error('transient'))
  expect(await workflow.drain(10)).toBe(1)
  expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual([
    hash('a'),
    hash('b'),
  ])
  expect(await workflow.drain(10)).toBe(2)
})

it('compact deterministic rejection removes ciphertext; unsupported and unavailable validation stay pending', async () => {
  await state.importInboxPage(context, 0, [
    input('empty', PEER, 'empty'),
    input('unsupported', OTHER, 'unsupported'),
    input('undecryptable', OTHER, 'undecryptable'),
  ])
  expect(await workflow.drain(10)).toBe(0)
  expect(state.pendingInbox()).toHaveLength(2)
  await reopen()
  const db = (state as any).db
  expect(JSON.parse(await db.get('inbox:v1:' + hash('empty')))).toEqual({
    version: 1,
    phase: 'rejected',
    payloadHashHex: hash('empty'),
    reason: 'no-text',
  })
  await state.importInboxPage(context, 1, [input('empty')])
  expect(state.pendingInbox()).toHaveLength(2)
})

it.each([false, true])(
  'failed page commit (actually committed=%s) poisons all mutations without cache publication or effects',
  async committed => {
    const db = (state as any).db
    const original = db.batch.bind(db)
    const batch = jest
      .spyOn(db, 'batch')
      .mockImplementation(async (...args: any[]) => {
        if (committed) await original(...args)
        throw new Error('STORAGE_BODY_SENTINEL')
      })
    const before = state.getInboxScan()
    await expect(
      state.importInboxPage(context, 0, [input('a')], 'opaque'),
    ).rejects.toThrow('persistence failed')
    expect(state.getInboxScan()).toEqual(before)
    expect(state.pendingInbox()).toHaveLength(0)
    await expect(workflow.drain(10)).rejects.toThrow('restart required')
    await expect(
      state.importInboxPage(context, 0, [input('b')]),
    ).rejects.toThrow('restart required')
    expect(() => state.addProcessed(hash('a'))).toThrow('restart required')
    expect(generate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    batch.mockRestore()
    await reopen()
    expect(state.pendingInbox()).toHaveLength(committed ? 1 : 0)
    expect(state.getInboxScan().cursor).toBe(committed ? 'opaque' : undefined)
  },
)

it('concurrent imports CAS the revision, and concurrent drains claim one model/payment owner', async () => {
  expect(
    await Promise.all([
      state.importInboxPage(context, 0, [input('a')], 'newer'),
      state.importInboxPage(context, 0, [input('b')], 'stale'),
    ]),
  ).toEqual(['committed', 'stale'])
  expect(state.getInboxScan().cursor).toBe('newer')
  expect(await Promise.all([workflow.drain(1), workflow.drain(1)])).toEqual([
    1, 0,
  ])
  await state.importInboxPage(context, 1, [input('a')])
  expect(state.pendingInbox()).toHaveLength(0)
  expect(generate).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
})

it.each(['model', 'confirmation'] as const)(
  'uncertain %s transition reopens to the committed owner, never re-enqueues',
  async stage => {
    await state.importInboxPage(context, 0, [input('a')])
    const db = (state as any).db
    const original = db.batch.bind(db)
    const batch = jest
      .spyOn(db, 'batch')
      .mockImplementation(async (operations: any[], options: any) => {
        await original(operations, options)
        if (
          operations.some(
            op =>
              op.key.startsWith('response:') &&
              JSON.parse(op.value).phase ===
                (stage === 'model' ? 'model-started' : 'confirmed'),
          )
        )
          throw new Error('uncertain')
      })
    await expect(workflow.drain(1)).rejects.toThrow('persistence failed')
    expect(state.hasProcessed(hash('a'))).toBe(false)
    batch.mockRestore()
    await reopen()
    expect(state.pendingInbox()).toHaveLength(0)
    expect(state.getResponse(hash('a'))?.phase).toBe(
      stage === 'model' ? 'model-started' : 'confirmed',
    )
    await state.importInboxPage(context, 1, [input('a')])
    expect(await workflow.drain(1)).toBe(0)
    expect(generate).toHaveBeenCalledTimes(stage === 'model' ? 0 : 1)
    expect(send).toHaveBeenCalledTimes(stage === 'model' ? 0 : 1)
  },
)

it('backpressures whole pages at both ciphertext bounds without advancing or evicting', async () => {
  const rows = Array.from({ length: QWEN_INBOX_MAX_COUNT }, (_, i) => input(i))
  expect(await state.importInboxPage(context, 0, rows, 'retained')).toBe(
    'committed',
  )
  const checkpoint = state.getInboxScan()
  expect(
    await state.importInboxPage(context, 1, [input('excess')], 'omitted'),
  ).toBe('capacity')
  expect(state.getInboxScan()).toEqual(checkpoint)
  expect(state.pendingInbox()).toHaveLength(QWEN_INBOX_MAX_COUNT)
  await reopen()
  expect(
    await state.importInboxPage(context, 1, [
      {
        ...input('huge'),
        encryptedPayloadHex: '00'.repeat(QWEN_INBOX_MAX_BYTES),
      },
    ]),
  ).toBe('capacity')
  expect(state.getInboxScan()).toEqual(checkpoint)
})

it('completed turns have one history and no inbox ciphertext, history snapshots, reasoning or provider logs', async () => {
  await state.importInboxPage(context, 0, [input('a'), input('b')])
  expect(await workflow.drain(10)).toBe(2)
  const records: Array<[string, string]> = []
  for await (const row of (state as any).db.iterator({})) records.push(row)
  expect(records.filter(([key]) => key.startsWith('inbox:v1:'))).toEqual([])
  expect(
    records.filter(([key]) => key.startsWith('conversation:')),
  ).toHaveLength(1)
  const metadata = JSON.stringify(
    records.filter(([key]) => !key.startsWith('conversation:')),
  )
  for (const sentinel of [
    'PROMPT_SENTINEL',
    'REPLY_SENTINEL',
    'REASONING_SENTINEL',
    'PROVIDER_BODY_SENTINEL',
    input('a').encryptedPayloadHex,
  ]) {
    expect(metadata).not.toContain(sentinel)
    expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(
      sentinel,
    )
  }
})

it.each(['botAddress', 'networkTag', 'relayBaseUrl'] as const)(
  'fails closed on %s context mismatch without deleting retained data',
  async field => {
    await state.importInboxPage(context, 0, [input('a')], 'opaque')
    const checkpoint = state.getInboxScan()
    const changed = {
      ...context,
      [field]: field === 'relayBaseUrl' ? 'http://127.0.0.1:9999' : 'changed',
    }
    await expect(state.initializeInbox(changed, 100)).rejects.toThrow(
      'context mismatch',
    )
    await expect(state.importInboxPage(changed, 1, [])).rejects.toThrow(
      'context mismatch',
    )
    expect(state.getInboxScan()).toEqual(checkpoint)
    expect(state.pendingInbox()).toHaveLength(1)
  },
)

it('byte capacity backpressures a single oversized input without a cursor change', async () => {
  const before = state.getInboxScan()
  expect(
    await state.importInboxPage(
      context,
      0,
      [
        {
          ...input('huge'),
          encryptedPayloadHex: '00'.repeat(QWEN_INBOX_MAX_BYTES + 1),
        },
      ],
      'omitted',
    ),
  ).toBe('capacity')
  expect(state.getInboxScan()).toEqual(before)
  expect(state.pendingInbox()).toHaveLength(0)
})

it('imports a valid large ciphertext record within the existing relay page ceiling', async () => {
  const ciphertext = Buffer.alloc(2 * 1024 * 1024, 0x5a)
  relay.addMessage({
    recipient: BOT,
    timestamp: 10,
    payloadHash: Buffer.from(hash('large'), 'hex'),
    encryptedPayload: ciphertext,
    networkTag: Buffer.from('fixture'),
  })
  await workflow.import()
  await reopen()
  expect(state.pendingInbox()[0].encryptedPayloadHex).toBe(
    ciphertext.toString('hex'),
  )
})

it.each(['recipient', 'relayBaseUrl'])(
  'validates the actual mailbox authentication %s against the durable context before reading',
  async field => {
    ;(workflow as any).options.auth[field] =
      field === 'recipient' ? OTHER : 'http://127.0.0.1:9999'
    await expect(workflow.import()).rejects.toThrow('context mismatch')
    expect(relay.log).toHaveLength(0)
    expect(state.getInboxScan().revision).toBe(0)
  },
)

it('new roots persist the startup floor once; legacy cursors adopt origin zero without rewriting markers', async () => {
  const fresh = new QwenBotStateStore(join(location, 'fresh'))
  await fresh.Open()
  await fresh.initializeInbox(context, 123)
  await fresh.initializeInbox(context, 456)
  expect(fresh.getInboxScan().origin).toBe(123)
  await fresh.Close()
  const legacyLocation = join(location, 'legacy')
  const legacy = new QwenBotStateStore(legacyLocation)
  await legacy.Open()
  legacy.setSince(100000)
  legacy.addProcessed(hash('old'))
  await legacy.Close()
  const adopted = new QwenBotStateStore(legacyLocation)
  await adopted.Open()
  try {
    await adopted.initializeInbox(context, 999999)
    expect(adopted.getInboxScan().origin).toBe(0)
    expect(adopted.getSince()).toBe(100000)
    await adopted.importInboxPage(context, 0, [
      input('old'),
      input('previously-skipped'),
    ])
    expect(adopted.pendingInbox().map(row => row.payloadHashHex)).toEqual([
      hash('previously-skipped'),
    ])
  } finally {
    await adopted.Close()
  }
})

it.each([
  'model-started',
  'response-ready',
  'send-started',
  'confirmed',
  'processed',
  'history',
] as const)(
  'adopts origin zero from legacy %s evidence even when the first timestamp checkpoint was never written',
  async phase => {
    await state.Close()
    const legacyLocation = join(location, 'legacy-without-cursor')
    state = new QwenBotStateStore(legacyLocation)
    await state.Open()
    const history = [
      { role: 'user' as const, content: 'legacy prompt' },
      { role: 'assistant' as const, content: 'legacy reply' },
    ]
    if (phase === 'processed') state.addProcessed(hash('legacy-a'))
    else if (phase === 'history') state.setConversation(PEER, history)
    else {
      await state.beginResponse({
        payloadHashHex: hash('legacy-a'),
        senderAddress: PEER,
        senderPubKeyHex: 'aa',
        context: responseContext,
      })
      if (phase !== 'model-started')
        await state.saveResponse(hash('legacy-a'), 'legacy reply', history)
      if (phase === 'send-started' || phase === 'confirmed')
        await state.startResponseSend(hash('legacy-a'))
      if (phase === 'confirmed')
        await state.confirmResponse(hash('legacy-a'), {
          payloadHashHex: 'legacy-outgoing',
          txHashes: ['legacy-tx'],
        })
    }
    await state.Close()
    state = new QwenBotStateStore(legacyLocation)
    await state.Open()
    expect(state.getSince()).toBeUndefined()
    const owned = state.getResponse(hash('legacy-a'))
    await state.initializeInbox(context, 999999)
    expect(state.getInboxScan().origin).toBe(0)
    makeWorkflow()
    if (phase !== 'history') add('legacy-a')
    add('retained-b')
    add('independent-c', OTHER)
    await workflow.import()
    expect(
      state
        .pendingInbox()
        .map(row => row.payloadHashHex)
        .sort(),
    ).toEqual([hash('retained-b'), hash('independent-c')].sort())
    expect(generate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const held = ['model-started', 'response-ready', 'send-started'].includes(
      phase,
    )
    expect(await workflow.drain(10)).toBe(held ? 1 : 2)
    expect(state.getResponse(hash('legacy-a'))).toEqual(owned)
    expect(state.pendingInbox().map(row => row.payloadHashHex)).toEqual(
      held ? [hash('retained-b')] : [],
    )
    await state.Close()
    state = new QwenBotStateStore(legacyLocation)
    await state.Open()
    await state.initializeInbox(context, 777777)
    expect(state.getInboxScan().origin).toBe(0)
    makeWorkflow()
    await workflow.import()
    expect(await workflow.drain(10)).toBe(0)
    expect(generate).toHaveBeenCalledTimes(held ? 1 : 2)
    expect(send).toHaveBeenCalledTimes(held ? 1 : 2)
  },
)

it.each(['scan', 'pending', 'extra'] as const)(
  'malformed %s durable state fails closed and preserves the offending bytes',
  async kind => {
    const target = join(location, 'malformed-' + kind)
    const seed = new QwenBotStateStore(target)
    await seed.Open()
    await seed.Close()
    const dbLocation = join(target, 'qwen-bot-state')
    const db = level(dbLocation)
    if (kind !== 'scan') {
      await db.put(
        'inbox-scan:v1',
        JSON.stringify({
          version: 1,
          context,
          origin: 0,
          revision: 0,
          nextOrder: 1,
        }),
      )
    }
    const key = kind === 'scan' ? 'inbox-scan:v1' : 'inbox:v1:' + hash('bad')
    const value = JSON.stringify(
      kind === 'scan'
        ? { version: 1, origin: -1 }
        : {
            ...input('bad'),
            version: 1,
            phase: 'pending',
            order: kind === 'pending' ? -1 : 0,
            ...(kind === 'extra' ? { plaintext: 'FORBIDDEN' } : {}),
          },
    )
    await db.put(key, value)
    await db.close()
    const malformed = new QwenBotStateStore(target)
    await expect(malformed.Open()).rejects.toThrow('Invalid Qwen inbox state')
    const retained = level(dbLocation)
    try {
      expect(await retained.get(key)).toBe(value)
      if (kind !== 'scan') {
        await retained.put(
          key,
          JSON.stringify({
            ...input('bad'),
            version: 1,
            phase: 'pending',
            order: 0,
          }),
        )
      }
    } finally {
      await retained.close()
    }
    if (kind !== 'scan') {
      const valid = new QwenBotStateStore(target)
      await valid.Open()
      expect(valid.pendingInbox()).toHaveLength(1)
      await valid.Close()
    }
  },
)

it('an otherwise valid orphan inbox row fails closed without a scan', async () => {
  const target = join(location, 'orphan')
  const seed = new QwenBotStateStore(target)
  await seed.Open()
  await seed.Close()
  const db = level(join(target, 'qwen-bot-state'))
  const value = JSON.stringify({
    ...input('orphan'),
    version: 1,
    phase: 'pending',
    order: 0,
  })
  await db.put('inbox:v1:' + hash('orphan'), value)
  await db.close()
  await expect(new QwenBotStateStore(target).Open()).rejects.toThrow(
    'Invalid Qwen inbox state',
  )
  const preserved = level(join(target, 'qwen-bot-state'))
  try {
    expect(await preserved.get('inbox:v1:' + hash('orphan'))).toBe(value)
  } finally {
    await preserved.close()
  }
})

it('refuses to bind pre-existing response ownership to another account before any inbox effects', async () => {
  const target = join(location, 'old-response')
  const old = new QwenBotStateStore(target)
  await old.Open()
  await old.beginResponse({
    payloadHashHex: hash('old'),
    senderAddress: PEER,
    senderPubKeyHex: 'aa',
    context: responseContext,
  })
  try {
    await expect(
      old.initializeInbox({ ...context, botAddress: OTHER }, 0),
    ).rejects.toThrow('context mismatch')
    expect(old.getResponse(hash('old'))?.phase).toBe('model-started')
  } finally {
    await old.Close()
  }
})

// ---------------------------------------------------------------------------------------------
// #778 canonical inbound. Real shared producer/opener, real Node directory admission over signed
// public evidence, real role keys from typed roots and real Level state. The mailbox page source
// and the reply send are local stand-ins; payments inside the delivery frame are not verified
// here (the relay's admission owns that) and no funds or relay are involved.
// ---------------------------------------------------------------------------------------------
import { Transaction, Wallet, computeAddress, getBytes } from 'ethers'
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
import type { CanonicalInboxRecord } from '@frank/cashweb/relay/monad-mailbox-client'
import { openNodeDirectoryStore } from '@frank/directory-admission/node'
import type { PublicRevisionZeroInput } from '@frank/wallet/monad-wallet-handle'
import {
  createMonadWalletMaterial,
  type MonadRootBundle,
} from '@frank/wallet/monad-wallet-material'
import domainVectors from '../domain-roots/vectors/domain-roots-v1.json'
import type { QwenCanonicalInbound } from './qwen-inbound-workflow'

describe('#778 canonical inbound', () => {
  const NETWORK = 'monad-testnet'
  let root: string
  let canonicalState: QwenBotStateStore
  let inbound: QwenInboundWorkflow
  let pages: CanonicalInboxRecord[][]
  let fetches: number
  let reply: jest.Mock
  let sent: jest.Mock
  let installed: boolean
  let refreshes: number
  let directoryDown: boolean
  let staleCurrent: typeof bot.current | undefined
  let cleanup: Array<() => Promise<void>>
  let bot: Awaited<ReturnType<typeof principal>>
  let user: Awaited<ReturnType<typeof principal>>
  let canonicalContext: {
    botAddress: string
    networkTag: string
    relayBaseUrl: string
  }

  function bundle(index: number): MonadRootBundle {
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
  async function principal(index: number, binding: 'A' | 'B') {
    const material = createMonadWalletMaterial(bundle(index))
    const tuple = (label: string) => ({
      processId: label,
      origin: `https://${label}.example`,
      tuple: {
        relayId: new Uint8Array(16).fill(label === 'a' ? 1 : 2),
        endpoint: `https://${label}.example`,
        identity: {
          keyType: 1,
          keyBytes: material.canonicalRoles!.publicGenerationZeroPoints().auth,
        },
        expiry: { seconds: 3700n, nanoseconds: 0 },
        unknownFields: new Map(),
      },
    })
    const input: PublicRevisionZeroInput = {
      networkTag: 'MONT',
      network: NETWORK,
      chainId: 10143n,
      issuedAt: { seconds: 100n, nanoseconds: 0 },
      expiresAt: { seconds: 3700n, nanoseconds: 0 },
      now: { seconds: 100n, nanoseconds: 0 },
      relayA: tuple('a'),
      relayB: tuple('b'),
      subjectBinding: binding,
    }
    const exported = material.canonicalRoles!.prepareRevisionZero(input)
    const store = await openNodeDirectoryStore({
      location: join(root, `directory-${index}`),
      anchor: {
        network: NETWORK,
        subject: { keyType: 1, keyBytes: exported.auth.compressedPoint },
        revisionZero: exported.t1,
      },
      mode: { kind: 'new' },
    })
    const current = await store.enroll(
      [{ statement: exported.statement, attestation: exported.attestation }],
      {
        now: input.now,
        relay: binding === 'A' ? input.relayA.tuple : input.relayB.tuple,
      },
    )
    cleanup.push(async () => {
      await store.close()
      material.dispose()
    })
    return {
      material,
      current,
      subject: toHex(exported.auth.compressedPoint),
      address: computeAddress(
        '0x' + toHex(exported.auth.compressedPoint),
      ).toLowerCase(),
    }
  }

  /** A real sealed message wrapped in the exact type-1 delivery frame a relay page carries. */
  async function record(
    text: string,
    id: number,
    options: {
      from?: typeof user
      to?: typeof bot
      mutate?: (parts: { payload: Uint8Array; context: Uint8Array }) => void
      wrongDigest?: boolean
    } = {},
  ): Promise<CanonicalInboxRecord & { digest: string }> {
    const from = options.from ?? user,
      to = options.to ?? bot
    const sealed = prepareDirectMessage({
      network: NETWORK,
      senderCurrent: from.current,
      recipientCurrent: to.current,
      messageId: new Uint8Array(16).fill(id),
      items: [directMessageText(text)],
      roles: from.material.canonicalRoles!.create(NETWORK, from.current),
    })
    const parts = { payload: sealed.payload, context: sealed.context }
    options.mutate?.(parts)
    const digest = recipientPayloadDigest(NETWORK, parts.payload)
    const raw = await new Wallet('0x' + '00'.repeat(31) + '01').signTransaction(
      {
        type: 2,
        chainId: 10143n,
        nonce: id,
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
            [1, to.current.stampKey.keyBytes],
          ]),
        ],
        [2, parts.payload],
        [3, options.wrongDigest ? new Uint8Array(32).fill(9) : digest],
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
    return {
      delivery,
      context: parts.context,
      submissionIdentity: 'ab'.repeat(32),
      timestampMs: 1000 + id,
      digest: toHex(digest),
    }
  }

  function make() {
    const responses = new QwenResponseWorkflow({
      state: canonicalState,
      context: {
        ...canonicalContext,
        fundingAddress: bot.address,
        stampValueWei: '1',
      },
      systemPrompt: 'system',
      generator: { reply },
      send: sent,
    })
    const source: QwenCanonicalInbound = {
      network: NETWORK,
      subject: bot.subject,
      recipient: bot.address,
      relayBaseUrl: canonicalContext.relayBaseUrl,
      fetchPage: async () => {
        fetches++
        return { records: pages.shift() ?? [] }
      },
      selfCurrent: async () => bot.current,
      peerCurrent: async (subject, refresh) => {
        if (refresh) refreshes++
        if (!installed || subject !== user.subject) return undefined
        if (directoryDown && refresh) throw new Error('relay unreachable')
        // A recent read may lag the relay; a forced read never does.
        return staleCurrent && !refresh ? staleCurrent : user.current
      },
      roles: self => bot.material.canonicalRoles!.create(NETWORK, self),
    }
    inbound = new QwenInboundWorkflow({
      state: canonicalState,
      context: canonicalContext,
      responses,
      canonical: source,
      peerBlockReason: async () => undefined,
      reserveReply: () => true,
    })
  }
  async function reopenCanonical() {
    await canonicalState.Close()
    canonicalState = new QwenBotStateStore(join(root, 'bot'))
    await canonicalState.Open()
    make()
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'qwen-canonical-inbox-'))
    cleanup = []
    pages = []
    fetches = 0
    installed = true
    refreshes = 0
    directoryDown = false
    staleCurrent = undefined
    reply = jest.fn(async () => ({
      content: 'REPLY_SENTINEL',
      reasoning: 'REASONING_SENTINEL',
    }))
    sent = jest.fn(async () => ({ payloadHashHex: 'ee', txHashes: ['tx'] }))
    bot = await principal(0, 'A')
    user = await principal(1, 'B')
    canonicalContext = {
      botAddress: bot.address,
      networkTag: 'MONT',
      relayBaseUrl: 'https://a.example',
    }
    canonicalState = new QwenBotStateStore(join(root, 'bot'))
    await canonicalState.Open()
    await canonicalState.initializeInbox(canonicalContext, 0)
    make()
  })
  afterEach(async () => {
    await canonicalState.Close()
    for (const close of cleanup.reverse()) await close()
    rmSync(root, { recursive: true, force: true })
  })

  it('imports the exact page durably before any effect, opens it with the bot role keys and answers once', async () => {
    const first = await record('PROMPT_SENTINEL', 1)
    pages.push([first])
    await inbound.import()
    // Durable before the model, the directory or the reply path is touched.
    expect(reply).not.toHaveBeenCalled()
    expect(canonicalState.pendingInbox()).toEqual([
      expect.objectContaining({
        payloadHashHex: first.digest,
        encryptedPayloadHex: toHex(first.delivery),
        contextHex: toHex(first.context),
        timestamp: 1001,
      }),
    ])
    expect(JSON.stringify(canonicalState.pendingInbox())).not.toContain(
      'SENTINEL',
    )
    await reopenCanonical()
    expect(await inbound.drain(10)).toBe(1)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0][0]).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'PROMPT_SENTINEL' },
    ])
    expect(sent).toHaveBeenCalledTimes(1)
    // The peer and its key come from the opened, admitted sender — not from a profile lookup.
    expect(canonicalState.getResponse(first.digest)).toMatchObject({
      phase: 'confirmed',
      senderAddress: user.address,
      senderPubKeyHex: user.subject,
    })
    expect(canonicalState.pendingInbox()).toEqual([])
    // The relay may return the same record again; it is terminal by its payload digest.
    pages.push([first])
    await inbound.import()
    expect(canonicalState.pendingInbox()).toEqual([])
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledTimes(1)
  }, 30000)

  it.each([
    [
      'ciphertext',
      (parts: { payload: Uint8Array }) => {
        parts.payload[parts.payload.length - 200] ^= 1
      },
    ],
    [
      'authenticated context',
      (parts: { context: Uint8Array }) => {
        parts.context[parts.context.length - 1] ^= 1
      },
    ],
  ])(
    'rejects a row whose %s was altered without blocking a valid message behind it from the same peer',
    async (_name, mutate) => {
      const altered = await record('PROMPT_SENTINEL', 2, {
        mutate: mutate as never,
      })
      const valid = await record('PROMPT_SENTINEL', 3)
      pages.push([altered, valid])
      // Structurally valid, so it is imported; only opening can tell it was altered.
      await inbound.import()
      expect(canonicalState.pendingInbox()).toHaveLength(2)
      expect(await inbound.drain(10)).toBe(1)
      // The altered row was decided against a new directory read and is terminal; the valid
      // message behind it, from the same peer, is answered exactly once.
      expect(refreshes).toBe(1)
      expect(reply).toHaveBeenCalledTimes(1)
      expect(sent).toHaveBeenCalledTimes(1)
      expect(canonicalState.pendingInbox()).toEqual([])
      expect(canonicalState.getResponse(valid.digest)?.phase).toBe('confirmed')
      await reopenCanonical()
      pages.push([altered, valid])
      await inbound.import()
      expect(await inbound.drain(10)).toBe(0)
      expect(canonicalState.pendingInbox()).toEqual([])
      expect(reply).toHaveBeenCalledTimes(1)
      expect(canonicalState.getResponse(altered.digest)).toBeUndefined()
    },
    30000,
  )

  it('retains, without opening, a message from a subject that is not installed, then answers once it is', async () => {
    installed = false
    const first = await record('PROMPT_SENTINEL', 3)
    pages.push([first])
    await inbound.import()
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).not.toHaveBeenCalled()
    expect(canonicalState.pendingInbox()).toHaveLength(1)
    installed = true
    expect(await inbound.drain(10)).toBe(1)
    expect(reply).toHaveBeenCalledTimes(1)
  }, 30000)

  it('does not let a forged frame that only claims the approved sender block that sender', async () => {
    // Sealed by someone else entirely, with the sender field rewritten to the approved subject
    // is not constructible here without the codec; an unopenable frame from the approved
    // subject's own producer with a foreign context is the same case for the drain.
    const other = await record('OTHER_SENTINEL', 9)
    const forged = await record('PROMPT_SENTINEL', 8, {
      mutate: parts => {
        parts.context = other.context
      },
    })
    const valid = await record('PROMPT_SENTINEL', 10)
    pages.push([forged, valid])
    await inbound.import()
    expect(await inbound.drain(10)).toBe(1)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(canonicalState.getResponse(forged.digest)).toBeUndefined()
    expect(canonicalState.getResponse(valid.digest)?.phase).toBe('confirmed')
    expect(canonicalState.pendingInbox()).toEqual([])
  }, 30000)

  it('opens under a newly read directory entry instead of rejecting when its recent read was stale', async () => {
    // The recent read is another subject's entry, standing in for a superseded statement.
    staleCurrent = bot.current
    const first = await record('PROMPT_SENTINEL', 11)
    pages.push([first])
    await inbound.import()
    expect(await inbound.drain(10)).toBe(1)
    expect(refreshes).toBe(1)
    expect(reply).toHaveBeenCalledTimes(1)
  }, 30000)

  it('retains, and does not reject, a row that fails to open while the directory cannot be read afresh', async () => {
    staleCurrent = bot.current
    directoryDown = true
    const first = await record('PROMPT_SENTINEL', 12)
    pages.push([first])
    await inbound.import()
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).not.toHaveBeenCalled()
    expect(canonicalState.pendingInbox()).toHaveLength(1)
    directoryDown = false
    expect(await inbound.drain(10)).toBe(1)
    expect(reply).toHaveBeenCalledTimes(1)
  }, 30000)

  it('rejects a frame addressed to another recipient and refuses a page whose digest does not match its payload', async () => {
    const foreign = await record('PROMPT_SENTINEL', 4, { from: bot, to: user })
    pages.push([foreign])
    await inbound.import()
    expect(await inbound.drain(10)).toBe(0)
    expect(canonicalState.pendingInbox()).toEqual([])
    expect(reply).not.toHaveBeenCalled()

    pages.push([await record('PROMPT_SENTINEL', 5, { wrongDigest: true })])
    await expect(inbound.import()).rejects.toThrow('Qwen inbox read failed')
    expect(canonicalState.pendingInbox()).toEqual([])
    expect(reply).not.toHaveBeenCalled()
  }, 30000)

  it('keeps a later turn from the same peer pending, in order, behind a held earlier turn', async () => {
    const first = await record('PROMPT_SENTINEL', 6),
      second = await record('PROMPT_SENTINEL', 7)
    pages.push([first, second])
    sent.mockRejectedValueOnce(new Error('SEND_ERROR_SENTINEL'))
    await inbound.import()
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(canonicalState.getResponse(first.digest)?.phase).toBe('send-started')
    expect(
      canonicalState.pendingInbox().map(row => row.payloadHashHex),
    ).toEqual([second.digest])
    await reopenCanonical()
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledTimes(1)
  }, 30000)

  it('leaves legacy rows untouched in canonical mode', async () => {
    expect(
      await canonicalState.importInboxPage(canonicalContext, 0, [
        {
          payloadHashHex: 'aa'.repeat(32),
          encryptedPayloadHex: Buffer.from(
            `${user.address}|${bot.address}|valid`,
          ).toString('hex'),
          timestamp: 1,
          networkTagHex: Buffer.from('MONT').toString('hex'),
        },
      ]),
    ).toBe('committed')
    expect(await inbound.drain(10)).toBe(0)
    expect(reply).not.toHaveBeenCalled()
    expect(canonicalState.pendingInbox()).toHaveLength(1)
  }, 30000)
})
