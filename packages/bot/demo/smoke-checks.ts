/**
 * The checks the demo smoke test (#312) runs against a live demo stack: a new user talks to each
 * bot and the reply is verified by kind. `classifyReply` is pure (unit-tested); `runSmokeChecks`
 * drives the real relay and bots.
 */
import { request } from 'http'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import { MessageItem, RaffleItem } from '@frank/cashweb/types/messages'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import {
  fetchMonadIdentityPubKey,
  mailboxAuthFor,
  MonadIdentity,
} from '@frank/wallet/monad-identity'

import __pb_broadcast_pb from '@frank/cashweb/registry/broadcast_pb'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { SubAccountLeaseManager } from '@frank/wallet/monad-account-lease'
import {
  MonadTopicPostClient,
  quoteMonadTopicBurnGasReserve,
} from '@frank/wallet/monad-topic-post-client'

const { BroadcastMessage, ForumPost: BroadcastForumPostPayload } = __pb_broadcast_pb

import { registerAndLog, sendDirectMessageItems, setUpFundedStampClient } from '../qwen-bot-common'
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
    items.find(
      i =>
        i.type === type && (action === undefined || (i as { action?: string }).action === action),
    )
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
  return (
    items
      .map(
        i =>
          `${i.type}${
            (i as { action?: string }).action ? `:${(i as { action?: string }).action}` : ''
          }`,
      )
      .join(',') || 'nothing'
  )
}

const PROMPTS: Record<string, MessageItem[]> = {
  qwen: [{ type: 'text', text: 'What is Frank?' }],
  vendor: [{ type: 'text', text: 'hello' }],
  raffle: [{ type: 'text', text: 'hello' }],
  // A bare "deal" needs no wager: the dealer answers it with a tagged error, proving it is live.
  // This is ALL the blackjack smoke check proves: a full hand (wager transfer, bet, hit/stand,
  // payout) is not played here, so the dealer's game logic is covered by its unit tests only.
  blackjack: [{ type: 'blackjack-move', gameId: 'smoke-game', action: 'deal' }],
}

export const POSTED_TITLE = 'Demo smoke'
export const POSTED_MESSAGE = 'posted by the smoke test'

/** The origin of the app's dev server (what a browser sends as `Origin`). */
const APP_ORIGIN = 'http://localhost:8080'

interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
}

function rawRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
    })
    req.setTimeout(10_000, () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

/** What a browser app on another origin needs (#361): the preflight is answered and the response
 * carries `access-control-allow-origin`. Node's own fetch ignores CORS, so it is checked by hand
 * against each endpoint the app calls from the page. */
export async function checkCors(handle: DemoHandle): Promise<SmokeCheck> {
  const targets: Array<{
    name: string
    url: string
    method: string
    body?: string
    contentType?: string
  }> = [
    ...(handle.config.fakeChain
      ? [
          {
            name: 'fake chain RPC',
            url: handle.config.rpcUrl,
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          },
        ]
      : []),
    {
      name: 'relay topics',
      url: `${handle.relayUrl}/message/monad/topics`,
      method: 'PUT',
      // A real (rejected) PUT: the relay's CORS layer must decorate actual responses, not only the
      // preflight. The body is not a valid post, so any status is fine; only the header matters.
      body: 'x',
      contentType: 'application/x-protobuf',
    },
    {
      name: 'relay topic read',
      url: `${handle.relayUrl}/message/monad/topics/${'00'.repeat(32)}`,
      method: 'GET',
      body: '',
    },
  ]
  const failures: string[] = []
  for (const t of targets) {
    try {
      const pre = await rawRequest(t.url, 'OPTIONS', {
        'origin': APP_ORIGIN,
        'access-control-request-method': t.method,
        'access-control-request-headers': 'content-type',
      })
      if (pre.status < 200 || pre.status >= 300 || !pre.headers['access-control-allow-origin']) {
        failures.push(
          `${t.name}: preflight got HTTP ${pre.status} and ${
            pre.headers['access-control-allow-origin'] ? 'an' : 'no'
          } access-control-allow-origin`,
        )
      }
      if (t.body !== undefined) {
        const res = await rawRequest(
          t.url,
          t.method,
          { 'origin': APP_ORIGIN, 'content-type': t.contentType ?? 'application/json' },
          t.body,
        )
        if (!res.headers['access-control-allow-origin']) {
          failures.push(`${t.name}: ${t.method} response has no access-control-allow-origin`)
        }
      }
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return failures.length === 0
    ? {
        name: 'cors',
        ok: true,
        detail: `${targets.map(t => t.name).join(' and ')} answer a cross-origin browser request`,
      }
    : { name: 'cors', ok: false, detail: failures.join('; ') }
}

/** Checks the payload the relay returned for the posted topic: present, and the SAME title and
 * message that were posted (not merely "some post"). Pure, unit-tested. */
export function verifyReadBackPost(
  payload: Uint8Array | undefined,
  payloadHashHex: string,
): SmokeCheck {
  if (!payload) {
    return {
      name: 'topic-post',
      ok: false,
      detail: 'the relay accepted the post but does not return it',
    }
  }
  const entry = BroadcastMessage.deserializeBinary(payload).getEntriesList()[0]
  if (!entry) {
    return { name: 'topic-post', ok: false, detail: 'the relay returned a post with no entries' }
  }
  const read = BroadcastForumPostPayload.deserializeBinary(entry.getPayload_asU8())
  if (read.getTitle() !== POSTED_TITLE || read.getMessage() !== POSTED_MESSAGE) {
    return {
      name: 'topic-post',
      ok: false,
      detail: `the relay returned a different post: title "${read.getTitle()}", message "${read.getMessage()}"`,
    }
  }
  return {
    name: 'topic-post',
    ok: true,
    detail: `posted to "news" and read back the same title and message (payload ${payloadHashHex.slice(
      0,
      12,
    )}...)`,
  }
}

/** Posts a forum topic through the relay's real route (a burn transaction to the demo burn address
 * plus `PUT /message/monad/topics`) and reads it back (#364). A relay configured without the burn
 * address answers HTTP 500 here. */
export async function checkTopicPost(
  handle: DemoHandle,
  ctx: Pick<
    Awaited<ReturnType<typeof setUpFundedStampClient>>,
    'pool' | 'provider' | 'mainAccountSigner'
  >,
): Promise<SmokeCheck> {
  try {
    const { config, relayUrl } = handle
    const httpClient = new MonadHttpClient({ rpcUrl: config.rpcUrl })
    const client = new MonadTopicPostClient({
      pool: ctx.pool,
      leaseManager: new SubAccountLeaseManager(ctx.pool),
      provider: ctx.provider,
      httpClient,
      relayBaseUrl: relayUrl,
    })
    const voteWeightWei = BigInt(config.minStampWei)
    const gasReserveWei = await quoteMonadTopicBurnGasReserve({
      signer: ctx.mainAccountSigner,
      burnAddress: config.stampBurnAddress,
    })
    const prepared = await ctx.pool.prepareBurnAccount({
      mainAccountSigner: ctx.mainAccountSigner,
      provider: ctx.provider,
      burnValueWei: voteWeightWei,
      gasReserveWei,
    })
    const result = await client.submitTopicPost({
      topic: 'news',
      entries: [{ kind: 'post', title: POSTED_TITLE, message: POSTED_MESSAGE }],
      direction: 'up',
      burnAddress: config.stampBurnAddress,
      voteWeightWei,
      leaseIndex: prepared.index,
    })
    const view = await client.fetchStoredTopicPostView(result.payloadHashHex)
    return verifyReadBackPost(view?.post?.post?.encryptedPayload, result.payloadHashHex)
  } catch (err) {
    const status = (err as { status?: number }).status
    return {
      name: 'topic-post',
      ok: false,
      detail: `${err instanceof Error ? err.message : String(err)}${
        status === 500
          ? ' (a 500 here means the relay has no MONAD_STAMP_BURN_ADDRESS: see relay.log)'
          : ''
      }`,
    }
  }
}

/** Judges a filled raffle round from what entrants received and what the fake chain saw (#363):
 * every entrant got the same draw naming one of them, and the raffle identity paid exactly that
 * winner exactly the pot in one transaction. Pure, unit-tested. */
export function judgeRaffleFill(params: {
  entrants: string[]
  draws: Map<string, RaffleItem>
  raffleAddress: string
  txs: Array<{ from: string; to: string | null; valueWei: string }>
}): SmokeCheck {
  const name = 'raffle-round'
  const { entrants, draws, raffleAddress, txs } = params
  const missing = entrants.filter(e => !draws.has(e))
  if (missing.length > 0) {
    return {
      name,
      ok: false,
      detail: `${missing.length}/${entrants.length} entrants got no draw message`,
    }
  }
  const first = draws.get(entrants[0]) as RaffleItem
  const winner = first.winnerAddress ?? ''
  const pot = first.potWei ?? ''
  if (
    ![...draws.values()].every(
      d => d.winnerAddress === winner && d.potWei === pot,
    )
  ) {
    return {
      name,
      ok: false,
      detail: 'entrants were sent different draw results',
    }
  }
  if (!entrants.some(e => e.toLowerCase() === winner.toLowerCase())) {
    return { name, ok: false, detail: 'the announced winner is not an entrant' }
  }
  const payouts = txs.filter(
    t =>
      t.from.toLowerCase() === raffleAddress.toLowerCase() &&
      t.to?.toLowerCase() === winner.toLowerCase(),
  )
  if (payouts.length !== 1 || payouts[0].valueWei !== pot) {
    return {
      name,
      ok: false,
      detail: `expected exactly one payout of ${pot} wei to the winner, saw ${
        payouts.length
      } (${payouts.map(p => p.valueWei).join(',')})`,
    }
  }
  return {
    name,
    ok: true,
    detail: `${entrants.length} entrants drew; the winner was paid the ${pot} wei pot`,
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function checkRaffleFill(
  handle: DemoHandle,
  ctx: Pick<
    Awaited<ReturnType<typeof setUpFundedStampClient>>,
    'stampClient' | 'pool' | 'provider' | 'mainAccountSigner'
  >,
): Promise<SmokeCheck> {
  const name = 'raffle-round'
  try {
    const raffle = handle.config.bots.find(b => b.name === 'raffle')
    const maxEntries = Number(raffle?.env.RAFFLE_BOT_MAX_ENTRIES ?? 5)
    const price = BigInt(
      raffle?.env.RAFFLE_BOT_ENTRY_PRICE_WEI ?? '20000000000000000',
    )
    const raffleAddress = handle.addresses.raffle
    const raffleKey = await fetchMonadIdentityPubKey({
      relayBaseUrl: handle.relayUrl,
      address: raffleAddress,
    })
    if (!raffleKey)
      return { name, ok: false, detail: 'the raffle has no registered profile' }
    const entrants: MonadIdentity[] = []
    const startedAt = Date.now()
    for (let i = 0; i < maxEntries; i++) {
      const who = MonadIdentity.generate()
      await registerAndLog({
        relayBaseUrl: handle.relayUrl,
        identity: who,
        label: `raffle-entrant-${i}`,
        bot: false,
      })
      entrants.push(who)
      await sendDirectMessageItems({
        ...ctx,
        fromIdentity: who,
        toAddress: raffleAddress,
        toPubKey: raffleKey,
        items: [{ type: 'raffle', raffleId: 'current', action: 'enter' }],
        stampValueWei: price,
        networkTag: handle.config.networkTag,
      })
    }
    const draws = new Map<string, RaffleItem>()
    const deadline = Date.now() + 120_000
    while (draws.size < entrants.length && Date.now() < deadline) {
      for (const who of entrants) {
        if (draws.has(who.displayAddress)) continue
        const stored = await fetchMonadMessagesSince({
          ...mailboxAuthFor(who, handle.relayUrl),
          sinceMs: startedAt,
        })
        for (const row of stored) {
          if (!row.message) continue
          const envelope = parseEnvelope(row.message.encryptedPayload)
          if (
            !envelope ||
            !sameMonadEnvelopeAddress(envelope.from, raffleAddress)
          )
            continue
          const plaintext = tryDecryptEnvelope({
            envelope,
            myPrivateKey: who.toBitcorePrivateKey(),
            senderPubKey: raffleKey,
          })
          if (plaintext === undefined) continue
          const draw = deserializeMessageItems(plaintext).find(
            (i): i is RaffleItem => i.type === 'raffle' && i.action === 'draw',
          )
          if (draw) draws.set(who.displayAddress, draw)
        }
      }
      if (draws.size < entrants.length) await sleep(2000)
    }
    return judgeRaffleFill({
      entrants: entrants.map(e => e.displayAddress),
      draws,
      raffleAddress,
      txs: handle.fakeRpc?.transactions() ?? [],
    })
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

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
  const { stampClient, mainAccountSigner, provider, pool, closePool } =
    await setUpFundedStampClient({
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

    // The forum and browser-reachability checks: they need only the relay and the chain.
    const topicPost = await checkTopicPost(handle, { pool, provider, mainAccountSigner })
    const cors = await checkCors(handle)

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
          lastDetail.get(bot) ?? {
            name: bot,
            ok: false,
            detail: `no reply within ${options.timeoutMs}ms`,
          },
        )
      }
    }

    // Fill a raffle round: N fresh entrants each pay the entry price, then everyone must receive
    // the draw and the winner must actually be paid the pot (the #363 acceptance check).
    const raffleCheck = await checkRaffleFill(handle, {
      stampClient,
      pool,
      mainAccountSigner,
      provider,
    })

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
    return [
      ...Object.keys(PROMPTS).map(b => results.get(b) as SmokeCheck),
      faucet,
      topicPost,
      cors,
      raffleCheck,
    ]
  } finally {
    await closePool()
  }
}
