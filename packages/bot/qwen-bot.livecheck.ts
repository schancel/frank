/**
 * Ticket #9: a headless Frank client that bridges real conversation turns to Qwen 3.8 Max
 * (Alibaba Cloud), targeting the "Best Builds with Qwen" bounty (Trust, Identity & AI track).
 * Builds entirely on `app`'s existing TS `cashweb`/`relay`/`wallet` library code (no UI) -- this
 * file is only the runnable entry point, same `.livecheck.ts` convention ticket #8's
 * `monad-e2e-demo.livecheck.ts` established (hits the real network, so excluded from `jest`'s
 * `testMatch` and never runs under `yarn test:unit:ci` -- meant to be run manually).
 *
 * Ported (see `qwen-bot-common.ts`'s own header) from the original `lotus-identity.ts`/
 * `FrankIdentity`-based version to `monad-identity.ts`'s `MonadIdentity` once the real Frank UI's
 * `ActiveChain`/`MonadChain` stack (#41-#45) landed -- a Lotus-identity bot was invisible to, and
 * couldn't message, any Monad wallet created through the actual app.
 *
 * ## What this proves, end to end
 *
 * 1. Registers its own Frank identity (`./monad-identity.ts`) via a real `PUT /metadata/:addr`,
 *    no payment (POP disabled, ticket #35) -- the same acceptance criterion ticket #8 proved,
 *    here done from a from-scratch TS client since no TS client for that route existed yet.
 * 2. Polls the *real*, live `GET /message/monad?since=<t>` route (ticket #37) for new stamped
 *    messages, filtering client-side for ones addressed to itself via the envelope convention in
 *    `./monad-message-envelope.ts` (see that file's header for why, and for the exact gap in the
 *    wire format this works around).
 * 3. For each message actually addressed to it, decrypts the real E2E-encrypted payload
 *    (`./monad-message-envelope.ts`, reusing `../relay/crypto.ts`'s existing ECDH+AES code),
 *    sends it to Qwen 3.8 Max over a real HTTPS streaming call (`./qwen-client.ts`), and gets back
 *    a real completion.
 * 4. Builds a real reply: encrypts Qwen's response for the sender, computes `h_m`, leases a fresh
 *    single-use Monad sub-account (#14/#18/#34), builds+signs a real EIP-1559 burn tx, and `PUT`s
 *    it to the relay's live `PUT /message/monad` route (#13/#19/#27) -- the relay itself
 *    broadcasts, confirms, and verifies that exact tx against real Monad testnet before storing
 *    it, exactly as `monad-e2e-demo.livecheck.ts` (#8) already proved for a single message.
 *
 * ## Usage
 *
 * Ticket #53 (package split): this is now `@frank/bot`, a real workspace package depending on
 * `@frank/wallet`/`@frank/cashweb` -- runs directly via `tsx`, no manual `tsc` compile step. See
 * `README.md` for the full runbook (env vars, starting a local relay, etc); short version:
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn bot
 *
 * Prints its own Frank identity address on startup (and writes it to `QWEN_BOT_HANDOFF_JSON`) --
 * that's what `qwen-bot-send-demo.livecheck.ts` addresses its first message to.
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'

import { fetchMonadIdentityPubKey } from '@frank/wallet/monad-identity'
import {
  buildEnvelope,
  decryptEnvelope,
  parseEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  deserializeMessageItems,
  serializeMessageItems,
} from '@frank/wallet/chain/monad-chain'
import { QwenChatMessage, QwenClient } from './qwen-client'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  setUpFundedStampClient,
} from './qwen-bot-common'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Extracts plain text from a decrypted envelope's plaintext, whichever wire shape it's in.
 * Found tonight (autonomous overnight session, 2026-09-27), the hard way: the *real* Frank UI's
 * `MonadChain.directMessages` (`../chain/monad-chain.ts`, ticket #42) always wraps a message's
 * plaintext as `serializeMessageItems`'s JSON-array-of-`MessageItem` shape -- this bot originally
 * sent/expected a bare plaintext string instead (fine when bot and sender were both this same
 * ticket's own scripts, broken once a real `ActiveChain` wallet is on the other end:
 * `deserializeMessageItems` on a bare string throws `SyntaxError`, confirmed live). Tries the real
 * UI's shape first, falls back to treating `plaintext` as a bare string only if that parse fails,
 * so this bot still works talking to itself (or to the old bare-string convention) either way. */
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

const SYSTEM_PROMPT =
  process.env.QWEN_BOT_SYSTEM_PROMPT ??
  'You are a helpful assistant reachable only over Frank, a burn-to-speak messaging protocol ' +
    'on the Monad blockchain (ticket #9, "Best Builds with Qwen" bounty demo). Every message ' +
    "you receive was paid for with a real, tiny MON burn by the sender's own on-chain identity, " +
    'and your replies are delivered back the same way. Keep replies short (2-4 sentences) since ' +
    'each one costs a real transaction.'

