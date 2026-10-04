import { handValue } from './deck'
import { CHAIN_LENGTH, drawCard, entropyChain } from './entropy'
import { playOutDealer, type BlackjackOutcome } from './game'
import {
  applyHandEvent,
  awaitedRole,
  buildAccept,
  buildBet,
  buildChallenge,
  challengeLimitWei,
  checkWager,
  commitmentOf,
  dealerStep,
  DEALER_COVER_MULTIPLE,
  foldHand,
  handEventsOf,
  handPreviewText,
  handView,
  maxDealerBetWei,
  maxPlayerBetWei,
  payoutWei,
  playerMoves,
  playerStep,
  refundBetStep,
  refundShortfallWei,
  roleOf,
  seedFromBytes,
  soleHandItem,
  totalStakeWei,
  type HandAction,
  type HandEvent,
  type HandItem,
  type HandPhase,
  type HandState,
} from './hand'

const ALICE = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
const BOB = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
const EVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const GAME = '0123456789abcdef0123456789abcdef'
const STAMP = 10n
const WAGER = 1_000n
type Move = 'hit' | 'stand' | 'double'

let counter = 0
const digest = () => (++counter).toString(16).padStart(64, '0')
const seedOf = (n: number) => n.toString(16).padStart(64, '0')
const DEALER_SEED = seedOf(0xd)

/** A table: who deals, both seeds, and the running state, driven only through events. */
class Table {
  state: HandState | undefined
  log: HandEvent[] = []
  constructor(
    readonly dealer: string,
    readonly player: string,
    readonly dealerSeed: string,
    readonly playerSeed: string,
  ) {}
  /** The fields of the hand's next message. */
  next(fields: Record<string, unknown>): HandItem {
    return {
      type: 'blackjack-hand',
      gameId: GAME,
      seq: this.state?.count ?? 0,
      ...(this.state ? { prev: this.state.head } : {}),
      ...fields,
    } as HandItem
  }
  send(from: string, item: HandItem, stampWei = STAMP, d = digest()) {
    const event: HandEvent = {
      item,
      from,
      to: from === this.dealer ? this.player : this.dealer,
      stampWei,
      digest: d,
    }
    const result = applyHandEvent(this.state, event)
    this.state = result.state
    this.log.push(event)
    return { ...result, event }
  }
  /** Sends whatever the dealer must send next; returns it. */
  dealerActs() {
    const step = dealerStep(this.state, this.dealerSeed)
    if (!step) throw new Error(`dealer has no step in ${this.state?.phase}`)
    const result = this.send(this.dealer, step.item, step.payWei ?? STAMP)
    expect(result.error).toBeUndefined()
    return step
  }
  playerActs(move: Move) {
    const item = playerStep(this.state, move, this.playerSeed)
    if (!item) throw new Error(`player may not ${move} in ${this.state?.phase}`)
    const result = this.send(
      this.player,
      item,
      move === 'double' ? this.state?.wagerWei : STAMP,
    )
    expect(result.error).toBeUndefined()
    return item
  }
  bet(wager = WAGER) {
    const item = buildBet(this.state, this.playerSeed)
    if (!item) throw new Error('no bet')
    return this.send(this.player, item, wager)
  }
}

/** Opens a hand up to the accepted bet. */
function open(
  challenger: 'dealer' | 'player',
  playerSeed: string,
  dealerSeed = DEALER_SEED,
  wager = WAGER,
  maxBet = WAGER,
): Table {
  const table =
    challenger === 'dealer'
      ? new Table(ALICE, BOB, dealerSeed, playerSeed)
      : new Table(BOB, ALICE, dealerSeed, playerSeed)
  if (challenger === 'dealer') {
    table.send(
      ALICE,
      table.next({
        action: 'challenge',
        role: 'dealer',
        maxBetWei: maxBet.toString(),
        commitment: commitmentOf(dealerSeed),
      }),
    )
  } else {
    table.send(
      ALICE,
      table.next({
        action: 'challenge',
        role: 'player',
        maxBetWei: (maxBet * 2n).toString(),
      }),
    )
    expect(table.state?.phase).toBe('challenged')
    table.send(
      BOB,
      table.next({
        action: 'accept',
        maxBetWei: maxBet.toString(),
        commitment: commitmentOf(dealerSeed),
      }),
    )
  }
  expect(table.state?.phase).toBe('open')
  expect(table.bet(wager).error).toBeUndefined()
  return table
}

/** The cards of a hand computed without the state machine: straight from both chains, with the
 * shared dealer rule. `hits` is how many cards the player takes after the first two. */
function expected(dealerSeed: string, playerSeed: string, hits: number) {
  const d = entropyChain(dealerSeed)
  const p = entropyChain(playerSeed)
  const draws: number[] = []
  for (let k = 0; k < CHAIN_LENGTH; k++)
    draws.push(drawCard(GAME, k, d[k + 1], p[k + 1], draws))
  const playerCards = [draws[0], draws[2], ...draws.slice(3, 3 + hits)]
  if (handValue(playerCards).bust)
    return { playerCards, upCard: draws[1], dealerCards: [draws[1]], outcome: 'dealer_win' }
  const [hole, ...more] = draws.slice(3 + hits)
  const deck = [draws[0], draws[1], draws[2], hole, ...draws.slice(3, 3 + hits), ...more]
  const played = playOutDealer(deck, playerCards, 4 + hits)
  return {
    playerCards,
    upCard: draws[1],
    dealerCards: played.dealerCards,
    outcome: played.outcome,
  }
}

