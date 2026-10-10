import { spawnSync } from 'child_process'
import { join } from 'path'

import {
  createQwenReplyGenerator,
  qwenBotConfigFromEnv,
  STUB_REPLY_PREFIX,
  stubReply,
} from './qwen-reply'

const LIVE_ENV = {
  QWEN_API_KEY: 'dummy-key',
  QWEN_OPENAI_COMPATIBLE_ENDPOINT: 'http://127.0.0.1:1/v1',
}

describe('qwenBotConfigFromEnv', () => {
  it('fails in live mode without a key, naming the variable and the stub option', () => {
    expect(() => qwenBotConfigFromEnv({})).toThrow(/QWEN_API_KEY/)
    expect(() => qwenBotConfigFromEnv({})).toThrow(/QWEN_BOT_MODE=stub/)
    expect(() => qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'live' })).toThrow(
      /QWEN_API_KEY/,
    )
  })

  it('names the endpoint variable when only the key is set', () => {
    expect(() => qwenBotConfigFromEnv({ QWEN_API_KEY: 'k' })).toThrow(
      /QWEN_OPENAI_COMPATIBLE_ENDPOINT/,
    )
  })

  it('never falls back to stub on its own: a stub needs QWEN_BOT_MODE=stub', () => {
    expect(qwenBotConfigFromEnv(LIVE_ENV).mode).toBe('live')
    expect(qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'stub' }).mode).toBe('stub')
  })

  it('needs no key or endpoint in stub mode', () => {
    const c = qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'stub' })
    expect(c.apiKey).toBeUndefined()
    expect(c.endpoint).toBeUndefined()
  })

  it('rejects an unknown mode instead of guessing', () => {
    expect(() => qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'echo' })).toThrow(
      /QWEN_BOT_MODE must be "live" or "stub"/,
    )
  })

  it('keeps running by default: unlimited replies, no idle exit', () => {
    const c = qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'stub' })
    expect(c.maxReplies).toBe(Infinity)
    expect(c.idleTimeoutMs).toBe(0)
  })

  it('exits after N replies only when QWEN_BOT_MAX_REPLIES asks for it', () => {
    const c = qwenBotConfigFromEnv({
      QWEN_BOT_MODE: 'stub',
      QWEN_BOT_MAX_REPLIES: '1',
    })
    expect(c.maxReplies).toBe(1)
    expect(c.idleTimeoutMs).toBe(10 * 60 * 1000)
    expect(
      qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'stub', QWEN_BOT_MAX_REPLIES: '0' })
        .maxReplies,
    ).toBe(Infinity)
  })

  it('honours an explicit idle timeout and rejects junk numbers', () => {
    expect(
      qwenBotConfigFromEnv({
        QWEN_BOT_MODE: 'stub',
        QWEN_BOT_IDLE_TIMEOUT_MS: '5000',
      }).idleTimeoutMs,
    ).toBe(5000)
    expect(() =>
      qwenBotConfigFromEnv({
        QWEN_BOT_MODE: 'stub',
        QWEN_BOT_MAX_REPLIES: 'lots',
      }),
    ).toThrow(/QWEN_BOT_MAX_REPLIES/)
  })
})

describe('reply generator seam', () => {
  const history = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'What is Frank?' },
  ]

  it('stub answers deterministically, labelled, without any client', async () => {
    const gen = createQwenReplyGenerator(
      qwenBotConfigFromEnv({ QWEN_BOT_MODE: 'stub' }),
      () => {
        throw new Error('stub mode must not build a Qwen client')
      },
    )
    const a = await gen.reply(history)
    const b = await gen.reply(history)
    expect(a).toEqual(b)
    expect(a.content.startsWith(STUB_REPLY_PREFIX)).toBe(true)
    expect(a.content).toContain('What is Frank?')
    expect(gen.describe()).toMatch(/STUB/)
  })

  it('stub bounds the echoed text', () => {
    const long = stubReply([{ role: 'user', content: 'x'.repeat(5000) }])
    expect(long.content.length).toBeLessThan(400)
  })

  it('live mode goes through the client, with the configured key, and is not labelled a stub', async () => {
    const chat = jest.fn(async () => ({ content: 'real', reasoning: 'r' }))
    const makeClient = jest.fn(() => ({ chat }))
    const gen = createQwenReplyGenerator(
      qwenBotConfigFromEnv(LIVE_ENV),
      makeClient,
    )
    expect(await gen.reply(history)).toEqual({
      content: 'real',
      reasoning: 'r',
    })
    expect(makeClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'dummy-key' }),
    )
    expect(gen.describe()).not.toMatch(/STUB/)
    expect(gen.describe()).not.toContain('dummy-key')
  })
})

