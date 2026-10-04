/**
 * The headless bot on a real typed wallet, against a second real typed wallet, through the
 * canonical direct-message path (the offline two-wallet table of
 * `@frank/wallet/chain/canonical-two-wallets.testutil`). The bot's account here is exactly
 * `walletBotAccount(chain, wallet)`: the same chain facade the app uses, no key of its own.
 */
import {
  STAMP,
  START_BALANCE,
  table,
  type Seat,
} from '@frank/wallet/chain/canonical-two-wallets.testutil'
import { handValue } from '@frank/wallet/message-item-plugins/blackjack/deck'
import {
  buildChallenge,
  dealerStep,
  playerMoves,
  seedFromBytes,
  type HandItem,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

import {
  BlackjackP2pBot,
  MemoryBotStore,
  walletBotAccount,
  type BotAccount,
} from './blackjack-p2p-bot'

jest.mock('@frank/wallet/monad-provider', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('@frank/wallet/monad-http', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('@frank/wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)

const RESERVE = 10n ** 16n
const MAX_BET = 40_000n

describe('the bot is an ordinary account on a real typed wallet', () => {
  jest.setTimeout(600_000)
  let t: Awaited<ReturnType<typeof table>>
  let user: Seat
  let bot: BlackjackP2pBot
  let account: BotAccount
  /** Every stamp the bot's wallet paid, in order. */
  let paid: bigint[]

  beforeEach(async () => {
    t = await table()
    user = t.bob
    const real = walletBotAccount(t.f.chain as never, t.f.alice as never)
    paid = []
    account = {
      ...real,
      // The offline relay needs to be told whose mailbox the next delivery goes to.
      send: async params => {
        t.f.setMailbox(user.mailbox)
        try {
          const sent = await real.send(params)
          paid.push(sent.stampValueWei)
          return sent
        } finally {
          t.f.setMailbox(undefined)
        }
      },
    }
    bot = new BlackjackP2pBot(account, new MemoryBotStore(), {
      maxBetWei: MAX_BET,
      stampWei: STAMP,
      reserveWei: RESERVE,
    })
  })
  afterEach(() => t.f.close())

  const botTurn = async () => {
    for (let i = 0; i < 10; i++) if ((await bot.tick()) === 0) break
    await user.poll()
  }

  it('deals and pays when a user challenges it as player', async () => {
    const gameId = 'user-plays'
    const challenge = buildChallenge({
      gameId,
      role: 'player',
      maxBetWei: MAX_BET,
      spendableWei: await user.balance(),
      reserveWei: RESERVE,
    })
    if ('error' in challenge) throw new Error(challenge.error)
    await user.send(challenge.item)
    await botTurn()
    expect(user.hand(gameId)).toMatchObject({
      phase: 'open',
      dealer: account.address,
      player: user.address,
      maxBetWei: MAX_BET,
    })
    await user.send({ type: 'blackjack-hand', gameId, action: 'bet' }, MAX_BET)
    await botTurn()
    for (let i = 0; i < 10 && playerMoves(user.hand(gameId)).length; i++) {
      const action = handValue(user.hand(gameId)!.playerCards).total < 17 ? 'hit' : 'stand'
      await user.send({ type: 'blackjack-hand', gameId, action })
      await botTurn()
    }
    const final = user.hand(gameId)!
    expect(final.phase).toBe('resolved')
    expect(bot.hand(user.address, gameId)).toEqual(final)
    // The bot paid exactly what the hand says it owed, as the stamp of its reveal, and the
    // user's own wallet verified that amount on receipt.
    const owed = final.owedWei!
    expect(final.paidWei).toBe(owed > 0n ? owed : STAMP)
    expect(paid[paid.length - 1]).toBe(owed > 0n ? owed : STAMP)
    expect(paid.slice(0, -1).every(v => v === STAMP)).toBe(true)
    const reveal = user.events[user.events.length - 1]
    expect(reveal.item.action).toBe('reveal')
    expect(user.received.get(reveal.digest)).toBe(owed > 0n ? owed : STAMP)
    // Its wager reached the bot as a stamp the bot's wallet verified.
    expect(final.wagerWei).toBe(MAX_BET)
    expect(await account.spendableWei()).toBeLessThan(START_BALANCE - owed)
  })

  it('bets and plays when a user challenges it as dealer', async () => {
    const gameId = 'user-deals'
    const seed = seedFromBytes(new Uint8Array(32).fill(9))
    const challenge = buildChallenge({
      gameId,
      role: 'dealer',
      maxBetWei: MAX_BET * 2n,
      spendableWei: await user.balance(),
      reserveWei: RESERVE,
      seed,
    })
    if ('error' in challenge) throw new Error(challenge.error)
    await user.send(challenge.item)
    for (let i = 0; i < 20; i++) {
      await botTurn()
      const step = dealerStep(user.hand(gameId), seed)
      if (!step) break
      await user.send(step.item, step.payWei ?? STAMP)
    }
    const final = user.hand(gameId)!
    expect(final).toMatchObject({
      phase: 'resolved',
      dealer: user.address,
      player: account.address,
      // The bot bet its own configured max, below the hand's, as the stamp of its bet.
      wagerWei: MAX_BET,
    })
    expect(bot.hand(user.address, gameId)).toEqual(final)
    expect(paid[0]).toBe(MAX_BET)
    expect(user.received.get(final.betDigest!)).toBe(MAX_BET)
    expect(paid.slice(1).every(v => v === STAMP)).toBe(true)
    expect(final.paidWei).toBe(final.owedWei! > 0n ? final.owedWei : STAMP)
  })

  it('challenges, as dealer, an account that messages it for the first time', async () => {
    await user.send({ type: 'text', text: 'hello' } as unknown as HandItem)
    await botTurn()
    const [challenge] = user.events
    expect(challenge.item).toMatchObject({
      type: 'blackjack-hand',
      action: 'challenge',
      role: 'dealer',
      maxBetWei: MAX_BET.toString(),
    })
    const gameId = challenge.item.gameId
    expect(user.hand(gameId)).toMatchObject({
      phase: 'open',
      dealer: account.address,
      player: user.address,
    })
    // Once: a second message brings no second challenge.
    await user.send({ type: 'text', text: 'hello again' } as unknown as HandItem)
    await botTurn()
    expect(user.events).toHaveLength(1)
    // And the hand it offered is playable.
    await user.send({ type: 'blackjack-hand', gameId, action: 'bet' }, 20_000n)
    await botTurn()
    expect(['player_turn', 'dealer_turn', 'resolved']).toContain(user.hand(gameId)!.phase)
    if (user.hand(gameId)!.phase === 'player_turn') {
      await user.send({ type: 'blackjack-hand', gameId, action: 'stand' })
      await botTurn()
    }
    expect(user.hand(gameId)!.phase).toBe('resolved')
    expect(bot.hand(user.address, gameId)).toEqual(user.hand(gameId))
  })
})