/** Finds a player seed (against the fixed dealer seed) whose hand satisfies `want`. */
function findSeed(
  hits: number,
  want: (hand: ReturnType<typeof expected>) => boolean,
): string {
  for (let n = 1; n < 5000; n++) {
    const seed = seedOf(n)
    if (want(expected(DEALER_SEED, seed, hits))) return seed
  }
  throw new Error('no seed found')
}
const natural = (cards: number[]) => handValue(cards.slice(0, 2)).blackjack
const bust = (cards: number[]) => handValue(cards).bust

const seeds: Record<string, string> = {
  win: findSeed(0, h => !natural(h.playerCards) && h.outcome === 'player_win'),
  loss: findSeed(0, h => !natural(h.playerCards) && h.outcome === 'dealer_win'),
  push: findSeed(0, h => !natural(h.playerCards) && h.outcome === 'push'),
  blackjack: findSeed(0, h => h.outcome === 'player_blackjack'),
  bust: findSeed(1, h => !natural(h.playerCards) && bust(h.playerCards)),
  doubleWin: findSeed(
    1,
    h => !natural(h.playerCards) && !bust(h.playerCards) && h.outcome === 'player_win',
  ),
  doubleLoss: findSeed(
    1,
    h => !natural(h.playerCards) && !bust(h.playerCards) && h.outcome === 'dealer_win',
  ),
  twoHits: findSeed(2, h => !natural(h.playerCards) && !bust(h.playerCards)),
}

describe.each(['dealer', 'player'] as const)(
  'a complete hand when the challenger is the %s',
  challenger => {
    const play = (
      name: string,
      moves: Move[],
      outcome: BlackjackOutcome,
      owed: bigint,
    ) =>
      it(`${name}: pays ${owed}`, () => {
        const table = open(challenger, seeds[name])
        expect(table.state?.phase).toBe('awaiting_deal')
        expect(table.dealerActs().item.action).toBe('deal')
        for (const move of moves) {
          expect(playerMoves(table.state, table.playerSeed)).toContain(move)
          table.playerActs(move)
          if (move !== 'stand') expect(table.dealerActs().item.action).toBe('card')
        }
        expect(table.state?.phase).toBe('dealer_turn')
        const step = table.dealerActs()
        expect(step.item.action).toBe('reveal')
        expect(step.payWei).toBe(owed > 0n ? owed : undefined)
        const hits = moves.filter(move => move !== 'stand').length
        const cards = expected(table.dealerSeed, table.playerSeed, hits)
        expect(cards.outcome).toBe(outcome)
        expect(table.state).toMatchObject({
          phase: 'resolved',
          outcome,
          playerCards: cards.playerCards,
          dealerUpCard: cards.upCard,
          dealerCards: cards.dealerCards,
          owedWei: owed,
          paidWei: owed > 0n ? owed : STAMP,
          dealer: challenger === 'dealer' ? ALICE : BOB,
          player: challenger === 'dealer' ? BOB : ALICE,
        })
        expect(playerMoves(table.state, table.playerSeed)).toEqual([])
        expect(dealerStep(table.state, table.dealerSeed)).toBeUndefined()
        expect(awaitedRole(table.state)).toBeUndefined()
        // Both sides fold the same log to the same state.
        expect(foldHand(table.log).state).toEqual(table.state)
      })

    play('win', ['stand'], 'player_win', WAGER * 2n)
    play('loss', ['stand'], 'dealer_win', 0n)
    play('push', ['stand'], 'push', WAGER)
    play('blackjack', ['stand'], 'player_blackjack', (WAGER * 5n) / 2n)
    play('bust', ['hit'], 'dealer_win', 0n)
    play('doubleWin', ['double'], 'player_win', WAGER * 4n)
    play('doubleLoss', ['double'], 'dealer_win', 0n)
    play('twoHits', ['hit', 'hit', 'stand'], expected(DEALER_SEED, seeds.twoHits, 2).outcome as BlackjackOutcome, payoutWei(expected(DEALER_SEED, seeds.twoHits, 2).outcome as BlackjackOutcome, WAGER, false))

    it('offers double only on the first two cards', () => {
      const table = open(challenger, seeds.twoHits)
      table.dealerActs()
      expect(playerMoves(table.state, table.playerSeed)).toEqual(['hit', 'stand', 'double'])
      table.playerActs('hit')
      table.dealerActs()
      expect(playerMoves(table.state, table.playerSeed)).toEqual(['hit', 'stand'])
      const late = table.next({
        action: 'double',
        link: entropyChain(table.playerSeed)[CHAIN_LENGTH],
      })
      const result = table.send(table.player, late, WAGER)
      expect(result.error).toBe('wrong-phase')
      // The money of the refused double is owed back.
      expect(table.state?.rejected).toHaveLength(1)
    })

    it('lets a natural only stand', () => {
      const table = open(challenger, seeds.blackjack)
      table.dealerActs()
      expect(playerMoves(table.state, table.playerSeed)).toEqual(['stand'])
      const chain = entropyChain(table.playerSeed)
      expect(
        table.send(table.player, table.next({ action: 'hit', link: chain[4] })).error,
      ).toBe('wrong-phase')
      expect(table.state?.phase).toBe('player_turn')
    })
  },
)

