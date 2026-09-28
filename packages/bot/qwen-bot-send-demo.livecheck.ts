/**
 * Ticket #9's "human side" of the live demo: registers its own Frank identity, sends a real
 * stamped message to the running `qwen-bot.livecheck.ts` bot over Monad testnet, then polls for
 * the bot's real Qwen-generated reply and prints it -- the acceptance criterion "demonstrated
 * holding a short real conversation end-to-end: a human/script sends the bot a message on Monad
 * testnet, the bot replies with a real Qwen-generated response, also delivered over Monad
 * testnet."
 *
 * Run `qwen-bot.livecheck.ts` first (it registers its identity and writes its address to
 * `QWEN_BOT_HANDOFF_JSON`, default `/tmp/qwen-bot-handoff.json`), then run this in a separate
 * process/shell while the bot is polling. `qwen-bot.livecheck.ts` must be started with
 * `QWEN_BOT_MAX_REPLIES` set to at least the number of messages this script will send (its
 * sub-account pool is sized to that up front -- see `setUpFundedStampClient`'s doc comment).
 *
 * `QWEN_BOT_MESSAGES` (a JSON array of strings) sends more than one turn, sequentially -- waiting
 * for each reply before sending the next -- for a real multi-turn "conversation" (the bot's own
 * `history` map, `qwen-bot.livecheck.ts`, keeps every turn from the same sender address, so Qwen
 * sees the full back-and-forth, not just the latest message in isolation). Falls back to a single
 * `QWEN_BOT_MESSAGE` turn if `QWEN_BOT_MESSAGES` isn't set.
 *
 * ## Usage
 *
 * Ticket #53 (package split): runs via `tsx` from `@frank/bot`, no manual compile step -- see
 * `README.md` for the full runbook.
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   export QWEN_BOT_MESSAGES='["What model are you?","Why does Frank make you an agentic identity?"]'
 *   yarn send-demo
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

import { fetchMonadIdentityPubKey } from '@frank/wallet/monad-identity'
import {
  decryptEnvelope,
  parseEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageText,
  setUpFundedStampClient,
} from './qwen-bot-common'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** See `qwen-bot.livecheck.ts`'s identical helper for why this exists: the real Frank UI always
 * wraps a message's plaintext as `serializeMessageItems`'s JSON shape; this falls back to a bare
 * string only if that parse fails, so this script still works against the bot's own bare-string
 * historical convention too. */
function extractText(plaintext: string): string {
  try {
    const items = deserializeMessageItems(plaintext)
    const text = items
      .filter(
        (item): item is { type: 'text'; text: string } => item.type === 'text',
      )
      .map(item => item.text)
      .join('\n')
    if (text) return text
  } catch {
    // Not a MessageItem[] JSON array -- fall through to the bare-string convention below.
  }
  return plaintext
}

