import { deriveDeck, handValue, sha256Hex } from './deck'
import {
  applyDoubleRejection,
  blackjackPayoutWei,
  BlackjackGameState,
  formatBlackjackError,
  parseBlackjackError,
  validateBetWei,
  HydratedBlackjackMove,
  reduceBlackjackState,
  resolveOutcome,
  verifyRevealedHand,
} from './game'

const SERVER_SEED = 'bot-secret-seed-1'
const WAGER_TX_HASH = '0xwagertxhash'
const PLAYER_ADDRESS = '0xPlayerAddress'

function move(partial: Partial<HydratedBlackjackMove>): HydratedBlackjackMove {
  return {
    gameId: 'game-1',
    action: 'bet',
    senderAddress: PLAYER_ADDRESS,
    ...partial,
  }
}

describe('reduceBlackjackState', () => {
  it('walks a full, non-bust, player-wins hand through every phase', () => {
    const deck = deriveDeck(SERVER_SEED, WAGER_TX_HASH, 0)
    const playerCards = [deck[0], deck[2]]
    const dealerCards = [deck[1], deck[3]]

    let state: BlackjackGameState | undefined
    state = reduceBlackjackState(
      state,
      move({
        action: 'bet',
        wagerTxHash: WAGER_TX_HASH,
        verifiedWager: {
          fromAddress: PLAYER_ADDRESS,
          toAddress: '0xBotAddress',
          valueWei: 10000000000000000n,
        },
      }),
    )
    expect(state.phase).toBe('awaiting_deal')
    expect(state.verifiedWagerWei).toBe(10000000000000000n)

    state = reduceBlackjackState(
      state,
      move({
        action: 'deal',
        serverSeedHash: 'commitment-hash',
        playerCards,
        dealerUpCard: dealerCards[0],
      }),
    )
    expect(state.phase).toBe('player_turn')
    expect(state.availableActions).toEqual(['hit', 'stand', 'double'])

    state = reduceBlackjackState(state, move({ action: 'stand' }))
    expect(state.phase).toBe('dealer_turn')
    expect(state.availableActions).toEqual([])

    state = reduceBlackjackState(
      state,
      move({
        action: 'reveal',
        dealerCards,
        serverSeed: SERVER_SEED,
        outcome: 'player_win',
      }),
    )
    expect(state.phase).toBe('resolved')
    expect(state.outcome).toBe('player_win')
    expect(state.availableActions).toEqual(['bet'])
  })

  it('knows the outcome of a bust immediately, but still waits for an explicit reveal', () => {
    let state: BlackjackGameState | undefined = reduceBlackjackState(
      undefined,
      move({ action: 'bet', wagerTxHash: WAGER_TX_HASH }),
    )
    state = reduceBlackjackState(
      state,
      move({ action: 'deal', playerCards: [10, 9], dealerUpCard: 0 }), // 10+10=20, not blackjack
    )
    expect(state.availableActions).toEqual(['hit', 'stand', 'double'])

    // King(12) + Queen(11) + 5(rank 4) = bust
    state = reduceBlackjackState(state, move({ action: 'hit', playerCards: [12, 11, 4] }))
    // Not 'resolved' yet -- every hand, busted or not, ends via an explicit 'reveal' so
    // serverSeed always gets published and the hand stays independently verifiable.
    expect(state.phase).toBe('dealer_turn')
    expect(state.outcome).toBe('dealer_win')
    expect(state.availableActions).toEqual([])

    state = reduceBlackjackState(
      state,
      move({ action: 'reveal', dealerCards: [0, 1], serverSeed: SERVER_SEED, outcome: 'dealer_win' }),
    )
    expect(state.phase).toBe('resolved')
  })

  it('ignores a duplicate bet for a thread that already has state', () => {
    const first = reduceBlackjackState(undefined, move({ wagerTxHash: '0xfirst' }))
    const second = reduceBlackjackState(first, move({ wagerTxHash: '0xsecond' }))
    expect(second).toBe(first)
  })

  it('ignores an out-of-order hit before a deal', () => {
    const betState = reduceBlackjackState(undefined, move({ action: 'bet' }))
    const afterBadHit = reduceBlackjackState(
      betState,
      move({ action: 'hit', playerCards: [1, 2, 3] }),
    )
    expect(afterBadHit).toBe(betState)
  })

  it('offers double as a third option on the freshly-dealt hand', () => {
    const betState = reduceBlackjackState(undefined, move({ action: 'bet' }))
    const dealtState = reduceBlackjackState(
      betState,
      move({ action: 'deal', playerCards: [9, 10], dealerUpCard: 0 }), // 10+10=20, not blackjack
    )
    expect(dealtState.availableActions).toEqual(['hit', 'stand', 'double'])
  })

  it('folds a double-down through both its own request and the dealer broadcast without losing the verified transfer', () => {
    const dealtState = reduceBlackjackState(
      reduceBlackjackState(undefined, move({ action: 'bet' })),
      move({ action: 'deal', playerCards: [9, 10], dealerUpCard: 0 }), // 10+10=20
    )

    // The player's own outgoing request: carries the verified second transfer, no cards yet.
    const requested = reduceBlackjackState(
      dealtState,
      move({
        action: 'double',
        verifiedDoubleWager: {
          fromAddress: PLAYER_ADDRESS,
          toAddress: '0xBotAddress',
          valueWei: 10000000000000000n,
        },
      }),
    )
    expect(requested.phase).toBe('dealer_turn')
    expect(requested.doubled).toBe(true)
    expect(requested.availableActions).toEqual([])
    expect(requested.verifiedDoubleWagerWei).toBe(10000000000000000n)

    // The dealer's broadcast of the resulting card: carries the new hand, no transfer of its own
    // -- must not clobber the already-verified wager with `undefined`.
    const dealt = reduceBlackjackState(
      requested,
      move({ action: 'double', playerCards: [9, 10, 1] }), // +2 = 22, bust
    )
    expect(dealt.playerCards).toEqual([9, 10, 1])
    expect(dealt.doubled).toBe(true)
    expect(dealt.verifiedDoubleWagerWei).toBe(10000000000000000n)
    expect(dealt.outcome).toBe('dealer_win')
    expect(dealt.phase).toBe('dealer_turn')
  })

  it('ignores a double-down after a hit has already been taken', () => {
    const dealtState = reduceBlackjackState(
      reduceBlackjackState(undefined, move({ action: 'bet' })),
      move({ action: 'deal', playerCards: [9, 10], dealerUpCard: 0 }),
    )
    const afterHit = reduceBlackjackState(
      dealtState,
      move({ action: 'hit', playerCards: [9, 10, 0] }),
    )
    const afterBadDouble = reduceBlackjackState(
      afterHit,
      move({
        action: 'double',
        verifiedDoubleWager: {
          fromAddress: PLAYER_ADDRESS,
          toAddress: '0xBotAddress',
          valueWei: 10000000000000000n,
        },
      }),
    )
    expect(afterBadDouble).toBe(afterHit)
  })
})

