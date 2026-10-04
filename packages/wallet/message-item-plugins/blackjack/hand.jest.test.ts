import { deriveDeck, handValue } from './deck'
import { playOutDealer, type BlackjackOutcome } from './game'
import {
  applyHandEvent,
  buildAccept,
  buildChallenge,
  challengeLimitWei,
  checkWager,
  handEventsOf,
  commitmentOf,
  dealerStep,
  DEALER_COVER_MULTIPLE,
  foldHand,
  handPreviewText,
  maxDealerBetWei,
  maxPlayerBetWei,
  payoutWei,
  playerMoves,
  refundBetStep,
  roleOf,
  seedFromBytes,
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
const GAME = 'game-1'
const STAMP = 10n
const WAGER = 1_000n

let counter = 0
const digest = () => (++counter).toString(16).padStart(64, '0')
const seedOf = (n: number) => n.toString(16).padStart(64, '0')
const item = (fields: Record<string, unknown>): HandItem =>
  ({ type: 'blackjack-hand', gameId: GAME, ...fields } as HandItem)

/** A table: who deals, the dealer's seed, and the running state, driven only through events. */
class Table {
  state: HandState | undefined
  log: HandEvent[] = []
  constructor(
    readonly dealer: string,
    readonly player: string,
    readonly seed: string,
  ) {}
  send(from: string, fields: Record<string, unknown>, stampWei = STAMP, d = digest()) {
    const event: HandEvent = {
      item: item(fields),
      from,
      to: from === this.dealer ? this.player : this.dealer,
      stampWei,
      digest: d,
    }
    const result = applyHandEvent(this.state, event)
    this.state = result.state
    if (!result.error) this.log.push(event)
    return result
  }
  /** Sends whatever the dealer must send next; returns it. */
  dealerActs() {
    const step = dealerStep(this.state, this.seed)
    if (!step) throw new Error(`dealer has no step in ${this.state?.phase}`)
    const result = this.send(this.dealer, step.item, step.payWei ?? STAMP)
    expect(result.error).toBeUndefined()
    return step
  }
}

/** Opens a hand up to the accepted bet. `betDigest` is fixed so a seed determines the cards. */
function open(
  challenger: 'dealer' | 'player',
  seed: string,
  betDigest: string,
  wager = WAGER,
  maxBet = WAGER,
): Table {
  const table =
    challenger === 'dealer'
      ? new Table(ALICE, BOB, seed)
      : new Table(BOB, ALICE, seed)
  if (challenger === 'dealer') {
    table.send(ALICE, {
      action: 'challenge',
      role: 'dealer',
      maxBetWei: maxBet.toString(),
      commitment: commitmentOf(seed),
    })
  } else {
    table.send(ALICE, {
      action: 'challenge',
      role: 'player',
      maxBetWei: (maxBet * 2n).toString(),
    })
    expect(table.state?.phase).toBe('challenged')
    table.send(BOB, {
      action: 'accept',
      maxBetWei: maxBet.toString(),
      commitment: commitmentOf(seed),
    })
  }
  expect(table.state?.phase).toBe('open')
  expect(table.send(table.player, { action: 'bet' }, wager, betDigest).error).toBeUndefined()
  return table
}

const BET_DIGEST = 'be'.repeat(32)

/** Finds a seed whose deck (with the fixed bet digest) satisfies `want`. Deterministic. */
function findSeed(want: (deck: number[]) => boolean): string {
  for (let n = 1; n < 5000; n++) {
    const seed = seedOf(n)
    if (want(deriveDeck(seed, BET_DIGEST, 0))) return seed
  }
  throw new Error('no seed found')
}
const initial = (deck: number[]) => [deck[0], deck[2]]
/** The outcome if the player stands on the first two cards. */
const standOutcome = (deck: number[]) => playOutDealer(deck, initial(deck), 4).outcome
const noNatural = (deck: number[]) => !handValue(initial(deck)).blackjack

const seeds: Record<string, string> = {
  win: findSeed(d => noNatural(d) && standOutcome(d) === 'player_win'),
  loss: findSeed(d => noNatural(d) && standOutcome(d) === 'dealer_win'),
  push: findSeed(d => noNatural(d) && standOutcome(d) === 'push'),
  blackjack: findSeed(d => standOutcome(d) === 'player_blackjack'),
  // One hit busts.
  bust: findSeed(d => noNatural(d) && handValue([...initial(d), d[4]]).bust),
  // Double: one more card, no bust, and the player wins.
  doubleWin: findSeed(
    d =>
      noNatural(d) &&
      !handValue([...initial(d), d[4]]).bust &&
      playOutDealer(d, [...initial(d), d[4]], 5).outcome === 'player_win',
  ),
  doubleLoss: findSeed(
    d =>
      noNatural(d) &&
      !handValue([...initial(d), d[4]]).bust &&
      playOutDealer(d, [...initial(d), d[4]], 5).outcome === 'dealer_win',
  ),
  // Two hits without busting, then the player stands.
  twoHits: findSeed(
    d => noNatural(d) && !handValue([...initial(d), d[4], d[5]]).bust,
  ),
}

describe.each(['dealer', 'player'] as const)(
  'a complete hand when the challenger is the %s',
  challenger => {
    const play = (
      name: string,
      moves: ('hit' | 'stand' | 'double')[],
      outcome: BlackjackOutcome,
      owed: bigint,
    ) =>
      it(`${name}: pays ${owed}`, () => {
        const table = open(challenger, seeds[name], BET_DIGEST)
        expect(table.state?.phase).toBe('awaiting_deal')
        expect(table.dealerActs().item.action).toBe('deal')
        for (const move of moves) {
          expect(playerMoves(table.state)).toContain(move)
          const stamp = move === 'double' ? WAGER : STAMP
          expect(table.send(table.player, { action: move }, stamp).error).toBeUndefined()
          if (move !== 'stand') expect(table.dealerActs().item.action).toBe('card')
        }
        expect(table.state?.phase).toBe('dealer_turn')
        const step = table.dealerActs()
        expect(step.item.action).toBe('reveal')
        expect(step.payWei).toBe(owed > 0n ? owed : undefined)
        expect(table.state).toMatchObject({
          phase: 'resolved',
          outcome,
          owedWei: owed,
          paidWei: owed > 0n ? owed : STAMP,
          dealer: challenger === 'dealer' ? ALICE : BOB,
          player: challenger === 'dealer' ? BOB : ALICE,
        })
        expect(playerMoves(table.state)).toEqual([])
        expect(dealerStep(table.state, table.seed)).toBeUndefined()
        // Both sides fold the same log to the same state.
        expect(foldHand(table.log).state).toEqual(table.state)
      })

    play('win', ['stand'], 'player_win', WAGER * 2n)
    play('loss', ['stand'], 'dealer_win', 0n)
    play('push', ['stand'], 'push', WAGER)
    play('blackjack', [], 'player_blackjack', (WAGER * 5n) / 2n)
    play('bust', ['hit'], 'dealer_win', 0n)
    play('doubleWin', ['double'], 'player_win', WAGER * 4n)
    play('doubleLoss', ['double'], 'dealer_win', 0n)

    it('offers double only on the first two cards', () => {
      const table = open(challenger, seeds.twoHits, BET_DIGEST)
      table.dealerActs()
      expect(playerMoves(table.state)).toEqual(['hit', 'stand', 'double'])
      table.send(table.player, { action: 'hit' })
      expect(table.state?.phase).toBe('awaiting_card')
      expect(playerMoves(table.state)).toEqual([])
      table.dealerActs()
      expect(playerMoves(table.state)).toEqual(['hit', 'stand'])
      table.send(table.player, { action: 'hit' })
      table.dealerActs()
      expect(table.state?.playerCards).toHaveLength(4)
      table.send(table.player, { action: 'stand' })
      table.dealerActs()
      expect(table.state?.phase).toBe('resolved')
    })
  },
)

describe('roles and limits', () => {
  it('gives the challenger the role it picked and the other user the opposite', () => {
    const dealerFirst = open('dealer', seeds.win, BET_DIGEST)
    expect(roleOf(dealerFirst.state!, ALICE.toLowerCase())).toBe('dealer')
    expect(roleOf(dealerFirst.state!, BOB)).toBe('player')
    expect(roleOf(dealerFirst.state!, EVE)).toBeUndefined()
    expect(dealerFirst.state?.challenger).toBe('dealer')
    const playerFirst = open('player', seeds.win, BET_DIGEST)
    expect(roleOf(playerFirst.state!, ALICE)).toBe('player')
    expect(roleOf(playerFirst.state!, BOB)).toBe('dealer')
    expect(playerFirst.state?.challenger).toBe('player')
  })

  it('lets the accepting dealer lower the max bet but never raise it', () => {
    const table = new Table(BOB, ALICE, seeds.win)
    table.send(ALICE, { action: 'challenge', role: 'player', maxBetWei: '500' })
    const accept = (maxBetWei: string) =>
      table.send(BOB, {
        action: 'accept',
        maxBetWei,
        commitment: commitmentOf(seeds.win),
      })
    expect(accept('501').error).toBe('bad-amount')
    expect(accept('0').error).toBe('bad-amount')
    expect(accept('1.5').error).toBe('bad-amount')
    expect(table.state?.phase).toBe('challenged')
    expect(accept('200').error).toBeUndefined()
    expect(table.state).toMatchObject({ phase: 'open', maxBetWei: 200n })
    // The player may bet up to the dealer's figure, not their own.
    expect(table.send(ALICE, { action: 'bet' }, 201n).error).toBe('bad-amount')
    expect(table.send(ALICE, { action: 'bet' }, 200n).error).toBeUndefined()
  })

  it('rejects a malformed challenge', () => {
    const challenge = (fields: Record<string, unknown>, to = BOB) =>
      applyHandEvent(undefined, {
        item: item({ action: 'challenge', ...fields }),
        from: ALICE,
        to,
        stampWei: STAMP,
        digest: digest(),
      })
    expect(challenge({ role: 'player', maxBetWei: '0' })).toEqual({
      state: undefined,
      error: 'bad-amount',
    })
    expect(challenge({ role: 'player', maxBetWei: '-1' }).error).toBe('bad-amount')
    expect(challenge({ role: 'player', maxBetWei: '9'.repeat(41) }).error).toBe('bad-amount')
    expect(challenge({ role: 'dealer', maxBetWei: '5', commitment: 'zz' }).error).toBe(
      'bad-commitment',
    )
    expect(challenge({ role: 'player', maxBetWei: '5' }, ALICE).error).toBe('wrong-sender')
  })

  it('caps a dealer at a quarter of its spendable balance and a player at what it can send', () => {
    expect(DEALER_COVER_MULTIPLE).toBe(4n)
    expect(maxDealerBetWei(1_000n, 200n)).toBe(200n)
    expect(maxDealerBetWei(1_003n, 200n)).toBe(200n)
    expect(maxDealerBetWei(200n, 200n)).toBe(0n)
    expect(maxDealerBetWei(100n, 200n)).toBe(0n)
    expect(maxPlayerBetWei(1_000n, 200n)).toBe(800n)
    expect(maxPlayerBetWei(100n, 200n)).toBe(0n)
    // The dealer's cap covers the worst case of every outcome.
    const max = maxDealerBetWei(1_000n, 200n)
    for (const doubled of [false, true])
      for (const outcome of ['player_win', 'dealer_win', 'push', 'player_blackjack'] as const)
        // A natural ends the hand at the deal, so it can never be doubled.
        if (!(doubled && outcome === 'player_blackjack'))
          expect(payoutWei(outcome, max, doubled)).toBeLessThanOrEqual(800n)
  })

  it('computes payouts from the stake', () => {
    expect(payoutWei('player_blackjack', 1_001n, false)).toBe(2_502n)
    expect(payoutWei('player_win', 1_000n, false)).toBe(2_000n)
    expect(payoutWei('player_win', 1_000n, true)).toBe(4_000n)
    expect(payoutWei('push', 1_000n, true)).toBe(2_000n)
    expect(payoutWei('dealer_win', 1_000n, true)).toBe(0n)
    expect(totalStakeWei({ wagerWei: 7n, doubled: true })).toBe(14n)
    expect(totalStakeWei({ wagerWei: 7n, doubled: false })).toBe(7n)
  })

  it('makes a seed and its commitment', () => {
    const seed = seedFromBytes(new Uint8Array(32).fill(0xab))
    expect(seed).toBe('ab'.repeat(32))
    expect(commitmentOf(seed)).toMatch(/^[0-9a-f]{64}$/)
    expect(() => seedFromBytes(new Uint8Array(31))).toThrow()
  })
})

describe('rejected messages', () => {
  /** A hand stopped in each phase, both role assignments. */
  function at(phase: HandPhase): Table {
    if (phase === 'challenged') {
      const table = new Table(BOB, ALICE, seeds.win)
      table.send(ALICE, { action: 'challenge', role: 'player', maxBetWei: '1000' })
      return table
    }
    if (phase === 'open') {
      const table = new Table(ALICE, BOB, seeds.win)
      table.send(ALICE, {
        action: 'challenge',
        role: 'dealer',
        maxBetWei: '1000',
        commitment: commitmentOf(seeds.win),
      })
      return table
    }
    const table = open('dealer', seeds.twoHits, BET_DIGEST)
    if (phase === 'awaiting_deal') return table
    if (phase === 'refunded') {
      const step = refundBetStep(table.state)!
      table.send(table.dealer, step.item, step.payWei)
      return table
    }
    table.dealerActs()
    if (phase === 'player_turn') return table
    if (phase === 'awaiting_card') {
      table.send(table.player, { action: 'hit' })
      return table
    }
    table.send(table.player, { action: 'stand' })
    if (phase === 'dealer_turn') return table
    table.dealerActs()
    return table
  }

  const phases: HandPhase[] = [
    'challenged',
    'open',
    'awaiting_deal',
    'player_turn',
    'awaiting_card',
    'dealer_turn',
    'resolved',
    'refunded',
  ]
  /** Every (phase, sender, action) that is legal; everything else must be rejected. */
  const legal: Record<HandPhase, Partial<Record<'dealer' | 'player', HandAction[]>>> = {
    challenged: { dealer: ['accept'] },
    open: { player: ['bet'] },
    awaiting_deal: { dealer: ['deal', 'refund'] },
    player_turn: { player: ['hit', 'stand', 'double'] },
    awaiting_card: { dealer: ['card'] },
    dealer_turn: { dealer: ['reveal'] },
    resolved: {},
    refunded: {},
  }
  const actions: HandAction[] = [
    'challenge',
    'accept',
    'bet',
    'deal',
    'hit',
    'stand',
    'double',
    'card',
    'reveal',
    'refund',
  ]
  /** A well-formed message of `action` for the table's current state, as the given sender. */
  function wellFormed(table: Table, action: HandAction): { fields: Record<string, unknown>; stamp: bigint } {
    const state = table.state!
    const deck = deriveDeck(table.seed, state.betDigest ?? BET_DIGEST, 0)
    const cards = state.playerCards.length ? state.playerCards : initial(deck)
    switch (action) {
      case 'challenge':
        return { fields: { action, role: 'player', maxBetWei: '1000' }, stamp: STAMP }
      case 'accept':
        return {
          fields: { action, maxBetWei: '1000', commitment: commitmentOf(table.seed) },
          stamp: STAMP,
        }
      case 'bet':
        return { fields: { action }, stamp: WAGER }
      case 'double':
        return { fields: { action }, stamp: state.wagerWei || WAGER }
      case 'deal':
        return {
          fields: { action, playerCards: initial(deck), dealerUpCard: deck[1] },
          stamp: STAMP,
        }
      case 'card':
        return {
          fields: { action, playerCards: [...cards, deck[2 + cards.length]] },
          stamp: STAMP,
        }
      case 'reveal': {
        const played = playOutDealer(deck, cards, 2 + cards.length)
        return {
          fields: {
            action,
            dealerCards: played.dealerCards,
            seed: table.seed,
            outcome: played.outcome,
          },
          stamp: WAGER * 4n,
        }
      }
      case 'refund':
        return { fields: { action, ref: state.betDigest ?? 'ff'.repeat(32) }, stamp: WAGER }
      default:
        return { fields: { action }, stamp: STAMP }
    }
  }

  describe.each(phases)('in %s', phase => {
    it.each(actions.flatMap(a => [['dealer', a] as const, ['player', a] as const]))(
      'the %s sending %s is accepted only when legal',
      (role, action) => {
        const table = at(phase)
        expect(table.state?.phase).toBe(phase)
        const before = table.state!
        const { fields, stamp } = wellFormed(table, action)
        const from = role === 'dealer' ? table.dealer : table.player
        const result = table.send(from, fields, stamp)
        const allowed = legal[phase][role]?.includes(action) ?? false
        if (allowed) {
          expect(result.error).toBeUndefined()
          expect(result.state?.phase).not.toBe(undefined)
          return
        }
        expect(result.error).toBeDefined()
        // The hand itself never moves. Only the player's own money is remembered as owed back.
        const playerMoney = role === 'player' && (action === 'bet' || action === 'double')
        if (playerMoney) {
          expect(result.state).toEqual({
            ...before,
            rejected: [{ digest: expect.any(String), stampWei: stamp }],
            seen: [...before.seen, expect.any(String)],
          })
        } else {
          expect(result.state).toBe(before)
        }
      },
    )

    it('ignores a third address', () => {
      const table = at(phase)
      const before = table.state
      for (const action of actions) {
        const { fields, stamp } = wellFormed(table, action)
        for (const [from, to] of [
          [EVE, table.dealer],
          [EVE, table.player],
          [table.player, EVE],
          [table.dealer, EVE],
        ]) {
          const result = applyHandEvent(table.state, {
            item: item(fields),
            from,
            to,
            stampWei: stamp,
            digest: digest(),
          })
          expect(result.error).toBeDefined()
          expect(result.state).toBe(before)
        }
      }
    })

    it('ignores a redelivered message', () => {
      const table = at(phase)
      const before = table.state
      for (const event of [...table.log]) {
        const result = applyHandEvent(table.state, event)
        expect(result).toEqual({ state: before, error: 'duplicate' })
      }
      // And a whole log delivered twice folds to the same hand.
      expect(foldHand([...table.log, ...table.log]).state).toEqual(before)
    })
  })

  it('rejects a move for a hand that does not exist and a message of another hand', () => {
    for (const action of actions.filter(a => a !== 'challenge')) {
      const result = applyHandEvent(undefined, {
        item: item({ action }),
        from: BOB,
        to: ALICE,
        stampWei: WAGER,
        digest: digest(),
      })
      expect(result).toEqual({ state: undefined, error: 'no-hand' })
    }
    const table = at('open')
    const other = applyHandEvent(table.state, {
      item: { type: 'blackjack-hand', gameId: 'other', action: 'bet' },
      from: BOB,
      to: ALICE,
      stampWei: WAGER,
      digest: digest(),
    })
    expect(other).toEqual({ state: table.state, error: 'no-hand' })
  })

  it('stalls when messages arrive out of order, and recovers when folded in order', () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    table.dealerActs()
    table.send(table.player, { action: 'stand' })
    table.dealerActs()
    const [challenge, bet, deal, stand, reveal] = table.log
    const shuffled = foldHand([challenge, deal, bet, reveal, stand])
    expect(shuffled.state?.phase).toBe('awaiting_deal')
    expect(shuffled.rejected.map(r => r.error)).toEqual([
      'wrong-phase',
      'wrong-phase',
      'wrong-phase',
    ])
    expect(shuffled.state?.rejected).toEqual([])
    expect(foldHand([challenge, bet, deal, stand, reveal]).state).toEqual(table.state)
  })
})

