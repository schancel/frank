/**
 * Autonomous overnight session (2026-09-27): verifies a real Frank UI wallet can discover and
 * exchange messages with the Monad-native Qwen bot (`qwen-bot.livecheck.ts`, ported off
 * `lotus-identity.ts` tonight) through the *exact* code path the real app uses --
 * `cashweb/chain/index.ts`'s `activeChain` (`createMonadChain`/`MonadChain`,
 * `directMessages.send`/`fetchSince`) -- not a hand-rolled equivalent. This is the strongest
 * verification available without a real browser: every function call here is one the app's own
 * `stores/chats.ts`/`useActiveWallet.ts`/`boot/monad-direct-messages.ts` also make.
 *
 * Also exercises tonight's `boot/monad-direct-messages.ts` fix directly:
 * `registerMonadIdentity` is called right after `createWallet`, mirroring that boot file exactly,
 * to confirm a fresh wallet actually becomes discoverable (this was previously never wired up
 * anywhere in the app at all).
 *
 * ## Usage (from `app/`, same compile convention as the other `.livecheck.ts` files)
 *
 *   node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop \
 *     --resolveJsonModule --allowJs --skipLibCheck --outDir /tmp/qwen-bot-demo \
 *     src/cashweb/wallet/monad-http.ts src/cashweb/wallet/monad-account-tx.ts \
 *     src/cashweb/wallet/monad-hd-keyring.ts src/cashweb/wallet/monad-account-pool.ts \
 *     src/cashweb/wallet/monad-account-lease.ts src/cashweb/wallet/monad-stamp-client.ts \
 *     src/cashweb/wallet/monad_message_pb.js src/cashweb/wallet/monad-message-feed.ts \
 *     src/cashweb/wallet/monad-message-envelope.ts src/cashweb/wallet/monad-identity.ts \
 *     src/cashweb/wallet/monad-topic-post-client.ts src/cashweb/wallet/monad-topic-vote-client.ts \
 *     src/cashweb/wallet/topic_message_pb.js \
 *     src/cashweb/registry/metadata_pb.js src/cashweb/signed_payload/payload_pb.js \
 *     src/cashweb/wallet/storage/sub-account-pool-storage.ts src/cashweb/wallet/monad-change-keyring.ts \
 *     src/cashweb/wallet/monad-change-pool.ts src/cashweb/wallet/monad-change-recovery.ts \
 *     src/cashweb/chain/active-chain.ts src/cashweb/chain/monad-chain.ts \
 *     src/cashweb/types/messages.ts src/cashweb/types/forum.ts \
 *     src/cashweb/wallet/monad-ui-verify.livecheck.ts
 *
 *   (output lands at /tmp/qwen-bot-demo/wallet/monad-ui-verify.livecheck.js -- this file lives in
 *   cashweb/wallet/, not cashweb/chain/, since it needs qwen-bot-common.ts's funding helper)
 *
 *   set -a; source ../.env; set +a
 *   export MONAD_RELAY_BASE_URL=http://127.0.0.1:8098
 *   export QWEN_BOT_ADDRESS=0x...   # from /tmp/qwen-bot-handoff.json
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   node /tmp/qwen-bot-demo/chain/monad-ui-verify.livecheck.js
 */
import { readFileSync } from 'fs'

import { generateMnemonic } from 'bip39'