describe('double lockout recovery', () => {
  const dealt = () =>
    reduceBlackjackState(
      reduceBlackjackState(undefined, move({ action: 'bet' })),
      move({ action: 'deal', playerCards: [9, 10], dealerUpCard: 0 }),
    )
  const requestDouble = (s: BlackjackGameState) =>
    reduceBlackjackState(
      s,
      move({
        action: 'double',
        verifiedDoubleWager: { fromAddress: PLAYER_ADDRESS, toAddress: '0xBot', valueWei: 5n },
      }),
    )

  it('an error reply unlocks the optimistic double, offering only hit/stand', () => {
    const requested = requestDouble(dealt())
    expect(requested.doublePending).toBe(true)
    expect(requested.availableActions).toEqual([])
    const recovered = applyDoubleRejection(requested)
    expect(recovered.phase).toBe('player_turn')
    expect(recovered.doubled).toBe(false)
    expect(recovered.doublePending).toBe(false)
    expect(recovered.verifiedDoubleWagerWei).toBeUndefined()
    expect(recovered.availableActions).toEqual(['hit', 'stand'])
  })

  it('a late authoritative broadcast re-locks to the real state after a rejection was assumed', () => {
    const recovered = applyDoubleRejection(requestDouble(dealt()))
    const broadcast = reduceBlackjackState(
      recovered,
      move({ action: 'double', playerCards: [9, 10, 3] }),
    )
    expect(broadcast.doubled).toBe(true)
    expect(broadcast.doublePending).toBe(false)
    expect(broadcast.playerCards).toEqual([9, 10, 3])
    expect(broadcast.availableActions).toEqual([])
  })

  it('only acts in dealer_turn', () => {
    const s: BlackjackGameState = { ...requestDouble(dealt()), phase: 'player_turn' }
    expect(applyDoubleRejection(s)).toBe(s)
  })

  it('only acts while the hand still has exactly two cards', () => {
    const s: BlackjackGameState = { ...requestDouble(dealt()), playerCards: [9, 10, 3] }
    expect(applyDoubleRejection(s)).toBe(s)
  })

  it('never rewinds a state the dealer already answered', () => {
    const answered = reduceBlackjackState(
      requestDouble(dealt()),
      move({ action: 'double', playerCards: [9, 10, 3] }),
    )
    expect(applyDoubleRejection(answered)).toBe(answered)
    const fresh = dealt()
    expect(applyDoubleRejection(fresh)).toBe(fresh)
  })
})

