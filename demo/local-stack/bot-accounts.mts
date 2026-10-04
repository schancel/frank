// Prints the public addresses of the stack's two bot accounts as JSON, without contacting a
// relay: { qwen: { address, fund }, blackjack: { address, fund } }. `address` is what a person
// messages; `fund` is the account whose balance pays the bot's stamps. Creates the Qwen roots
// file on first use (the bot itself would). Run by stack.mjs with each bot's own environment.
import { join } from 'node:path'
import {
  loadQwenCanonicalRoots,
  openQwenCanonicalWallet,
  qwenCanonicalChainConfig,
} from '../../packages/bot/qwen-bot-common'
import { openBlackjackBotWallet } from '../../packages/bot/blackjack-p2p-bot.livecheck'

const which = process.argv[2]
const quiet = console.log
console.log = () => undefined
let out: { address: string; fund: string }
if (which === 'qwen') {
  const wallet = await openQwenCanonicalWallet({
    chain: qwenCanonicalChainConfig({
      relayBaseUrl: process.env.E2E_DEMO_RELAY_URL as string,
      walletStorageLocation: join(process.env.QWEN_BOT_WALLET_STATE_DIR as string, 'canonical'),
      stampValueWei: BigInt(process.env.QWEN_BOT_STAMP_VALUE_WEI as string),
    }),
    roots: loadQwenCanonicalRoots(process.env.QWEN_BOT_CANONICAL_ROOTS_JSON as string),
  })
  out = { address: wallet.identityAddress, fund: wallet.accountAddress }
  await wallet.close()
} else if (which === 'blackjack') {
  const { wallet } = await openBlackjackBotWallet()
  out = { address: wallet.identity.address.raw, fund: (await wallet.getReceiveAddress()).raw }
  await wallet.close()
} else throw new Error('usage: bot-accounts.mts qwen|blackjack')
quiet(JSON.stringify(out))
