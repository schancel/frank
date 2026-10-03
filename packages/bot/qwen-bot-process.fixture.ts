/** Child-process fixture: real Qwen CLI/workflow/Level state; external identity, crypto,
 * relay and payment boundaries are local fixtures. Never reads credentials or sends funds. */
import type { QwenReplyGenerator, QwenBotConfig } from './qwen-reply'
import type { StampMonadMessageResult } from '@frank/wallet/monad-stamp-client'

function replaceModule(request: string, exports: unknown): void {
  const filename = require.resolve(request)
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  } as NodeModule
}

let polls = 0
let generations = 0
let sends = 0
let closed = 0
process.on('exit', () => {
  console.log(
    `QWEN_PROCESS_FIXTURE ${JSON.stringify({
      polls,
      generations,
      sends,
      closed,
    })}`,
  )
})

replaceModule('@frank/cashweb/relay/monad-message-envelope', {
  canonicalMonadEnvelopeAddress: (address: string) => address.toLowerCase(),
  sameMonadEnvelopeAddress: (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase(),
  parseEnvelope: () => ({ from: 'peer', to: 'bot' }),
  tryDecryptEnvelope: () => 'PROCESS_PROMPT_SENTINEL',
})
replaceModule('@frank/wallet/monad-identity', {
  fetchMonadIdentityPubKey: async () => Buffer.from('public-key'),
  fetchMonadProfile: async () => ({ bot: false }),
  mailboxAuthFor: () => ({}),
})
replaceModule('./qwen-prompt', { extractPromptText: (text: string) => text })
replaceModule('./bot-directory', { botProfileFields: () => [] })

const input = (id: string, timestamp: number) => ({
  timestamp,
  message: {
    payloadHash: Buffer.from(id),
    encryptedPayload: Buffer.alloc(0),
    stampPayments: [],
  },
})
replaceModule('@frank/cashweb/relay/monad-message-feed', {
  fetchMonadMessagesSince: async () => {
    polls++
    if (polls === 1) return [input('first', 1)]
    if (polls <= 3) return [input('first', 1), input('second', 2)]
    return []
  },
})
replaceModule('./qwen-bot-common', {
  requiredEnv: (name: string) => process.env[name],
  loadOrCreateIdentity: () => ({
    displayAddress: 'bot',
    toNakamotoPrivateKey: () => null,
  }),
  registerAndLog: async () => undefined,
  setUpDurableFundedStampClient: async () => ({
    mainAccountSigner: { address: 'funding' },
    close: async () => {
      closed++
    },
  }),
  sendDirectMessageText: async (): Promise<StampMonadMessageResult> => {
    sends++
    // This is a real ChangeSweepOutcome variant returned after a successful stamp send.
    // Its BigInts must never enter the durable receipt, even though TS permits extra fields.
    const changeSweeps: StampMonadMessageResult['changeSweeps'] = [
      {
        swept: false,
        reason: 'below-dust-threshold',
        balanceWei: 1n,
        dustThresholdWei: 2n,
      },
    ]
    return {
      payloadHashHex: `reply-${sends}`,
      txHashes: [`tx-${sends}`],
      stored: {
        message: undefined,
        timestamp: sends,
        networkTag: Buffer.from('fixture'),
      },
      leaseIndices: [sends - 1],
      changeSweeps,
    }
  },
})

const replyModule = require('./qwen-reply') as typeof import('./qwen-reply')
replaceModule('./qwen-reply', {
  ...replyModule,
  createQwenReplyGenerator: (config: QwenBotConfig): QwenReplyGenerator => {
    const generator = replyModule.createQwenReplyGenerator(config)
    return {
      ...generator,
      reply: async history => {
        generations++
        return generator.reply(history)
      },
    }
  },
})
require('./qwen-bot.livecheck')
