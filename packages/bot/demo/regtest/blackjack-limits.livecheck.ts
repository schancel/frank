/**
 * The blackjack dealer's offer names its table limits, end to end on the local Monad network
 * (monad-solonet): the real relay binary, the real bot host running `BlackjackDealerBot`, and a
 * player wallet that reads every dealer message through the relay and the message-item codec,
 * then folds the hand with the shared state machine the app uses. Nothing is simulated. Not part
 * of CI.
 *
 *   yarn --cwd packages/bot regtest:blackjack-limits
 *   BLACKJACK_LIMITS_MIN_HANDS=30 BLACKJACK_LIMITS_MAX_HANDS=40 yarn --cwd packages/bot regtest:blackjack-limits
 *
 * Checked:
 *   1. the dealer's challenge carries `minBetWei` and `maxBetWei` (the bot's `limits()`), and the
 *      app's own check (`checkWager`) refuses a bet below the one and above the other;
 *   2. a bet below the minimum, sent anyway (as an old app would), is not taken by the hand and
 *      is returned in full, on chain;
 *   3. hands at the minimum are played until one ends in a push and one in a player win, and
 *      BLACKJACK_LIMITS_MIN_HANDS fully checked hands have completed (default 0, at most
 *      BLACKJACK_LIMITS_MAX_HANDS attempts, default 40). The cards come from both sides'
 *      entropy, so an outcome cannot be chosen. For every payout:
 *      the reveal pays exactly what the hand owes; each transfer it names lands, succeeds and
 *      moves exactly its value to the player's account (balance before and after its block);
 *      the player's wallet counts exactly that; no other message of the hand carries money; and
 *      how long the transfers took to land, with what the relay's log says about broadcasting
 *      them (a payment the node refused at the relay's broadcast stays refused for minutes:
 *      docs/protocol/chains/monad-reserve-balance.md).
 *
 * Funding comes from the solonet faucet. Every key funded here lives under the run's directory
 * (FRANK_REGTEST_STACK_DIR, kept with FRANK_REGTEST_KEEP=1 until the sweep is done): the bot
 * host's funding key is written there before it is funded. At the end, also after a failure,
 * everything is sent back to the faucet.
 */
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { Wallet } from 'ethers'

