/**
 * The checks the demo smoke test runs against a live demo stack on Monad testnet: a new user with
 * a real wallet talks to each bot through the real relay and each reply is checked for what it
 * says, not merely that something came back. `classifyReply` is pure (unit-tested);
 * `runSmokeChecks` drives the real relay, bots and chain.
 */
import { request } from 'http'

import { formatEther } from 'ethers'

import type { MessageItem, RpsItem, SatoshiDiceItem } from '@frank/cashweb/types/messages'
import { BLACKJACK_DEFAULT_MIN_WAGER_WEI } from '@frank/wallet/message-item-plugins/blackjack/game'
import { isGameId, type HandItem } from '@frank/wallet/message-item-plugins/blackjack/hand'
import { formatMon } from '@frank/wallet/monad-amount'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { RPS_DEFAULT_MAX_WAGER_WEI } from '../src/bots/rps-bot'
import { DICE_DEFAULT_MAX_PAYOUT_WEI } from '../src/bots/satoshi-dice-bot'
import { DemoHandle } from './demo'
import { RealStack, RealWallet, startRealStack } from './real-stack'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ReplyExpectations {
  qwenMode: 'stub' | 'live'
  raffleEntryPriceWei?: string
  raffleMaxEntries?: number
  /** The dealer's table minimum (`BLACKJACK_BOT_MIN_WAGER_WEI`); the bot's default when unset. */
  blackjackMinWagerWei?: bigint
  /** The dice table limit and the rock-paper-scissors table limit; the bots' defaults when unset
   * (the demo starts both with their defaults). */
  diceMaxPayoutWei?: bigint
  rpsMaxWagerWei?: bigint
}

/** A bot's message as the test user received it: its decoded items and what it paid the user. */
export interface BotReply {
  items: MessageItem[]
  stampValueWei: bigint
}