describe('no card exists before both sides opened its links', () => {
  it('shows the first cards to the player after the deal and to the dealer after the first move', () => {
    const table = open('dealer', seeds.twoHits)
    // Before the deal nobody can know a card: the dealer has opened nothing.
    expect(handView(table.state, table.playerSeed).playerCards).toEqual([])
    table.dealerActs()
    expect(table.state).toMatchObject({ phase: 'player_turn', draws: [], playerCards: [] })
    expect(table.state?.dealerUpCard).toBeUndefined()
    // The dealer holds only its own chain: no card yet, whatever it does with its seed.
    expect(handView(table.state, table.dealerSeed)).toEqual({
      playerCards: [],
      dealerUpCard: undefined,
      dealerCards: [],
    })
    expect(handView(table.state)).toMatchObject({ playerCards: [] })
    // The player holds both sides' links for the first three cards.
    const cards = expected(table.dealerSeed, table.playerSeed, 0)
    expect(handView(table.state, table.playerSeed)).toEqual({
      playerCards: cards.playerCards,
      dealerUpCard: cards.upCard,
      dealerCards: [],
    })
    table.playerActs('hit')
    // The first move opens them to both; the card asked for is not known to the state yet.
    expect(table.state).toMatchObject({
      phase: 'awaiting_card',
      playerCards: cards.playerCards,
      dealerUpCard: cards.upCard,
    })
    expect(table.state?.draws).toHaveLength(3)
    table.dealerActs()
    expect(table.state?.draws).toHaveLength(4)
    expect(table.state?.dealerCards).toEqual([])
  })

  it('never puts a card, a seed or an outcome into a message', () => {
    const table = open('dealer', seeds.twoHits)
    table.dealerActs()
    table.playerActs('hit')
    table.dealerActs()
    table.playerActs('stand')
    table.dealerActs()
    for (const { item } of table.log) {
      const allowed = ['type', 'gameId', 'action', 'seq', 'prev', 'role', 'maxBetWei', 'commitment', 'link', 'ref']
      expect(Object.keys(item).filter(key => !allowed.includes(key))).toEqual([])
    }
    // A link once opened is one of the chain, never the seed itself.
    const text = JSON.stringify(table.log.map(e => e.item))
    expect(text).not.toContain(table.dealerSeed)
    expect(text).not.toContain(table.playerSeed)
  })

  it('leaves the dealer hole card undrawn until the reveal, and undrawn for ever after a bust', () => {
    const table = open('dealer', seeds.bust)
    table.dealerActs()
    table.playerActs('hit')
    table.dealerActs()
    expect(table.state?.phase).toBe('dealer_turn')
    table.dealerActs()
    expect(table.state).toMatchObject({ phase: 'resolved', outcome: 'dealer_win' })
    expect(table.state?.dealerCards).toEqual([table.state?.dealerUpCard])
  })
})

describe('neither side can choose or predict a card when it commits', () => {
  const firstCards = (dealerSeed: string, playerSeed: string) => {
    const table = open('dealer', playerSeed, dealerSeed)
    table.dealerActs()
    return handView(table.state, playerSeed).playerCards
  }

  it('a dealer that fixes its seed gets cards that depend on the player seed', () => {
    const seen = new Set<number>()
    for (let n = 1; n <= 200; n++) seen.add(firstCards(DEALER_SEED, seedOf(n))[0])
    expect(seen.size).toBeGreaterThan(45)
  })

  it('a player that fixes its seed gets cards that depend on the dealer seed', () => {
    const seen = new Set<number>()
    for (let n = 1; n <= 200; n++) seen.add(firstCards(seedOf(n), seeds.win)[0])
    expect(seen.size).toBeGreaterThan(45)
  })

  it('the dealer commits before the bet exists and the player before the deal', () => {
    const table = open('player', seeds.win)
    const [challenge, accept, bet] = table.log.map(e => e.item)
    expect(challenge).not.toHaveProperty('commitment')
    expect(accept).toMatchObject({ action: 'accept', commitment: commitmentOf(table.dealerSeed) })
    expect(bet).toMatchObject({ action: 'bet', commitment: commitmentOf(table.playerSeed) })
    expect(table.state).toMatchObject({
      dealerLink: { index: 0, link: commitmentOf(table.dealerSeed) },
      playerLink: { index: 0, link: commitmentOf(table.playerSeed) },
    })
  })

  it('a bet without a well-formed commitment is not a bet, and its money is owed back', () => {
    const table = new Table(ALICE, BOB, DEALER_SEED, seeds.win)
    table.send(
      ALICE,
      table.next({ action: 'challenge', role: 'dealer', maxBetWei: '1000', commitment: commitmentOf(DEALER_SEED) }),
    )
    const result = table.send(BOB, table.next({ action: 'bet', commitment: 'xyz' }), WAGER)
    expect(result.error).toBe('bad-commitment')
    expect(table.state).toMatchObject({
      phase: 'open',
      rejected: [{ digest: result.event.digest, stampWei: WAGER }],
    })
  })

  it('the dealer cannot open another chain than the one it committed to', () => {
    const table = open('dealer', seeds.twoHits)
    const before = table.state
    const other = entropyChain(seedOf(0xbad))
    const own = entropyChain(table.dealerSeed)
    for (const link of [other[3], own[2], own[4], own[CHAIN_LENGTH], own[0], 'f'.repeat(64)]) {
      expect(table.send(table.dealer, table.next({ action: 'deal', link })).error).toBe('bad-link')
      expect(table.state).toBe(before)
    }
    table.dealerActs()
    table.playerActs('hit')
    for (const link of [other[4], own[3], own[5]])
      expect(table.send(table.dealer, table.next({ action: 'card', link })).error).toBe('bad-link')
    table.dealerActs()
    table.playerActs('stand')
    for (const link of [other[CHAIN_LENGTH], own[5], own[CHAIN_LENGTH - 1]])
      expect(table.send(table.dealer, table.next({ action: 'reveal', link }), 5_000n).error).toBe(
        'bad-link',
      )
    expect(table.state?.phase).toBe('dealer_turn')
  })

  it('the player cannot open another chain than the one it committed to', () => {
    const table = open('dealer', seeds.twoHits)
    table.dealerActs()
    const other = entropyChain(seedOf(0xbad))
    const own = entropyChain(table.playerSeed)
    const before = table.state
    // A hit opens exactly the link of the card it asks for; a stand or double the last link.
    for (const link of [other[4], own[3], own[5], own[CHAIN_LENGTH]])
      expect(table.send(table.player, table.next({ action: 'hit', link })).error).toBe('bad-link')
    for (const link of [other[CHAIN_LENGTH], own[4], own[CHAIN_LENGTH - 1]])
      expect(table.send(table.player, table.next({ action: 'stand', link })).error).toBe('bad-link')
    expect(table.state).toBe(before)
    // A double with a wrong link is refused and its money owed back.
    const wrong = table.send(table.player, table.next({ action: 'double', link: own[4] }), WAGER)
    expect(wrong.error).toBe('bad-link')
    expect(table.state?.rejected).toEqual([{ digest: wrong.event.digest, stampWei: WAGER }])
    expect(table.state?.phase).toBe('player_turn')
  })

  it('a party that opens a link cannot swap the card afterwards', () => {
    // The same position opened twice is refused: the second link is not "after" the first.
    const table = open('dealer', seeds.twoHits)
    table.dealerActs()
    table.playerActs('hit')
    table.dealerActs()
    const own = entropyChain(table.dealerSeed)
    expect(table.send(table.dealer, table.next({ action: 'card', link: own[4] })).error).toBe(
      'wrong-phase',
    )
  })
})

