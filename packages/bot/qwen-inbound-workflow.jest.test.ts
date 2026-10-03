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

it.each(['scan', 'pending', 'orphan', 'extra'] as const)(
  'malformed %s durable state fails closed and preserves the offending bytes',
  async kind => {
    const target = join(location, 'malformed-' + kind)
    const seed = new QwenBotStateStore(target)
    await seed.Open()
    await seed.Close()
    const dbLocation = join(target, 'qwen-bot-state')
    const db = level(dbLocation)
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
    } finally {
      await retained.close()
    }
  },
)

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