/** A commitment is the hex of a SHA-256: what the game codecs carry. */
const isCommitment = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** What each bot must answer, decided from the decoded items of its reply and what it paid. */
export function classifyReply(bot: string, reply: BotReply, expected: ReplyExpectations): SmokeCheck {
  const { items } = reply
  const no = (detail: string): SmokeCheck => ({ name: bot, ok: false, detail })
  /** A game's opening message is free: only a payout or a refund carries money (#1384). */
  const paid = () =>
    reply.stampValueWei === 0n
      ? undefined
      : no(`the message paid ${formatMon(reply.stampValueWei)}; an offer to play carries no money`)
  const text = items.find(i => i.type === 'text') as { text: string } | undefined
  const kind = (type: string, action?: string) =>
    items.find(
      i =>
        (i.type as string) === type && (action === undefined || (i as { action?: string }).action === action),
    ) as Record<string, unknown> | undefined
  switch (bot) {
    case 'qwen': {
      const answer = text?.text.trim() ?? ''
      if (expected.qwenMode === 'stub') {
        return answer.startsWith(STUB_REPLY_PREFIX) && answer.includes(QWEN_PROMPT)
          ? { name: bot, ok: true, detail: 'answered in STUB mode, echoing the question' }
          : { name: bot, ok: false, detail: `expected a labelled stub reply echoing the question, got ${describe(items)}` }
      }
      // A live model: a real sentence about the question, not a stub and not an error line.
      if (answer.startsWith(STUB_REPLY_PREFIX)) {
        return { name: bot, ok: false, detail: 'the bot is configured live but answered with a stub reply' }
      }
      return answer.length >= 20 && /frank/i.test(answer)
        ? { name: bot, ok: true, detail: `the model answered about Frank (${answer.length} characters)` }
        : { name: bot, ok: false, detail: `expected an answer about Frank, got ${JSON.stringify(answer.slice(0, 120))}` }
    }
    case 'vendor': {
      const catalog = kind('digital-goods', 'catalog') as
        | { catalog?: Array<{ itemId?: string; priceWei?: string }> }
        | undefined
      const entries = catalog?.catalog ?? []
      return entries.length > 0 && entries.every(e => !!e.itemId && /^[1-9][0-9]*$/.test(e.priceWei ?? ''))
        ? { name: bot, ok: true, detail: `catalog with ${entries.length} priced item(s)` }
        : { name: bot, ok: false, detail: `expected a catalog of priced items, got ${describe(items)}` }
    }
    case 'raffle': {
      const round = kind('raffle', 'announce') as
        | { entryPriceWei?: string; maxEntries?: number; serverSeedHash?: string }
        | undefined
      if (!round) return { name: bot, ok: false, detail: `expected a raffle announcement, got ${describe(items)}` }
      if (!round.serverSeedHash) return { name: bot, ok: false, detail: 'the round is announced without its committed seed hash' }
      if (
        (expected.raffleEntryPriceWei !== undefined && String(round.entryPriceWei) !== expected.raffleEntryPriceWei) ||
        (expected.raffleMaxEntries !== undefined && Number(round.maxEntries) !== expected.raffleMaxEntries)
      ) {
        return {
          name: bot,
          ok: false,
          detail: `the round is announced as ${round.maxEntries} entries at ${round.entryPriceWei} wei, the demo is configured for ${expected.raffleMaxEntries} at ${expected.raffleEntryPriceWei}`,
        }
      }
      return { name: bot, ok: true, detail: `announced a ${round.maxEntries}-entry round with its seed committed` }
    }
    case 'blackjack': {
      // The opening move of a hand: the dealer's challenge, committed to its seed before any
      // bet, with the largest bet it covers; its text names the table minimum and that limit.
      const challenge = kind('blackjack-hand', 'challenge') as Extract<HandItem, { action: 'challenge' }> | undefined
      if (!challenge) return no(`expected a blackjack-hand challenge, got ${describe(items)}`)
      if (!isGameId(challenge.gameId)) return no('the challenge carries no game ID (32 hex characters)')
      if (challenge.role !== 'dealer') return no(`the challenge is sent as the ${challenge.role}, not the dealer`)
      if (!isCommitment(challenge.commitment)) return no("the challenge carries no commitment to the dealer's seed")
      const minWei = expected.blackjackMinWagerWei ?? BLACKJACK_DEFAULT_MIN_WAGER_WEI
      const maxBetWei = BigInt(challenge.maxBetWei)
      if (maxBetWei < minWei) {
        return no(`the challenge offers bets up to ${formatMon(maxBetWei)}, below the table minimum of ${formatMon(minWei)}`)
      }
      const said = text?.text ?? ''
      if (!said.includes(`bet between ${formatMon(minWei)} and ${formatMon(maxBetWei)}`)) {
        return no(
          `the challenge's text does not name the table (bet between ${formatMon(minWei)} and ${formatMon(maxBetWei)}): ${JSON.stringify(said.slice(0, 120))}`,
        )
      }
      return (
        paid() ?? {
          name: bot,
          ok: true,
          detail: `a free dealer challenge for game ${challenge.gameId.slice(0, 8)}, seed committed, bets from ${formatMon(minWei)} to ${formatMon(maxBetWei)}`,
        }
      )
    }
    case 'dice': {
      // The roll on offer: its ID and the hash of the bot's secret, published before any bet.
      // The secret itself comes only with a result.
      const table = kind('dice', 'table') as SatoshiDiceItem | undefined
      if (!table) return no(`expected a dice table, got ${describe(items)}`)
      if (!table.rollId) return no('the table names no roll')
      if (!isCommitment(table.commitment)) return no('the table carries no commitment to the secret of its roll')
      if (table.serverSecret !== undefined) return no('the table gives away the secret of its roll before the bet')
      const limitWei = expected.diceMaxPayoutWei ?? DICE_DEFAULT_MAX_PAYOUT_WEI
      const said = text?.text ?? ''
      if (!said.includes(`The most one roll pays is ${formatMon(limitWei)}`) || !/Your stake is what your bet message pays/.test(said)) {
        return no(`the help does not name the table limit of ${formatMon(limitWei)} and how a stake is paid: ${JSON.stringify(said.slice(0, 120))}`)
      }
      return (
        paid() ?? {
          name: bot,
          ok: true,
          detail: `a free table for roll ${table.rollId.slice(0, 8)}, secret committed, paying up to ${formatMon(limitWei)} a roll`,
        }
      )
    }
    case 'rps': {
      // A new match: its ID and the hash of the move the bot has already chosen. The move and
      // its salt come only with the result.
      const start = kind('rps', 'start') as RpsItem | undefined
      if (!start) return no(`expected a rock-paper-scissors match start, got ${describe(items)}`)
      if (!start.matchId) return no('the start names no match')
      if (!isCommitment(start.commitHash)) return no("the start carries no commitment to the bot's move")
      if (start.botMove !== undefined || start.secretSalt !== undefined) {
        return no('the start gives away the bot\'s move or its salt before the player has moved')
      }
      const limitWei = expected.rpsMaxWagerWei ?? RPS_DEFAULT_MAX_WAGER_WEI
      const said = text?.text ?? ''
      if (!said.includes(`Your stake is what your move message pays me, up to ${formatMon(limitWei)}`)) {
        return no(`the help does not name the table limit of ${formatMon(limitWei)} and how a stake is paid: ${JSON.stringify(said.slice(0, 120))}`)
      }
      return (
        paid() ?? {
          name: bot,
          ok: true,
          detail: `a free start of match ${start.matchId.slice(0, 8)}, move committed, stakes up to ${formatMon(limitWei)}`,
        }
      )
    }
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

export const QWEN_PROMPT = 'What is Frank?'
const PROMPTS: Record<string, MessageItem[]> = {
  qwen: [{ type: 'text', text: QWEN_PROMPT }],
  vendor: [{ type: 'text', text: 'hello' }],
  raffle: [{ type: 'text', text: 'hello' }],
  blackjack: [{ type: 'text', text: 'deal me in' }],
  // No bet is placed here (`real-games.livecheck.ts` plays for money): each game bot is asked
  // what it offers, which it answers with its next commitment.
  dice: [{ type: 'text', text: 'help' }],
  rps: [{ type: 'text', text: 'help' }],
}

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
    {
      // The app reaches the chain through the relay's proxy, from the page.
      name: 'relay chain RPC',
      url: `${handle.relayUrl}/chain-rpc/monad-testnet/rpc`,
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    },
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** What the smoke user's account must hold per prompt before any is sent. The wallet pays each
 * message from a single-use account it funds with the stamp and a fee reserve, and refuses a
 * send when its main account cannot cover that (just under 0.01 MON at testnet fees, measured:
 * 0.0157 MON left the main account for two prompts). What a fee did not use stays in the spent
 * account. The (persistent) test user is topped up to this, never beyond: a run costs the test
 * wallet what its prompts take.
 *
 * LOWER THIS when the `wallet-parallel-send` work lands: this number is today's wallet, which
 * funds single-use stamp accounts ahead of each message. That branch brings a message's cost
 * down to about 0.004 MON, and this constant (the only place the amount is written) should
 * follow it, re-measured on testnet. */
export const SMOKE_PROMPT_NEED_WEI = 12_000_000_000_000_000n // 0.012 MON

/** What the test user must hold to send `prompts` prompts. */
export function smokeUserNeedWei(prompts: number): bigint {
  return SMOKE_PROMPT_NEED_WEI * BigInt(prompts)
}

export async function runSmokeChecks(
  handle: DemoHandle,
  options: {
    timeoutMs: number
    env?: Record<string, string | undefined>
    /** Called with the test user once it is open (the smoke reuses it for its proxy check). */
    onUser?: (user: RealWallet) => void | Promise<void>
  },
): Promise<SmokeCheck[]> {
  const { config, relayUrl } = handle
  const checks: SmokeCheck[] = []
  // A bot the launcher reported as not started or not funded fails the run by name.
  for (const problem of handle.botProblems) checks.push({ name: 'bots', ok: false, detail: problem })

  const expected: ReplyExpectations = {
    qwenMode: config.qwenMode,
    raffleEntryPriceWei: config.botProcess.env.RAFFLE_BOT_ENTRY_PRICE_WEI,
    raffleMaxEntries: Number(config.botProcess.env.RAFFLE_BOT_MAX_ENTRIES),
    blackjackMinWagerWei: config.botProcess.env.BLACKJACK_BOT_MIN_WAGER_WEI
      ? BigInt(config.botProcess.env.BLACKJACK_BOT_MIN_WAGER_WEI)
      : undefined,
  }
  const stampValueWei = BigInt(config.minStampWei) * 10n
  let stack: RealStack | undefined
  try {
    // The demo's funding wallet belongs to the running bot host (it counts that wallet's nonces
    // in memory): the test user is funded from a second wallet, never from that one.
    if (!config.testWalletJson) {
      throw new Error(
        'FRANK_TEST_WALLET_JSON is required: a second funded testnet wallet for the test user (the demo funding wallet must not be spent from by anything but the bot host)',
      )
    }
    stack = await startRealStack({
      env: { ...options.env, MONAD_TESTNET_HTTP_RPC_URL: config.rpcUrl, FRANK_TEST_WALLET_JSON: config.testWalletJson },
      relayUrl,
      // Kept with the demo's own state: the test user lives on the demo's relay.
      stateDir: `${config.stateDir}/checks`,
    })
    if (stack.fundingAddress.toLowerCase() === handle.fundingAddress.toLowerCase()) {
      throw new Error('FRANK_TEST_WALLET_JSON is the same wallet as E2E_DEMO_MAIN_WALLET_JSON; it must be a different one')
    }
    // ONE fixed test user, reused on every run: a new profile each time would take a faucet
    // grant per run. It is topped up to what this run's prompts need.
    // The faucet's grant to this profile (one per profile, ever) is what the faucet check reads on
    // later runs: it stays in the identity account and is not this run's money to return.
    const user = await stack.openWallet('smoke-user', { stampValueWei, keepIdentityFunds: true })
    await options.onUser?.(user)
    const needWei = smokeUserNeedWei(Object.keys(PROMPTS).filter(bot => handle.addresses[bot]).length)
    const heldWei = await stack.provider.getBalance(user.mainAccount)
    if (heldWei < needWei) await stack.fund(user.mainAccount, needWei - heldWei)

    for (const [bot, items] of Object.entries(PROMPTS)) {
      if (!handle.addresses[bot]) continue
      try {
        await user.send(handle.addresses[bot], items, stampValueWei)
      } catch (err) {
        checks.push({ name: bot, ok: false, detail: `the prompt could not be sent: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    for (const bot of Object.keys(PROMPTS)) {
      if (!handle.addresses[bot] || checks.some(c => c.name === bot)) continue
      // A bot may say more than one thing (a greeting before the answer): it passes as soon as
      // one of its messages satisfies the check, and fails with the last one's detail.
      let last: SmokeCheck = { name: bot, ok: false, detail: `no reply within ${options.timeoutMs}ms` }
      try {
        await user.receive(message => {
          if (message.senderAddress.raw.toLowerCase() !== handle.addresses[bot].toLowerCase()) return false
          last = classifyReply(bot, message, expected)
          return last.ok
        }, options.timeoutMs)
      } catch {
        /* `last` says why */
      }
      checks.push(last)
    }

    if (config.faucetAmountWei) {
      const wanted = BigInt(config.faucetAmountWei)
      const deadline = Date.now() + options.timeoutMs
      let balance = 0n
      do {
        balance = await stack.provider.getBalance(user.address)
        if (balance < wanted) await sleep(2000)
      } while (balance < wanted && Date.now() < deadline)
      checks.push(
        balance >= wanted
          ? {
              name: 'faucet',
              ok: true,
              detail: user.reused
                ? `the test profile ${user.address} holds ${formatEther(balance)} MON on chain from the faucet's grant on an earlier run (one grant per profile: this run did not exercise the faucet)`
                : `the new profile ${user.address} holds ${formatEther(balance)} MON on chain`,
            }
          : { name: 'faucet', ok: false, detail: `the profile ${user.address} holds ${formatEther(balance)} MON on chain, the faucet should have sent ${formatEther(wanted)}` },
      )
    }
    checks.push(await checkCors(handle))
  } catch (err) {
    checks.push({ name: 'smoke-user', ok: false, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    // The test user is persistent and keeps only its float; the rest of this run's top-up goes
    // back to the test wallet. The demo's bots are never touched here.
    await stack?.finish().catch(err => checks.push({ name: 'smoke-user funds', ok: false, detail: err instanceof Error ? err.message : String(err) }))
  }
  return checks
}