describe('blackjack error token', () => {
  it('round-trips awkward game ids and stays readable', () => {
    for (const id of ['g1', 'a"b', 'x\\y', 'has [game="z"] inside', 'line\nbreak', 'é🃏']) {
      const text = formatBlackjackError(id, 'nope: really')
      expect(text.startsWith('Blackjack: nope: really')).toBe(true)
      expect(parseBlackjackError(text)).toEqual({ gameId: id, text: 'nope: really' })
    }
  })
  it('does not parse untagged or foreign text', () => {
    expect(parseBlackjackError('Blackjack: nope')).toBeUndefined()
    expect(parseBlackjackError('hello [game="g1"]')).toBeUndefined()
    expect(parseBlackjackError('Blackjack: x [game=g1]')).toBeUndefined()
  })
})

describe('validateBetWei', () => {
  it.each([
    [0n, /greater than zero/],
    [-1n, /greater than zero/],
    [10n ** 16n - 1n, /minimum/],
    [10n ** 18n + 1n, /maximum/],
  ])('rejects %s', (wei, msg) => {
    expect(validateBetWei(wei)).toMatch(msg)
  })
  it('accepts the inclusive bounds', () => {
    expect(validateBetWei(10n ** 16n)).toBeUndefined()
    expect(validateBetWei(10n ** 18n)).toBeUndefined()
  })
})

describe('verifyRevealedHand', () => {
  it('accepts a genuinely fair, correctly-played hand', () => {
    const deck = deriveDeck(SERVER_SEED, WAGER_TX_HASH, 0)
    const playerCards = [deck[0], deck[2]]
    let dealerCards = [deck[1], deck[3]]
    let next = 4
    while (handValue(dealerCards).total < 17) {
      dealerCards = [...dealerCards, deck[next]]
      next += 1
    }
    const state: BlackjackGameState = {
      gameId: 'g',
      phase: 'resolved',
      playerAddress: PLAYER_ADDRESS,
      wagerTxHash: WAGER_TX_HASH,
      serverSeed: SERVER_SEED,
      serverSeedHash: sha256Hex(SERVER_SEED),
      playerCards,
      dealerCards,
      outcome: resolveOutcome(
        handValue(playerCards),
        handValue(dealerCards),
      ),
      availableActions: [],
    }
    expect(verifyRevealedHand(state)).toEqual({ valid: true })
  })

  it('rejects a revealed seed that does not match its own earlier commitment', () => {
    const state: BlackjackGameState = {
      gameId: 'g',
      phase: 'resolved',
      playerAddress: PLAYER_ADDRESS,
      wagerTxHash: WAGER_TX_HASH,
      serverSeed: SERVER_SEED,
      serverSeedHash: 'not-the-real-hash',
      playerCards: [0, 1],
      dealerCards: [2, 3],
      outcome: 'push',
      availableActions: [],
    }
    const result = verifyRevealedHand(state)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/commit/)
  })

  it('rejects a dealt hand that does not match the committed shuffle (a cheating bot)', () => {
    const deck = deriveDeck(SERVER_SEED, WAGER_TX_HASH, 0)
    const state: BlackjackGameState = {
      gameId: 'g',
      phase: 'resolved',
      playerAddress: PLAYER_ADDRESS,
      wagerTxHash: WAGER_TX_HASH,
      serverSeed: SERVER_SEED,
      serverSeedHash: sha256Hex(SERVER_SEED),
      // Tampered: doesn't match deck[0]/deck[2].
      playerCards: [(deck[0] + 1) % 52, deck[2]],
      dealerCards: [deck[1], deck[3]],
      outcome: 'push',
      availableActions: [],
    }
    const result = verifyRevealedHand(state)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/player cards/)
  })
})

describe('blackjackPayoutWei', () => {
  const WAGER = 100_000_000_000_000_000n
  const resolved = (
    outcome: BlackjackGameState['outcome'],
    extra: Partial<BlackjackGameState> = {},
  ) => ({
    phase: 'resolved' as const,
    outcome,
    verifiedWagerWei: WAGER,
    ...extra,
  })

  it.each([
    ['player_win', WAGER * 2n],
    ['player_blackjack', (WAGER * 5n) / 2n],
    ['push', WAGER],
    ['dealer_win', 0n],
  ] as const)('%s pays %s', (outcome, expected) => {
    expect(blackjackPayoutWei(resolved(outcome))).toBe(expected)
  })

  it('a double pays on both verified transfers', () => {
    expect(
      blackjackPayoutWei(
        resolved('player_win', { doubled: true, verifiedDoubleWagerWei: WAGER }),
      ),
    ).toBe(WAGER * 4n)
  })

  it('a double whose second transfer is not verified is not counted', () => {
    expect(blackjackPayoutWei(resolved('player_win', { doubled: true }))).toBe(
      WAGER * 2n,
    )
  })

  it('has no figure until the hand is resolved with a verified wager', () => {
    expect(
      blackjackPayoutWei({ ...resolved('player_win'), phase: 'dealer_turn' }),
    ).toBeUndefined()
    expect(
      blackjackPayoutWei({ ...resolved('player_win'), verifiedWagerWei: undefined }),
    ).toBeUndefined()
    expect(blackjackPayoutWei(resolved(undefined))).toBeUndefined()
  })
})