describe('amounts', () => {
  it('rejects a bet above the max and a zero bet, and the dealer owes the money back', () => {
    const table = new Table(ALICE, BOB, seeds.win)
    table.send(ALICE, {
      action: 'challenge',
      role: 'dealer',
      maxBetWei: '1000',
      commitment: commitmentOf(seeds.win),
    })
    expect(table.send(BOB, { action: 'bet' }, 0n).error).toBe('bad-amount')
    expect(table.state?.rejected).toEqual([])
    const over = 'aa'.repeat(32)
    expect(table.send(BOB, { action: 'bet' }, 1_001n, over).error).toBe('bad-amount')
    expect(table.state).toMatchObject({
      phase: 'open',
      wagerWei: 0n,
      rejected: [{ digest: over, stampWei: 1_001n }],
    })
    // The dealer's next step is the refund, for exactly what was sent, naming that message.
    const step = dealerStep(table.state, table.seed)!
    expect(step).toEqual({
      item: { type: 'blackjack-hand', gameId: GAME, action: 'refund', ref: over },
      payWei: 1_001n,
    })
    table.send(ALICE, step.item, step.payWei)
    expect(table.state?.rejected).toEqual([
      { digest: over, stampWei: 1_001n, refundedWei: 1_001n },
    ])
    // Owed exactly once: nothing more to send, and a second refund for it is rejected.
    expect(dealerStep(table.state, table.seed)).toBeUndefined()
    expect(table.send(ALICE, step.item, step.payWei).error).toBe('bad-ref')
    // The hand is still open and a proper bet is accepted.
    expect(table.send(BOB, { action: 'bet' }, 1_000n).error).toBeUndefined()
    expect(table.state).toMatchObject({ phase: 'awaiting_deal', wagerWei: 1_000n })
  })

  it('rejects a second bet and a double of the wrong amount, each owed back', () => {
    const table = open('dealer', seeds.twoHits, BET_DIGEST)
    expect(table.send(BOB, { action: 'bet' }, 500n).error).toBe('wrong-phase')
    // Refunds come before the deal.
    let step = table.dealerActs()
    expect(step).toMatchObject({ item: { action: 'refund' }, payWei: 500n })
    expect(table.dealerActs().item.action).toBe('deal')
    for (const wrong of [WAGER - 1n, WAGER + 1n, WAGER * 2n]) {
      expect(table.send(BOB, { action: 'double' }, wrong).error).toBe('bad-amount')
      expect(table.state).toMatchObject({ phase: 'player_turn', doubled: false })
      step = table.dealerActs()
      expect(step).toMatchObject({ item: { action: 'refund' }, payWei: wrong })
    }
    table.send(BOB, { action: 'hit' })
    table.dealerActs()
    // No double after a hit.
    expect(table.send(BOB, { action: 'double' }, WAGER).error).toBe('wrong-phase')
    expect(table.dealerActs()).toMatchObject({ item: { action: 'refund' }, payWei: WAGER })
    expect(table.state?.rejected.every(r => r.refundedWei === r.stampWei)).toBe(true)
  })

  it('lets the dealer return the accepted bet instead of dealing', () => {
    const table = open('player', seeds.win, BET_DIGEST)
    const step = refundBetStep(table.state)!
    expect(step).toEqual({
      item: { type: 'blackjack-hand', gameId: GAME, action: 'refund', ref: BET_DIGEST },
      payWei: WAGER,
    })
    table.send(table.dealer, step.item, step.payWei)
    expect(table.state).toMatchObject({ phase: 'refunded', refundedWei: WAGER })
    expect(dealerStep(table.state, table.seed)).toBeUndefined()
    expect(refundBetStep(table.state)).toBeUndefined()
    expect(refundBetStep(undefined)).toBeUndefined()
  })

  it('rejects a refund that names nothing owed, and one from the player', () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    table.dealerActs()
    expect(table.send(ALICE, { action: 'refund', ref: BET_DIGEST }, WAGER).error).toBe('bad-ref')
    expect(table.send(ALICE, { action: 'refund', ref: 'ff'.repeat(32) }, WAGER).error).toBe(
      'bad-ref',
    )
    expect(table.send(BOB, { action: 'refund', ref: BET_DIGEST }, WAGER).error).toBe(
      'wrong-sender',
    )
  })

  it('records a short payout as owed more than paid', () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    table.dealerActs()
    table.send(BOB, { action: 'stand' })
    const step = dealerStep(table.state, table.seed)!
    table.send(ALICE, step.item, STAMP)
    expect(table.state).toMatchObject({
      phase: 'resolved',
      owedWei: WAGER * 2n,
      paidWei: STAMP,
    })
  })
})

