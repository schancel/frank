/**
 * Two real typed wallets play complete blackjack hands against each other through the canonical
 * direct-message path: real typed custody, real Level journals, real directory admission, real
 * sealing/opening and real stamp funding. As in `monad-chain-canonical-dm.jest.test.ts` (whose
 * offline fixture this copies), the chain RPC and the relay's HTTP surface are offline stand-ins.
 *
 * Every wager, payout and refund here is the stamp of the message that carries the move.
 */
import {
  START_BALANCE,
  STAMP,
  mockBalances,
  table,
  type Seat,
} from './canonical-two-wallets.testutil'
import { handValue } from '../message-item-plugins/blackjack/deck'
import {
  buildAccept,
  buildBet,
  buildChallenge,
  checkWager,
  dealerStep,
  handView,
  maxDealerBetWei,
  playerMoves,
  playerStep,
  refundBetStep,
  seedFromBytes,
  totalStakeWei,
  type HandItem,
  type HandRole,
  type HandState,
} from '../message-item-plugins/blackjack/hand'

/** What a wallet keeps back for the fees of its own messages. */
const RESERVE = 10n ** 16n

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

// Cards: the scripted hands below fix the cards so that each outcome is certain. Everything else
// is real, including both sides' commitments and the check of every opened link. With no script
// the real derivation runs (see the unscripted hand); `hand.jest.test.ts` and
// `entropy.jest.test.ts` cover the derivation itself.
let mockScriptedDeck: number[] | undefined
jest.mock('../message-item-plugins/blackjack/entropy', () => {
  const actual = jest.requireActual('../message-item-plugins/blackjack/entropy')
  return {
    ...actual,
    drawCard: (...args: [string, number, string, string, number[]]) =>
      mockScriptedDeck ? mockScriptedDeck[args[1]] : actual.drawCard(...args),
  }
})
/** The cards in the order they are drawn: player, dealer up, player, the player's further cards,
 * then the dealer's hole card and draws. Rank is `card % 13`: 0 ace, 9..12 tens. */
function deckStarting(...first: number[]): number[] {
  return [...first, ...Array.from({ length: 52 }, (_, i) => i).filter(c => !first.includes(c))]
}
/** The player's bet, with a fresh seed of its own kept before its commitment leaves. */
async function bet(player: Seat, gameId: string, wagerWei: bigint): Promise<void> {
  const seed = player.seeds.get(gameId) ?? freshSeed()
  player.seeds.set(gameId, seed)
  const state = player.hand(gameId)
  const item =
    buildBet(state, seed) ??
    // Not the hand's turn for a bet: sent anyway, as a careless client might.
    ({ ...rawNext(player, gameId), action: 'bet', commitment: 'c'.repeat(64) } as HandItem)
  await player.send(item, wagerWei)
}
/** The chain fields of the hand's next message, for items built by hand. */
function rawNext(seat: Seat, gameId: string) {
  const state = seat.hand(gameId)
  return {
    type: 'blackjack-hand' as const,
    gameId,
    seq: state?.count ?? 1,
    prev: state?.head ?? '0'.repeat(64),
  }
}

type Move = 'hit' | 'stand' | 'double'
let games = 0
let seedCounter = 0
const freshSeed = () =>
  seedFromBytes(new Uint8Array(32).fill(0).map((_, i) => (i === 0 ? ++seedCounter : i * 7) & 255))

/** Opens a hand: challenge (and accept, when the challenger plays). */
async function challenge(
  challenger: Seat,
  role: HandRole,
  maxBetWei: bigint,
): Promise<{ gameId: string; dealer: Seat; player: Seat }> {
  const gameId = (++games).toString(16).padStart(32, '0')
  const challenged = challenger.peer
  const dealer = role === 'dealer' ? challenger : challenged
  const player = role === 'dealer' ? challenged : challenger
  const seed = freshSeed()
  dealer.seeds.set(gameId, seed)
  const built = buildChallenge({
    gameId,
    role,
    maxBetWei,
    spendableWei: await challenger.balance(),
    reserveWei: RESERVE,
    seed: role === 'dealer' ? seed : undefined,
  })
  if ('error' in built) throw new Error(built.error)
  await challenger.send(built.item)
  await challenged.poll()
  if (role === 'player') {
    const accept = buildAccept({
      state: dealer.hand(gameId)!,
      spendableWei: await dealer.balance(),
      reserveWei: RESERVE,
      seed,
    })
    if ('error' in accept) throw new Error(accept.error)
    await dealer.send(accept.item)
    await player.poll()
  }
  return { gameId, dealer, player }
}