describe('a withheld or wrong link is detected and attributable', () => {
  it('names the side the hand is waiting for in every state', () => {
    const table = new Table(BOB, ALICE, DEALER_SEED, seeds.twoHits)
    const waits: (string | undefined)[] = []
    const note = () => waits.push(awaitedRole(table.state))
    table.send(ALICE, table.next({ action: 'challenge', role: 'player', maxBetWei: '2000' }))
    note()
    table.send(BOB, table.next({ action: 'accept', maxBetWei: '1000', commitment: commitmentOf(DEALER_SEED) }))
    note()
    table.bet()
    note()
    table.dealerActs()
    note()
    table.playerActs('hit')
    note()
    table.dealerActs()
    note()
    table.playerActs('stand')
    note()
    table.dealerActs()
    note()
    expect(waits).toEqual([
      'dealer', // accept
      'player', // bet
      'dealer', // deal: withholding it withholds the dealer's first links
      'player', // first move: withholding it withholds the player's first links
      'dealer', // card
      'player',
      'dealer', // reveal
      undefined,
    ])
  })

  it('records who sent a wrong link, and leaves the hand waiting for that side', () => {
    const table = open('dealer', seeds.win)
    table.dealerActs()
    table.playerActs('stand')
    const bad: HandEvent = {
      item: table.next({ action: 'reveal', link: entropyChain(seedOf(0xbad))[CHAIN_LENGTH] }),
      from: table.dealer,
      to: table.player,
      stampWei: 2_000n,
      digest: digest(),
    }
    const folded = foldHand([...table.log, bad])
    expect(folded.rejected).toEqual([
      { digest: bad.digest, error: 'bad-link', from: table.dealer },
    ])
    expect(folded.state?.phase).toBe('dealer_turn')
    expect(awaitedRole(folded.state)).toBe('dealer')
    // The right link still resolves the hand afterwards.
    table.dealerActs()
    expect(table.state?.phase).toBe('resolved')
  })
})