async function main() {
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  // Ticket #57: no MONAD_STAMP_BURN_ADDRESS here -- this message's stamp pays its real
  // recipient (botAddress, below), not a fixed address.
  const burnValueWei = BigInt(requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'))

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_SENDER_IDENTITY_JSON ??
      '/tmp/qwen-bot-sender-identity.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const handoffJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_BOT_HANDOFF_JSON ?? '/tmp/qwen-bot-handoff.json',
  )
  const botAddress =
    process.env.QWEN_BOT_ADDRESS ??
    (JSON.parse(readFileSync(handoffJsonPath, 'utf8')) as { address: string })
      .address
  const messages: string[] = process.env.QWEN_BOT_MESSAGES
    ? (JSON.parse(process.env.QWEN_BOT_MESSAGES) as string[])
    : [
        process.env.QWEN_BOT_MESSAGE ??
          'Hello! Who are you, and what makes you an "agentic" identity on Frank?',
      ]
  const replyTimeoutMs = Number(
    process.env.QWEN_SENDER_REPLY_TIMEOUT_MS ?? 5 * 60 * 1000,
  )
  const pollIntervalMs = Number(
    process.env.QWEN_SENDER_POLL_INTERVAL_MS ?? 4000,
  )

  console.log('== Ticket #9: human/script side of the live Qwen-bot demo ==')
  console.log(`Relay:      ${relayBaseUrl}`)
  console.log(`Bot address: ${botAddress}`)
  console.log(`Turns:      ${messages.length}`)

  const identity = loadOrCreateIdentity(identityJsonPath, 'sender')
  await registerAndLog({ relayBaseUrl, identity, label: 'sender' })
  console.log(`Sender Frank identity address: ${identity.displayAddress}`)

  const botPubKey = await fetchMonadIdentityPubKey({
    relayBaseUrl,
    address: botAddress,
  })
  if (!botPubKey) {
    throw new Error(
      `Bot address ${botAddress} has no registered Frank identity yet -- start qwen-bot.livecheck.ts first`,
    )
  }

  const { stampClient } = await setUpFundedStampClient({
    rpcUrl,
    relayBaseUrl,
    mainWalletJsonPath,
    poolSize: messages.length,
    burnValueWei,
    label: 'sender',
  })

  const transcript: Array<{ sentTx: string; replyTx: string; reply: string }> =
    []

  for (const [turnIndex, message] of messages.entries()) {
    console.log(
      `\n== Turn ${turnIndex + 1}/${messages.length}: "${message}" ==`,
    )
    const sendTimestamp = Date.now()

    console.log('Stamping + sending the message over Monad testnet ...')
    // Ticket #77: goes through the shared `sendDirectMessageText` helper (`qwen-bot-common.ts`),
    // extracted from this exact build-envelope-then-submit sequence (previously duplicated between
    // this file and `qwen-bot.livecheck.ts`'s reply logic) -- a DM's stamp pays its recipient (the
    // bot), not a fixed burn address (ticket #57), which the helper's `destinationAddress` always
    // does.
    const sent = await sendDirectMessageText({
      stampClient,
      fromIdentity: identity,
      toAddress: botAddress,
      toPubKey: botPubKey,
      text: message,
      stampValueWei: burnValueWei,
    })
    console.log(
      `Sent -- payload_hash=${sent.payloadHashHex} burn tx=${sent.txHash}`,
    )

    console.log(
      `Polling for the bot's reply (up to ${replyTimeoutMs}ms, every ${pollIntervalMs}ms) ...`,
    )
    const deadline = Date.now() + replyTimeoutMs
    let since = sendTimestamp
    let replyFound = false
    while (Date.now() < deadline) {
      const stored = await fetchMonadMessagesSince({
        relayBaseUrl,
        sinceMs: since,
      })
      let maxSeenTimestamp = since - 1
      for (const stored_ of stored) {
        maxSeenTimestamp = Math.max(maxSeenTimestamp, stored_.timestamp)
        if (!stored_.message) continue
        const envelopeIn = parseEnvelope(stored_.message.encryptedPayload)
        if (!envelopeIn) continue
        if (envelopeIn.to !== identity.displayAddress) continue
        if (envelopeIn.from !== botAddress) continue

        const plaintext = extractText(
          decryptEnvelope({
            envelope: envelopeIn,
            myPrivateKey: identity.toBitcorePrivateKey(),
            senderPubKey: botPubKey,
          }),
        )
        const replyTxHash = `0x${Buffer.from(stored_.txHash).toString('hex')}`
        console.log(`Reply text: "${plaintext}"`)
        console.log(`Reply burn tx: ${replyTxHash}`)
        transcript.push({
          sentTx: sent.txHash,
          replyTx: replyTxHash,
          reply: plaintext,
        })
        replyFound = true
        break
      }
      if (replyFound) break
      if (stored.length > 0) since = maxSeenTimestamp + 1
      await sleep(pollIntervalMs)
    }
    if (!replyFound) {
      throw new Error(
        `No reply from ${botAddress} within ${replyTimeoutMs}ms for turn ${
          turnIndex + 1
        } -- is qwen-bot.livecheck.ts running with QWEN_BOT_MAX_REPLIES >= ${
          messages.length
        }?`,
      )
    }
  }

  console.log('\n== CONVERSATION PROVEN ==')
  transcript.forEach((turn, index) => {
    console.log(
      `Turn ${index + 1}: sent tx ${turn.sentTx} -> bot reply tx ${
        turn.replyTx
      }`,
    )
  })
}

main().catch(err => {
  console.error('\nQWEN BOT SEND DEMO FAILED:', err)
  process.exit(1)
})
