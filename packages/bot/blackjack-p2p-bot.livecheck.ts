/**
 * PARKED: not registered. Nothing in the bot set, `targets/`, the launcher or the demo starts
 * this (the `blackjack:p2p` package script is gone); the dealer that runs is
 * `src/bots/blackjack-bot.ts`. Kept for ticket #1377 (games on escrow).
 *
 * What is known: this plays the same peer-to-peer hand as the running dealer (two-sided
 * commit-reveal, money as the value of a message). It does NOT use the 2-of-2 threshold escrow
 * (`@frank/wallet/message-item-plugins/blackjack/escrow`): no code outside tests imports that
 * module. It counts a bet at the value the wallet reports, not at what the chain confirms.
 */
/**
 * Launcher for the headless peer-to-peer blackjack bot (`./blackjack-p2p-bot.ts`).
 *
 *   BLACKJACK_P2P_ACCOUNT_ROOT_HEX=<64 hex>  the bot account's root secret (keep it private)
 *   BLACKJACK_P2P_STATE_DIR=<dir>            bot state and wallet storage (default ./.blackjack-p2p)
 *   BLACKJACK_P2P_MAX_BET_WEI=<wei>          max bet it offers or accepts as dealer (default 0.1 MON)
 *   BLACKJACK_P2P_PLAYER_BET_WEI=<wei>       most it bets in one hand as player (default 10 stamps)
 *   BLACKJACK_P2P_PLAYER_RISK_WEI=<wei>      most it has at stake as player in total (default 3 bets)
 *   BLACKJACK_P2P_MAX_OPEN_HANDS=<n>         hands with money at stake at once (default 20)
 *   BLACKJACK_P2P_INTERVAL_MS=<ms>           poll interval (default 3000)
 *   BLACKJACK_P2P_NEW_ACCOUNTS_URL=<url>     relay URL listing accounts published since a time; the
 *                                            bot challenges each new one once (see `newAccounts`)
 *   plus the usual MONAD_* / relay variables read by `loadMonadChainConfigFromEnv`.
 *
 *   yarn workspace @frank/bot blackjack:p2p
 *
 * The bot is an ordinary account: a typed wallet opened through the same chain facade as the app,
 * sending and receiving through `chain.directMessages`. At start it signs and publishes its own
 * directory entry on its relay (`./bot-open-directory`, the same setup the Qwen bot uses) and can
 * then message any address that has published an entry. Nothing about another account is
 * configured.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join, resolve } from 'path'

import { deriveDomainRoot } from '../domain-roots/src'
import {
  createEvmChain,
  installCanonicalDirectory,
  loadMonadChainConfigFromEnv,
} from "@frank/wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "@frank/wallet/evm-wallet-handle";
import { BET_MESSAGE_FEE_RESERVE_WEI } from '@frank/wallet/message-item-plugins/blackjack/game'
import { installMessageItemRegistry } from '@frank/wallet/chain/monad-canonical-dm'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '@frank/wallet/message-item-plugins/registry'

import {
  BlackjackP2pBot,
  FileBotStore,
  runBlackjackP2pBot,
  walletBotAccount,
} from './blackjack-p2p-bot'
import {
  openBotDirectory,
  publishBotDirectoryEntry,
} from './bot-open-directory'
import { requiredEnv } from './qwen-bot-common'

function loadRootEnvIfPresent() {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(__dirname, '../../.env'),
  ]
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      try {
        const text = readFileSync(envPath, 'utf8')
        for (const rawLine of text.split('\n')) {
          const line = rawLine.trim()
          if (!line || line.startsWith('#')) continue
          const eq = line.indexOf('=')
          if (eq <= 0) continue
          const key = line.slice(0, eq).trim()
          let val = line.slice(eq + 1).trim()
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1)
          }
          if (!(key in process.env)) {
            process.env[key] = val
          }
        }
      } catch {
        // ignore errors reading .env
      }
      break
    }
  }
}

/**
 * Where the bot learns of new accounts. A feed returns the addresses that appeared since the
 * time it is given (milliseconds); the bot challenges each address once, ever, whatever the feed
 * repeats. `relayNewAccounts` reads the relay's listing of accounts in the order their first
 * directory entry was accepted (`GET /directory/v1/{network}/accounts`); the launcher uses it
 * when BLACKJACK_P2P_NEW_ACCOUNTS_URL is set. Without that variable the bot challenges only
 * accounts that message it.
 */
