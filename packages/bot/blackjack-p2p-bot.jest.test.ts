/**
 * The headless blackjack bot against a scripted user, over an in-memory relay and wallet journal.
 * The bot is given nothing a person's app does not have: an account that can send a stamped
 * message, read its mailbox and ask about its own payment attempts.
 *
 * The crash tests kill the bot at every durable write and at every point inside a send, reopen it
 * from its file, and check that each payout, refund and bet was paid exactly once.
 */
import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { deriveDeck, handValue } from '@frank/wallet/message-item-plugins/blackjack/deck'
import { playOutDealer } from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  commitmentOf,
  dealerStep,
  foldHand,
  handEventsOf,
  type HandEvent,
  type HandItem,
  type HandRejection,
  type HandState,
} from '@frank/wallet/message-item-plugins/blackjack/hand'

import {
  BlackjackP2pBot,
  FileBotStore,
  MemoryBotStore,
  type AttemptStatus,
  type BotAccount,
  type BotConfig,
  type BotState,
  type BotStore,
  runBlackjackP2pBot,
} from './blackjack-p2p-bot'

const BOT = '0xB07b07B07b07b07b07b07B07b07B07b07b07b07B'
const USER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const STAMP = 10n
const RESERVE = 1_000n
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
/** A well-formed game id (32 lowercase hex characters) for a readable name. */
const gid = (name: string) => sha(`game:${name}`).slice(0, 32)

class Crash extends Error {}

interface Delivered {
  from: string
  to: string
  item: { type: string }
  /** Further items of the same message. */
  extra?: { type: string }[]
  stampWei: bigint
  digest: string
  time: number
}

/** The relay, the chain balances and each wallet's durable payment journal. It outlives a bot
 * process, like the real ones do. */
class Net {
  readonly delivered: Delivered[] = []
  readonly balances = new Map<string, bigint>()
  readonly attempts = new Map<
    string,
    { owner: string; status: AttemptStatus; message: Omit<Delivered, 'time'>; accounted: boolean }
  >()
  private clock = 1_000
  /** Counts every point at which a process may die; `dieAt` kills at that one. */
  points = 0
  dieAt = 0
  /** The running process. A killed process can do nothing more, whatever it catches. */
  process = 0
  point(process = this.process) {
    this.alive(process)
    if (++this.points === this.dieAt) {
      this.process++
      throw new Crash(`killed at point ${this.points}`)
    }
  }
  alive(process: number) {
    if (process !== this.process) throw new Crash('this process was killed')
  }
  deliver(message: Omit<Delivered, 'time'>) {
    if (this.delivered.some(d => d.digest === message.digest)) return
    this.delivered.push({ ...message, time: ++this.clock })
  }
  spend(address: string, value: bigint) {
    this.balances.set(address, (this.balances.get(address) ?? 0n) - value)
  }
  /** Every stamp the address paid, in order. */
  paidBy(address: string): Delivered[] {
    return this.delivered.filter(d => d.from === address)
  }
}