describe('replayed and reordered messages', () => {
  const played = () => {
    const table = open('dealer', seeds.twoHits)
    table.dealerActs()
    table.playerActs('hit')
    table.dealerActs()
    return table
  }

  it('rejects a message that is replayed under a new digest', () => {
    const table = played()
    const before = table.state
    for (const event of table.log.slice(1)) {
      const result = table.send(event.from, event.item, 0n)
      expect(result.error).toBe('out-of-order')
    }
    expect(table.state).toBe(before)
    // The challenge again is a second hand under the same id.
    expect(table.send(table.dealer, table.log[0].item).error).toBe('hand-exists')
  })

  it('rejects a move whose seq or prev does not continue the chain', () => {
    const table = played()
    const link = entropyChain(table.playerSeed)[5]
    const good = table.next({ action: 'hit', link })
    const cases: HandItem[] = [
      { ...good, seq: good.seq - 1 } as HandItem,
      { ...good, seq: good.seq + 1 } as HandItem,
      { ...good, prev: table.log[2].digest } as HandItem,
      { ...good, prev: 'f'.repeat(64) } as HandItem,
    ]
    for (const item of cases)
      expect(table.send(table.player, item).error).toBe('out-of-order')
    expect(table.send(table.player, good).error).toBeUndefined()
  })

  it('ignores a redelivered message', () => {
    const table = played()
    const before = table.state
    const last = table.log[table.log.length - 1]
    expect(applyHandEvent(table.state, last)).toEqual({ state: before, error: 'duplicate' })
  })

  it('folds a log that was stored or delivered in any order to the same state', () => {
    const table = played()
    table.playerActs('stand')
    table.dealerActs()
    const reversed = [...table.log].reverse()
    const rotated = [...table.log.slice(3), ...table.log.slice(0, 3)]
    for (const order of [reversed, rotated]) {
      const folded = foldHand(order)
      expect(folded.state).toEqual(table.state)
      expect(folded.rejected).toEqual([])
    }
  })

  it('stalls on a message that arrives before the one it follows, applied one at a time', () => {
    const table = open('dealer', seeds.twoHits)
    table.dealerActs()
    const hit = playerStep(table.state, 'hit', table.playerSeed) as HandItem
    const hitDigest = digest()
    const early: HandEvent = {
      item: { ...hit, action: 'card', seq: hit.seq + 1, prev: hitDigest, link: entropyChain(table.dealerSeed)[4] } as HandItem,
      from: table.dealer,
      to: table.player,
      stampWei: STAMP,
      digest: digest(),
    }
    expect(applyHandEvent(table.state, early).error).toBe('out-of-order')
    const hitEvent: HandEvent = { item: hit, from: table.player, to: table.dealer, stampWei: STAMP, digest: hitDigest }
    const folded = foldHand([...table.log, early, hitEvent])
    expect(folded.rejected).toEqual([])
    expect(folded.state?.phase).toBe('player_turn')
    expect(folded.state?.playerCards).toHaveLength(3)
  })

  it('counts only one of two messages that continue the same point', () => {
    // The player forks: two bets after the same message. The first one given is the bet; the
    // other is money the hand did not accept.
    const table = new Table(ALICE, BOB, DEALER_SEED, seeds.win)
    table.send(
      ALICE,
      table.next({ action: 'challenge', role: 'dealer', maxBetWei: '1000', commitment: commitmentOf(DEALER_SEED) }),
    )
    const bet = (seed: string, stampWei: bigint): HandEvent => ({
      item: buildBet(table.state, seed) as HandItem,
      from: BOB,
      to: ALICE,
      stampWei,
      digest: digest(),
    })
    const first = bet(seeds.win, 700n)
    const second = bet(seeds.loss, 900n)
    const folded = foldHand([...table.log, first, second])
    expect(folded.state).toMatchObject({
      phase: 'awaiting_deal',
      wagerWei: 700n,
      betDigest: first.digest,
      rejected: [{ digest: second.digest, stampWei: 900n }],
    })
    expect(folded.rejected).toEqual([{ digest: second.digest, error: 'out-of-order', from: BOB }])
    // Once the dealer has dealt on one of them, that one is the bet in whatever order they come.
    const dealt = foldHand([...table.log, second]).state
    const deal: HandEvent = {
      item: dealerStep(dealt, DEALER_SEED)?.item as HandItem,
      from: ALICE,
      to: BOB,
      stampWei: STAMP,
      digest: digest(),
    }
    for (const order of [[first, second, deal], [deal, first, second], [second, first, deal]]) {
      const state = foldHand([...table.log, ...order]).state
      expect(state).toMatchObject({
        phase: 'player_turn',
        wagerWei: 900n,
        betDigest: second.digest,
        rejected: [{ digest: first.digest, stampWei: 700n }],
      })
    }
  })

  it('rejects a move for a hand that does not exist and a message of another hand', () => {
    const hit = { type: 'blackjack-hand', gameId: GAME, action: 'hit', seq: 4, prev: 'a'.repeat(64), link: 'b'.repeat(64) } as HandItem
    expect(
      applyHandEvent(undefined, { item: hit, from: ALICE, to: BOB, stampWei: STAMP, digest: digest() }),
    ).toEqual({ state: undefined, error: 'no-hand' })
    const table = played()
    const other = { ...table.next({ action: 'hit', link: entropyChain(table.playerSeed)[5] }), gameId: 'f'.repeat(32) } as HandItem
    expect(table.send(table.player, other).error).toBe('no-hand')
  })
})