export type NewAccountsFeed = (sinceMs: number) => Promise<string[]>
export interface LauncherDeps {
  /** Builds the feed for a relay listing URL. Defaults to `relayNewAccounts`. */
  relayNewAccounts?: (relayUrl: string) => NewAccountsFeed
}

/** Turns a since-based feed into the bot's `newAccounts`: it asks for what is new since the last
 * successful call and never loses a batch to a failed one. */
export function sinceFeed(
  feed: NewAccountsFeed,
  now: () => number = Date.now,
  startMs: number = now(),
): () => Promise<string[]> {
  let since = startMs
  return async () => {
    const asked = now()
    const addresses = await feed(since)
    since = asked
    return addresses
  }
}

type FeedFetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/**
 * Reads the relay's new-account listing. `listingUrl` is the full route, for example
 * `https://relay.example/directory/v1/monad-testnet/accounts`. The first read asks for accounts
 * accepted since the given time; every later read continues from the position the relay handed
 * back, so nothing is skipped or depends on this machine's clock agreeing with the relay's. One
 * page (at most 100 accounts) is read per call. A failed or malformed answer throws and moves
 * nothing.
 */
export function relayNewAccounts(
  listingUrl: string,
  fetchJson: FeedFetch = url =>
    (globalThis as unknown as { fetch: FeedFetch }).fetch(url),
): NewAccountsFeed {
  let cursor: string | undefined
  return async sinceMs => {
    const url = new URL(listingUrl)
    if (cursor !== undefined) url.searchParams.set('after', cursor)
    else url.searchParams.set('since', String(Math.max(0, Math.floor(sinceMs))))
    const response = await fetchJson(url.toString())
    if (!response.ok)
      throw new Error(`new-account listing answered ${response.status}`)
    const body = (await response.json()) as {
      accounts?: unknown
      cursor?: unknown
    } | null
    if (!body || !Array.isArray(body.accounts))
      throw new Error('new-account listing answered an unexpected body')
    const addresses: string[] = []
    for (const account of body.accounts) {
      const address = (account as { address?: unknown } | null)?.address
      if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address))
        throw new Error(
          'new-account listing named something that is no address',
        )
      addresses.push(address)
    }
    if (body.cursor !== null && body.cursor !== undefined) {
      if (
        typeof body.cursor !== 'string' ||
        !/^[0-9a-f]{56}$/.test(body.cursor)
      )
        throw new Error('new-account listing answered an unexpected cursor')
      cursor = body.cursor
    }
    return addresses
  }
}

const optionalWei = (name: string): bigint | undefined =>
  process.env[name] ? BigInt(process.env[name] as string) : undefined

