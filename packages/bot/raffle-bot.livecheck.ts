/**
 * A headless Frank client that runs a provably-fair, N-entrant, winner-takes-the-pot raffle over
 * stamped DMs -- the fourth bot built on `qwen-bot-common.ts`'s shared framework (identity, lazy
 * stamp funding, `sendDirectMessageItems`).
 *
 * ## Why this bot can't be drained
 *
 * A trivia-style bot that pays a fixed reward for a correct answer has no cap tying its payout to
 * its revenue -- nothing stops it paying out more than it ever collects. This bot is structured so
 * that can't happen: every entry's price is that same message's own relay-verified stamp value (no
 * self-reported amount, same as `digital-goods.ts`'s `request`), those stamps pay this bot's own
 * identity address directly (ticket #57: a DM's stamp always pays its recipient), and a round's
 * payout is *arithmetically* `entryPriceWei * entrants.length` -- exactly what that round's entrants
 * already paid into this bot's own balance, never a number decided independently of that. The
 * payout transaction is even signed and sent from the bot's own identity address (`identitySigner`
 * below), not the shared `mainAccountSigner` demo wallet blackjack/vendor-bot draw from for their
 * own payouts/fulfillment -- so there is no path, buggy or adversarial, for a round to pay out
 * testnet MON this bot didn't itself just receive from that same round's entrants. The only thing
 * `mainAccountSigner` ever funds here is a small, flat, round-count-independent gas reserve on the
 * identity address (see `ensureIdentityFunded`) -- ordinary bot-operation overhead, not payout
 * money.
 *
 * ## Fairness scheme
 *
 * See `@frank/wallet/raffle/draw.ts`'s header for the full "why." Short version: this bot always
 * holds a `serverSeed` it generated (and hashed) *before* the round that will use it had any
 * entrants. Each entrant's own entry-payment tx hash is folded into that round's combined entropy
 * the instant their entry is accepted. At `draw`, the seed is published in plaintext so anyone can
 * independently replay the whole round (`verifyRaffleDraw`) and catch any deviation.
 *
 * ## Usage
 *
 *   cd packages/bot
 *   set -a; source ../../.env; set +a
 *   export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
 *   export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/chain-wallet.json
 *   yarn tsx raffle-bot.livecheck.ts
 *
 * Env vars:
 *   RAFFLE_BOT_IDENTITY_JSON     -- default /tmp/raffle-bot-identity.json
 *   RAFFLE_BOT_STATE_DIR         -- default /tmp/raffle-bot-state
 *   RAFFLE_BOT_ENTRY_PRICE_WEI   -- default 0.02 MON
 *   RAFFLE_BOT_MAX_ENTRIES       -- entrants per round, default 5
 *   RAFFLE_BOT_MAX_ROUNDS        -- how many rounds to draw before exiting (default 1000)
 *   RAFFLE_BOT_POLL_INTERVAL_MS  -- default 4000
 *   RAFFLE_BOT_IDLE_TIMEOUT_MS   -- default 10 minutes
 */
import { randomBytes } from 'crypto'
import { resolve } from 'path'

import { Provider, Transaction, hexlify } from 'ethers'

import {
  parseEnvelope,
  sameMonadEnvelopeAddress,
  tryDecryptEnvelope,
} from '@frank/cashweb/relay/monad-message-envelope'
import { fetchMonadMessagesSince } from '@frank/cashweb/relay/monad-message-feed'
import {
  fetchMonadIdentityPubKey,
  MonadIdentity,
} from '@frank/wallet/monad-identity'
import { deserializeMessageItems } from '@frank/wallet/chain/monad-chain'
import { Message, RaffleItem } from '@frank/cashweb/types/messages'
import {
  getMessageItemPlugin,
  MessageItemContext,
} from '@frank/wallet/message-item-plugins'
import '@frank/wallet/message-item-plugins/built-in'
import '@frank/wallet/message-item-plugins/raffle'
import { HydratedRaffleItem } from '@frank/wallet/message-item-plugins/raffle'
import { combineEntrantEntropy, pickWinnerIndex, sha256Hex } from '@frank/wallet/raffle/draw'
import { MonadHttpClient } from '@frank/wallet/monad-http'
import { MonadAccountTxSigner } from '@frank/wallet/monad-account-tx'
import {
  loadOrCreateIdentity,
  registerAndLog,
  requiredEnv,
  sendDirectMessageItems,
  setUpFundedStampClient,
  waitForConfirmation,
} from './qwen-bot-common'
import { RaffleBotStateStore, RaffleEntrant, RaffleRoundRecord } from './raffle-bot-state'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function generateServerSeed(): string {
  return randomBytes(32).toString('hex')
}

