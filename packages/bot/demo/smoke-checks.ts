/**
 * The checks the demo smoke test (#312) runs against a live demo stack: a new user talks to each
 * bot and the reply is verified by kind. `classifyReply` is pure (unit-tested); `runSmokeChecks`
 * drives the real relay and bots.
 */
import { request } from 'http'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fromHex, toHex, contentHash, matchForumOperation, validateFrame, defaultContext } from '@frank/codec'
import type { ForumMessage } from '@frank/wallet/forum-model'
import { openMonadWalletBundle } from '@frank/wallet/storage/monad-wallet-bundle'
import { MonadTopicVoteClient } from '@frank/wallet/monad-topic-vote-client'
import { fetchMonadTopicPostView, fetchMonadTopicPostsSince, fetchDiscoveredTopics } from '@frank/wallet/monad-topic-tally-client'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import { BlackjackMoveItem, MessageItem, RaffleItem } from '@frank/cashweb/types/messages'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import {
  fetchMonadIdentityPubKey,
  mailboxAuthFor,
  MonadIdentity,
} from '@frank/wallet/monad-identity'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import {
  BLACKJACK_DEFAULT_MAX_WAGER_WEI,
  BLACKJACK_DEFAULT_MIN_WAGER_WEI,
  BlackjackGameState,
  parseBlackjackWelcome,
  reduceBlackjackState,
  verifyRevealedHand,
} from '@frank/wallet/message-item-plugins/blackjack/game'
import { handValue } from '@frank/wallet/message-item-plugins/blackjack/deck'
import { Wallet } from 'ethers'

import { MonadHttpClient } from '@frank/wallet/monad-http'
import {
  MonadTopicPostClient,
  quoteMonadTopicBurnGasReserve,
} from '@frank/wallet/monad-topic-post-client'