/** Opens the bot's typed wallet from the environment. No relay request is made here. */
export async function openBlackjackBotWallet() {
  loadRootEnvIfPresent()
  const stateDir = process.env.BLACKJACK_P2P_STATE_DIR ?? './.blackjack-p2p'
  let rootHex = process.env.BLACKJACK_P2P_ACCOUNT_ROOT_HEX
  const rootFile = join(stateDir, 'account-root.hex')
  if (!rootHex && existsSync(rootFile)) {
    rootHex = readFileSync(rootFile, 'utf8').trim()
  }
  if (!rootHex) {
    mkdirSync(stateDir, { recursive: true })
    rootHex = randomBytes(32).toString('hex')
    writeFileSync(rootFile, rootHex, { mode: 0o600 })
    console.log(`[blackjack-p2p] Generated new bot account root: ${rootFile}`)
  }
  if (!/^[0-9a-fA-F]{64}$/.test(rootHex))
    throw new Error('BLACKJACK_P2P_ACCOUNT_ROOT_HEX must be 64 hex characters')
  const accountRoot = Uint8Array.from(Buffer.from(rootHex, 'hex'))
  const config = {
    ...loadMonadChainConfigFromEnv(),
    walletStorageLocation: join(stateDir, 'wallet'),
  }
  const chain = createEvmChain(config)
  const wallet = (await chain.createWallet({
    evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
    authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
    messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
  })) as EvmChainWalletHandle
  return { stateDir, config, chain, wallet }
}

export async function main(deps: LauncherDeps = {}) {
  const { stateDir, config, chain, wallet } = await openBlackjackBotWallet()
  console.log(`Blackjack bot account: ${wallet.identity.address.raw}`)
  // The account's own balance is what it can stake; this is the address to fund.
  console.log(
    `Blackjack bot funding address: ${(await wallet.getReceiveAddress()).raw}`,
  )
  if (config.networkTag !== 'MONT' && config.networkTag !== 'MON1')
    throw new Error('The blackjack bot needs a Monad network')
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())

  const log = (line: string) => console.log(`[blackjack-p2p] ${line}`)
  // The bot's own entry, signed by this wallet and published before anything else happens.
  const directory = openBotDirectory({
    handle: wallet,
    networkTag: config.networkTag,
    relayBaseUrl: config.relayBaseUrl,
    location: join(stateDir, 'directory'),
  })
  try {
    await publishBotDirectoryEntry({
      directory,
      label: 'blackjack-p2p',
      signal: stop.signal,
    })
  } catch (error) {
    await directory.close().catch(() => undefined)
    await wallet.close()
    if (stop.signal.aborted) return
    throw error
  }
  const uninstallDirectory = installCanonicalDirectory(wallet, directory)
  const uninstallMessageItems = installMessageItemRegistry(
    wallet,
    createDefaultMessageItemRegistry(pluginCapabilitiesNotYetAvailable),
  )
  const uninstall = () => {
    uninstallDirectory()
    uninstallMessageItems()
  }
  const feedUrl = process.env.BLACKJACK_P2P_NEW_ACCOUNTS_URL
  const newAccounts = feedUrl
    ? sinceFeed((deps.relayNewAccounts ?? relayNewAccounts)(feedUrl))
    : undefined
  log(
    feedUrl
      ? `challenging new accounts listed at ${feedUrl}`
      : 'no new-account listing configured: challenging only accounts that message this one',
  )
  const bot = new BlackjackP2pBot(
    walletBotAccount(chain as never, wallet as never),
    new FileBotStore(join(stateDir, 'bot-state.json')),
    {
      maxBetWei: BigInt(process.env.BLACKJACK_P2P_MAX_BET_WEI ?? 10n ** 17n),
      playerBetWei: optionalWei('BLACKJACK_P2P_PLAYER_BET_WEI'),
      maxPlayerRiskWei: optionalWei('BLACKJACK_P2P_PLAYER_RISK_WEI'),
      maxOpenHands: process.env.BLACKJACK_P2P_MAX_OPEN_HANDS
        ? Number(process.env.BLACKJACK_P2P_MAX_OPEN_HANDS)
        : undefined,
      stampWei: config.defaultStampValueWei,
      reserveWei: BET_MESSAGE_FEE_RESERVE_WEI,
      newAccounts,
      log,
    },
  )
  await runBlackjackP2pBot({
    bot,
    intervalMs: Number(process.env.BLACKJACK_P2P_INTERVAL_MS ?? 3000),
    signal: stop.signal,
    log,
  })
  uninstall()
  await directory.close()
  await wallet.close()
}

if (require.main === module)
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
