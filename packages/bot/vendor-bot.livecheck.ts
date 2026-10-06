/**
 * A headless Frank client that sells digital images for a fixed price -- the third bot built on
 * `qwen-bot-common.ts`'s shared framework (identity, lazy stamp funding,
 * `sendDirectMessageItems`), and the simplest of the three: no fairness/randomness protocol
 * needed (unlike `blackjack-bot.livecheck.ts`), since "pay a fixed price, receive an item" doesn't
 * need one. Ticket #63 ("bot-driven ads / 1-click purchase").
 *
 * ## Payment verification
 *
 * A `request` for `itemId` carries no self-reported price -- see `DigitalGoodsItem`'s own header
 * on `@frank/cashweb/types/messages`. The real price paid is that message's own stamp value
 * (`message.message.stampValueWei` on the raw relay response), which the relay has *already*
 * verified as a real on-chain payment before ever storing the message. There is nothing left for
 * this bot to go verify externally (contrast `blackjack-bot.livecheck.ts`'s wager, a *separate*
 * transfer the relay knows nothing about) -- `hydrate()` in
 * `@frank/wallet/message-item-plugins/digital-goods/plugin.ts` just reads that already-trustworthy field.
 *
 * ## Usage
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn tsx vendor-bot.livecheck.ts
 *
 * Env vars:
 *   VENDOR_BOT_CATALOG_DIR       -- directory with manifest.json + image files (default: the
 *                                   bundled demo-catalog/); see vendor-catalog.ts
 *   VENDOR_BOT_IDENTITY_JSON     -- default /tmp/vendor-bot-identity.json
 *   VENDOR_BOT_STATE_DIR         -- default ~/.frank-bots/vendor (or $XDG_STATE_HOME/frank-bots/vendor)
 *   VENDOR_BOT_MAX_SALES         -- how many fulfilled purchases before exiting (default 1000)
 *   VENDOR_BOT_POLL_INTERVAL_MS  -- default 4000
 *   VENDOR_BOT_IDLE_TIMEOUT_MS   -- default 10 minutes
 */
import { resolve } from 'path'