import {
  registerAndLog,
  sendDirectMessageItems,
  setUpFundedStampClient,
  waitForConfirmation,
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

/** What the dealer's welcome must be (#395): a valid `welcome` item whose limits are the dealer's
 * own configured table, followed by the plain-text line older clients show (it must be LAST: an
 * older client's chat-list preview reads the last item and cannot render an unknown action).
 * Pure, unit-tested. */
export function judgeWelcome(
  items: MessageItem[],
  expected: { minWei: bigint; maxWei: bigint },
): SmokeCheck {
  const name = 'blackjack-welcome'
  const welcomeItem = items.find(
    (i): i is BlackjackMoveItem => i.type === 'blackjack-move' && i.action === 'welcome',
  )
  if (!welcomeItem) return { name, ok: false, detail: `no welcome item, got ${describe(items)}` }
  const table = parseBlackjackWelcome(welcomeItem)
  if (!table) return { name, ok: false, detail: 'the welcome item is malformed' }
  if (table.minWagerWei !== expected.minWei || table.maxWagerWei !== expected.maxWei) {
    return {
      name,
      ok: false,
      detail: `the welcome advertises ${table.minWagerWei}..${table.maxWagerWei} wei, the dealer is configured for ${expected.minWei}..${expected.maxWei}`,
    }
  }
  if (items[items.length - 1]?.type !== 'text') {
    return { name, ok: false, detail: 'the welcome is not followed by a text line (last item)' }
  }
  return {
    name,
    ok: true,
    detail: `new profile welcomed with table limits ${table.minWagerWei}..${table.maxWagerWei} wei`,
  }
}

/** Judges a played first hand from what the dealer sent (its `deal`, any `hit`s, its `reveal`) and
 * what the player sent (`bet`, and `stand` if the hand was not over): the reveal must exist, and
 * the revealed seed must reproduce the committed hash, every card and the outcome
 * (`verifyRevealedHand`). Pure, unit-tested. */
export function judgeFirstBet(params: {
  gameId: string
  wagerTxHash: string
  wagerWei: bigint
  playerAddress: string
  /** The blackjack-move items of this game, in the order they were sent/received. */
  moves: BlackjackMoveItem[]
}): SmokeCheck {
  const name = 'blackjack-first-bet'
  let state: BlackjackGameState | undefined
  for (const move of params.moves) {
    if (move.gameId !== params.gameId || move.action === 'welcome') continue
    state = reduceBlackjackState(state, {
      gameId: move.gameId,
      action: move.action,
      wagerTxHash: move.wagerTxHash,
      serverSeedHash: move.serverSeedHash,
      playerCards: move.playerCards,
      dealerUpCard: move.dealerUpCard,
      dealerCards: move.dealerCards,
      serverSeed: move.serverSeed,
      outcome: move.outcome,
      verifiedWager:
        move.action === 'bet'
          ? { fromAddress: params.playerAddress, toAddress: '', valueWei: params.wagerWei }
          : undefined,
      senderAddress: params.playerAddress,
    })
  }
  if (!state || state.phase !== 'resolved') {
    return {
      name,
      ok: false,
      detail: `the hand did not resolve (phase ${state?.phase ?? 'none'}): ${params.moves
        .map(m => m.action)
        .join(',')}`,
    }
  }
  const verdict = verifyRevealedHand(state)
  if (!verdict.valid) {
    return { name, ok: false, detail: `the reveal failed the fairness check: ${verdict.reason}` }
  }
  return {
    name,
    ok: true,
    detail: `a wager of ${params.wagerWei} wei was dealt, played and revealed (${state.outcome}); fairness verified`,
  }
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
      contentType: 'application/cbor',
    },
    ...[
      ['relay topic vote', '/vote', 'PUT'],
      ['relay topic status', '/status', 'POST'],
      ['relay topic list', '?topic=news', 'GET'],
      ['relay topic discovery', '/discover', 'GET'],
    ].map(([name, path, method]) => ({
      name, url: `${handle.relayUrl}/message/monad/topics${path}`,
      method, body: method === 'GET' ? '' : 'x', contentType: 'application/cbor',
    })),
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
        'access-control-request-headers': 'content-type,accept',
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
          { 'origin': APP_ORIGIN, 'content-type': t.contentType ?? 'application/json', 'accept': t.name.startsWith('relay topic') ? 'application/cbor' : 'application/json' },
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
  read: ForumMessage | undefined,
  payloadHashHex: string,
  expected: { title: string; message: string; parentDigest?: string } = {
    title: POSTED_TITLE, message: POSTED_MESSAGE,
  },
): SmokeCheck {
  if (!read) return { name: 'topic-post', ok: false, detail: 'the relay accepted the post but does not return it' }
  const entry = read.entries[0]
  if (!entry) return { name: 'topic-post', ok: false, detail: 'the relay returned a post with no entries' }
  if (read.payloadDigest !== payloadHashHex || read.topic !== 'news' ||
      read.parentDigest !== expected.parentDigest || read.entries.length !== 1 ||
      entry.kind !== 'post' || entry.title !== expected.title || entry.message !== expected.message) {
    return { name: 'topic-post', ok: false, detail: 'the relay returned a different title, body, topic, parent or T1' }
  }
  return { name: 'topic-post', ok: true, detail: `canonical post read back exactly (T1 ${payloadHashHex.slice(0, 12)}...)` }
}

