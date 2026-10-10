/**
 * The checks the demo smoke test runs against a live demo stack on Monad testnet: a new user with
 * a real wallet talks to each bot through the real relay and each reply is checked for what it
 * says, not merely that something came back. `classifyReply` is pure (unit-tested);
 * `runSmokeChecks` drives the real relay, bots and chain.
 */
import { request } from 'http'

import { formatEther } from 'ethers'

import type { MessageItem } from '@frank/cashweb/types/messages'

import { STUB_REPLY_PREFIX } from '../qwen-reply'
import { DemoHandle } from './demo'
import { RealStack, startRealStack } from './real-stack'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ReplyExpectations {
  qwenMode: 'stub' | 'live'
  raffleEntryPriceWei?: string
  raffleMaxEntries?: number
}

/** What each bot must answer, decided from the decoded items of its reply. */
export function classifyReply(bot: string, items: MessageItem[], expected: ReplyExpectations): SmokeCheck {
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
      // The opening move of a hand: the dealer's challenge, with the table's bet limit.
      const challenge = kind('blackjack-hand', 'challenge') as { gameId?: string } | undefined
      return challenge?.gameId && /blackjack challenge/i.test(text?.text ?? '')
        ? { name: bot, ok: true, detail: `dealt a challenge for game ${challenge.gameId.slice(0, 8)}` }
        : { name: bot, ok: false, detail: `expected a blackjack challenge, got ${describe(items)}` }
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

/** What the smoke user's account is given: enough for the four prompts' stamps and the accounts
 * the wallet prepares to pay them from. What is left goes back to the funding wallet. */
export const SMOKE_USER_FUND_WEI = 50_000_000_000_000_000n // 0.05 MON

export async function runSmokeChecks(
  handle: DemoHandle,
  options: { timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<SmokeCheck[]> {
  const { config, relayUrl } = handle
  const checks: SmokeCheck[] = []
  // A bot the launcher reported as not started or not funded fails the run by name.
  for (const problem of handle.botProblems) checks.push({ name: 'bots', ok: false, detail: problem })

  const expected: ReplyExpectations = {
    qwenMode: config.qwenMode,
    raffleEntryPriceWei: config.botProcess.env.RAFFLE_BOT_ENTRY_PRICE_WEI,
    raffleMaxEntries: Number(config.botProcess.env.RAFFLE_BOT_MAX_ENTRIES),
  }
  const stampValueWei = BigInt(config.minStampWei) * 10n
  let stack: RealStack | undefined
  try {
    stack = await startRealStack({ env: options.env, relayUrl, stateDir: `${config.stateDir}/smoke-${Date.now()}` })
    // A new human profile, registered AFTER the bots started: the faucet pays its address.
    const user = await stack.openWallet('smoke-user', { stampValueWei })
    await stack.fund(user.mainAccount, SMOKE_USER_FUND_WEI)

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
          last = classifyReply(bot, message.items, expected)
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
          ? { name: 'faucet', ok: true, detail: `the new profile ${user.address} holds ${formatEther(balance)} MON on chain` }
          : { name: 'faucet', ok: false, detail: `the new profile ${user.address} holds ${formatEther(balance)} MON on chain, the faucet should have sent ${formatEther(wanted)}` },
      )
    }
    checks.push(await checkCors(handle))
  } catch (err) {
    checks.push({ name: 'smoke-user', ok: false, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    await stack?.stop()
  }
  return checks
}