/** The dealer sends everything it must; returns how many messages that was. */
async function dealerActs(dealer: Seat, gameId: string): Promise<number> {
  let sent = 0
  for (;;) {
    const step = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)
    if (!step) return sent
    await dealer.send(step.item, step.payWei ?? STAMP)
    await dealer.peer.poll()
    sent++
  }
}

/** Plays one hand to the end with the player's strategy; both sides must agree on the result. */
async function playHand(
  challenger: Seat,
  role: HandRole,
  wagerWei: bigint,
  strategy: (state: HandState) => Move,
): Promise<HandState> {
  const { gameId, dealer, player } = await challenge(challenger, role, wagerWei)
  expect(
    checkWager(player.hand(gameId)!, wagerWei, await player.balance(), RESERVE),
  ).toBeUndefined()
  await bet(player, gameId, wagerWei)
  await dealer.poll()
  for (;;) {
    await dealerActs(dealer, gameId)
    const state = player.hand(gameId)!
    const seed = player.seeds.get(gameId)!
    const moves = playerMoves(state, seed)
    if (moves.length === 0) break
    // Right after the deal only the player can see its cards.
    const move = strategy({ ...state, ...handView(state, seed) })
    await player.send(
      playerStep(state, move, seed)!,
      move === 'double' ? state.wagerWei : STAMP,
    )
    await dealer.poll()
  }
  const final = player.hand(gameId)!
  expect(dealer.hand(gameId)).toEqual(final)
  return final
}

