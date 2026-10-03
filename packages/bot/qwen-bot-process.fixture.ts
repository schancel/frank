/** Child-process fixture: real Qwen CLI/workflow/Level state; external identity, crypto,
 * relay and payment boundaries are local fixtures. Never reads credentials or sends funds. */
import type { QwenReplyGenerator, QwenBotConfig } from './qwen-reply'
import type { StampMonadMessageResult } from '@frank/wallet/monad-stamp-client'
import { createHash } from 'crypto'
import {
  privateKeyFromSecretBytes,
  publicFromPrivate,
  signEcdsa,
} from '@frank/nakamoto'
import { MockMailboxRelay } from '@frank/cashweb/relay/monad-mailbox-mock-relay.testutil'

const BOT = '0x' + 'ab'.repeat(20)
const PEER = '0x' + 'cd'.repeat(20)
const OTHER = '0x' + 'ef'.repeat(20)
const mode = process.env.QWEN_PROCESS_SCENARIO
const key = privateKeyFromSecretBytes(new Uint8Array(32).fill(7), true)
if (!key.ok) throw new Error('fixture key')
const pub = publicFromPrivate(key.value)
if (!pub.ok) throw new Error('fixture public key')
const relay = new MockMailboxRelay({
  networkTag: Buffer.from('fixture'),
  maxUsedChallenges: 10000,
})
relay.registerProfile(BOT, pub.value.compressed)
const hash = (id: string) => createHash('sha256').update(id).digest()
const input = (id: string, timestamp: number, peer = PEER) => ({
  recipient: BOT,
  timestamp,
  payloadHash: hash(id),
  encryptedPayload: Buffer.from(`ciphertext:${peer}`),
  networkTag: Buffer.from('fixture'),
})
if (mode !== 'empty') {
  relay.addMessage(input('first', 1))
  if (mode === 'held') {
    relay.addMessage(input('second', 2))
    relay.addMessage(input('other', 3, OTHER))
  }
}

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
  parseEnvelope: (bytes: Buffer) => ({
    from: bytes.toString().slice('ciphertext:'.length),
    to: BOT,
  }),
  tryDecryptEnvelope: () => 'PROCESS_PROMPT_SENTINEL',
})
replaceModule('@frank/wallet/monad-identity', {
  fetchMonadIdentityPubKey: async () => Buffer.from('public-key'),
  fetchMonadProfile: async () => ({ bot: false }),
  mailboxAuthFor: () => ({
    recipient: BOT,
    relayBaseUrl: 'http://127.0.0.1:8098',
    signDigest: (digest: Uint8Array) => {
      const result = signEcdsa(key.value, digest)
      if (!result.ok) throw new Error('fixture signature')
      return result.value
    },
    http: async (request: Parameters<typeof relay.http>[0]) => {
      if (request.method === 'get') {
        polls++
        if (!mode && polls === 3) relay.addMessage(input('second', 2))
      }
      return relay.http(request)
    },
  }),
})
replaceModule('./qwen-prompt', { extractPromptText: (text: string) => text })
replaceModule('./bot-directory', { botProfileFields: () => [] })

replaceModule('./qwen-bot-common', {
  requiredEnv: (name: string) => process.env[name],
  loadOrCreateIdentity: () => ({
    displayAddress: BOT,
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
        if (mode === 'held' && generations === 1)
          throw new Error('MODEL_BODY_SENTINEL')
        return generator.reply(history)
      },
    }
  },
})
const { QwenBotStateStore } =
  require('./qwen-bot-state') as typeof import('./qwen-bot-state')
const crash = process.env.QWEN_PROCESS_CRASH
if (crash) {
  const method =
    crash === 'page'
      ? 'importInboxPage'
      : crash === 'model'
      ? 'beginResponse'
      : 'confirmResponse'
  const original = QwenBotStateStore.prototype[method]
  ;(QwenBotStateStore.prototype[method] as unknown) = async function (
    this: InstanceType<typeof QwenBotStateStore>,
    ...args: unknown[]
  ) {
    const result = await (original as Function).apply(this, args)
    process.kill(process.pid, 'SIGKILL')
    return result
  }
}
require('./qwen-bot.livecheck')