describe('tampering', () => {
  const standing = () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    table.dealerActs()
    table.send(BOB, { action: 'stand' })
    return table
  }

  it('rejects a reveal whose seed, cards or outcome do not match the commitment', () => {
    const table = standing()
    const honest = dealerStep(table.state, table.seed)!.item as Extract<
      HandItem,
      { action: 'reveal' }
    >
    const before = table.state
    const tampered: Record<string, unknown>[] = [
      { ...honest, seed: seeds.loss },
      { ...honest, seed: 'not-a-seed' },
      { ...honest, outcome: 'dealer_win' },
      { ...honest, dealerCards: [...honest.dealerCards].reverse() },
      { ...honest, dealerCards: honest.dealerCards.slice(0, 1) },
    ]
    for (const fields of tampered) {
      expect(table.send(ALICE, fields, WAGER * 2n).error).toBe('bad-reveal')
      expect(table.state).toBe(before)
    }
    expect(table.send(ALICE, honest, WAGER * 2n).error).toBeUndefined()
  })

  it('cannot settle a hand whose dealt cards were not the committed ones', () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    const deck = deriveDeck(table.seed, BET_DIGEST, 0)
    // A dealer that hands the player different cards than its deck gives.
    const fake = deck.slice(10, 12)
    expect(
      table.send(ALICE, { action: 'deal', playerCards: fake, dealerUpCard: deck[1] }).error,
    ).toBeUndefined()
    if (table.state?.phase === 'player_turn') table.send(BOB, { action: 'stand' })
    const played = playOutDealer(deck, fake, 4)
    const result = table.send(ALICE, {
      action: 'reveal',
      dealerCards: played.dealerCards,
      seed: table.seed,
      outcome: played.outcome,
    })
    expect(result.error).toBe('bad-reveal')
    expect(table.state?.phase).toBe('dealer_turn')
  })

  it('rejects malformed deals and cards', () => {
    const table = open('dealer', seeds.twoHits, BET_DIGEST)
    const deck = deriveDeck(table.seed, BET_DIGEST, 0)
    const deal = (playerCards: number[], dealerUpCard: number) =>
      table.send(ALICE, { action: 'deal', playerCards, dealerUpCard }).error
    expect(deal([deck[0]], deck[1])).toBe('bad-cards')
    expect(deal([deck[0], deck[0]], deck[1])).toBe('bad-cards')
    expect(deal([deck[0], deck[2]], deck[0])).toBe('bad-cards')
    expect(deal([deck[0], 52], deck[1])).toBe('bad-cards')
    expect(deal([deck[0], 1.5], deck[1])).toBe('bad-cards')
    table.dealerActs()
    table.send(BOB, { action: 'hit' })
    const card = (playerCards: number[]) =>
      table.send(ALICE, { action: 'card', playerCards }).error
    const had = table.state!.playerCards
    expect(card(had)).toBe('bad-cards')
    expect(card([...had, deck[4], deck[5]])).toBe('bad-cards')
    expect(card([had[1], had[0], deck[4]])).toBe('bad-cards')
    expect(card([...had, had[0]])).toBe('bad-cards')
    expect(card([...had, table.state!.dealerUpCard!])).toBe('bad-cards')
    expect(card([...had, deck[4]])).toBeUndefined()
  })

  it('gives a dealer holding the wrong seed nothing to send', () => {
    const table = open('dealer', seeds.win, BET_DIGEST)
    expect(dealerStep(table.state, seeds.loss)).toBeUndefined()
    expect(dealerStep(undefined, seeds.win)).toBeUndefined()
  })

  it('gives the same dealer step every time it is asked', () => {
    const table = standing()
    expect(dealerStep(table.state, table.seed)).toEqual(dealerStep(table.state, table.seed))
  })
})