describe('two typed wallets play blackjack through stamped messages', () => {
  jest.setTimeout(600_000)
  let f: Awaited<ReturnType<typeof table>>['f']
  let alice: Seat
  let bob: Seat
  beforeEach(async () => {
    ;({ f, alice, bob } = await table())
  })
  afterEach(() => f.close())


  const WAGER = 40_000n
  // Draw order: player, dealer (up), player, the player's further cards, dealer (hole), draws.
  const scripts: {
    name: string
    deck: number[]
    moves: Move[]
    outcome: string
    owed: bigint
  }[] = [
    { name: 'win', deck: deckStarting(9, 35, 22, 6), moves: ['stand'], outcome: 'player_win', owed: WAGER * 2n },
    { name: 'loss', deck: deckStarting(9, 35, 6, 22), moves: ['stand'], outcome: 'dealer_win', owed: 0n },
    { name: 'push', deck: deckStarting(9, 22, 7, 20), moves: ['stand'], outcome: 'push', owed: WAGER },
    { name: 'blackjack', deck: deckStarting(0, 35, 12, 6), moves: ['stand'], outcome: 'player_blackjack', owed: (WAGER * 5n) / 2n },
    { name: 'double', deck: deckStarting(4, 9, 5, 22, 19), moves: ['double'], outcome: 'player_win', owed: WAGER * 4n },
    { name: 'bust', deck: deckStarting(9, 22, 5, 35, 19), moves: ['hit'], outcome: 'dealer_win', owed: 0n },
  ]

  describe.each(['dealer', 'player'] as const)('the challenger is the %s', role => {
    it.each(scripts)('$name: the dealer pays exactly what is owed', async script => {
      mockScriptedDeck = script.deck
      const moves = [...script.moves]
      const final = await playHand(alice, role, WAGER, () => moves.shift()!)
      const dealer = role === 'dealer' ? alice : bob
      const player = dealer.peer
      expect(moves).toEqual([])
      expect(final).toMatchObject({
        phase: 'resolved',
        outcome: script.outcome,
        dealer: dealer.address,
        player: player.address,
        wagerWei: WAGER,
        doubled: script.name === 'double',
        owedWei: script.owed,
      })
      expect(handValue(final.playerCards).bust).toBe(script.name === 'bust')
      // The money the player put in is the bet's stamp (and the double's), as the dealer's own
      // wallet verified it on receipt.
      expect(dealer.received.get(final.betDigest!)).toBe(WAGER)
      expect([...dealer.received.values()].filter(v => v === WAGER)).toHaveLength(
        script.name === 'double' ? 2 : 1,
      )
      expect(totalStakeWei(final)).toBe(script.name === 'double' ? WAGER * 2n : WAGER)
      // The payout is the stamp of the dealer's last message, as the player's wallet verified it.
      const reveal = player.events[player.events.length - 1]
      expect(reveal.item.action).toBe('reveal')
      expect(player.received.get(reveal.digest)).toBe(script.owed > 0n ? script.owed : STAMP)
      expect(final.paidWei).toBe(script.owed > 0n ? script.owed : STAMP)
      expect(dealer.paid[dealer.paid.length - 1]).toBe(script.owed > 0n ? script.owed : STAMP)
      // Nothing else the dealer sent carried more than an ordinary stamp.
      expect(dealer.paid.slice(0, -1).every(v => v === STAMP)).toBe(true)
      // Spendable balances only went down, by at least what each paid: what a wallet receives
      // as stamps is not spendable. (A stamp is paid straight from the main account, and the
      // offline chain charges no gas, so nothing more than the stamps themselves left it.)
      expect(await player.balance()).toBeLessThanOrEqual(
        START_BALANCE - totalStakeWei(final),
      )
      expect(await dealer.balance()).toBeLessThanOrEqual(START_BALANCE - script.owed)
    })
  })

  it('plays an unscripted hand with the real deck derivation, verified on reveal', async () => {
    mockScriptedDeck = undefined
    const final = await playHand(bob, 'dealer', WAGER, state =>
      handValue(state.playerCards).total < 17 && !handValue(state.playerCards).blackjack
        ? 'hit'
        : 'stand',
    )
    expect(final.phase).toBe('resolved')
    expect(final.paidWei).toBe(final.owedWei! > 0n ? final.owedWei : STAMP)
  })

  it('refunds a bet above the max bet with a reply whose stamp equals it, then plays on', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const { gameId, dealer, player } = await challenge(alice, 'dealer', WAGER)
    await bet(player, gameId, WAGER + 1n)
    await dealer.poll()
    expect(dealer.hand(gameId)).toMatchObject({ phase: 'open', wagerWei: 0n })
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(dealer.paid[dealer.paid.length - 1]).toBe(WAGER + 1n)
    const refund = player.events[player.events.length - 1]
    expect(refund.item.action).toBe('refund')
    expect(player.received.get(refund.digest)).toBe(WAGER + 1n)
    expect(player.hand(gameId)).toEqual(dealer.hand(gameId))
    expect(player.hand(gameId)?.rejected).toMatchObject([
      { stampWei: WAGER + 1n, refundedWei: WAGER + 1n },
    ])
    // Nothing more is owed; the hand is still open for a proper bet.
    expect(await dealerActs(dealer, gameId)).toBe(0)
    await bet(player, gameId, WAGER)
    await dealer.poll()
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(dealer.hand(gameId)?.phase).toBe('player_turn')
  })

  it('moves no money for a replayed, an out-of-turn or a tampered message', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const { gameId, dealer, player } = await challenge(alice, 'dealer', WAGER)
    // Out of turn: the player stands before betting. The dealer has nothing to send.
    await player.send({ ...rawNext(player, gameId), action: 'stand', link: 'a'.repeat(64) })
    await dealer.poll()
    expect(dealer.hand(gameId)?.phase).toBe('open')
    expect(await dealerActs(dealer, gameId)).toBe(0)

    await bet(player, gameId, WAGER)
    await dealer.poll()
    expect(await dealerActs(dealer, gameId)).toBe(1)
    const afterDeal = dealer.hand(gameId)
    const dealerPaid = dealer.paid.length

    // Replay: the relay delivers the bet a second time. One wager, one hand, no refund.
    // (The whole mailbox, in fact: every earlier message arrives again.)
    dealer.since = 0
    await dealer.poll()
    expect(dealer.hand(gameId)).toEqual(afterDeal)
    expect(await dealerActs(dealer, gameId)).toBe(0)

    // Out of turn: the dealer's own move types sent by the player change nothing.
    await player.send({ ...rawNext(player, gameId), action: 'card', link: 'a'.repeat(64) })
    await player.send({ ...rawNext(player, gameId), action: 'reveal', link: 'a'.repeat(64) })
    await dealer.poll()
    expect(dealer.hand(gameId)).toEqual(afterDeal)
    expect(await dealerActs(dealer, gameId)).toBe(0)
    expect(dealer.paid).toHaveLength(dealerPaid)

    // Tampered: the dealer opens a link of another chain, which would give other cards. The
    // player's hand does not settle on it.
    await player.send(playerStep(player.hand(gameId), 'stand', player.seeds.get(gameId)!)!)
    await dealer.poll()
    const honest = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)!
    expect(honest.payWei).toBe(WAGER * 2n)
    const playerBefore = player.hand(gameId)
    await dealer.send({ ...honest.item, link: 'f'.repeat(64) } as HandItem)
    await player.poll()
    expect(player.hand(gameId)).toEqual(playerBefore)
    expect(player.hand(gameId)?.phase).toBe('dealer_turn')
    // The honest reveal still settles it, once.
    expect(await dealerActs(dealer, gameId)).toBe(1)
    expect(player.hand(gameId)).toMatchObject({
      phase: 'resolved',
      owedWei: WAGER * 2n,
      paidWei: WAGER * 2n,
    })
    expect(await dealerActs(dealer, gameId)).toBe(0)
  })

  it('limits the max bet by what each side can actually spend', async () => {
    mockScriptedDeck = deckStarting(9, 35, 22, 6)
    const spend = async (seat: Seat, balance: bigint) =>
      mockBalances.set((await seat.wallet.getReceiveAddress()).raw.toLowerCase(), balance)
    // A dealer with 4 units above the reserve may offer at most 1 unit.
    await spend(alice, RESERVE + 400_000n)
    const asDealer = (maxBetWei: bigint, spendableWei: bigint) =>
      buildChallenge({
        gameId: 'ab'.repeat(16),
        role: 'dealer',
        maxBetWei,
        spendableWei,
        reserveWei: RESERVE,
        seed: freshSeed(),
      })
    expect(await alice.balance()).toBe(RESERVE + 400_000n)
    expect(asDealer(100_001n, await alice.balance())).toEqual({ error: 'above-own-limit' })
    expect('item' in asDealer(100_000n, await alice.balance())).toBe(true)
    // A challenging player may name at most what it can send.
    const asPlayer = (maxBetWei: bigint, spendableWei: bigint) =>
      buildChallenge({ gameId: 'ab'.repeat(16), role: 'player', maxBetWei, spendableWei, reserveWei: RESERVE })
    expect(asPlayer(400_001n, await alice.balance())).toEqual({ error: 'above-own-limit' })
    expect('item' in asPlayer(400_000n, await alice.balance())).toBe(true)

    // Alice challenges as player for 400000; Bob can only cover 50000 and accepts at that.
    await spend(bob, RESERVE + 1_200_000n)
    const bobCap = maxDealerBetWei(await bob.balance(), RESERVE)
    expect(bobCap).toBe(300_000n)
    const { gameId, dealer, player } = await challenge(alice, 'player', 400_000n)
    const accepted = dealer.hand(gameId)!
    expect(accepted.phase).toBe('open')
    expect(accepted.maxBetWei).toBe(bobCap)
    expect(player.hand(gameId)).toEqual(accepted)
    // The player's own check refuses more than the dealer's figure...
    expect(
      checkWager(accepted, accepted.maxBetWei + 1n, await player.balance(), RESERVE),
    ).toBe('above-max-bet')
    // ...and a player that sends it anyway is refunded, not dealt.
    await bet(player, gameId, accepted.maxBetWei + 1n)
    await dealer.poll()
    expect(dealer.hand(gameId)?.phase).toBe('open')
    const step = dealerStep(dealer.hand(gameId), dealer.seeds.get(gameId)!)!
    expect(step).toMatchObject({ item: { action: 'refund' }, payWei: accepted.maxBetWei + 1n })
  })

  it('lets the dealer return the bet instead of dealing', async () => {
    const { gameId, dealer, player } = await challenge(bob, 'player', WAGER)
    await bet(player, gameId, WAGER)
    await dealer.poll()
    const step = refundBetStep(dealer.hand(gameId))!
    await dealer.send(step.item, step.payWei)
    await player.poll()
    expect(player.hand(gameId)).toMatchObject({ phase: 'refunded', refundedWei: WAGER })
    expect(player.hand(gameId)).toEqual(dealer.hand(gameId))
    expect(await dealerActs(dealer, gameId)).toBe(0)
  })
})
