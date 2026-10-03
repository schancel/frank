import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

// The real CLI, stub generator, poll loop and Level store; only network/identity/funding are
// fixtures. Reset modules between boots to discard all volatile bot state.
jest.mock('./qwen-bot-common', () => ({
  requiredEnv: (name: string) => process.env[name],
  loadOrCreateIdentity: () => ({
    displayAddress: 'bot',
    toNakamotoPrivateKey: () => null,
  }),
  registerAndLog: jest.fn(),
  setUpDurableFundedStampClient: jest.fn(),
  sendDirectMessageText: jest.fn(),
}))
jest.mock('@frank/wallet/monad-identity', () => ({
  fetchMonadIdentityPubKey: async () => Buffer.from('public-key'),
  fetchMonadProfile: jest.fn(async () => ({ bot: false })),
  mailboxAuthFor: (
    identity: { displayAddress: string },
    relayBaseUrl: string,
  ) => ({
    recipient: identity.displayAddress,
    relayBaseUrl,
  }),
}))
jest.mock('@frank/cashweb/relay/monad-message-feed', () => ({
  fetchMonadMessagesSince: jest.fn(),
}))
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/monad-mailbox-client'),
  fetchMonadMailboxInboxPage: jest.fn(),
}))
jest.mock('@frank/cashweb/relay/monad-message-envelope', () => ({
  canonicalMonadEnvelopeAddress: (address: string) => address.toLowerCase(),
  sameMonadEnvelopeAddress: (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase(),
  parseEnvelope: () => ({ from: 'peer', to: 'bot' }),
  tryDecryptEnvelope: () => 'PRIVATE_PROMPT_SENTINEL',
}))
jest.mock('./qwen-prompt', () => ({
  extractPromptText: (text: string) => text,
}))
jest.mock('./bot-directory', () => ({ botProfileFields: () => [] }))

const INPUT_HASH = createHash('sha256').update('input').digest('hex')
let location: string
let previousEnv: NodeJS.ProcessEnv

beforeEach(() => {
  location = mkdtempSync(join(tmpdir(), 'qwen-cli-'))
  previousEnv = { ...process.env }
  Object.assign(process.env, {
    QWEN_BOT_MODE: 'stub',
    QWEN_BOT_MAX_REPLIES: '1',
    QWEN_BOT_MAX_GREETINGS: '0',
    QWEN_BOT_STATE_DIR: location,
    QWEN_BOT_HANDOFF_JSON: join(location, 'handoff.json'),
    MONAD_TESTNET_HTTP_RPC_URL: 'http://127.0.0.1:1',
    FRANK_NETWORK_TAG: 'fixture',
    CASHWEB_STAMP_MIN_BURN_VALUE_WEI: '1',
    QWEN_BOT_POLL_INTERVAL_MS: '0',
    QWEN_BOT_DEBUG: '1',
  })
})

afterEach(() => {
  jest.restoreAllMocks()
  process.env = previousEnv
  rmSync(location, { recursive: true, force: true })
})

async function boot(
  options: {
    interruptBeforeSend?: boolean
    sendError?: boolean
    modelError?: boolean
    profileError?: boolean
    transientProfileError?: boolean
    emptyFeed?: boolean
  } = {},
) {
  jest.resetModules()
  const { QwenBotStateStore } =
    require('./qwen-bot-state') as typeof import('./qwen-bot-state')
  const common = require('./qwen-bot-common')
  const feed = require('@frank/cashweb/relay/monad-message-feed')
  const mailbox = require('@frank/cashweb/relay/monad-mailbox-client')
  const identity = require('@frank/wallet/monad-identity')
  if (options.profileError)
    identity.fetchMonadProfile.mockRejectedValue(
      new Error('PROFILE_PROVIDER_BODY_SENTINEL'),
    )
  if (options.transientProfileError)
    identity.fetchMonadProfile.mockRejectedValueOnce(
      new Error('TRANSIENT_PROFILE_SENTINEL'),
    )
  const reply = require('./qwen-reply') as typeof import('./qwen-reply')
  const logs: unknown[][] = []
  const spies = ['log', 'warn', 'error'].map(method =>
    jest.spyOn(console, method as 'log').mockImplementation((...args) => {
      logs.push(args)
    }),
  )
  const exit = jest
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never)
  const generator = reply.createQwenReplyGenerator(
    reply.qwenBotConfigFromEnv(process.env),
  )
  const generate = jest.spyOn(generator, 'reply')
  if (options.modelError)
    generate.mockRejectedValue(
      new Error('PROVIDER_BODY_SENTINEL PRIVATE_PROMPT_SENTINEL'),
    )
  const create = jest
    .spyOn(reply, 'createQwenReplyGenerator')
    .mockReturnValue(generator)
  let liveState!: InstanceType<typeof QwenBotStateStore>
  const open = QwenBotStateStore.prototype.Open
  const openSpy = jest
    .spyOn(QwenBotStateStore.prototype, 'Open')
    .mockImplementation(async function (
      this: InstanceType<typeof QwenBotStateStore>,
    ) {
      liveState = this
      await open.call(this)
    })
  // On the base there is no durable boundary; this same test must observe an unwanted send.
  const interruption =
    options.interruptBeforeSend &&
    typeof QwenBotStateStore.prototype.startResponseSend === 'function'
      ? jest
          .spyOn(QwenBotStateStore.prototype, 'startResponseSend')
          .mockRejectedValue(new Error('simulated interruption'))
      : undefined
  let finish!: () => void
  const finished = new Promise<void>(resolve => {
    finish = resolve
  })
  common.setUpDurableFundedStampClient.mockResolvedValue({
    mainAccountSigner: { address: 'funding' },
    close: async () => finish(),
  })
  // End a held boot after one poll without relying on timers or any external service.
  feed.fetchMonadMessagesSince
    .mockResolvedValueOnce(
      options.emptyFeed
        ? []
        : [
            {
              timestamp: 1,
              message: {
                payloadHash: Buffer.from(INPUT_HASH, 'hex'),
                encryptedPayload: Buffer.alloc(0),
                stampPayments: [],
              },
              networkTag: Buffer.from('fixture'),
            },
          ],
    )
    .mockRejectedValue(new Error('fixture end of feed'))
  mailbox.fetchMonadMailboxInboxPage.mockImplementation(async () => ({
    messages: await feed.fetchMonadMessagesSince(),
    nextCursor: undefined,
  }))
  const sends: Array<{ processed: boolean; history: unknown; text: string }> =
    []
  common.sendDirectMessageText.mockImplementation(
    async ({ text }: { text: string }) => {
      sends.push({
        processed: liveState.hasProcessed(INPUT_HASH),
        history: liveState.getConversation('peer'),
        text,
      })
      if (options.sendError)
        throw new Error('PROVIDER_BODY_SENTINEL PRIVATE_REPLY_SENTINEL')
      return { payloadHashHex: 'reply-hash', txHashes: ['fixture-tx'] }
    },
  )
  try {
    require('./qwen-bot.livecheck')
    await finished
    await new Promise(setImmediate)
    return {
      sends,
      modelCalls: generate.mock.calls.length,
      logs: JSON.stringify(logs),
      exitCalls: exit.mock.calls.length,
    }
  } finally {
    interruption?.mockRestore()
    openSpy.mockRestore()
    create.mockRestore()
    generate.mockRestore()
    exit.mockRestore()
    spies.forEach(spy => spy.mockRestore())
  }
}