class NetAccount implements BotAccount {
  private counter = 0
  /** 'lost' drops the relay answer after delivery, 'dead' ends the payment set at the relay. */
  fault: 'none' | 'lost' | 'dead' | 'unreachable' = 'none'
  private readonly process: number
  constructor(
    private readonly net: Net,
    readonly address: string,
  ) {
    this.process = net.process
  }
  async spendableWei() {
    this.net.alive(this.process)
    return this.net.balances.get(this.address) ?? 0n
  }
  async send(params: Parameters<BotAccount['send']>[0]) {
    this.net.alive(this.process)
    if (this.fault === 'unreachable') throw new Error('relay unreachable')
    this.net.point(this.process)
    // A fresh payment set: this is the only place money leaves the account.
    const digest = sha(`${this.address}:${this.net.attempts.size}:${++this.counter}`)
    this.net.spend(this.address, params.stampWei)
    this.net.attempts.set(digest, {
      owner: this.address,
      status: 'live',
      message: {
        from: this.address,
        to: params.to,
        item: params.item,
        stampWei: params.stampWei,
        digest,
      },
      accounted: false,
    })
    this.net.point(this.process)
    await params.onAttemptCreated(digest)
    this.net.point(this.process)
    const attempt = this.net.attempts.get(digest)!
    if (this.fault === 'dead') {
      attempt.status = 'dead'
      throw new Error('mailbox_terminal')
    }
    this.net.deliver(attempt.message)
    attempt.status = 'delivered'
    if (this.fault === 'lost') throw new Error('no response')
    this.net.point(this.process)
    return { payloadDigest: digest, stampValueWei: params.stampWei }
  }
  async receive(sinceMs: number) {
    this.net.alive(this.process)
    return this.net.delivered
      .filter(d => d.to === this.address && d.time >= sinceMs)
      .map(d => ({
        from: d.from,
        items: [d.item, ...(d.extra ?? [])],
        stampValueWei: d.stampWei,
        payloadDigest: d.digest,
        receivedTime: d.time,
      }))
  }
  async attemptStatus(digests: string[]) {
    this.net.alive(this.process)
    const result: Record<string, AttemptStatus> = {}
    for (const digest of digests) {
      const attempt = this.net.attempts.get(digest)
      if (!attempt || attempt.owner !== this.address) {
        result[digest] = 'unknown'
        continue
      }
      // A live attempt is re-sent as the same bytes: same digest, no new payment.
      if (attempt.status === 'live' && this.fault !== 'unreachable') {
        this.net.deliver(attempt.message)
        attempt.status = 'delivered'
      }
      attempt.accounted = true
      result[digest] = attempt.status
    }
    return result
  }
  async unattributedAttempts(known: string[]) {
    this.net.alive(this.process)
    const orphans: string[] = []
    for (const [digest, attempt] of this.net.attempts) {
      if (attempt.owner !== this.address) continue
      if (known.includes(digest)) attempt.accounted = true
      else if (!attempt.accounted) orphans.push(digest)
    }
    return orphans
  }
}

/** A person at the other end, scripted: it sends through the same net and folds the same hand. */
class User {
  readonly events: HandEvent[] = []
  private counter = 0
  constructor(
    private readonly net: Net,
    readonly address: string,
    private readonly peer = BOT,
  ) {}
  send(item: Record<string, unknown> | { type: string }, stampWei = STAMP, digest?: string) {
    const full = { type: 'blackjack-hand', ...item } as { type: string }
    this.net.deliver({
      from: this.address,
      to: this.peer,
      item: full,
      stampWei,
      digest: digest ?? sha(`${this.address}:${++this.counter}`),
    })
  }
  /** Reads everything exchanged with the peer, in relay order. */
  hand(gameId: string): { state: HandState | undefined; rejected: HandRejection[] } {
    const events = this.net.delivered
      .filter(
        d =>
          (d.from === this.address && d.to === this.peer) ||
          (d.from === this.peer && d.to === this.address),
      )
      .flatMap(d =>
        handEventsOf({
          items: [d.item],
          senderAddress: d.from,
          recipientAddress: d.to,
          stampValueWei: d.stampWei,
          payloadDigest: d.digest,
        }),
      )
      .filter(e => e.item.gameId === gameId)
    const folded = foldHand(events)
    return { state: folded.state, rejected: folded.rejected.map(r => r.error) }
  }
  fromBot(): HandItem[] {
    return this.net
      .paidBy(this.peer)
      .filter(d => d.to === this.address)
      .map(d => d.item as HandItem)
  }
}

const SEED_BYTES = new Uint8Array(32).fill(7)
const BOT_SEED = '07'.repeat(32)
/** The bot's randomness is fixed, so the cards depend only on the bet's digest. */
const config = (over: Partial<BotConfig> = {}): BotConfig => ({
  maxBetWei: 500n,
  stampWei: STAMP,
  reserveWei: RESERVE,
  randomBytes: n => SEED_BYTES.slice(0, n),
  ...over,
})
/** A bet digest for which the player's first two cards, stood on, give `want` against the bot's
 * fixed seed. */
function betDigestFor(want: (deck: number[]) => boolean, seed = BOT_SEED): string {
  for (let i = 0; i < 5000; i++) {
    const digest = sha(`bet:${i}`)
    if (want(deriveDeck(seed, digest, 0))) return digest
  }
  throw new Error('no digest')
}
const firstTwo = (d: number[]) => [d[0], d[2]]
const standOutcome = (d: number[]) => playOutDealer(d, firstTwo(d), 4).outcome
const plain = (d: number[]) => !handValue(firstTwo(d)).blackjack
const WIN_BET = betDigestFor(d => plain(d) && standOutcome(d) === 'player_win')
const LOSS_BET = betDigestFor(d => plain(d) && standOutcome(d) === 'dealer_win')