describe('roles and limits', () => {
  it('gives the challenger the role it picked and the other user the opposite', () => {
    const asDealer = open('dealer', seeds.win)
    expect(asDealer.state).toMatchObject({ dealer: ALICE, player: BOB, challenger: 'dealer' })
    expect(roleOf(asDealer.state as HandState, ALICE.toLowerCase())).toBe('dealer')
    expect(roleOf(asDealer.state as HandState, BOB)).toBe('player')
    expect(roleOf(asDealer.state as HandState, EVE)).toBeUndefined()
    const asPlayer = open('player', seeds.win)
    expect(asPlayer.state).toMatchObject({ dealer: BOB, player: ALICE, challenger: 'player' })
  })

  it('lets the accepting dealer lower the max bet but never raise it', () => {
    const table = new Table(BOB, ALICE, DEALER_SEED, seeds.win)
    table.send(ALICE, table.next({ action: 'challenge', role: 'player', maxBetWei: '500' }))
    const accept = (maxBetWei: string) =>
      table.next({ action: 'accept', maxBetWei, commitment: commitmentOf(DEALER_SEED) })
    expect(table.send(BOB, accept('501')).error).toBe('bad-amount')
    expect(table.send(BOB, accept('0')).error).toBe('bad-amount')
    expect(table.send(BOB, { ...accept('5'), commitment: 'nope' } as HandItem).error).toBe('bad-commitment')
    expect(table.send(BOB, accept('300')).error).toBeUndefined()
    expect(table.state).toMatchObject({ phase: 'open', maxBetWei: 300n })
  })

  it('rejects a malformed challenge', () => {
    const challenge = (fields: Record<string, unknown>, from = ALICE, to = BOB) =>
      applyHandEvent(undefined, {
        item: { type: 'blackjack-hand', gameId: GAME, action: 'challenge', seq: 0, ...fields } as HandItem,
        from,
        to,
        stampWei: STAMP,
        digest: digest(),
      }).error
    expect(challenge({ role: 'player', maxBetWei: '0' })).toBe('bad-amount')
    expect(challenge({ role: 'player', maxBetWei: '1.5' })).toBe('bad-amount')
    expect(challenge({ role: 'dealer', maxBetWei: '5', commitment: 'zz' })).toBe('bad-commitment')
    expect(challenge({ role: 'player', maxBetWei: '5' }, ALICE, ALICE)).toBe('wrong-sender')
    expect(challenge({ role: 'player', maxBetWei: '5', seq: 1 })).toBe('out-of-order')
    expect(challenge({ role: 'player', maxBetWei: '5' })).toBeUndefined()
  })

  it('caps a dealer at a quarter of its spendable balance and a player at what it can send', () => {
    expect(DEALER_COVER_MULTIPLE).toBe(4n)
    expect(maxDealerBetWei(4_100n, 100n)).toBe(1_000n)
    expect(maxDealerBetWei(50n, 100n)).toBe(0n)
    expect(maxPlayerBetWei(4_100n, 100n)).toBe(4_000n)
    expect(maxPlayerBetWei(50n, 100n)).toBe(0n)
    expect(challengeLimitWei('dealer', 4_100n, 100n)).toBe(1_000n)
    expect(challengeLimitWei('player', 4_100n, 100n)).toBe(4_000n)
  })

  it('computes payouts from the stake', () => {
    expect(payoutWei('player_blackjack', 1_001n, false)).toBe(2_502n)
    expect(payoutWei('player_win', 1_000n, false)).toBe(2_000n)
    expect(payoutWei('player_win', 1_000n, true)).toBe(4_000n)
    expect(payoutWei('push', 1_000n, true)).toBe(2_000n)
    expect(payoutWei('dealer_win', 1_000n, true)).toBe(0n)
    expect(totalStakeWei({ wagerWei: 1_000n, doubled: false })).toBe(1_000n)
    expect(totalStakeWei({ wagerWei: 1_000n, doubled: true })).toBe(2_000n)
  })

  it('makes a seed and its commitment', () => {
    const seed = seedFromBytes(new Uint8Array(32).fill(0xab))
    expect(seed).toBe('ab'.repeat(32))
    expect(commitmentOf(seed)).toBe(entropyChain(seed)[0])
    expect(commitmentOf(seed)).not.toBe(seed)
    expect(() => seedFromBytes(new Uint8Array(31))).toThrow('32 random bytes')
  })
})

describe('messages from the wrong side or in the wrong state', () => {
  const link = 'a'.repeat(64)
  const shapes: Record<Exclude<HandAction, 'challenge'>, Record<string, unknown>> = {
    accept: { maxBetWei: '5', commitment: link },
    bet: { commitment: link },
    deal: { link },
    hit: { link },
    stand: { link },
    double: { link },
    card: { link },
    reveal: { link },
    refund: { ref: link },
  }
  const dealerOnly: HandAction[] = ['accept', 'deal', 'card', 'reveal', 'refund']
  const at: Record<string, () => Table> = {
    awaiting_deal: () => open('dealer', seeds.twoHits),
    player_turn: () => {
      const table = open('dealer', seeds.twoHits)
      table.dealerActs()
      return table
    },
    awaiting_card: () => {
      const table = at.player_turn()
      table.playerActs('hit')
      return table
    },
    dealer_turn: () => {
      const table = at.player_turn()
      table.playerActs('stand')
      return table
    },
    resolved: () => {
      const table = at.dealer_turn()
      table.dealerActs()
      return table
    },
  }
  const allowed: Record<string, HandAction[]> = {
    awaiting_deal: ['deal', 'refund'],
    player_turn: ['hit', 'stand', 'double'],
    awaiting_card: ['card'],
    dealer_turn: ['reveal'],
    resolved: [],
  }

  describe.each(Object.keys(at))('in %s', phase => {
    it.each(Object.keys(shapes) as Exclude<HandAction, 'challenge'>[])(
      'a %s from the wrong side is rejected',
      action => {
        const table = at[phase]()
        const before = table.state
        const wrong = dealerOnly.includes(action) ? table.player : table.dealer
        const result = table.send(wrong, table.next({ action, ...shapes[action] }), 0n)
        expect(result.error).toBeDefined()
        expect(table.state).toBe(before)
      },
    )

    it('only the moves of this state advance the hand', () => {
      for (const action of Object.keys(shapes) as Exclude<HandAction, 'challenge'>[]) {
        if (allowed[phase].includes(action)) continue
        const table = at[phase]()
        const sender = dealerOnly.includes(action) ? table.dealer : table.player
        const result = table.send(sender, table.next({ action, ...shapes[action] }), 0n)
        expect(result.error).toBeDefined()
        expect(table.state?.phase).toBe(phase as HandPhase)
      }
    })

    it('ignores a third address', () => {
      const table = at[phase]()
      const before = table.state
      for (const action of Object.keys(shapes) as Exclude<HandAction, 'challenge'>[]) {
        const event: HandEvent = {
          item: table.next({ action, ...shapes[action] }),
          from: EVE,
          to: table.dealer,
          stampWei: WAGER,
          digest: digest(),
        }
        expect(applyHandEvent(table.state, event)).toEqual({ state: before, error: 'wrong-sender' })
      }
    })
  })
})