import { FrankBotHost } from '@frank/bot-framework'
import {
  buildBet,
  checkWager,
  foldHand,
  payoutWei,
  playerStep,
  type HandEvent,
  type HandItem,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

import { FundsInPendingSendError } from '@frank/wallet/evm-transaction-set-types'

import { DEMO_DEFAULT_BURN_ADDRESS } from '../demo-config'
import { BlackjackDealerBot } from '../../src/bots/blackjack-bot'
import { monadOf, openMonadWallet, returnToFaucet } from './monad-wallets'
import { startRegtestStack } from './regtest-stack'

const MON = 10n ** 18n
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const randomHex32 = () => Wallet.createRandom().privateKey.slice(2)

async function main(): Promise<boolean> {
  const minHands = Number(process.env.BLACKJACK_LIMITS_MIN_HANDS ?? '0')
  const maxHands = Number(process.env.BLACKJACK_LIMITS_MAX_HANDS ?? '40')
  if (!Number.isSafeInteger(minHands) || minHands < 0 ||
      !Number.isSafeInteger(maxHands) || maxHands < 1 || minHands > maxHands)
    throw new Error('BLACKJACK_LIMITS_MIN_HANDS and BLACKJACK_LIMITS_MAX_HANDS must be safe integers with 0 <= MIN_HANDS <= MAX_HANDS and MAX_HANDS >= 1')
  const stack = await startRegtestStack({
    chains: ['monad-regtest'],
    env: { ...process.env, FRANK_REGTEST_KEEP: '1' },
  })
  say(`run directory (keys of every funded account): ${stack.stateDir}`)
  const monad = monadOf(stack)
  const problems: string[] = []
  const check = (ok: boolean, what: string) => {
    say(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
    if (!ok) problems.push(what)
  }
  // The faucet is shared with whatever else runs on the chain: a payment that loses its nonce to
  // another one is tried again.
  const fund = async (address: string, amount: bigint) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await monad.fund(address, amount)
      } catch (error) {
        if (attempt >= 40) throw error
        say(`faucet payment failed (${(error as Error).message.slice(0, 80)}); trying again`)
        await sleep(1000 + Math.floor(Math.random() * 3000))
      }
    }
  }
  let host: FrankBotHost | undefined
  const wallets: { close(): Promise<void> }[] = []
  try {
    // The bot host on this run's relay and on monad-regtest, its keys under the run directory.
    const botDir = join(stack.stateDir, 'bot-host')
    mkdirSync(botDir, { recursive: true, mode: 0o700 })
    for (const name of ['E2E_DEMO_MAIN_WALLET_JSON', 'E2E_DEMO_MAIN_WALLET_PRIVATE_KEY', 'FRANK_DEMO_FAUCET_WALLET_JSON'])
      delete process.env[name]
    process.env.MONAD_RPC_CHAIN = 'monad-regtest'
    process.env.MONAD_STAMP_BURN_ADDRESS = DEMO_DEFAULT_BURN_ADDRESS
    process.env.BLACKJACK_BOT_IDENTITY_JSON = join(botDir, 'blackjack.json')
    // No shared funding wallet: the dealer's two accounts are funded from the faucet directly,
    // after its keys are on disk under the run directory (registration writes them).
    host = new FrankBotHost({
      stateDir: botDir,
      relayBaseUrl: stack.relayUrl,
      networkTag: 'MONR',
      rpcUrl: monad.rpcUrl,
      fundingPrivateKeyHex: '',
      watchRegistrations: false,
      pollIntervalMs: 1500,
    })
    await host.register(new BlackjackDealerBot())
    const instance = (host as any).instances.get('blackjack')
    const dealer = instance.context.address as string
    const dealerMain = (await instance.wallet.getReceiveAddress()).raw as string
    say(`dealer ${dealer}, main account ${dealerMain}`)
    // The dealer covers a bet of (identity balance - 0.02) / 4: about 0.5 MON at 2 MON. Its
    // payouts and refunds are paid from its wallet (main account).
    await fund(dealer, 2n * MON)
    if (dealerMain.toLowerCase() !== dealer.toLowerCase()) await fund(dealerMain, 2n * MON)
    await host.start()

    const player = await openMonadWallet(stack, 'blackjack-limits-player')
    wallets.push(player)
    await fund(player.mainAccount, 4n * MON)

    /** Sends once the wallet's earlier payments have settled: a paid send while the change of an
     * earlier one is still on its way is refused (owner ruling 2026-10-26), never queued, and the
     * wallet's own ticks finish that change. */
    const sendSettled = async (items: never[], stampWei?: bigint): Promise<string> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await player.send(dealer, items, stampWei)
        } catch (error) {
          const pending =
            error instanceof FundsInPendingSendError ||
            // Also when every coin is change of a send so recent the node would not take it yet
            // (docs/protocol/chains/monad-reserve-balance.md): the wallet then names no amount.
            /tied up in a previous send|No funds cover a stamp/.test(String((error as Error)?.message))
          // A payment the node refused stays refused for up to about fifteen minutes.
          if (!pending || attempt >= 400) throw error
          if (attempt === 1) say('the previous send has not reached the chain yet; waiting for it')
          if (attempt % 40 === 0) say(`  still waiting (${attempt * 3} s); relay: ${relaySaid() || 'nothing refused'}`)
          await player.chain.directMessages.reconcileAttempts({ wallet: player.handle, payloadDigests: [] })
          await sleep(3000)
        }
      }
    }
    /** What the relay logged about payments it could not broadcast, or one payment's. */
    const relaySaid = (txHash?: string) => {
      try {
        return readFileSync(join(stack.stateDir, 'logs', 'relay.log'), 'utf8')
          .replace(/\x1b\[[0-9;]*m/g, '')
          .split('\n')
          .filter(line => /payment not broadcast/.test(line) && (!txHash || line.includes(txHash.replace(/^0x/, ''))))
          .map(line => `${line.slice(11, 19)} ${line.match(/tx_hash=(\w{10})/)?.[1] ?? ''} ${line.match(/reason=(.*)$/)?.[1]?.slice(0, 120) ?? ''}`)
          .join('; ')
      } catch {
        return ''
      }
    }
    const seen = new Set<string>()
    const item = (m: { items: readonly { type: string }[] }) =>
      m.items.find(i => i.type === 'blackjack-hand') as HandItem | undefined
    const text = (m: { items: readonly { type: string }[] }) =>
      (m.items.find(i => i.type === 'text') as { text?: string } | undefined)?.text ?? ''
    const hand = () => {
      const events: HandEvent[] = []
      const fromDealer = async (action: string, timeoutMs = 300_000) => {
        const m = await player
          .receive(x => item(x)?.action === action && !seen.has(x.payloadDigest), timeoutMs)
          .catch(async error => {
            // What the dealer did say instead, for the report.
            const got = await player.chain.directMessages.fetchSince({ wallet: player.handle, sinceMs: 0 })
            for (const x of got.filter(x => !x.outbound))
              say(`  inbound ${item(x)?.action ?? '-'} paying ${x.stampValueWei}: ${text(x)}`)
            throw error
          })
        seen.add(m.payloadDigest)
        events.push({ item: item(m)!, from: dealer, to: player.address, stampWei: m.stampValueWei ?? 0n, digest: m.payloadDigest })
        return m
      }
      /** `stampWei`: the money the message carries (a bet); a move goes with the ordinary stamp. */
      const toDealer = async (it: HandItem, stampWei?: bigint) => {
        const digest = await sendSettled([it as never], stampWei)
        events.push({ item: it, from: player.address, to: dealer, stampWei: stampWei ?? 0n, digest })
      }
      return { events, fromDealer, toDealer, state: () => foldHand(events).state! }
    }
    /** What the dealer's message paid, as the chain confirms it (the wallet's payment check, the
     * one the bot uses for what a player paid). */
    const onChain = async (m: { payloadDigest: string }) => {
      for (let attempt = 1; ; attempt++) {
        const checked = await player.handle.checkMessagePayment!(m.payloadDigest)
        if (checked.receivedWei > 0n || attempt >= 150) return checked.receivedWei
        await sleep(2000)
      }
    }

    /**
     * The payout of a hand, checked on chain: the reveal says it pays `owed`; every transfer it
     * names lands, succeeds and moves exactly its value to the player's account; the player's
     * wallet counts exactly `owed` for it; and no other message of the hand carries money (it is
     * paid once). Waits up to ten minutes for the transfers and says how long they took.
     */
    const verifyPayout = async (
      label: string,
      gameId: string,
      reveal: { payloadDigest: string; stampValueWei?: bigint; stampPayments?: { txHash: string; destinationAddress: string; valueWei: bigint }[] },
      owed: bigint,
    ) => {
      const payments = reveal.stampPayments ?? []
      say(
        `${label}: reveal carries ${reveal.stampValueWei} in ${payments.length} transfer(s): ${payments
          .map(p => `${p.txHash.slice(0, 10)}→${p.destinationAddress.slice(0, 10)} ${p.valueWei}`)
          .join(', ')}`,
      )
      check(reveal.stampValueWei === owed, `${label}: the reveal pays exactly what the hand owes (${reveal.stampValueWei} of ${owed})`)
      const startedAt = Date.now()
      const landed = new Map<string, { block: number; to: string; value: bigint; ok: boolean }>()
      while (landed.size < payments.length && Date.now() - startedAt < 600_000) {
        for (const p of payments) {
          if (landed.has(p.txHash)) continue
          const receipt = await monad.provider.getTransactionReceipt(p.txHash)
          if (!receipt) continue
          const tx = await monad.provider.getTransaction(p.txHash)
          landed.set(p.txHash, {
            block: receipt.blockNumber,
            to: tx?.to ?? '',
            value: tx?.value ?? -1n,
            ok: receipt.status === 1,
          })
        }
        if (landed.size < payments.length) await sleep(3000)
      }
      say(`${label}: ${landed.size} of ${payments.length} transfer(s) on chain after ${Math.round((Date.now() - startedAt) / 1000)} s`)
      for (const p of payments) {
        const said = relaySaid(p.txHash)
        if (said) say(`${label}: relay could not broadcast ${p.txHash.slice(0, 10)}: ${said}`)
      }
      let total = 0n
      for (const p of payments) {
        const tx = landed.get(p.txHash)
        const good =
          !!tx && tx.ok && tx.to.toLowerCase() === p.destinationAddress.toLowerCase() && tx.value === p.valueWei
        check(good, `${label}: transfer ${p.txHash} landed, succeeded and paid ${p.valueWei} to ${p.destinationAddress}`)
        if (!good || !tx) continue
        total += p.valueWei
        const before = await monad.provider.getBalance(p.destinationAddress, tx.block - 1)
        const after = await monad.provider.getBalance(p.destinationAddress, tx.block)
        check(after - before === p.valueWei, `${label}: the player's account ${p.destinationAddress} moved by ${after - before} (${p.valueWei} paid)`)
      }
      check(total === owed, `${label}: what landed on chain (${total}) is what the hand owes (${owed})`)
      const counted = await onChain(reveal)
      check(counted === owed, `${label}: the player's wallet counts ${counted} for the payout`)
      // Paid once: after a pause, no other message of this hand from the dealer carries money.
      await sleep(20_000)
      const inbound = (await player.chain.directMessages.fetchSince({ wallet: player.handle, sinceMs: 0 })).filter(
        x => !x.outbound && item(x)?.gameId === gameId && (x.stampValueWei ?? 0n) > 0n,
      )
      check(
        inbound.length === 1 && inbound[0].payloadDigest === reveal.payloadDigest,
        `${label}: the payout is the only paying message of the hand (${inbound.length} found)`,
      )
    }

    // 1. The offer names the table limits.
    const first = hand()
    await player.send(dealer, [{ type: 'text', text: 'deal me in' }])
    const offer = await first.fromDealer('challenge')
    const offered = item(offer) as HandItem & { minBetWei?: string; maxBetWei: string }
    say(`offer: ${JSON.stringify(offered)}; text: ${text(offer)}`)
    check(typeof offered.minBetWei === 'string', 'the challenge, as decoded from the relay, carries minBetWei')
    const min = BigInt(offered.minBetWei ?? '0')
    const max = BigInt(offered.maxBetWei)
    check(min > 0n && min <= max, `0 < minBetWei (${min}) <= maxBetWei (${max})`)
    check(first.state().minBetWei === min && first.state().maxBetWei === max, 'the folded hand holds both limits')
    const spendable = 10n * MON
    check(checkWager(first.state(), min - 1n, spendable, 0n) === 'below-min-bet', "the app's check refuses a bet below the minimum")
    check(checkWager(first.state(), max + 1n, spendable, 0n) === 'above-max-bet', "the app's check refuses a bet above the maximum")
    check(checkWager(first.state(), min, spendable, 0n) === undefined, "the app's check takes a bet at the minimum")

    // 2. A bet below the minimum, sent anyway, is returned in full and not dealt.
    const under = min - 1n
    await first.toDealer(buildBet(first.state(), randomHex32())!, under)
    const refund = await first.fromDealer('refund')
    check((refund.stampValueWei ?? 0n) === under, `the refund carries the bet (${refund.stampValueWei} of ${under})`)
    check((await onChain(refund)) === under, 'the refund is on chain')
    check(first.state().phase === 'open', 'the hand never took the bet (still open, nothing dealt)')

    // 3. Hands at the minimum, played until one ended in a push and one in a player win (the
    //    cards come from both sides' entropy, so an outcome cannot be chosen: hands are played
    //    until each has come up and the requested minimum number of hands has been verified).
    //    Every payout is checked on chain: paid once, in full, and the
    //    player's receiving accounts moved by exactly that much.
    let verifiedHands = 0
    const wanted = new Map<string, boolean>([
      ['push', false],
      ['player win', false],
    ])
    say(`playing at least ${minHands} verified hands, at most ${maxHands} attempts, requiring a push and a player win`)
    for (let n = 1; n <= maxHands && (verifiedHands < minHands || [...wanted.values()].includes(false)); n++) {
      const problemsBeforeHand = problems.length
      const h = hand()
      await sendSettled([{ type: 'text', text: `hand ${n}` }] as never[])
      await h.fromDealer('challenge')
      const seed = randomHex32()
      await h.toDealer(buildBet(h.state(), seed)!, h.state().minBetWei!)
      await h.fromDealer('deal')
      if (h.state().phase === 'player_turn') await h.toDealer(playerStep(h.state(), 'stand', seed)!)
      const reveal = await h.fromDealer('reveal')
      const end = h.state()
      const owed = payoutWei(end.outcome!, end.wagerWei, end.doubled)
      say(`hand ${n}: ${end.outcome}, bet ${end.wagerWei}, owed ${owed}`)
      check(end.phase === 'resolved', `hand ${n} resolved`)
      const kind =
        end.outcome === 'push' ? 'push' : end.outcome === 'player_win' || end.outcome === 'player_blackjack' ? 'player win' : undefined
      if (owed > 0n) await verifyPayout(`hand ${n} (${end.outcome})`, end.gameId, reveal, owed)
      else check((reveal.stampValueWei ?? 0n) === 0n, `hand ${n}: a reveal that owes nothing pays nothing`)
      if (kind) wanted.set(kind, true)
      if (problems.length === problemsBeforeHand) verifiedHands++
    }
    check(verifiedHands >= minHands, `${verifiedHands} fully checked hands completed (at least ${minHands} required)`)
    for (const [kind, seen] of wanted) check(seen, `a ${kind} came up within ${maxHands} hands and was paid`)
  } catch (error) {
    problems.push(error instanceof Error ? error.stack ?? error.message : String(error))
    say('FAIL ', error)
  } finally {
    await host?.stop().catch(() => undefined)
    for (const wallet of wallets) await wallet.close().catch(() => undefined)
    // Everything the run's accounts hold goes back to the faucet, the bot host's included.
    const back = await returnToFaucet(stack).catch(error => {
      say('sweep failed:', error)
      return undefined
    })
    if (back) say(`returned ${back.returnedWei} wei to the faucet; ${back.leftWei} wei left as dust or in flight`)
    say(`keys stay in ${stack.stateDir} until it is removed: sweep again with yarn --cwd packages/bot regtest:monad-sweep-state ${stack.stateDir}`)
    await stack.stop()
  }
  say(problems.length ? `FAILED:\n  ${problems.join('\n  ')}` : 'all checks passed')
  return problems.length === 0
}

if (require.main === module) {
  main().then(
    ok => process.exit(ok ? 0 : 1),
    error => {
      console.error(error)
      process.exit(1)
    },
  )
}