/** The ordinary demo uses the canonical clients and an isolated durable wallet root. */
export async function checkTopicPost(
  handle: DemoHandle,
  ctx: Pick<Awaited<ReturnType<typeof setUpFundedStampClient>>, 'pool' | 'provider' | 'mainAccountSigner'>,
): Promise<SmokeCheck> {
  let walletState: Awaited<ReturnType<typeof openMonadWalletBundle>> | undefined
  let location: string | undefined
  try {
    const { config, relayUrl } = handle
    if (!config.fakeChain) throw new Error('canonical Forum smoke requires the built-in fake chain')
    location = await mkdtemp(join(tmpdir(), 'frank-forum-smoke-'))
    const syntheticWallet = Wallet.createRandom()
    walletState = await openMonadWalletBundle({
      location, mode: 'create', seed: { mnemonic: syntheticWallet.mnemonic!.phrase },
    })
    const policy = {
      network: 'monad-testnet',
      chainId: (await ctx.provider.getNetwork()).chainId,
      burnAddress: config.stampBurnAddress,
    }
    const handleParams = {
      pool: walletState.pool, leaseManager: walletState.leaseManager,
      topicOperationJournal: walletState.topicOperationJournal, walletState,
      provider: ctx.provider, httpClient: new MonadHttpClient({ rpcUrl: config.rpcUrl }),
      relayBaseUrl: relayUrl, cborNetwork: policy.network,
      forumChainId: policy.chainId, forumBurnAddress: policy.burnAddress,
    }
    const client = new MonadTopicPostClient(handleParams)
    const votes = new MonadTopicVoteClient(handleParams)
    const voteWeightWei = BigInt(config.minStampWei)
    const gasReserveWei = await quoteMonadTopicBurnGasReserve({
      signer: ctx.mainAccountSigner, burnAddress: policy.burnAddress,
    })
    const prepare = async () => {
      await client.resumePendingOperations()
      await votes.resumePendingOperations()
      return walletState!.pool.prepareBurnAccount({
        mainAccountSigner: ctx.mainAccountSigner, provider: ctx.provider,
        burnValueWei: voteWeightWei, gasReserveWei,
      })
    }
    const verifyStatus = async (expected: Parameters<typeof matchForumOperation>[1]) => {
      const response = await fetch(`${relayUrl}/message/monad/topics/status`, {
        method: 'POST', headers: { 'content-type': 'application/cbor', accept: 'application/cbor' },
        body: expected.submittedFrame as unknown as BodyInit,
      })
      if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/cbor') throw new Error('status did not return CBOR success')
      const status = matchForumOperation(new Uint8Array(await response.arrayBuffer()), expected)
      if (status.state !== 2) throw new Error('exact status is not confirmed')
    }
    const submit = async (title: string, message: string, parentDigest?: string) => {
      const prepared = await prepare()
      const result = await client.submitTopicPost({
        topic: 'news', entries: [{ kind: 'post', title, message }], direction: 'up',
        parentPostHash: parentDigest ? fromHex(parentDigest) : undefined,
        burnAddress: policy.burnAddress, voteWeightWei, leaseIndex: prepared.index,
      })
      const parsed = validateFrame(result.postFrame, defaultContext())
      if (parsed.kind !== 'parsed' || parsed.typed?.type !== 9 || parsed.schemaVersion !== 2) throw new Error('post is not canonical schema 2')
      if (toHex(contentHash(parsed)) !== result.payloadHashHex) throw new Error('post T1 differs from exact schema-2 bytes')
      await verifyStatus({
        network: policy.network, submittedFrame: result.status.submittedFrame.frame,
        targetHash: fromHex(result.payloadHashHex), transactionHash: result.status.transactionHash,
        sender: result.status.sender, direction: 1, value: voteWeightWei,
      })
      const read = await fetchMonadTopicPostView({ relayBaseUrl: relayUrl, payloadHashHex: result.payloadHashHex, policy })
      const verdict = verifyReadBackPost(read, result.payloadHashHex, { title, message, parentDigest })
      if (!verdict.ok) throw new Error(verdict.detail)
      return result
    }
    const post = await submit(POSTED_TITLE, POSTED_MESSAGE)
    await submit('Demo reply', 'canonical reply body', post.payloadHashHex)
    for (const direction of ['up', 'down'] as const) {
      const prepared = await prepare()
      const result = await votes.castVote({
        targetPayloadHash: fromHex(post.payloadHashHex), direction,
        burnAddress: policy.burnAddress, voteWeightWei, leaseIndex: prepared.index,
      })
      if (result.status.state !== 2 || result.status.direction !== (direction === 'up' ? 1 : 0) || result.status.value !== voteWeightWei) throw new Error('vote status does not match direction/value')
      await verifyStatus({
        network: policy.network, submittedFrame: result.status.submittedFrame.frame,
        targetHash: fromHex(post.payloadHashHex), transactionHash: result.status.transactionHash,
        sender: result.status.sender, direction: direction === 'up' ? 1 : 0, value: voteWeightWei,
      })
    }
    const rows = await fetchMonadTopicPostsSince({ relayBaseUrl: relayUrl, topic: 'news', policy })
    const topics = await fetchDiscoveredTopics({ relayBaseUrl: relayUrl, policy })
    const read = rows.find(row => row.payloadDigest === post.payloadHashHex)
    if (!verifyReadBackPost(read, post.payloadHashHex).ok || read!.voteWeightWei !== voteWeightWei.toString()) throw new Error('complete list does not show exact post and net up/down weight')
    if (!topics.some(topic => topic.topic === 'news')) throw new Error('complete discovery omits news')
    if (walletState.topicOperationJournal.getAll().length !== 0) throw new Error('confirmed smoke operations remain unsettled')
    return { name: 'topic-post', ok: true, detail: 'canonical post, reply/parent/T1, list, discovery, up/down votes and exact confirmed status verified' }
  } catch (err) {
    return { name: 'topic-post', ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    await walletState?.close()
    if (location) await rm(location, { recursive: true, force: true })
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
  entryPriceWei: bigint
  maxEntries: number
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
  if (entrants.length !== params.maxEntries) {
    return {
      name,
      ok: false,
      detail: `expected ${params.maxEntries} entrants, got ${entrants.length}`,
    }
  }
  const expectedPot = params.entryPriceWei * BigInt(entrants.length)
  if (pot !== expectedPot.toString()) {
    return {
      name,
      ok: false,
      detail: `the draw states a pot of ${pot} wei, expected ${expectedPot} (${entrants.length} x ${params.entryPriceWei})`,
    }
  }
  // Everything the raffle identity sent to an entrant: exactly one payment, to the winner.
  const isEntrant = (a: string | null) =>
    a !== null && entrants.some(e => e.toLowerCase() === a.toLowerCase())
  const toEntrants = txs.filter(
    t => t.from.toLowerCase() === raffleAddress.toLowerCase() && isEntrant(t.to),
  )
  const others = toEntrants.filter(t => t.to?.toLowerCase() !== winner.toLowerCase())
  if (others.length > 0) {
    return {
      name,
      ok: false,
      detail: `the raffle also paid ${others.length} non-winner entrant(s)`,
    }
  }
  const payouts = toEntrants
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
): Promise<SmokeCheck> {
  const name = 'raffle-round'
  let entrantClient: Awaited<ReturnType<typeof setUpFundedStampClient>> | undefined
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

    entrantClient = await setUpFundedStampClient({
      rpcUrl: handle.config.rpcUrl,
      relayBaseUrl: handle.relayUrl,
      mainWalletJsonPath: handle.config.mainWalletJson,
      stampValueWei: price,
      label: 'raffle-entrants',
    })

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
        ...entrantClient,
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
            myPrivateKey: who.toNakamotoPrivateKey(),
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
      entryPriceWei: price,
      maxEntries,
    })
  } catch (err) {
    return {
      name,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (entrantClient) await entrantClient.closePool()
  }
}