describe('amounts', () => {
  const challenged = () => {
    const table = new Table(ALICE, BOB, DEALER_SEED, seeds.win)
    table.send(
      ALICE,
      table.next({ action: 'challenge', role: 'dealer', maxBetWei: '1000', commitment: commitmentOf(DEALER_SEED) }),
    )
    return table
  }

  it('rejects a bet above the max and a zero bet, and the dealer owes the money back', () => {
    const table = challenged()
    const over = table.bet(1_001n)
    expect(over.error).toBe('bad-amount')
    expect(table.bet(0n).error).toBe('bad-amount')
    expect(table.state).toMatchObject({
      phase: 'open',
      rejected: [{ digest: over.event.digest, stampWei: 1_001n }],
    })
    // The dealer's next message is the refund, for exactly that amount.
    const step = dealerStep(table.state, table.dealerSeed)
    expect(step).toMatchObject({
      item: { action: 'refund', ref: over.event.digest },
      payWei: 1_001n,
    })
    // A refund needs no seed.
    expect(dealerStep(table.state, '')).toEqual(step)
    table.dealerActs()
    expect(table.state?.rejected[0].refundedWei).toBe(1_001n)
    expect(refundShortfallWei(table.state as HandState)).toBe(0n)
    // The hand is still open, and the refund did not take a place in the chain.
    expect(table.bet(1_000n).error).toBeUndefined()
    expect(foldHand(table.log).state).toEqual(table.state)
  })

  it('rejects a second bet and a double of the wrong amount, each owed back', () => {
    const table = open('dealer', seeds.twoHits)
    const again = table.send(table.player, table.next({ action: 'bet', commitment: commitmentOf(seeds.win) }), 400n)
    expect(again.error).toBe('wrong-phase')
    // Money owed back goes first, then the deal.
    expect(table.dealerActs().item.action).toBe('refund')
    expect(table.dealerActs().item.action).toBe('deal')
    const chain = entropyChain(table.playerSeed)
    const double = table.send(
      table.player,
      table.next({ action: 'double', link: chain[CHAIN_LENGTH] }),
      WAGER - 1n,
    )
    expect(double.error).toBe('bad-amount')
    expect(table.state).toMatchObject({ phase: 'player_turn', doubled: false, wagerWei: WAGER })
    expect(table.state?.rejected.map(r => r.stampWei)).toEqual([400n, WAGER - 1n])
    expect(refundShortfallWei(table.state as HandState)).toBe(WAGER - 1n)
  })

  it('lets the dealer return the accepted bet instead of dealing', () => {
    const table = open('dealer', seeds.win)
    const step = refundBetStep(table.state)
    expect(step).toMatchObject({ item: { action: 'refund', ref: table.state?.betDigest }, payWei: WAGER })
    expect(table.send(table.dealer, (step as { item: HandItem }).item, WAGER).error).toBeUndefined()
    expect(table.state).toMatchObject({ phase: 'refunded', refundedWei: WAGER })
    expect(refundBetStep(table.state)).toBeUndefined()
    expect(dealerStep(table.state, table.dealerSeed)).toBeUndefined()
    expect(awaitedRole(table.state)).toBeUndefined()
  })

  it('rejects a refund that names nothing owed, and one from the player', () => {
    const table = open('dealer', seeds.win)
    expect(table.send(table.dealer, table.next({ action: 'refund', ref: 'c'.repeat(64) }), WAGER).error).toBe('bad-ref')
    expect(
      table.send(table.player, table.next({ action: 'refund', ref: table.state?.betDigest }), WAGER).error,
    ).toBe('wrong-sender')
    expect(table.state?.phase).toBe('awaiting_deal')
  })

  it('counts a short refund as still owed', () => {
    const table = challenged()
    table.bet(1_500n)
    const step = dealerStep(table.state, table.dealerSeed) as { item: HandItem }
    table.send(table.dealer, step.item, 1_000n)
    expect(refundShortfallWei(table.state as HandState)).toBe(500n)
    const returned = open('dealer', seeds.win)
    returned.send(returned.dealer, (refundBetStep(returned.state) as { item: HandItem }).item, 400n)
    expect(refundShortfallWei(returned.state as HandState)).toBe(WAGER - 400n)
  })

  it('records a short payout as owed more than paid', () => {
    const table = open('dealer', seeds.win)
    table.dealerActs()
    table.playerActs('stand')
    const step = dealerStep(table.state, table.dealerSeed) as { item: HandItem; payWei: bigint }
    expect(step.payWei).toBe(WAGER * 2n)
    table.send(table.dealer, step.item, 1n)
    expect(table.state).toMatchObject({ phase: 'resolved', owedWei: WAGER * 2n, paidWei: 1n })
  })
})