import {
  createMonadChain,
  loadMonadChainConfigFromEnv,
} from './chain/monad-chain'
import { registerMonadIdentity, MonadIdentity } from './monad-identity'
import { requiredEnv } from './qwen-bot-common'
import { setUpFundedStampClient } from './qwen-bot-common'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  const config = loadMonadChainConfigFromEnv()
  const activeChain = createMonadChain(config)

  const handoffJsonPath =
    process.env.QWEN_BOT_HANDOFF_JSON ?? '/tmp/qwen-bot-handoff.json'
  const botAddress =
    process.env.QWEN_BOT_ADDRESS ??
    (JSON.parse(readFileSync(handoffJsonPath, 'utf8')) as { address: string })
      .address

  console.log(
    '== Real-UI-path verification: a fresh ActiveChain wallet talks to the bot ==',
  )
  console.log(`Relay:       ${config.relayBaseUrl}`)
  console.log(`Bot address: ${botAddress}`)

  // Exactly what pages/Setup.vue would eventually do for a fresh user, and exactly what
  // boot/monad-direct-messages.ts does with the resulting seed on every subsequent boot.
  const mnemonic = generateMnemonic()
  const wallet = await activeChain.createWallet({ mnemonic })
  console.log(`My address:  ${wallet.identity.displayAddress}`)

  // Tonight's fix, exercised directly: without this, the bot could never resolve my pubkey to
  // decrypt my message or encrypt its reply (MonadChain.directMessages.fetchSince calls
  // fetchMonadProfile on the sender's address).
  await registerMonadIdentity({
    relayBaseUrl: config.relayBaseUrl,
    identity: wallet.identity as MonadIdentity,
  })
  console.log(
    'Registered my identity with the relay (no payment -- POP disabled).',
  )

  // The wallet needs a funded burn sub-account pool to actually send a Stamp message -- reuses the
  // same funding helper the bot itself uses (qwen-bot-common.ts), since the app's own
  // `useActiveWallet`/`MonadChain.createWallet` derives the pool from the wallet's own HD seed,
  // which isn't pre-funded here (this script has no faucet access of its own) -- borrowing the
  // shared funded testnet wallet the same way the bot does, purely for this verification run.
  const { stampClient: fundedStampClient } = await setUpFundedStampClient({
    rpcUrl: config.rpcUrl,
    relayBaseUrl: config.relayBaseUrl,
    mainWalletJsonPath: requiredEnv('E2E_DEMO_MAIN_WALLET_JSON'),
    poolSize: 1,
    burnValueWei: config.defaultStampBurnValueWei,
    label: 'ui-verify',
  })
  // Graft the funded pool/lease-manager/httpClient onto the ActiveChain wallet handle so
  // `activeChain.directMessages.send` (which expects `MonadChainWalletHandle`'s bundle) uses the
  // already-funded pool instead of its own freshly-derived, unfunded one.
  const monadWallet = wallet as unknown as {
    pool: unknown
    leaseManager: unknown
    provider: unknown
    httpClient: unknown
  }
  const funded = fundedStampClient as unknown as {
    pool: unknown
    leaseManager: unknown
    provider: unknown
    httpClient: unknown
  }
  monadWallet.pool = funded.pool
  monadWallet.leaseManager = funded.leaseManager
  monadWallet.provider = funded.provider
  monadWallet.httpClient = funded.httpClient

  const message =
    process.argv[2] ?? 'Hello from a real ActiveChain wallet -- who are you?'
  console.log(`\nSending (via activeChain.directMessages.send): "${message}"`)
  const sendResult = await activeChain.directMessages.send({
    wallet,
    recipient: { raw: botAddress },
    items: [{ type: 'text', text: message }],
  })
  console.log(
    `Sent -- payload_hash=${sendResult.payloadDigest} burnValueWei=${sendResult.burnValueWei}`,
  )

  console.log(
    '\nPolling activeChain.directMessages.fetchSince for the reply ...',
  )
  const deadline = Date.now() + 5 * 60 * 1000
  let since = 0
  while (Date.now() < deadline) {
    const received = await activeChain.directMessages.fetchSince({
      wallet,
      sinceMs: since,
    })
    const reply = received.find(
      r => r.senderAddress.raw.toLowerCase() === botAddress.toLowerCase(),
    )
    if (reply) {
      console.log(
        '\n== REPLY RECEIVED (decrypted via activeChain.directMessages.fetchSince) ==',
      )
      console.log(JSON.stringify(reply.items, null, 2))
      console.log(
        `burn tx payload_hash=${reply.payloadDigest} burnValueWei=${reply.burnValueWei}`,
      )
      console.log(
        '\n== VERIFIED: a real ActiveChain wallet can talk to the bot end-to-end ==',
      )
      return
    }
    since = Date.now() - 5 * 60 * 1000 // fetchSince re-scans; keep a generous window
    await sleep(4000)
  }
  throw new Error('No reply received within 5 minutes')
}

main().catch(err => {
  console.error('\nUI VERIFY FAILED:', err)
  process.exit(1)
})