function setup(balance = RESERVE + 100_000n) {
  const net = new Net()
  net.balances.set(BOT, balance)
  const account = new NetAccount(net, BOT)
  const store = new MemoryBotStore()
  const bot = new BlackjackP2pBot(account, store, config())
  return { net, account, store, bot, user: new User(net, USER) }
}

/** Ticks until the bot has nothing more to send. */
async function settle(bot: BlackjackP2pBot, rounds = 20) {
  for (let i = 0; i < rounds; i++) if ((await bot.tick()) === 0) return
  throw new Error('the bot never went quiet')
}

/** The user challenges as player for 500, the bot accepts and deals; the user bets `wager` and
 * stands. Returns when the script has nothing more to do. */
async function userPlaysAgainstBotDealer(
  user: User,
  tick: () => Promise<void>,
  wager: bigint,
  betDigest: string,
  gameId = gid('g-user'),
) {
  user.send({ gameId, action: 'challenge', role: 'player', maxBetWei: '500' })
  await tick()
  expect(user.hand(gameId).state?.phase).toBe('open')
  user.send({ gameId, action: 'bet' }, wager, betDigest)
  await tick()
  if (user.hand(gameId).state?.phase === 'player_turn') {
    user.send({ gameId, action: 'stand' })
    await tick()
  }
  return user.hand(gameId)
}

describe('the bot accepts any challenge in the opposite role', () => {
  it('deals when challenged by a player, and pays a win as the stamp of its reveal', async () => {
    const { net, bot, user } = setup()
    const { state, rejected } = await userPlaysAgainstBotDealer(user, () => settle(bot), 300n, WIN_BET)
    expect(rejected).toEqual([])
    expect(state).toMatchObject({
      phase: 'resolved',
      dealer: BOT,
      player: USER,
      outcome: 'player_win',
      wagerWei: 300n,
      owedWei: 600n,
      paidWei: 600n,
    })
    expect(user.fromBot().map(i => i.action)).toEqual(['accept', 'deal', 'reveal'])
    // The only stamp above the ordinary one is the payout.
    expect(net.paidBy(BOT).map(d => d.stampWei)).toEqual([STAMP, STAMP, 600n])
    expect(bot.hand(USER, gid('g-user'))).toEqual(state)
  })

  it('pays nothing beyond the ordinary stamp when the player loses', async () => {
    const { net, bot, user } = setup()
    const { state } = await userPlaysAgainstBotDealer(user, () => settle(bot), 300n, LOSS_BET)
    expect(state).toMatchObject({ phase: 'resolved', outcome: 'dealer_win', owedWei: 0n })
    expect(net.paidBy(BOT).map(d => d.stampWei)).toEqual([STAMP, STAMP, STAMP])
  })

  it('accepts at most what it can cover: a quarter of its spendable balance', async () => {
    const { bot, user } = setup(RESERVE + 400n)
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    expect(user.hand(gid('g')).state).toMatchObject({ phase: 'open', maxBetWei: 100n })
  })

  it('does not accept when it cannot cover even a minimum bet', async () => {
    const { net, bot, user } = setup(RESERVE + 4n * STAMP - 1n)
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    expect(net.paidBy(BOT)).toEqual([])
    expect(user.hand(gid('g')).state?.phase).toBe('challenged')
  })

  it('plays when challenged by a dealer: it bets, draws below 17, and stands', async () => {
    const { net, bot, user } = setup()
    const seed = 'c4'.repeat(32)
    const gameId = gid('g-deal')
    user.send({
      gameId,
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '2000',
      commitment: commitmentOf(seed),
    })
    // The user's app deals, deals cards and reveals by the same shared step function.
    for (let i = 0; i < 20; i++) {
      await settle(bot)
      const step = dealerStep(user.hand(gameId).state, seed)
      if (!step) break
      user.send(step.item, step.payWei ?? STAMP)
    }
    const { state, rejected } = user.hand(gameId)
    expect(rejected).toEqual([])
    expect(state).toMatchObject({ phase: 'resolved', dealer: USER, player: BOT })
    // The bot bet the lower of the hand's max and its own configured max, as its bet's stamp.
    expect(state?.wagerWei).toBe(500n)
    const sent = net.paidBy(BOT)
    expect(sent[0]).toMatchObject({ item: { action: 'bet' }, stampWei: 500n })
    expect(sent.slice(1).every(d => d.stampWei === STAMP)).toBe(true)
    // It never stood below 17 and never drew at 17 or more.
    const cards = state!.playerCards
    const actions = sent.slice(1).map(d => (d.item as HandItem).action)
    actions.forEach((action, i) => {
      const total = handValue(cards.slice(0, 2 + i)).total
      expect(action).toBe(total < 17 ? 'hit' : 'stand')
    })
    expect(bot.hand(USER, gameId)).toEqual(state)
  })

  it('bets no more than it can spend', async () => {
    const { net, bot, user } = setup(RESERVE + 120n)
    user.send({
      gameId: gid('g'),
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '2000',
      commitment: commitmentOf('c4'.repeat(32)),
    })
    await settle(bot)
    expect(net.paidBy(BOT)).toMatchObject([{ item: { action: 'bet' }, stampWei: 120n }])
  })
})