it('has a preview line for every action', () => {
  for (const action of [
    'challenge',
    'accept',
    'bet',
    'deal',
    'hit',
    'stand',
    'double',
    'card',
    'reveal',
    'refund',
  ])
    expect(handPreviewText(item({ action }))).toMatch(/\S/)
  expect(handPreviewText(item({ action: 'future' }))).toBe('Blackjack')
})

describe('what a wallet may send', () => {
  const RESERVE = 200n
  it('refuses a challenge above what the challenger can cover in its role', () => {
    const challenge = (role: 'dealer' | 'player', maxBetWei: bigint, spendableWei: bigint) =>
      buildChallenge({ gameId: GAME, role, maxBetWei, spendableWei, reserveWei: RESERVE, seed: seeds.win })
    expect(challengeLimitWei('dealer', 1_000n, RESERVE)).toBe(200n)
    expect(challengeLimitWei('player', 1_000n, RESERVE)).toBe(800n)
    expect(challenge('dealer', 201n, 1_000n)).toEqual({ error: 'above-own-limit' })
    expect(challenge('player', 801n, 1_000n)).toEqual({ error: 'above-own-limit' })
    expect(challenge('player', 0n, 1_000n)).toEqual({ error: 'not-positive' })
    expect(challenge('player', 1n, RESERVE)).toEqual({ error: 'above-own-limit' })
    expect(challenge('dealer', 200n, 1_000n)).toEqual({
      item: {
        type: 'blackjack-hand',
        gameId: GAME,
        action: 'challenge',
        role: 'dealer',
        maxBetWei: '200',
        commitment: commitmentOf(seeds.win),
      },
    })
    expect(challenge('player', 800n, 1_000n)).toEqual({
      item: { type: 'blackjack-hand', gameId: GAME, action: 'challenge', role: 'player', maxBetWei: '800' },
    })
    expect(() =>
      buildChallenge({ gameId: GAME, role: 'dealer', maxBetWei: 1n, spendableWei: 1_000n, reserveWei: 0n }),
    ).toThrow('seed')
  })

  it('accepts at the lower of the challenge and what the dealer can cover', () => {
    const table = new Table(BOB, ALICE, seeds.win)
    table.send(ALICE, { action: 'challenge', role: 'player', maxBetWei: '500' })
    const accept = (spendableWei: bigint, wantedMaxBetWei?: bigint) =>
      buildAccept({ state: table.state!, spendableWei, reserveWei: RESERVE, seed: seeds.win, wantedMaxBetWei })
    expect(accept(100_000n)).toMatchObject({ item: { action: 'accept', maxBetWei: '500' } })
    expect(accept(1_000n)).toMatchObject({ item: { maxBetWei: '200' } })
    expect(accept(RESERVE)).toEqual({ error: 'above-own-limit' })
    expect(accept(100_000n, 300n)).toMatchObject({ item: { maxBetWei: '300' } })
    expect(accept(100_000n, 501n)).toEqual({ error: 'above-max-bet' })
    expect(accept(1_000n, 300n)).toEqual({ error: 'above-own-limit' })
    expect(accept(1_000n, 0n)).toEqual({ error: 'not-positive' })
    const built = accept(1_000n) as { item: HandItem }
    expect(table.send(BOB, built.item).error).toBeUndefined()
    expect(table.state).toMatchObject({ phase: 'open', maxBetWei: 200n })
  })

  it('checks a wager against the hand and the wallet', () => {
    const state = { maxBetWei: 500n }
    expect(checkWager(state, 0n, 10_000n, RESERVE)).toBe('not-positive')
    expect(checkWager(state, 501n, 10_000n, RESERVE)).toBe('above-max-bet')
    expect(checkWager(state, 500n, 699n, RESERVE)).toBe('above-own-limit')
    expect(checkWager(state, 500n, 700n, RESERVE)).toBeUndefined()
  })

  it('reads hand events from a message and nothing from other items', () => {
    const bet = item({ action: 'bet' })
    expect(
      handEventsOf({
        items: [{ type: 'text' }, bet],
        senderAddress: BOB,
        recipientAddress: ALICE,
        stampValueWei: 7n,
        payloadDigest: 'd1',
      }),
    ).toEqual([{ item: bet, from: BOB, to: ALICE, stampWei: 7n, digest: 'd1' }])
    expect(
      handEventsOf({ items: [bet], senderAddress: BOB, recipientAddress: ALICE, payloadDigest: 'd2' })[0]
        .stampWei,
    ).toBe(0n)
  })
})