async function stored() {
  const { QwenBotStateStore } =
    require('./qwen-bot-state') as typeof import('./qwen-bot-state')
  const state = new QwenBotStateStore(location)
  await state.Open()
  try {
    return {
      row: state.getResponse(INPUT_HASH),
      processed: state.hasProcessed(INPUT_HASH),
      history: state.getConversation('peer'),
    }
  } finally {
    await state.Close()
  }
}

it('CLI stub loop keeps processed/history uncommitted until delivery and logs no prompt/reply', async () => {
  const result = await boot()
  expect(result.sends).toEqual([
    {
      processed: false,
      history: undefined,
      text: expect.stringContaining('PRIVATE_PROMPT_SENTINEL'),
    },
  ])
  expect(await stored()).toMatchObject({
    processed: true,
    row: { phase: 'confirmed' },
  })
  expect(result.logs).not.toContain('PRIVATE_PROMPT_SENTINEL')
  expect(result.exitCalls).toBe(0)
})

it('CLI restart after response persistence reuses the exact stub result/history without a mailbox entry or model call', async () => {
  const first = await boot({ interruptBeforeSend: true })
  expect(first.sends).toHaveLength(0)
  expect(first.modelCalls).toBe(1)
  const ready = await stored()
  expect(ready).toMatchObject({
    processed: false,
    history: undefined,
    row: { phase: 'response-ready' },
  })
  const restart = await boot({ emptyFeed: true })
  expect(restart.modelCalls).toBe(0)
  expect(restart.sends).toEqual([
    {
      processed: false,
      history: undefined,
      text: (ready.row as { response: string }).response,
    },
  ])
  expect((await stored()).history).toEqual(
    (ready.row as { proposedHistory: unknown }).proposedHistory,
  )
  const duplicate = await boot()
  expect(duplicate.modelCalls).toBe(0)
  expect(duplicate.sends).toHaveLength(0)
})

it.each(['sendError', 'modelError'] as const)(
  'CLI holds %s across restart without exposing provider bodies, even in debug mode',
  async fault => {
    const first = await boot({ [fault]: true })
    const held = await stored()
    expect(held).toMatchObject({
      processed: false,
      history: undefined,
      row: { phase: fault === 'sendError' ? 'send-started' : 'model-started' },
    })
    const restart = await boot()
    expect(restart.modelCalls).toBe(0)
    expect(restart.sends).toHaveLength(0)
    for (const result of [first, restart]) {
      expect(result.logs).toContain('held')
      for (const sentinel of [
        'PRIVATE_PROMPT_SENTINEL',
        'PRIVATE_REPLY_SENTINEL',
        'PROVIDER_BODY_SENTINEL',
      ])
        expect(result.logs).not.toContain(sentinel)
    }
  },
)

it('CLI uses the shared guard and keeps its profile-provider error body out of logs', async () => {
  const result = await boot({ profileError: true })
  expect(result.modelCalls).toBe(0)
  expect(result.sends).toHaveLength(0)
  expect(result.logs).toContain(
    '[loop-guard] profile lookup failed -- treating as automated',
  )
  expect(result.logs).not.toContain('PROFILE_PROVIDER_BODY_SENTINEL')
  expect((await stored()).processed).toBe(false)
})

it('CLI retries a saved response after a transient profile failure on the next poll without another model call', async () => {
  await boot({ interruptBeforeSend: true })
  const ready = await stored()
  const restart = await boot({ transientProfileError: true, emptyFeed: true })
  expect(restart.modelCalls).toBe(0)
  expect(restart.sends).toEqual([
    {
      processed: false,
      history: undefined,
      text: (ready.row as { response: string }).response,
    },
  ])
  expect(restart.logs).not.toContain('TRANSIENT_PROFILE_SENTINEL')
  expect((await stored()).history).toEqual(
    (ready.row as { proposedHistory: unknown }).proposedHistory,
  )
  expect((await stored()).row?.phase).toBe('confirmed')
})
