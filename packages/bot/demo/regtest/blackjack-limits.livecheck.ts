/**
 * The blackjack dealer's offer names its table limits, end to end on the local Monad network
 * (monad-solonet): the real relay binary, the real bot host running `BlackjackDealerBot`, and a
 * player wallet that reads every dealer message through the relay and the message-item codec,
 * then folds the hand with the shared state machine the app uses. Nothing is simulated. Not part
 * of CI.
 *
 *   yarn --cwd packages/bot regtest:blackjack-limits
 *
 * Checked:
 *   1. the dealer's challenge carries `minBetWei` and `maxBetWei` (the bot's `limits()`), and the
 *      app's own check (`checkWager`) refuses a bet below the one and above the other;
 *   2. a bet below the minimum, sent anyway (as an old app would), is not taken by the hand and
 *      is returned in full, on chain;
 *   3. a bet at the minimum on a fresh offer is dealt and the hand resolves; what it owes is on
 *      chain.
 *
 * Funding comes from the solonet faucet. Every key funded here lives under the run's directory
 * (FRANK_REGTEST_STACK_DIR, kept with FRANK_REGTEST_KEEP=1 until the sweep is done): the bot
 * host's funding key is written there before it is funded. At the end, also after a failure,
 * everything is sent back to the faucet.
 */
import { mkdirSync, writeFileSync } from 'fs'
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

import { DEMO_DEFAULT_BURN_ADDRESS } from '../demo-config'
import { BlackjackDealerBot } from '../../src/bots/blackjack-bot'
import { monadOf, openMonadWallet, returnToFaucet, tickUntilSettled } from './monad-wallets'
import { startRegtestStack } from './regtest-stack'

const MON = 10n ** 18n
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const randomHex32 = () => Wallet.createRandom().privateKey.slice(2)

async function main(): Promise<boolean> {
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
        if (attempt >= 8) throw error
        say(`faucet payment failed (${(error as Error).message.slice(0, 80)}); trying again`)
        await sleep(1500)
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
    // The host's funding key is written down before it is funded; the sweep finds it by its name.
    const funder = Wallet.createRandom()
    writeFileSync(
      join(botDir, 'funding-wallet.json'),
      JSON.stringify({ address: funder.address, privateKey: funder.privateKey }),
      { mode: 0o600 },
    )
    await fund(funder.address, 6n * MON)
    host = new FrankBotHost({
      stateDir: botDir,
      relayBaseUrl: stack.relayUrl,
      networkTag: 'MONR',
      rpcUrl: monad.rpcUrl,
      fundingPrivateKeyHex: funder.privateKey,
      // The dealer covers a bet of (balance - 0.02) / 4: about 0.5 MON at 2 MON.
      topUpBelowWei: 2n * MON,
      topUpToWei: 3n * MON,
      fundingReserveWei: 0n,
      watchRegistrations: false,
      pollIntervalMs: 1500,
    })
    await host.register(new BlackjackDealerBot())
    await host.start()
    const dealer = (host as any).instances.get('blackjack').context.address as string
    say(`dealer ${dealer}`)
    for (const deadline = Date.now() + 120_000; (await monad.provider.getBalance(dealer)) < 2n * MON; ) {
      if (Date.now() > deadline) throw new Error('the bot host did not fund the dealer')
      await sleep(1000)
    }

    const player = await openMonadWallet(stack, 'blackjack-limits-player')
    wallets.push(player)
    await fund(player.mainAccount, 4n * MON)

    const seen = new Set<string>()
    const item = (m: { items: readonly { type: string }[] }) =>
      m.items.find(i => i.type === 'blackjack-hand') as HandItem | undefined
    const text = (m: { items: readonly { type: string }[] }) =>
      (m.items.find(i => i.type === 'text') as { text?: string } | undefined)?.text ?? ''
    const hand = () => {
      const events: HandEvent[] = []
      const fromDealer = async (action: string, timeoutMs = 300_000) => {
        const m = await player.receive(x => item(x)?.action === action && !seen.has(x.payloadDigest), timeoutMs)
        seen.add(m.payloadDigest)
        events.push({ item: item(m)!, from: dealer, to: player.address, stampWei: m.stampValueWei ?? 0n, digest: m.payloadDigest })
        return m
      }
      /** `stampWei`: the money the message carries (a bet); a move goes with the ordinary stamp. */
      const toDealer = async (it: HandItem, stampWei?: bigint) => {
        await tickUntilSettled(player)
        const digest = await player.send(dealer, [it as never], stampWei)
        events.push({ item: it, from: player.address, to: dealer, stampWei: stampWei ?? 0n, digest })
      }
      return { events, fromDealer, toDealer, state: () => foldHand(events).state! }
    }
    /** What the dealer's message paid, as the chain shows it. */
    const onChain = async (m: { stampPayments?: { txHash: string; destinationAddress: string; valueWei: bigint }[] }) => {
      let total = 0n
      for (const p of m.stampPayments ?? []) {
        const receipt = await monad.provider.getTransactionReceipt(p.txHash)
        const tx = await monad.provider.getTransaction(p.txHash)
        if (receipt?.status === 1 && tx?.to?.toLowerCase() === p.destinationAddress.toLowerCase() && tx.value === p.valueWei)
          total += p.valueWei
      }
      return total
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

    // 3. A bet at the minimum on a fresh offer is dealt and settles.
    const second = hand()
    await tickUntilSettled(player)
    await player.send(dealer, [{ type: 'text', text: 'another hand' }])
    await second.fromDealer('challenge')
    const seed = randomHex32()
    await second.toDealer(buildBet(second.state(), seed)!, second.state().minBetWei!)
    await second.fromDealer('deal')
    if (second.state().phase === 'player_turn') await second.toDealer(playerStep(second.state(), 'stand', seed)!)
    const reveal = await second.fromDealer('reveal')
    const end = second.state()
    check(end.phase === 'resolved', `the hand at the minimum resolved (${end.phase}, ${end.outcome})`)
    const owed = payoutWei(end.outcome!, end.wagerWei, end.doubled)
    check((await onChain(reveal)) >= owed, `what the hand owes (${owed}) is on chain`)
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
    say(`keys stay in ${stack.stateDir} until it is removed: sweep again with yarn --cwd packages/bot funds:sweep ${stack.stateDir}`)
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
