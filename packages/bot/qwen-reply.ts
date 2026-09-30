/**
 * Reply generation for the Qwen bot (#314): configuration parsing plus the one seam between the
 * bot's message loop and whatever produces the reply text.
 *
 * Two modes, chosen ONLY by `QWEN_BOT_MODE`:
 *
 * - `live` (the default): calls the OpenAI-compatible Qwen endpoint. `QWEN_API_KEY` and
 *   `QWEN_OPENAI_COMPATIBLE_ENDPOINT` are required; a missing one is a startup error naming the
 *   variable. It never silently degrades to the stub.
 * - `stub`: answers deterministically, offline, with no API key, so a demo, smoke test or CI run
 *   works without credentials or a provider. Every stub reply is labelled as a stub so nobody
 *   mistakes it for a model answer.
 */
import { QwenChatMessage, QwenChatResult, QwenClient } from './qwen-client'

export type QwenBotMode = 'live' | 'stub'

/** Every stub reply starts with this, and the startup banner says the same thing. */
export const STUB_REPLY_PREFIX = '[STUB -- no model, offline canned reply]'

const STUB_ECHO_MAX_CHARS = 200
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000

export interface QwenBotConfig {
  mode: QwenBotMode
  /** Only set (and only required) in live mode. Never logged. */
  apiKey?: string
  endpoint?: string
  model: string
  /** `Infinity` means keep running (the default); a finite value exits after that many replies. */
  maxReplies: number
  /** `0` disables the idle exit. Defaults to disabled when `maxReplies` is unlimited. */
  idleTimeoutMs: number
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return Number(raw)
}

export function qwenBotConfigFromEnv(env: NodeJS.ProcessEnv): QwenBotConfig {
  const rawMode = env.QWEN_BOT_MODE || 'live'
  if (rawMode !== 'live' && rawMode !== 'stub') {
    throw new Error(`QWEN_BOT_MODE must be "live" or "stub", got "${rawMode}"`)
  }
  const mode: QwenBotMode = rawMode

  let apiKey: string | undefined
  let endpoint: string | undefined
  if (mode === 'live') {
    for (const name of ['QWEN_API_KEY', 'QWEN_OPENAI_COMPATIBLE_ENDPOINT']) {
      if (!env[name]) {
        throw new Error(
          `Missing required env var ${name} (live mode). Set it, or set QWEN_BOT_MODE=stub ` +
            'to run the bot offline with canned replies and no API key.',
        )
      }
    }
    apiKey = env.QWEN_API_KEY
    endpoint = env.QWEN_OPENAI_COMPATIBLE_ENDPOINT
  }

  // 0 or unset = keep running; QWEN_BOT_MAX_REPLIES=1 is the explicit exit-after-one flag.
  const maxRepliesRaw = nonNegativeInt(env, 'QWEN_BOT_MAX_REPLIES')
  const maxReplies = maxRepliesRaw ? maxRepliesRaw : Infinity
  const idleRaw = nonNegativeInt(env, 'QWEN_BOT_IDLE_TIMEOUT_MS')
  const idleTimeoutMs =
    idleRaw ?? (Number.isFinite(maxReplies) ? DEFAULT_IDLE_TIMEOUT_MS : 0)

  return {
    mode,
    apiKey,
    endpoint,
    model: env.QWEN_MODEL || 'qwen3.8-max',
    maxReplies,
    idleTimeoutMs,
  }
}

export interface QwenReplyGenerator {
  mode: QwenBotMode
  /** One line for the startup banner; never contains the API key. */
  describe(): string
  reply(history: QwenChatMessage[]): Promise<QwenChatResult>
}

export function stubReply(history: QwenChatMessage[]): QwenChatResult {
  const lastUser = [...history].reverse().find(m => m.role === 'user')
  const said = (lastUser?.content ?? '').replace(/\s+/g, ' ').trim()
  const echo =
    said.length > STUB_ECHO_MAX_CHARS
      ? `${said.slice(0, STUB_ECHO_MAX_CHARS)}...`
      : said
  return {
    content: `${STUB_REPLY_PREFIX} You said: "${echo}"`,
    reasoning: 'stub mode: no model was called',
  }
}

export function createQwenReplyGenerator(
  config: QwenBotConfig,
  makeClient: (opts: {
    apiKey: string
    endpoint: string
    model: string
  }) => Pick<QwenClient, 'chat'> = opts => new QwenClient(opts),
): QwenReplyGenerator {
  if (config.mode === 'stub') {
    return {
      mode: 'stub',
      describe: () =>
        'STUB mode (QWEN_BOT_MODE=stub): deterministic offline replies, no API key, no model call',
      reply: async history => stubReply(history),
    }
  }
  const client = makeClient({
    apiKey: config.apiKey as string,
    endpoint: config.endpoint as string,
    model: config.model,
  })
  return {
    mode: 'live',
    describe: () => `LIVE mode: ${config.model} @ ${config.endpoint}`,
    reply: history => client.chat(history),
  }
}