function generateRaffleId(): string {
  return randomBytes(16).toString('hex')
}

/** The raw relay response's `message.message` doesn't carry a pre-summed `stampValueWei` the way
 * the frontend's own `Message` does, nor the transaction hash of the payment that funded it --
 * derive both from the message's actual signed stamp payment transaction, same as
 * `vendor-bot.livecheck.ts`'s `sumStampPayments`. A raffle entry's stamp is always a single payment
 * (one stamped DM, one transfer to this bot), so `[0]` is the entry's own payment, not a sum. */
function entryPayment(message: {
  stampPayments: Array<{ rawTx: Uint8Array }>
}): { valueWei: bigint; txHash: string } {
  const tx = Transaction.from(hexlify(message.stampPayments[0].rawTx))
  if (!tx.hash) throw new Error('entry payment transaction has no hash')
  return { valueWei: tx.value, txHash: tx.hash }
}

/** Tops up `identitySigner`'s own on-chain balance from `mainAccountSigner` if it's short of
 * `neededWei` -- a small, flat, per-payout operational gas cost, never scaled to a round's pot size
 * (see this file's header, "Why this bot can't be drained"). Only ever moves enough to cover the
 * shortfall, never a fixed lump sum, so repeated calls don't compound. */
async function ensureIdentityFunded(params: {
  identityAddress: string
  mainAccountSigner: MonadAccountTxSigner
  provider: Provider
  neededWei: bigint
  label: string
}): Promise<void> {
  const balance = await params.provider.getBalance(params.identityAddress)
  if (balance >= params.neededWei) return
  const shortfall = params.neededWei - balance
  console.log(
    `[${params.label}] topping up identity gas reserve by ${shortfall} wei from the main funded wallet`,
  )
  const signedTx = await params.mainAccountSigner.buildAndSignTransfer(
    params.identityAddress,
    shortfall,
  )
  const txHash = await params.mainAccountSigner.submit(signedTx)
  await waitForConfirmation(params.mainAccountSigner, txHash, `${params.label} identity funding`)
}