/** Every message the dealer has sent `human`, decoded (oldest first). Mailbox reads are
 * idempotent, so callers re-read from the start of the run. */
async function dealerMessages(
  handle: DemoHandle,
  human: MonadIdentity,
  dealerAddress: string,
  dealerKey: Buffer,
  since: number,
): Promise<MessageItem[][]> {
  const stored = await fetchMonadMessagesSince({
    ...mailboxAuthFor(human, handle.relayUrl),
    sinceMs: since,
  })
  const messages: MessageItem[][] = []
  for (const row of stored) {
    if (!row.message) continue
    const envelope = parseEnvelope(row.message.encryptedPayload)
    if (
      !envelope ||
      !sameMonadEnvelopeAddress(envelope.to, human.displayAddress) ||
      !sameMonadEnvelopeAddress(envelope.from, dealerAddress)
    ) {
      continue
    }
    const plaintext = tryDecryptEnvelope({
      envelope,
      myPrivateKey: human.toNakamotoPrivateKey(),
      senderPubKey: dealerKey,
    })
    if (plaintext === undefined) continue
    messages.push(deserializeMessageItems(plaintext))
  }
  return messages
}

/** The dealer's opening message and a scripted first bet, end to end (#395): a NEW profile (funded
 * by the faucet) must receive the welcome exactly once, and a real wager transfer from that
 * profile, the `bet`, a `stand` and the dealer's `reveal` must resolve with a passing fairness
 * check. The browser bet control is not exercised here; it sends exactly this sequence. */