describe('model call settings', () => {
  it('default to a 45 s limit, three tries and thinking off, and take each from the environment', () => {
    expect(qwenBotConfigFromEnv(LIVE_ENV)).toMatchObject({
      modelTimeoutMs: 45_000,
      modelTries: 3,
      thinking: false,
    })
    expect(
      qwenBotConfigFromEnv({
        ...LIVE_ENV,
        QWEN_MODEL_TIMEOUT_MS: '9000',
        QWEN_MODEL_TRIES: '1',
        QWEN_ENABLE_THINKING: '1',
        QWEN_SYSTEM_PROMPT: 'Be a pirate.',
      }),
    ).toMatchObject({
      modelTimeoutMs: 9000,
      modelTries: 1,
      thinking: true,
      systemPrompt: 'Be a pirate.',
    })
  })

  it.each([
    ['QWEN_MODEL_TIMEOUT_MS', '0'],
    ['QWEN_MODEL_TIMEOUT_MS', 'soon'],
    ['QWEN_MODEL_TRIES', '0'],
    ['QWEN_ENABLE_THINKING', 'yes'],
  ])('refuse %s=%s by name instead of guessing', (name, value) => {
    expect(() => qwenBotConfigFromEnv({ ...LIVE_ENV, [name]: value })).toThrow(name)
  })

  it('reach the client, and every call starts with the system prompt, naming the person when known', async () => {
    const chat = jest.fn(async () => ({ content: 'real', reasoning: '' }))
    const makeClient = jest.fn(() => ({ chat }))
    const gen = createQwenReplyGenerator(
      qwenBotConfigFromEnv({ ...LIVE_ENV, QWEN_ENABLE_THINKING: '1' }),
      makeClient,
    )
    expect(makeClient).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 45_000, thinking: true }),
    )
    const history = [{ role: 'user' as const, content: 'hi' }]
    const signal = new AbortController().signal
    await gen.reply(history, { signal, userName: 'Ada' })
    await gen.reply(history)
    const [named, anonymous] = chat.mock.calls as unknown as [
      [{ role: string; content: string }[], { signal?: AbortSignal }],
      [{ role: string; content: string }[]],
    ]
    expect(named[0][0].role).toBe('system')
    expect(named[0][0].content).toMatch(/resident chatbot inside Frank/)
    expect(named[0][0].content).toMatch(/You are chatting with Ada\.$/)
    expect(named[0].slice(1)).toEqual(history)
    expect(named[1].signal).toBe(signal)
    expect(anonymous[0][0].content).toMatch(/Reply in plain text\.$/)
  })
})

describe('qwen-bot.livecheck.ts entry point', () => {
  it('exits 1 with a clear message (no stack) when the key is missing and no stub mode', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TSX_TSCONFIG_PATH: join(__dirname, 'tsconfig.json'),
    }
    const r = spawnSync(
      join(__dirname, '../../node_modules/.bin/tsx'),
      [join(__dirname, 'qwen-bot.livecheck.ts')],
      { env, encoding: 'utf8', timeout: 30000 },
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('QWEN BOT FAILED')
    expect(r.stderr).toContain('QWEN_API_KEY')
    expect(r.stderr).toContain('QWEN_BOT_MODE=stub')
    expect(r.stderr).not.toMatch(/\n\s+at /)
  }, 35000)
})
