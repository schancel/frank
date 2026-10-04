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
 *   plus the usual MONAD_* / relay variables read by `loadMonadChainConfigFromEnv`.
 *
 *   yarn workspace @frank/bot blackjack:p2p
 *
 * The bot is an ordinary account: a typed wallet opened through the same chain facade as the app,
 * sending and receiving through `chain.directMessages`.
 *
 * NOT YET RUNNABLE LIVE: a typed wallet can message only after a directory is installed on it
 * (`installCanonicalDirectory`). Today only the app composes one (operator-installed, a single
 * peer); the open directory that lets any address be messaged is being built separately. Until a
 * headless directory composition exists, `installDirectory` below stops the launcher with that
 * explanation. Everything after it is covered by tests on real typed wallets
 * (`blackjack-p2p-bot.wallets.jest.test.ts`).
 */
import { join } from 'path'

import { deriveDomainRoot } from '../domain-roots/src'
import {
  createMonadChain,
  loadMonadChainConfigFromEnv,
  type MonadChainWalletHandle,
} from '@frank/wallet/chain/monad-chain'
import { BET_MESSAGE_FEE_RESERVE_WEI } from '@frank/wallet/message-item-plugins/blackjack/game'

import {
  BlackjackP2pBot,
  FileBotStore,
  runBlackjackP2pBot,
  walletBotAccount,
} from './blackjack-p2p-bot'
import { requiredEnv } from './qwen-bot-common'

/** The one missing piece for a live run; see this file's header. */
async function installDirectory(_wallet: MonadChainWalletHandle): Promise<void> {
  throw new Error(
    'No headless directory composition exists yet: the bot account cannot message until one is ' +
      'installed on its wallet (installCanonicalDirectory). Wire the open directory here.',
  )
}

const optionalWei = (name: string): bigint | undefined =>
  process.env[name] ? BigInt(process.env[name] as string) : undefined

async function main() {
  const stateDir = process.env.BLACKJACK_P2P_STATE_DIR ?? './.blackjack-p2p'
  const rootHex = requiredEnv('BLACKJACK_P2P_ACCOUNT_ROOT_HEX')
  if (!/^[0-9a-fA-F]{64}$/.test(rootHex))
    throw new Error('BLACKJACK_P2P_ACCOUNT_ROOT_HEX must be 64 hex characters')
  const accountRoot = Uint8Array.from(Buffer.from(rootHex, 'hex'))
  const config = {
    ...loadMonadChainConfigFromEnv(),
    walletStorageLocation: join(stateDir, 'wallet'),
  }
  const chain = createMonadChain(config)
  const wallet = (await chain.createWallet({
    evm: deriveDomainRoot(accountRoot, 'evm-wallet'),
    authentication: deriveDomainRoot(accountRoot, 'identity-authentication'),
    messaging: deriveDomainRoot(accountRoot, 'messaging-encryption'),
  })) as MonadChainWalletHandle
  console.log(`Blackjack bot account: ${wallet.identity.address.raw}`)
  await installDirectory(wallet)

  const log = (line: string) => console.log(`[blackjack-p2p] ${line}`)
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
      log,
    },
  )
  const stop = new AbortController()
  process.once('SIGINT', () => stop.abort())
  process.once('SIGTERM', () => stop.abort())
  await runBlackjackP2pBot({
    bot,
    intervalMs: Number(process.env.BLACKJACK_P2P_INTERVAL_MS ?? 3000),
    signal: stop.signal,
    log,
  })
  await wallet.close()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
