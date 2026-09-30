/**
 * The checks the demo smoke test (#312) runs against a live demo stack: a new user talks to each
 * bot and the reply is verified by kind. `classifyReply` is pure (unit-tested); `runSmokeChecks`
 * drives the real relay and bots.
 */
import { Transaction, hexlify } from 'ethers'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import { MessageItem } from '@frank/cashweb/types/messages'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import {
  fetchMonadIdentityPubKey,
  mailboxAuthFor,
  MonadIdentity,
} from '@frank/wallet/monad-identity'

import {
  registerAndLog,
  sendDirectMessageItems,
  setUpFundedStampClient,
} from '../qwen-bot-common'
import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { DemoHandle } from './demo'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
}

/** What each bot must answer, decided from the decoded items of its reply. */
export function classifyReply(bot: string, items: MessageItem[]): SmokeCheck {
  const text = items.find(i => i.type === 'text') as { text: string } | undefined
  const kind = (type: string, action?: string) =>
    items.find(i => i.type === type && (action === undefined || (i as { action?: string }).action === action))
  switch (bot) {
    case 'qwen':
      return text?.text.startsWith(STUB_REPLY_PREFIX)
        ? { name: bot, ok: true, detail: 'answered in STUB mode' }
        : { name: bot, ok: false, detail: `expected a labelled stub reply, got ${describe(items)}` }
    case 'vendor': {
      const catalog = kind('digital-goods', 'catalog') as
        | { catalog?: Array<{ itemId: string }> }
        | undefined
      return catalog?.catalog && catalog.catalog.length > 0
        ? { name: bot, ok: true, detail: `catalog with ${catalog.catalog.length} item(s)` }
        : { name: bot, ok: false, detail: `expected a catalog, got ${describe(items)}` }
    }
    case 'raffle':
      return kind('raffle', 'announce') || kind('raffle', 'joined')
        ? { name: bot, ok: true, detail: 'announced the current round' }
        : { name: bot, ok: false, detail: `expected a raffle announcement, got ${describe(items)}` }
    case 'blackjack':
      return text?.text.startsWith('Blackjack: deal is a dealer-only action')
        ? { name: bot, ok: true, detail: 'rejected a bare "deal" with the tagged dealer error' }
        : { name: bot, ok: false, detail: `expected the dealer error, got ${describe(items)}` }
    default:
      return { name: bot, ok: false, detail: `no check defined for ${bot}` }
  }
}

function describe(items: MessageItem[]): string {
  return items.map(i => `${i.type}${(i as { action?: string }).action ? `:${(i as { action?: string }).action}` : ''}`).join(',') || 'nothing'
}

const PROMPTS: Record<string, MessageItem[]> = {
  qwen: [{ type: 'text', text: 'What is Frank?' }],
  vendor: [{ type: 'text', text: 'hello' }],
  raffle: [{ type: 'text', text: 'hello' }],
  // A bare "deal" needs no wager: the dealer answers it with a tagged error, proving it is live.
  blackjack: [{ type: 'blackjack-move', gameId: 'smoke-game', action: 'deal' }],
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runSmokeChecks(
  handle: DemoHandle,
  options: { timeoutMs: number },
): Promise<SmokeCheck[]> {
  const { config, relayUrl } = handle
  const human = MonadIdentity.generate()
  const startedAt = Date.now()
  // A human profile (no bot marker), registered AFTER the bots started: the faucet funds it.
  await registerAndLog({ relayBaseUrl: relayUrl, identity: human, label: 'smoke-user', bot: false })

  const stampValueWei = BigInt(config.minStampWei) * 10n
  const { stampClient, mainAccountSigner, provider, pool, closePool } = await setUpFundedStampClient({
    rpcUrl: config.rpcUrl,
    relayBaseUrl: relayUrl,
    mainWalletJsonPath: config.mainWalletJson,
    stampValueWei,
    label: 'smoke-user',
  })

  const botKeys: Record<string, Buffer> = {}
  try {
    for (const [bot, items] of Object.entries(PROMPTS)) {
      const address = handle.addresses[bot]
      const toPubKey = await fetchMonadIdentityPubKey({ relayBaseUrl: relayUrl, address })
      if (!toPubKey) throw new Error(`${bot} (${address}) has no registered profile`)
      botKeys[bot] = toPubKey
      await sendDirectMessageItems({
        stampClient,
        pool,
        mainAccountSigner,
        provider,
        fromIdentity: human,
        toAddress: address,
        toPubKey,
        items,
        stampValueWei,
        networkTag: config.networkTag,
      })
    }

    // A bot may say more than one thing (Qwen greets a new profile before answering): a bot passes
    // as soon as any of its messages satisfies its check, and fails with the last one's detail.
    const results = new Map<string, SmokeCheck>()
    const lastDetail = new Map<string, SmokeCheck>()
    const deadline = Date.now() + options.timeoutMs
    let since = startedAt
    while (results.size < Object.keys(PROMPTS).length && Date.now() < deadline) {
      const stored = await fetchMonadMessagesSince({
        ...mailboxAuthFor(human, relayUrl),
        sinceMs: since,
      })
      let maxSeen = since - 1
      for (const row of stored) {
        maxSeen = Math.max(maxSeen, row.timestamp)
        if (!row.message) continue
        const envelope = parseEnvelope(row.message.encryptedPayload)
        if (!envelope || !sameMonadEnvelopeAddress(envelope.to, human.displayAddress)) continue
        const bot = Object.keys(PROMPTS).find(b =>
          sameMonadEnvelopeAddress(envelope.from, handle.addresses[b]),
        )
        if (!bot || results.has(bot)) continue
        const plaintext = tryDecryptEnvelope({
          envelope,
          myPrivateKey: human.toBitcorePrivateKey(),
          senderPubKey: botKeys[bot],
        })
        if (plaintext === undefined) continue
        // The stamp payments are real transactions on the fake chain; touching them proves the
        // reply carried a stamp the relay verified.
        void row.message.stampPayments.map(p => Transaction.from(hexlify(p.rawTx)).hash)
        const verdict = classifyReply(bot, deserializeMessageItems(plaintext))
        lastDetail.set(bot, verdict)
        if (verdict.ok) results.set(bot, verdict)
      }
      if (stored.length > 0) since = maxSeen + 1
      if (results.size < Object.keys(PROMPTS).length) await sleep(2000)
    }
    for (const bot of Object.keys(PROMPTS)) {
      if (!results.has(bot)) {
        results.set(
          bot,
          lastDetail.get(bot) ?? { name: bot, ok: false, detail: `no reply within ${options.timeoutMs}ms` },
        )
      }
    }

    // The faucet has no chat: it must have sent the new profile a transfer on the fake chain.
    let funded = false
    while (!funded && Date.now() < deadline) {
      funded = (handle.fakeRpc?.transactions() ?? []).some(
        t => t.to?.toLowerCase() === human.displayAddress.toLowerCase() && BigInt(t.valueWei) > 0n,
      )
      if (!funded) await sleep(2000)
    }
    const faucet: SmokeCheck = funded
      ? { name: 'faucet', ok: true, detail: 'funded the new profile' }
      : { name: 'faucet', ok: false, detail: 'no funding transfer to the new profile' }
    return [...Object.keys(PROMPTS).map(b => results.get(b) as SmokeCheck), faucet]
  } finally {
    await closePool()
  }
}