async function main() {
  const relayBaseUrl = process.env.E2E_DEMO_RELAY_URL ?? 'http://127.0.0.1:8098'
  const rpcUrl = requiredEnv('MONAD_TESTNET_HTTP_RPC_URL')
  const networkTag = requiredEnv('FRANK_NETWORK_TAG')
  const minimumStampValueWei = BigInt(requiredEnv('CASHWEB_STAMP_MIN_BURN_VALUE_WEI'))
  const entryPriceWei = BigInt(
    process.env.RAFFLE_BOT_ENTRY_PRICE_WEI ?? '20000000000000000', // 0.02 MON
  )
  if (entryPriceWei < minimumStampValueWei) {
    throw new Error(
      `Raffle bot entry price ${entryPriceWei} wei is below the relay minimum ${minimumStampValueWei}`,
    )
  }
  const maxEntries = Number(process.env.RAFFLE_BOT_MAX_ENTRIES ?? 5)
  if (maxEntries < 2) {
    throw new Error('RAFFLE_BOT_MAX_ENTRIES must be at least 2')
  }
  // Replies (announce/joined/error) go out with the relay's bare minimum stamp -- an entrant's own
  // `entryPriceWei` payment is what funds this bot; a reply is just a message, not another sale.
  const replyStampValueWei = minimumStampValueWei

  const identityJsonPath = resolve(
    process.cwd(),
    process.env.RAFFLE_BOT_IDENTITY_JSON ?? '/tmp/raffle-bot-identity.json',
  )
  const mainWalletJsonPath = resolve(
    process.cwd(),
    process.env.E2E_DEMO_MAIN_WALLET_JSON ??
      '../frank-worktrees/spike-demo/spike/data/chain-wallet.json',
  )
  const stateDirPath = resolve(
    process.cwd(),
    process.env.RAFFLE_BOT_STATE_DIR ?? '/tmp/raffle-bot-state',
  )
  const pollIntervalMs = Number(process.env.RAFFLE_BOT_POLL_INTERVAL_MS ?? 4000)
  const maxRounds = Number(process.env.RAFFLE_BOT_MAX_ROUNDS ?? 1000)
  const idleTimeoutMs = Number(process.env.RAFFLE_BOT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000)

  console.log('== Raffle bot: provably-fair, winner-takes-the-pot raffle over stamped Frank DMs ==')
  console.log(`Relay:        ${relayBaseUrl}`)
  console.log(`Entry price:  ${entryPriceWei} wei`)
  console.log(`Round size:   ${maxEntries} entrants`)

  const identity = loadOrCreateIdentity(identityJsonPath, 'raffle-bot')
  await registerAndLog({ relayBaseUrl, identity, label: 'raffle-bot' })
  console.log(`Raffle bot identity address: ${identity.displayAddress}`)

  const { stampClient, mainAccountSigner, provider, pool } = await setUpFundedStampClient({
    rpcUrl,
    relayBaseUrl,
    mainWalletJsonPath,
    stampValueWei: replyStampValueWei,
    label: 'raffle-bot',
  })

  // This bot's own signer over its own identity's private key -- used *only* to pay a round's
  // winner, from the balance entrants themselves just paid into this same address. See this file's
  // header, "Why this bot can't be drained."
  const httpClient = new MonadHttpClient({ rpcUrl })
  const identitySigner = new MonadAccountTxSigner({
    privateKey: identity.toPrivateKeyHex(),
    provider,
    httpClient,
  })

  const state = new RaffleBotStateStore(stateDirPath)
  await state.Open()
  console.log(`[raffle-bot] persisted state loaded from ${stateDirPath}`)

  function openFreshRound(): RaffleRoundRecord {
    const serverSeed = generateServerSeed()
    const serverSeedHash = sha256Hex(serverSeed)
    state.setPendingCommitment(serverSeed, serverSeedHash)
    const round: RaffleRoundRecord = {
      raffleId: generateRaffleId(),
      entryPriceWei: entryPriceWei.toString(),
      maxEntries,
      serverSeedHash,
      entrants: [],
    }
    state.setCurrentRound(round)
    return round
  }

  // The pending commitment (and the round bound to it) must already exist before this run can see
  // its first entry -- pick up a restart's in-progress round, or open the very first one.
  if (!state.getPendingCommitment() || !state.getCurrentRound()) {
    const round = openFreshRound()
    console.log(`[raffle-bot] opened round ${round.raffleId} (commitment ${round.serverSeedHash})`)
  } else {
    const round = state.getCurrentRound() as RaffleRoundRecord
    console.log(
      `[raffle-bot] resumed round ${round.raffleId} (${round.entrants.length}/${round.maxEntries} entered)`,
    )
  }

  const senderPubKeyCache = new Map<string, Buffer>()
  let since = Date.now()
  let roundsDrawn = 0
  let lastActivityAt = Date.now()

  console.log(
    `\nPolling ${relayBaseUrl}/message/monad?since=<t> every ${pollIntervalMs}ms for messages addressed to ${identity.displayAddress} ...`,
  )

  while (roundsDrawn < maxRounds) {
    if (Date.now() - lastActivityAt > idleTimeoutMs) {
      console.log(`\nNo activity within ${idleTimeoutMs}ms -- exiting.`)
      break
    }

    const stored = await fetchMonadMessagesSince({ relayBaseUrl, sinceMs: since })
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
        myPrivateKey: identity.toBitcorePrivateKey(),
        senderPubKey,
      })
      if (rawPlaintext === undefined) {
        console.warn(
          `[raffle-bot] rejected unauthenticated or undecryptable message ${payloadHashHex}`,
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
        (item): item is RaffleItem => item.type === 'raffle' && item.action === 'enter',
      )

      lastActivityAt = Date.now()

      const sendReply = async (
        replyItems: RaffleItem[],
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

      const round = state.getCurrentRound() as RaffleRoundRecord

      if (!request) {
        // Any other message from a would-be entrant gets the current round's status.
        console.log(`\n[raffle-bot] sending round status to ${envelope.from}`)
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'announce',
            entryPriceWei: round.entryPriceWei,
            maxEntries: round.maxEntries,
            entryCount: round.entrants.length,
            serverSeedHash: round.serverSeedHash,
          },
        ])
        continue
      }

      console.log(`\n[raffle-bot] entry request from ${envelope.from}`)

      if (round.entrants.some(entrant => entrant.address === envelope.from)) {
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'error',
            message: 'You have already entered this round.',
          },
        ])
        continue
      }

      const plugin = getMessageItemPlugin('raffle')
      if (!plugin) throw new Error('raffle plugin not registered')
      const context: MessageItemContext = {
        message: {
          ...(message.message as unknown as Message),
          stampValueWei: entryPayment(message.message).valueWei,
        },
        index: items.indexOf(request),
        provider,
      }
      const hydrated = (await plugin.hydrate(request, context)) as HydratedRaffleItem

      if ((hydrated.paidWei ?? 0n) < BigInt(round.entryPriceWei)) {
        console.log(
          `[raffle-bot] rejecting -- paid ${hydrated.paidWei} wei, needed ${round.entryPriceWei} wei`,
        )
        await sendReply([
          {
            type: 'raffle',
            raffleId: round.raffleId,
            action: 'error',
            message: `Payment ${hydrated.paidWei ?? 0n} wei is below this round's entry price of ${round.entryPriceWei} wei`,
          },
        ])
        continue
      }

      const { txHash } = entryPayment(message.message)
      const entrant: RaffleEntrant = { address: envelope.from, txHash }
      const updatedEntrants = [...round.entrants, entrant]
      const updatedRound: RaffleRoundRecord = { ...round, entrants: updatedEntrants }
      state.setCurrentRound(updatedRound)

      console.log(
        `[raffle-bot] ${envelope.from} entered round ${round.raffleId} (${updatedEntrants.length}/${round.maxEntries})`,
      )

      await sendReply([
        {
          type: 'raffle',
          raffleId: round.raffleId,
          action: 'joined',
          entryPriceWei: round.entryPriceWei,
          maxEntries: round.maxEntries,
          entryCount: updatedEntrants.length,
          serverSeedHash: round.serverSeedHash,
        },
      ])

      if (updatedEntrants.length < round.maxEntries) continue

      // Round is full -- draw, reveal, and pay out, then immediately rotate to a fresh round with
      // a brand new commitment (generated *before* it can have any entrants).
      const commitment = state.getPendingCommitment()
      if (!commitment || commitment.serverSeedHash !== round.serverSeedHash) {
        console.error(
          `[raffle-bot] internal error: no matching pending commitment for round ${round.raffleId} -- refusing to draw`,
        )
        continue
      }
      const entrantAddresses = updatedEntrants.map(e => e.address)
      const entryTxHashes = updatedEntrants.map(e => e.txHash)
      const winnerIndex = pickWinnerIndex(
        commitment.serverSeed,
        combineEntrantEntropy(entryTxHashes),
        entrantAddresses.length,
      )
      const winnerAddress = entrantAddresses[winnerIndex]
      const potWei = BigInt(round.entryPriceWei) * BigInt(updatedEntrants.length)

      console.log(
        `[raffle-bot] drawing round ${round.raffleId}: winner=${winnerAddress} pot=${potWei} wei`,
      )

      for (const e of updatedEntrants) {
        let toPubKey = senderPubKeyCache.get(e.address)
        if (!toPubKey) {
          toPubKey = await fetchMonadIdentityPubKey({ relayBaseUrl, address: e.address })
          if (!toPubKey) continue
          senderPubKeyCache.set(e.address, toPubKey)
        }
        await sendDirectMessageItems({
          stampClient,
          pool,
          mainAccountSigner,
          provider,
          fromIdentity: identity,
          toAddress: e.address,
          toPubKey,
          items: [
            {
              type: 'raffle',
              raffleId: round.raffleId,
              action: 'draw',
              entryPriceWei: round.entryPriceWei,
              winnerAddress,
              serverSeed: commitment.serverSeed,
              entrants: entrantAddresses,
              entryTxHashes,
              potWei: potWei.toString(),
            },
          ],
          stampValueWei: replyStampValueWei,
          networkTag,
        })
      }

      // See this file's header, "Why this bot can't be drained" -- this only ever tops up a flat
      // gas buffer, never the payout amount itself, and the payout is signed from the identity's
      // own balance (funded by this exact round's entrants), never mainAccountSigner.
      const feeData = await provider.getFeeData()
      const fallbackMaxFeePerGas = BigInt(250000000000)
      const maxFeePerGas = feeData.maxFeePerGas ?? fallbackMaxFeePerGas
      const gasBufferWei = (maxFeePerGas * BigInt(21000) * BigInt(11)) / BigInt(10)
      await ensureIdentityFunded({
        identityAddress: identity.displayAddress,
        mainAccountSigner,
        provider,
        neededWei: potWei + gasBufferWei,
        label: 'raffle-bot',
      })

      console.log(`[raffle-bot] paying out ${potWei} wei to ${winnerAddress} ...`)
      const payoutTx = await identitySigner.buildAndSignTransfer(winnerAddress, potWei)
      const payoutTxHash = await identitySigner.submit(payoutTx)
      console.log(`[raffle-bot] payout tx sent: ${payoutTxHash}`)

      roundsDrawn++
      const nextRound = openFreshRound()
      console.log(
        `[raffle-bot] opened round ${nextRound.raffleId} (commitment ${nextRound.serverSeedHash})`,
      )
      if (roundsDrawn >= maxRounds) break
    }

    if (stored.length > 0) since = maxSeenTimestamp + 1
    await state.flush()
    await sleep(pollIntervalMs)
  }

  await state.Close()
  console.log(`\nDone. Drew ${roundsDrawn} round${roundsDrawn === 1 ? '' : 's'}.`)
}

main().catch(err => {
  console.error('RAFFLE BOT FAILED:', err)
  process.exit(1)
})