async function main() {
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const burnAddress = requiredEnv('MONAD_STAMP_BURN_ADDRESS')
  const burnValueWei = BigInt(requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'))
  const qwenApiKey = requiredEnv('QWEN_API_KEY')
  const qwenEndpoint = requiredEnv('QWEN_OPENAI_COMPATIBLE_ENDPOINT')
  const qwenModel = process.env.QWEN_MODEL ?? 'qwen3.8-max'

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_BOT_IDENTITY_JSON ?? '/tmp/qwen-bot-identity.json',
  )
  const handoffJsonPath = resolve(
    process.cwd(),
    process.env.QWEN_BOT_HANDOFF_JSON ?? '/tmp/qwen-bot-handoff.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const pollIntervalMs = Number(process.env.QWEN_BOT_POLL_INTERVAL_MS ?? 4000)
  const maxReplies = Number(process.env.QWEN_BOT_MAX_REPLIES ?? 1)
  const idleTimeoutMs = Number(
    process.env.QWEN_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000,
  )

  console.log('== Ticket #9: Qwen 3.8 Max bot over Frank (Monad testnet) ==')
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Qwen model:   ${qwenModel} @ ${qwenEndpoint}`)
  console.log(`Max replies:  ${maxReplies}`)

  const identity = loadOrCreateIdentity(identityJsonPath, 'bot')
  await registerAndLog({ relayBaseUrl, identity, label: 'bot' })
  writeFileSync(
    handoffJsonPath,
    JSON.stringify({ address: identity.displayAddress }, null, 2),
  )
  console.log(`Bot Frank identity address: ${identity.displayAddress}`)
  console.log(`(handoff written to ${handoffJsonPath})`)

  const { stampClient } = await setUpFundedStampClient({
    rpcUrl,
    relayBaseUrl,
    mainWalletJsonPath,
    poolSize: maxReplies,
    burnValueWei,
    label: 'bot',
  })

  const qwen = new QwenClient({
    apiKey: qwenApiKey,
    endpoint: qwenEndpoint,
    model: qwenModel,
  })

  const senderPubKeyCache = new Map<string, Buffer>()
  const conversations = new Map<string, QwenChatMessage[]>()
  const processedPayloadHashes = new Set<string>()

  let since = 0
  let repliesSent = 0
  let lastActivityAt = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad?since=<t> every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  while (repliesSent < maxReplies) {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(
        `\nNo messages addressed to us within ${idleTimeoutMs}ms of the last activity -- exiting.`,
      )
      break
    }

    const stored = await fetchMonadMessagesSince({
      relayBaseUrl,
      sinceMs: since,
    })
    let maxSeenTimestamp = since - 1

    for (const message of stored) {
      maxSeenTimestamp = Math.max(maxSeenTimestamp, message.timestamp)
      if (!message.message) continue

      const payloadHashHex = Buffer.from(message.message.payloadHash).toString(
        'hex',
      )
      if (processedPayloadHashes.has(payloadHashHex)) continue
      processedPayloadHashes.add(payloadHashHex)

      const envelope = parseEnvelope(message.message.encryptedPayload)
      if (!envelope) continue // not our envelope convention -- e.g. #8's plain-JSON demo blob
      if (envelope.to !== identity.displayAddress) continue // not addressed to us
      if (envelope.from === identity.displayAddress) continue // our own outgoing message

      lastActivityAt = Date.now()
      console.log(
        `\n[bot] new stamped message ${payloadHashHex} from ${
          envelope.from
        } (tx ${'0x' + Buffer.from(message.txHash).toString('hex')})`,
      )

      let senderPubKey = senderPubKeyCache.get(envelope.from)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) {
          console.log(
            `[bot] sender ${envelope.from} has no registered Frank identity -- can't derive a shared key, skipping`,
          )
          continue
        }
        senderPubKeyCache.set(envelope.from, senderPubKey)
      }

      const rawPlaintext = decryptEnvelope({
        envelope,
        myPrivateKey: identity.toBitcorePrivateKey(),
        senderPubKey,
      })
      const plaintext = extractText(rawPlaintext)
      console.log(`[bot] decrypted: "${plaintext}"`)

      const history = conversations.get(envelope.from) ?? [
        { role: 'system', content: SYSTEM_PROMPT },
      ]
      history.push({ role: 'user', content: plaintext })

      console.log('[bot] asking Qwen 3.8 Max ...')
      const completion = await qwen.chat(history)
      console.log(`[bot] Qwen reasoning: ${completion.reasoning.slice(0, 400)}`)
      console.log(`[bot] Qwen reply: "${completion.content}"`)

      history.push({ role: 'assistant', content: completion.content })
      conversations.set(envelope.from, history)

      const replyEnvelope = buildEnvelope({
        fromAddress: identity.displayAddress,
        fromPrivateKey: identity.toBitcorePrivateKey(),
        toAddress: envelope.from,
        toPubKey: senderPubKey,
        // Wrapped as the real UI's MessageItem[] wire shape (see `extractText`'s doc comment) so a
        // real Frank UI wallet can decode this reply, not just this ticket's own scripts.
        plaintext: serializeMessageItems([
          { type: 'text', text: completion.content },
        ]),
      })

      console.log('[bot] stamping + sending reply over Monad testnet ...')
      const result = await stampClient.submitStampedMessage({
        encryptedPayload: replyEnvelope,
        burnAddress,
        burnValueWei,
      })
      console.log(
        `[bot] reply sent -- payload_hash=${result.payloadHashHex} burn tx=${result.txHash}`,
      )
      repliesSent++
      if (repliesSent >= maxReplies) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    if (repliesSent >= maxReplies) break
    await sleep(pollIntervalMs)
  }

  console.log(
    `\nDone. Sent ${repliesSent} real Qwen-generated repl${
      repliesSent === 1 ? 'y' : 'ies'
    } over Monad testnet.`,
  )
}

main().catch(err => {
  console.error('\nQWEN BOT FAILED:', err)
  process.exit(1)
})