export async function checkBlackjackWelcomeAndFirstBet(
  handle: DemoHandle,
  params: {
    human: MonadIdentity
    humanPrivateKey: string
    dealerKey: Buffer
    startedAt: number
    timeoutMs: number
    ctx: Pick<
      Awaited<ReturnType<typeof setUpFundedStampClient>>,
      'stampClient' | 'pool' | 'provider' | 'mainAccountSigner'
    >
  },
): Promise<SmokeCheck[]> {
  const welcomeName = 'blackjack-welcome'
  const betName = 'blackjack-first-bet'
  const { human, dealerKey, startedAt, ctx } = params
  const dealer = handle.addresses.blackjack
  const env = handle.config.bots.find(b => b.name === 'blackjack')?.env ?? {}
  const expected = {
    minWei: BigInt(env.BLACKJACK_BOT_MIN_WAGER_WEI ?? BLACKJACK_DEFAULT_MIN_WAGER_WEI),
    maxWei: BigInt(env.BLACKJACK_BOT_MAX_WAGER_WEI ?? BLACKJACK_DEFAULT_MAX_WAGER_WEI),
  }
  const read = () => dealerMessages(handle, human, dealer, dealerKey, startedAt)
  const isWelcome = (items: MessageItem[]) =>
    items.some(i => i.type === 'blackjack-move' && i.action === 'welcome')
  try {
    const deadline = Date.now() + params.timeoutMs
    let welcomed: MessageItem[] | undefined
    while (!welcomed && Date.now() < deadline) {
      welcomed = (await read()).find(isWelcome)
      if (!welcomed) await sleep(2000)
    }
    const welcomeCheck: SmokeCheck = welcomed
      ? judgeWelcome(welcomed, expected)
      : { name: welcomeName, ok: false, detail: `no welcome within ${params.timeoutMs}ms` }

    // The scripted first bet: the same sequence the browser control sends.
    const wagerWei = expected.minWei
    const signer = new MonadAccountTxSigner({
      privateKey: params.humanPrivateKey,
      provider: ctx.provider,
      httpClient: new MonadHttpClient({ rpcUrl: handle.config.rpcUrl }),
    })
    const wagerTxHash = await signer.submit(await signer.buildAndSignTransfer(dealer, wagerWei))
    await waitForConfirmation(signer, wagerTxHash, 'blackjack wager')
    const gameId = `bj-smoke-${Date.now()}`
    const bet: BlackjackMoveItem = { type: 'blackjack-move', gameId, action: 'bet', wagerTxHash }
    const send = (item: BlackjackMoveItem) =>
      sendDirectMessageItems({
        ...ctx,
        fromIdentity: human,
        toAddress: dealer,
        toPubKey: dealerKey,
        items: [item],
        stampValueWei: BigInt(handle.config.minStampWei) * 10n,
        networkTag: handle.config.networkTag,
      })
    await send(bet)

    const gameMoves = async () =>
      (await read())
        .flat()
        .filter((i): i is BlackjackMoveItem => i.type === 'blackjack-move' && i.gameId === gameId)
    const dealerError = async () =>
      (await read())
        .flat()
        .find(i => i.type === 'text' && i.text.includes(`[game=${JSON.stringify(gameId)}]`)) as
        | { text: string }
        | undefined
    const waitFor = async (action: BlackjackMoveItem['action']) => {
      const until = Date.now() + params.timeoutMs
      while (Date.now() < until) {
        const found = (await gameMoves()).find(m => m.action === action)
        if (found) return found
        const rejected = await dealerError()
        if (rejected) throw new Error(`the dealer rejected the bet: ${rejected.text}`)
        await sleep(2000)
      }
      throw new Error(`no ${action} from the dealer within ${params.timeoutMs}ms`)
    }

    const deal = await waitFor('deal')
    const moves: BlackjackMoveItem[] = [bet, deal]
    // A natural is revealed at once; otherwise stand and wait for the reveal.
    if (!handValue(deal.playerCards ?? []).blackjack) {
      const stand: BlackjackMoveItem = { type: 'blackjack-move', gameId, action: 'stand' }
      await send(stand)
      moves.push(stand)
    }
    const reveal = await waitFor('reveal')
    moves.push(reveal)
    const firstBet = judgeFirstBet({
      gameId,
      wagerTxHash,
      wagerWei,
      playerAddress: human.displayAddress,
      moves,
    })

    // Greeted exactly once, however long the dealer has been polling.
    const welcomes = (await read()).filter(isWelcome).length
    if (welcomes !== 1 && welcomeCheck.ok) {
      return [
        { name: welcomeName, ok: false, detail: `the dealer sent ${welcomes} welcomes, expected 1` },
        firstBet,
      ]
    }
    return [welcomeCheck, firstBet]
  } catch (err) {
    return [
      { name: welcomeName, ok: false, detail: 'not reached: ' + (err instanceof Error ? err.message : String(err)) },
      { name: betName, ok: false, detail: err instanceof Error ? err.message : String(err) },
    ]
  }
}