describe('the bot challenges accounts it has not met', () => {
  it('challenges an account that messages it, as dealer, once', async () => {
    const { net, bot, user } = setup()
    user.send({ type: 'text', text: 'hello' })
    await settle(bot)
    const [challenge] = net.paidBy(BOT)
    expect(challenge).toMatchObject({
      to: USER,
      stampWei: STAMP,
      item: { type: 'blackjack-hand', action: 'challenge', role: 'dealer', maxBetWei: '500' },
    })
    // The commitment is to a seed the bot keeps to itself.
    expect((challenge.item as { commitment: string }).commitment).toBe(commitmentOf(BOT_SEED))
    expect(net.delivered.map(d => JSON.stringify(d.item)).join()).not.toContain(BOT_SEED)
    user.send({ type: 'text', text: 'hello again' })
    await settle(bot)
    expect(net.paidBy(BOT)).toHaveLength(1)
  })

  it('plays the hand it offered when the account bets', async () => {
    const { net, bot, user } = setup()
    user.send({ type: 'text', text: 'hello' })
    await settle(bot)
    const gameId = (net.paidBy(BOT)[0].item as HandItem).gameId
    user.send({ gameId, action: 'bet' }, 200n, WIN_BET)
    await settle(bot)
    user.send({ gameId, action: 'stand' })
    await settle(bot)
    expect(user.hand(gameId).state).toMatchObject({
      phase: 'resolved',
      dealer: BOT,
      outcome: 'player_win',
      owedWei: 400n,
      paidWei: 400n,
    })
  })

  it('challenges accounts from a feed of new accounts, once each, and never itself', async () => {
    const net = new Net()
    net.balances.set(BOT, RESERVE + 100_000n)
    const feed = [USER, OTHER, BOT, USER.toUpperCase().replace('0X', '0x')]
    const bot = new BlackjackP2pBot(
      new NetAccount(net, BOT),
      new MemoryBotStore(),
      config({ newAccounts: async () => feed, randomBytes: undefined }),
    )
    await settle(bot)
    await settle(bot)
    expect(net.paidBy(BOT).map(d => d.to)).toEqual([USER, OTHER])
    const ids = net.paidBy(BOT).map(d => (d.item as HandItem).gameId)
    expect(new Set(ids).size).toBe(2)
  })

  it('does not invite an account that already challenged it', async () => {
    const { net, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    expect(net.paidBy(BOT).map(d => (d.item as HandItem).action)).toEqual(['accept'])
  })

  it('waits to challenge until it can cover a hand, then does', async () => {
    const { net, bot, user } = setup(RESERVE)
    user.send({ type: 'text', text: 'hello' })
    await settle(bot)
    expect(net.paidBy(BOT)).toEqual([])
    net.balances.set(BOT, RESERVE + 100_000n)
    user.send({ type: 'text', text: 'still here' })
    await settle(bot)
    expect(net.paidBy(BOT)).toHaveLength(1)
  })
})

describe('one stamp is one bet', () => {
  const openHands = async (bot: BlackjackP2pBot, user: User, count: number) => {
    const ids = Array.from({ length: count }, (_, i) => gid(`many-${i}`))
    for (const gameId of ids) {
      user.send({ gameId, action: 'challenge', role: 'player', maxBetWei: '500' })
      await settle(bot)
    }
    return ids
  }
  const oneMessage = (net: Net, ids: string[], stampWei: bigint) => {
    const [first, ...rest] = ids.map(gameId => ({ type: 'blackjack-hand', gameId, action: 'bet' }))
    net.deliver({ from: USER, to: BOT, item: first, extra: rest, stampWei, digest: 'multi' })
  }

  it.each([
    ['an over-max stamp', 600n],
    ['a valid stamp', 500n],
  ])('a message with several bet items and %s credits no hand and is refunded to none', async (_n, stamp) => {
    const { net, bot, user } = setup()
    const ids = await openHands(bot, user, 3)
    const before = net.paidBy(BOT).length
    oneMessage(net, ids, stamp)
    await settle(bot)
    await settle(bot)
    expect(net.paidBy(BOT)).toHaveLength(before)
    for (const gameId of ids)
      expect(bot.hand(USER, gameId)).toMatchObject({ phase: 'open', wagerWei: 0n, rejected: [] })
  })
})

describe('a hostile game id', () => {
  it.each(['__proto__', 'constructor', 'toString', 'not-hex', ''])(
    'does not stop the bot: %j is ignored and later messages are still handled',
    async gameId => {
      const { net, bot, user } = setup()
      user.send({ gameId, action: 'challenge', role: 'player', maxBetWei: '500' })
      user.send({ gameId, action: 'bet' }, 100n)
      await settle(bot)
      await settle(bot)
      user.send({ gameId: gid('after'), action: 'challenge', role: 'player', maxBetWei: '500' })
      await settle(bot)
      expect(user.hand(gid('after')).state?.phase).toBe('open')
      // Nothing was paid or recorded for the hostile id.
      expect(net.paidBy(BOT).every(d => (d.item as HandItem).gameId !== gameId)).toBe(true)
      expect(bot.hand(USER, gameId)).toBeUndefined()
    },
  )

  it('skips a message it cannot process and moves past it', async () => {
    const { net, account, bot, user } = setup()
    const real = account.receive.bind(account)
    // A message whose items blow up when read.
    account.receive = async since => {
      const messages = await real(since)
      return messages.map(m =>
        m.payloadDigest === 'poison'
          ? { ...m, items: new Proxy([], { get: () => { throw new Error('poison') } }) as never }
          : m,
      )
    }
    net.deliver({ from: USER, to: BOT, item: { type: 'text' }, stampWei: 1n, digest: 'poison' })
    user.send({ gameId: gid('after'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    expect(user.hand(gid('after')).state?.phase).toBe('open')
  })
})

describe('refunds', () => {
  it('returns a bet above the max bet, once, as a reply whose stamp equals it', async () => {
    const { net, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    user.send({ gameId: gid('g'), action: 'bet' }, 501n, 'over')
    await settle(bot)
    await settle(bot)
    const refunds = net.paidBy(BOT).filter(d => (d.item as HandItem).action === 'refund')
    expect(refunds).toMatchObject([{ stampWei: 501n, item: { ref: 'over' } }])
    expect(user.hand(gid('g')).state).toMatchObject({
      phase: 'open',
      rejected: [{ digest: 'over', stampWei: 501n, refundedWei: 501n }],
    })
  })

  it('returns a bet it can no longer cover instead of dealing', async () => {
    // Enough to accept two hands of 500 each, but not to cover both once both are bet.
    const { net, bot, user } = setup(RESERVE + 2_100n)
    const second = new User(net, OTHER)
    user.send({ gameId: gid('a'), action: 'challenge', role: 'player', maxBetWei: '500' })
    second.send({ gameId: gid('b'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    expect(user.hand(gid('a')).state?.maxBetWei).toBe(500n)
    expect(second.hand(gid('b')).state?.maxBetWei).toBe(500n)
    user.send({ gameId: gid('a'), action: 'bet' }, 500n, WIN_BET)
    second.send({ gameId: gid('b'), action: 'bet' }, 500n, 'second-bet')
    await settle(bot)
    expect(user.hand(gid('a')).state?.phase).toBe('player_turn')
    expect(second.hand(gid('b')).state).toMatchObject({ phase: 'refunded', refundedWei: 500n })
  })
})

describe('a payment is made exactly once', () => {
  it('re-sends the same bytes, not a second payment, when the relay answer is lost', async () => {
    const { net, account, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await settle(bot)
    user.send({ gameId: gid('g'), action: 'bet' }, 300n, WIN_BET)
    await settle(bot)
    user.send({ gameId: gid('g'), action: 'stand' })
    account.fault = 'lost'
    await bot.tick()
    account.fault = 'none'
    await settle(bot)
    expect(net.paidBy(BOT).filter(d => d.stampWei === 600n)).toHaveLength(1)
    expect([...net.attempts.values()].filter(a => a.message.stampWei === 600n)).toHaveLength(1)
    expect(user.hand(gid('g')).state).toMatchObject({ phase: 'resolved', paidWei: 600n })
  })

  it('sends again from scratch when a send failed before any payment existed', async () => {
    const { net, account, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    account.fault = 'unreachable'
    await bot.tick()
    expect(bot.outbox()).toMatchObject([{ phase: 'sending' }])
    expect(net.attempts.size).toBe(0)
    account.fault = 'none'
    await settle(bot)
    expect(net.attempts.size).toBe(1)
    expect(user.hand(gid('g')).state?.phase).toBe('open')
  })

  it('never pays again for a payment set the relay ended', async () => {
    const { net, account, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    account.fault = 'dead'
    await bot.tick()
    account.fault = 'none'
    await settle(bot)
    await settle(bot)
    expect(bot.outbox()).toMatchObject([{ phase: 'dead' }])
    expect(net.attempts.size).toBe(1)
    expect(net.paidBy(BOT)).toEqual([])
  })

  it('holds everything while two payment attempts are unexplained', async () => {
    const { net, account, bot, user } = setup()
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    account.fault = 'unreachable'
    await bot.tick()
    account.fault = 'none'
    for (const digest of ['stray-1', 'stray-2'])
      net.attempts.set(digest, {
        owner: BOT,
        status: 'live',
        message: { from: BOT, to: USER, item: { type: 'text' }, stampWei: 1n, digest },
        accounted: false,
      })
    expect(await bot.tick()).toBe(0)
    expect(net.paidBy(BOT)).toEqual([])
  })

  describe('across a kill at every point', () => {
    let directory: string
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), 'blackjack-p2p-bot-'))
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    /** A file store that can die right after any write reached the disk. */
    class KillableStore implements BotStore {
      private readonly file: FileBotStore
      private readonly process: number
      constructor(
        path: string,
        private readonly net: Net,
      ) {
        this.file = new FileBotStore(path)
        this.process = net.process
      }
      load(): BotState {
        return this.file.load()
      }
      save(state: BotState) {
        this.net.alive(this.process)
        this.file.save(state)
        this.net.point(this.process)
      }
    }

    /** Runs `script` with a bot that is killed at point `dieAt` (0: never) and reopened from its
     * file as often as needed. Returns the net and how many points a clean run has. */
    async function run(
      dieAt: number,
      script: (user: User, tick: () => Promise<void>, net: Net) => Promise<void>,
      balance = RESERVE + 100_000n,
    ) {
      const net = new Net()
      net.balances.set(BOT, balance)
      net.dieAt = dieAt
      const path = join(directory, `state-${dieAt}.json`)
      const open = () =>
        new BlackjackP2pBot(new NetAccount(net, BOT), new KillableStore(path, net), config())
      let bot = open()
      let running = net.process
      let kills = 0
      const tick = async () => {
        for (let i = 0; i < 40; i++) {
          let delivered = -1
          try {
            delivered = await bot.tick()
          } catch (error) {
            if (!(error instanceof Crash)) throw error
          }
          if (net.process !== running) {
            // The process is gone, wherever the kill landed and whatever it caught on the way
            // out: nothing in memory survives, only the file and the net.
            kills++
            running = net.process
            bot = open()
          } else if (delivered === 0) return
        }
        throw new Error('the bot never went quiet')
      }
      await script(new User(net, USER), tick, net)
      return { net, kills, points: net.points }
    }

    const dealerScript = async (user: User, tick: () => Promise<void>) => {
      const { state } = await userPlaysAgainstBotDealer(user, tick, 300n, WIN_BET)
      expect(state).toMatchObject({
        phase: 'resolved',
        outcome: 'player_win',
        owedWei: 600n,
        paidWei: 600n,
      })
    }
    const refundScript = async (user: User, tick: () => Promise<void>) => {
      user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
      await tick()
      user.send({ gameId: gid('g'), action: 'bet' }, 777n, 'over')
      await tick()
      await tick()
      expect(user.hand(gid('g')).state?.rejected).toEqual([
        { digest: 'over', stampWei: 777n, refundedWei: 777n },
      ])
    }
    const playerScript = async (user: User, tick: () => Promise<void>) => {
      const seed = 'c4'.repeat(32)
      user.send({
        gameId: gid('g'),
        action: 'challenge',
        role: 'dealer',
        maxBetWei: '2000',
        commitment: commitmentOf(seed),
      })
      for (let i = 0; i < 20; i++) {
        await tick()
        const step = dealerStep(user.hand(gid('g')).state, seed)
        if (!step) break
        user.send(step.item, step.payWei ?? STAMP)
      }
      expect(user.hand(gid('g')).state?.phase).toBe('resolved')
    }

    it.each([
      ['a payout', dealerScript, 600n, ['accept', 'deal', 'reveal']],
      ['a refund', refundScript, 777n, ['accept', 'refund']],
      ['its own bet', playerScript, 500n, undefined],
    ] as const)('pays %s once', async (_name, script, money, actions) => {
      const clean = await run(0, script)
      expect(clean.kills).toBe(0)
      const expected = clean.net.paidBy(BOT).map(d => (d.item as HandItem).action)
      if (actions) expect(expected).toEqual(actions)
      expect(clean.points).toBeGreaterThan(10)
      for (let dieAt = 1; dieAt <= clean.points; dieAt++) {
        const { net, kills } = await run(dieAt, script)
        expect(kills).toBe(1)
        const sent = net.paidBy(BOT)
        // The same messages as a run that was never killed: nothing twice, nothing missing.
        expect(sent.map(d => (d.item as HandItem).action)).toEqual(expected)
        // The money left the account exactly once, as one payment set.
        expect(sent.filter(d => d.stampWei === money)).toHaveLength(1)
        const paid = [...net.attempts.values()].filter(a => a.status !== 'dead')
        expect(paid.filter(a => a.message.stampWei === money)).toHaveLength(1)
        // Every payment set the wallet made was delivered: none is stranded or duplicated.
        expect(paid.every(a => a.status === 'delivered')).toBe(true)
        expect(paid).toHaveLength(sent.length)
        // The user's fold rejects nothing the clean run did not: the bot sent no stray message.
        const gameId = (sent[0].item as HandItem).gameId
        expect(new User(net, USER).hand(gameId).rejected).toEqual(
          new User(clean.net, USER).hand(gameId).rejected,
        )
      }
    })

    it('keeps its state across a reopen with no kill at all', async () => {
      const net = new Net()
      net.balances.set(BOT, RESERVE + 100_000n)
      const path = join(directory, 'reopen.json')
      const user = new User(net, USER)
      const open = () =>
        new BlackjackP2pBot(new NetAccount(net, BOT), new FileBotStore(path), config())
      await userPlaysAgainstBotDealer(user, () => settle(open()), 300n, WIN_BET)
      expect(user.hand(gid('g-user')).state).toMatchObject({ phase: 'resolved', paidWei: 600n })
      const reopened = open()
      await settle(reopened)
      expect(net.paidBy(BOT)).toHaveLength(3)
      expect(reopened.hand(USER, gid('g-user'))?.phase).toBe('resolved')
    })
  })
})

describe('the run loop', () => {
  it('keeps ticking through a failing round until it is told to stop', async () => {
    const { net, account, bot, user } = setup()
    const stop = new AbortController()
    const lines: string[] = []
    let rounds = 0
    const real = account.receive.bind(account)
    account.receive = async since => {
      if (++rounds === 1) throw new Error('relay down')
      return real(since)
    }
    user.send({ gameId: gid('g'), action: 'challenge', role: 'player', maxBetWei: '500' })
    await runBlackjackP2pBot({
      bot,
      intervalMs: 5,
      signal: stop.signal,
      log: line => lines.push(line),
      sleep: async () => {
        if (rounds >= 3) stop.abort()
      },
    })
    expect(lines).toEqual(['round failed: relay down'])
    expect(net.paidBy(BOT).map(d => (d.item as HandItem).action)).toEqual(['accept'])
  })
})