import { Transaction, hexlify } from 'ethers'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  fetchMonadIdentityPubKey,
  mailboxAuthFor,
} from '@frank/wallet/monad-identity'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { DigitalGoodsItem, Message, MessageItem } from '@frank/cashweb/types/messages'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/digital-goods/plugin'
import { HydratedDigitalGoods } from '@frank/wallet/message-item-plugins/digital-goods/plugin'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageItems,
  setUpFundedStampClient,
} from './qwen-bot-common'
import { botProfileFields } from './bot-directory'
import { VendorBotStateStore } from './vendor-bot-state'
import { botStateDir } from './bot-state-dir'
import { paymentBelowPriceMessage } from './vendor-messages'
import { botLoopGuardFromEnv } from './bot-loop-guard'
import {
  buildFulfillItems,
  catalogItem,
  DEFAULT_CATALOG_DIR,
  loadVendorCatalog,
} from './vendor-catalog'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  // Validated first: a bad catalog fails at startup, before any sale (#315).
  const catalogDir = resolve(
    process.cwd(),
    process.env.VENDOR_BOT_CATALOG_DIR || DEFAULT_CATALOG_DIR,
  )
  const CATALOG = loadVendorCatalog(catalogDir)
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const minimumStampValueWei = BigInt(
    requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'),
  )
  // Replies (catalog/error) go out with the cheapest catalog price as their own stamp -- fulfilling
  // a purchase re-uses whatever the buyer's own request already paid (see handleRequest below),
  // never a second stamp on top of the price they just paid.
  const replyStampValueWei = CATALOG.reduce(
    (min, item) => (item.priceWei < min ? item.priceWei : min),
    CATALOG[0].priceWei,
  )
  if (replyStampValueWei < minimumStampValueWei) {
    throw new Error(
      `Vendor bot's cheapest catalog item (${replyStampValueWei} wei) is below the relay minimum ${minimumStampValueWei}`,
    )
  }

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.VENDOR_BOT_IDENTITY_JSON ?? '/tmp/vendor-bot-identity.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const stateDirPath = botStateDir('vendor', 'VENDOR_BOT_STATE_DIR')
  const pollIntervalMs = Number(process.env.VENDOR_BOT_POLL_INTERVAL_MS ?? 4000)
  const maxSales = Number(process.env.VENDOR_BOT_MAX_SALES ?? 1000)
  const idleTimeoutMs = Number(
    process.env.VENDOR_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000,
  )

  console.log('== Vendor bot: flat-price digital goods over stamped Frank DMs (ticket #63) ==')
  console.log(`Relay:   ${relayBaseUrl}`)
  console.log(`Catalog dir: ${catalogDir}`)
  console.log(`Catalog: ${CATALOG.map(i => `${i.itemId} (${i.priceWei} wei)`).join(', ')}`)

  if (
    process.env.USE_BOT_FRAMEWORK === '1' ||
    (process.env.USE_BOT_FRAMEWORK !== '0' && process.env.NODE_ENV !== 'test')
  ) {
    const { FrankBotHost } = await import('@frank/bot-framework')
    const { VendorBot } = await import('./src/bots/vendor-bot')
    const host = new FrankBotHost({
      stateDir: stateDirPath,
      relayBaseUrl,
      rpcUrl,
      pollIntervalMs,
    })
    await host.register(new VendorBot({ catalogItems: CATALOG }))
    await host.start()
    return
  }

  const identity = loadOrCreateIdentity(identityJsonPath, 'vendor-bot')
  await registerAndLog({
    relayBaseUrl,
    identity,
    label: 'vendor-bot',
    profile: botProfileFields('vendor'),
  })
  console.log(`Vendor bot identity address: ${identity.displayAddress}`)

  const { stampClient, mainAccountSigner, provider, pool, closePool } =
    await setUpFundedStampClient({
      rpcUrl,
      relayBaseUrl,
      mainWalletJsonPath,
      stampValueWei: replyStampValueWei,
      label: 'vendor-bot',
      stateDir: stateDirPath,
    })

  // #311: the catalog goes to humans only, at most a bounded number of times per window.
  const guard = botLoopGuardFromEnv({
    selfAddress: identity.displayAddress,
    relayBaseUrl,
  })

  const state = new VendorBotStateStore(stateDirPath)
  await state.Open()
  console.log(`[vendor-bot] persisted state loaded from ${stateDirPath}`)

  const senderPubKeyCache = new Map<string, Buffer>()
  let since = Date.now()
  let salesCompleted = 0
  let lastActivityAt = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad/inbox/<me> (signed mailbox read, since=<t>) every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  while (salesCompleted < maxSales) {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }

    const stored = await fetchMonadMessagesSince({
      ...mailboxAuthFor(identity, relayBaseUrl),
      sinceMs: since,
    })
    let maxSeenTimestamp = since - 1

    for (const message of stored) {
      maxSeenTimestamp = Math.max(maxSeenTimestamp, message.timestamp)
      if (!message.message) continue

      const payloadHashHex = Buffer.from(message.message.payloadHash).toString('hex')
      if (state.hasProcessed(payloadHashHex)) continue
      state.addProcessed(payloadHashHex)

      const envelope = parseEnvelope(message.message.encryptedPayload)
      if (!envelope) continue
      if (!sameMonadEnvelopeAddress(envelope.to, identity.displayAddress)) continue
      if (sameMonadEnvelopeAddress(envelope.from, identity.displayAddress)) continue

      let senderPubKey = senderPubKeyCache.get(envelope.from)
      if (!senderPubKey) {
        senderPubKey = await fetchMonadIdentityPubKey({
          relayBaseUrl,
          address: envelope.from,
        })
        if (!senderPubKey) continue
        senderPubKeyCache.set(envelope.from, senderPubKey)
      }

      const rawPlaintext = tryDecryptEnvelope({
        envelope,
        myPrivateKey: identity.toNakamotoPrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[vendor-bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
        )
        continue
      }

      let items
      try {
        items = deserializeMessageItems(rawPlaintext)
      } catch {
        continue
      }
      const request = items.find(
        (item): item is DigitalGoodsItem =>
          item.type === 'digital-goods' && item.action === 'request',
      )

      lastActivityAt = Date.now()

      const sendReply = async (
        replyItems: MessageItem[],
        stampValueWei: bigint = replyStampValueWei,
      ) =>
        sendDirectMessageItems({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: envelope.from,
          toPubKey: senderPubKey as Buffer,
          items: replyItems,
          stampValueWei,
          networkTag,
        })

      if (!request) {
        // Any other message from a new-to-us buyer gets the catalog -- the "ad" half of "bot-driven
        // ads / 1-click purchase." Never to another bot, and rate-limited per sender: a bot that
        // answers this catalog with its own auto-reply would otherwise ping-pong (#311).
        const blockReason = await guard.peerBlockReason(envelope.from)
        if (blockReason) {
          console.log(
            `[vendor-bot] not sending catalog to ${envelope.from} (${blockReason})`,
          )
          continue
        }
        if (!guard.reserveReply(envelope.from)) {
          console.log(
            `[vendor-bot] catalog budget for ${envelope.from} exhausted this window -- not replying`,
          )
          continue
        }
        console.log(`\n[vendor-bot] sending catalog to ${envelope.from}`)
        await sendReply([catalogItem(CATALOG)])
        continue
      }

      console.log(`\n[vendor-bot] purchase request from ${envelope.from}: ${request.itemId}`)
      const plugin = getMessageItemPlugin('digital-goods')
      if (!plugin) throw new Error('digital-goods plugin not registered')
      const context: MessageItemContext = {
        message: {
          ...(message.message as unknown as Message),
          stampValueWei: sumStampPayments(message.message),
        },
        index: items.indexOf(request),
        provider,
      }
      const hydrated = (await plugin.hydrate(request, context)) as HydratedDigitalGoods

      const item = CATALOG.find(candidate => candidate.itemId === hydrated.itemId)
      if (!item) {
        await sendReply([
          { type: 'digital-goods', action: 'error', message: `Unknown item: ${hydrated.itemId}` },
        ])
        continue
      }
      if ((hydrated.paidWei ?? 0n) < item.priceWei) {
        console.log(
          `[vendor-bot] rejecting -- paid ${hydrated.paidWei} wei, needed ${item.priceWei} wei`,
        )
        await sendReply([
          {
            type: 'digital-goods',
            action: 'error',
            message: paymentBelowPriceMessage(hydrated.paidWei ?? 0n, item),
          },
        ])
        continue
      }

      console.log(`[vendor-bot] payment verified -- delivering ${item.itemId}`)
      await sendReply(
        buildFulfillItems(item),
        // The buyer already paid the full price via their own request's stamp -- this delivery
        // message pays only the relay's bare minimum stamp, not a second copy of the price.
        minimumStampValueWei,
      )
      salesCompleted++
      if (salesCompleted >= maxSales) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    await state.flush()
    await sleep(pollIntervalMs)
  }

  await state.Close()
  await closePool()
  console.log(`\nDone. Completed ${salesCompleted} sale${salesCompleted === 1 ? '' : 's'}.`)
}

/** The raw relay response's `message.message` doesn't carry a pre-summed `stampValueWei` the way
 * the frontend's own `Message` type does -- sum it the same way `chain/monad-chain.ts`'s
 * `fetchSince` does, from the message's actual signed stamp payment transactions. */
function sumStampPayments(message: {
  stampPayments: Array<{ rawTx: Uint8Array }>
}): bigint {
  return message.stampPayments.reduce(
    (total: bigint, payment: { rawTx: Uint8Array }) =>
      total + Transaction.from(hexlify(payment.rawTx)).value,
    0n,
  )
}

main().catch(err => {
  console.error(
    'VENDOR BOT FAILED:',
    process.env.VENDOR_BOT_DEBUG ? err : err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