export async function runSmokeChecks(
  handle: DemoHandle,
  options: { timeoutMs: number },
): Promise<SmokeCheck[]> {
  const { config, relayUrl } = handle
  // The wallet is kept so the scripted first bet can sign a real wager transfer as this profile.
  const humanWallet = Wallet.createRandom()
  const human = MonadIdentity.fromPrivateKeyHex(humanWallet.privateKey)
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
          myPrivateKey: human.toNakamotoPrivateKey(),
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
    const raffleCheck = await checkRaffleFill(handle)

    // The faucet has no chat: it must have sent the new profile a transfer on the fake chain.
    let funded = false
    const fundingDeadline = Date.now() + options.timeoutMs
    do {
      funded = (handle.fakeRpc?.transactions() ?? []).some(
        t => t.to?.toLowerCase() === human.displayAddress.toLowerCase() && BigInt(t.valueWei) > 0n,
      )
      if (!funded) await sleep(2000)
    } while (!funded && Date.now() < fundingDeadline)
    const faucet: SmokeCheck = funded
      ? { name: 'faucet', ok: true, detail: 'funded the new profile' }
      : { name: 'faucet', ok: false, detail: 'no funding transfer to the new profile' }

    // The dealer's welcome and a scripted first bet (needs the funding above).
    const blackjackChecks: SmokeCheck[] = funded
      ? await checkBlackjackWelcomeAndFirstBet(handle, {
          human,
          humanPrivateKey: humanWallet.privateKey,
          dealerKey: botKeys.blackjack,
          startedAt,
          timeoutMs: options.timeoutMs,
          ctx: { stampClient, pool, provider, mainAccountSigner },
        })
      : [
          { name: 'blackjack-welcome', ok: false, detail: 'skipped: the new profile was never funded' },
          { name: 'blackjack-first-bet', ok: false, detail: 'skipped: the new profile was never funded' },
        ]
    return [
      ...Object.keys(PROMPTS).map(b => results.get(b) as SmokeCheck),
      faucet,
      ...blackjackChecks,
      topicPost,
      cors,
      raffleCheck,
    ]
  } finally {
    await closePool()
  }
}