describe('seeds', () => {
  it('gives a dealer holding the wrong seed nothing to send', () => {
    const table = open('dealer', seeds.win)
    expect(dealerStep(table.state, seedOf(0xbad))).toBeUndefined()
    expect(dealerStep(table.state, '')).toBeUndefined()
    expect(dealerStep(undefined, table.dealerSeed)).toBeUndefined()
  })

  it('gives a player without its seed no move', () => {
    const table = open('dealer', seeds.win)
    table.dealerActs()
    expect(playerMoves(table.state)).toEqual([])
    expect(playerMoves(table.state, seedOf(0xbad))).toEqual([])
    expect(playerStep(table.state, 'hit', seedOf(0xbad))).toBeUndefined()
    expect(playerMoves(table.state, table.playerSeed)).toEqual(['hit', 'stand', 'double'])
    // Betting needs no earlier seed; moving out of turn gives nothing.
    expect(playerMoves(undefined)).toEqual([])
    expect(buildBet(table.state, table.playerSeed)).toBeUndefined()
  })

  it('gives the same step every time it is asked', () => {
    const table = open('dealer', seeds.twoHits)
    for (const move of ['hit', 'hit', 'stand'] as Move[]) {
      expect(dealerStep(table.state, table.dealerSeed)).toEqual(
        dealerStep(table.state, table.dealerSeed),
      )
      table.dealerActs()
      expect(playerStep(table.state, move, table.playerSeed)).toEqual(
        playerStep(table.state, move, table.playerSeed),
      )
      table.playerActs(move)
    }
    expect(dealerStep(table.state, table.dealerSeed)?.item.action).toBe('reveal')
  })

  it('chains every built message to the one before it', () => {
    const table = open('player', seeds.twoHits)
    table.dealerActs()
    table.playerActs('hit')
    table.dealerActs()
    table.playerActs('stand')
    table.dealerActs()
    expect(table.log.map(e => e.item.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(table.log.slice(1).map(e => (e.item as { prev: string }).prev)).toEqual(
      table.log.slice(0, -1).map(e => e.digest),
    )
    expect(table.state).toMatchObject({ count: 8, head: table.log[7].digest })
  })
})

describe('what a wallet may send', () => {
  const base = { gameId: GAME, reserveWei: 100n }

  it('refuses a challenge above what the challenger can cover in its role', () => {
    expect(buildChallenge({ ...base, role: 'dealer', maxBetWei: 1_001n, spendableWei: 4_100n, seed: DEALER_SEED })).toEqual({
      error: 'above-own-limit',
    })
    expect(buildChallenge({ ...base, role: 'player', maxBetWei: 0n, spendableWei: 4_100n })).toEqual({
      error: 'not-positive',
    })
    expect(buildChallenge({ ...base, role: 'dealer', maxBetWei: 1_000n, spendableWei: 4_100n, seed: DEALER_SEED })).toEqual({
      item: {
        type: 'blackjack-hand',
        gameId: GAME,
        action: 'challenge',
        seq: 0,
        role: 'dealer',
        maxBetWei: '1000',
        commitment: commitmentOf(DEALER_SEED),
      },
    })
    expect(buildChallenge({ ...base, role: 'player', maxBetWei: 4_000n, spendableWei: 4_100n })).toEqual({
      item: { type: 'blackjack-hand', gameId: GAME, action: 'challenge', seq: 0, role: 'player', maxBetWei: '4000' },
    })
    expect(() =>
      buildChallenge({ ...base, role: 'dealer', maxBetWei: 1n, spendableWei: 4_100n }),
    ).toThrow('needs a seed')
  })

  it('accepts at the lower of the challenge and what the dealer can cover', () => {
    const table = new Table(BOB, ALICE, DEALER_SEED, seeds.win)
    table.send(ALICE, table.next({ action: 'challenge', role: 'player', maxBetWei: '2000' }))
    const state = table.state as HandState
    const accept = (spendableWei: bigint, wantedMaxBetWei?: bigint) =>
      buildAccept({ state, spendableWei, reserveWei: 100n, seed: DEALER_SEED, wantedMaxBetWei })
    expect(accept(4_100n)).toEqual({
      item: {
        type: 'blackjack-hand',
        gameId: GAME,
        action: 'accept',
        seq: 1,
        prev: state.head,
        maxBetWei: '1000',
        commitment: commitmentOf(DEALER_SEED),
      },
    })
    expect(accept(100_000n)).toMatchObject({ item: { maxBetWei: '2000' } })
    expect(accept(100_000n, 2_001n)).toEqual({ error: 'above-max-bet' })
    expect(accept(4_100n, 1_001n)).toEqual({ error: 'above-own-limit' })
    expect(accept(4_100n, 0n)).toEqual({ error: 'not-positive' })
    expect(accept(50n)).toEqual({ error: 'above-own-limit' })
    const built = accept(4_100n) as { item: HandItem }
    expect(table.send(BOB, built.item).error).toBeUndefined()
  })

  it('checks a wager against the hand and the wallet', () => {
    const state = { maxBetWei: 1_000n }
    expect(checkWager(state, 0n, 5_000n, 100n)).toBe('not-positive')
    expect(checkWager(state, 1_001n, 5_000n, 100n)).toBe('above-max-bet')
    expect(checkWager(state, 1_000n, 1_050n, 100n)).toBe('above-own-limit')
    expect(checkWager(state, 1_000n, 1_100n, 100n)).toBeUndefined()
  })

  it('credits nothing when one message carries more than one hand item', () => {
    const table = new Table(ALICE, BOB, DEALER_SEED, seeds.win)
    const bet = table.next({ action: 'bet', commitment: commitmentOf(seeds.win) })
    expect(soleHandItem([bet])).toBe(bet)
    expect(soleHandItem([bet, bet])).toBeUndefined()
    expect(soleHandItem([{ type: 'text' }, bet])).toBe(bet)
    expect(soleHandItem([{ ...bet, gameId: 'short' }])).toBeUndefined()
    expect(
      handEventsOf({
        items: [bet, bet],
        senderAddress: BOB,
        recipientAddress: ALICE,
        stampValueWei: WAGER,
        payloadDigest: digest(),
      }),
    ).toEqual([])
  })

  it('reads hand events from a message and nothing from other items', () => {
    const table = new Table(ALICE, BOB, DEALER_SEED, seeds.win)
    const bet = table.next({ action: 'bet', commitment: commitmentOf(seeds.win) })
    const d = digest()
    expect(
      handEventsOf({
        items: [{ type: 'text' }, bet],
        senderAddress: BOB,
        recipientAddress: ALICE,
        stampValueWei: 7n,
        payloadDigest: d,
      }),
    ).toEqual([{ item: bet, from: BOB, to: ALICE, stampWei: 7n, digest: d }])
    expect(
      handEventsOf({ items: [{ type: 'text' }], senderAddress: BOB, recipientAddress: ALICE, payloadDigest: d }),
    ).toEqual([])
    expect(handPreviewText(bet)).toBe('Placed a blackjack bet')
  })
})
