import { deriveDeck, handValue, sha256Hex } from './deck'
import {
  applyDoubleRejection,
  BLACKJACK_RULES_SUMMARY,
  BLACKJACK_WELCOME_GAME_ID,
  BLACKJACK_WELCOME_RULES_MAX,
  buildBlackjackWelcomeItem,
  parseBlackjackWelcome,
  playOutDealer,
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

  it('a double whose second transfer is not verified has no figure, not a too-small one', () => {
    expect(
      blackjackPayoutWei(resolved('player_win', { doubled: true })),
    ).toBeUndefined()
  })

  it('formatBlackjackError keeps its own doc comment', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(require.resolve('./game'), 'utf8')
    const at = source.indexOf('export function formatBlackjackError')
    expect(source.slice(source.lastIndexOf('/**', at), at)).toContain(
      "The dealer's rejection text",
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

// Ticket #378: the client-side fairness check must follow exactly the dealing rules the dealer bot
// plays by. `botReference` is a frozen copy of the bot's original resolve step
// (`packages/bot/blackjack-bot.livecheck.ts` `resolveAndReveal`, before it moved onto the shared
// `playOutDealer`), kept here so the shared function cannot drift from the bot's behaviour.
describe('dealing rules shared by the bot and the fairness check (#378)', () => {
  function botReference(seed: string, txHash: string, hits: number) {
    const deck = deriveDeck(seed, txHash, 0)
    let dealtCount = 4 + hits
    const playerCards = [deck[0], deck[2], ...deck.slice(4, dealtCount)]
    const playerValue = handValue(playerCards)
    let dealerCards = [deck[1], deck[3]]
    if (!playerValue.bust && !playerValue.blackjack) {
      while (handValue(dealerCards).total < 17) {
        dealerCards = [...dealerCards, deck[dealtCount]]
        dealtCount += 1
      }
    }
    const outcome = playerValue.bust
      ? 'dealer_win'
      : resolveOutcome(playerValue, handValue(dealerCards))
    return { playerCards, dealerCards, dealtCount, outcome, deck }
  }

  function revealed(seed: string, txHash: string, hits: number): BlackjackGameState {
    const ref = botReference(seed, txHash, hits)
    return {
      gameId: 'g',
      phase: 'resolved',
      playerAddress: PLAYER_ADDRESS,
      wagerTxHash: txHash,
      serverSeed: seed,
      serverSeedHash: sha256Hex(seed),
      playerCards: ref.playerCards,
      dealerCards: ref.dealerCards,
      outcome: ref.outcome,
      availableActions: [],
    }
  }

  it('regression: a fair player natural against a dealer under 17 verifies', () => {
    let found = 0
    for (let i = 0; i < 20000 && found < 3; i++) {
      const seed = `natural-${i}`
      const ref = botReference(seed, WAGER_TX_HASH, 0)
      const dealerStart = handValue([ref.deck[1], ref.deck[3]])
      if (!handValue(ref.playerCards).blackjack || dealerStart.total >= 17) continue
      found++
      // The dealer really stays put, and the check agrees.
      expect(ref.dealerCards).toEqual([ref.deck[1], ref.deck[3]])
      expect(verifyRevealedHand(revealed(seed, WAGER_TX_HASH, 0))).toEqual({
        valid: true,
      })
    }
    expect(found).toBe(3)
  })

  it('a fixed seed known to be a natural vs a dealer under 17', () => {
    // Found by scanning `natural-N`; pins one concrete case so the regression does not depend on
    // the scan above finding anything.
    const seed = 'natural-12'
    const ref = botReference(seed, WAGER_TX_HASH, 0)
    expect(handValue(ref.playerCards).blackjack).toBe(true)
    expect(handValue([ref.deck[1], ref.deck[3]]).total).toBeLessThan(17)
    expect(verifyRevealedHand(revealed(seed, WAGER_TX_HASH, 0))).toEqual({
      valid: true,
    })
  })

  it('playOutDealer equals the bot rules, and every fair hand verifies, for 6000 seeds x 0-2 extra player cards', () => {
    const seen = { natural: 0, push: 0, bust: 0, win: 0, loss: 0, drew: 0 }
    for (let i = 0; i < 6000; i++) {
      const seed = `table-${i}`
      const txHash = `0xtx${i}`
      for (const hits of [0, 1, 2]) {
        const ref = botReference(seed, txHash, hits)
        const shared = playOutDealer(ref.deck, ref.playerCards, 4 + hits)
        expect(shared.dealerCards).toEqual(ref.dealerCards)
        expect(shared.dealtCount).toBe(ref.dealtCount)
        expect(shared.outcome).toBe(ref.outcome)
        expect(verifyRevealedHand(revealed(seed, txHash, hits))).toEqual({
          valid: true,
        })
        if (hits === 0 && handValue(ref.playerCards).blackjack) seen.natural++
        if (ref.outcome === 'push') seen.push++
        if (handValue(ref.playerCards).bust) seen.bust++
        if (ref.outcome === 'player_win') seen.win++
        if (ref.outcome === 'dealer_win') seen.loss++
        if (ref.dealerCards.length > 2) seen.drew++
      }
    }
    // The table really covers naturals, pushes, busts, wins, losses and dealer draws.
    for (const [name, count] of Object.entries(seen)) {
      expect([name, count > 0]).toEqual([name, true])
    }
  })

  it('a tampered hand still fails (dealer card, player card, outcome, seed)', () => {
    const seed = 'table-7'
    const good = revealed(seed, WAGER_TX_HASH, 0)
    const flip = (cards: number[]) => [(cards[0] + 1) % 52, ...cards.slice(1)]
    expect(
      verifyRevealedHand({ ...good, playerCards: flip(good.playerCards) }).valid,
    ).toBe(false)
    expect(
      verifyRevealedHand({ ...good, serverSeed: 'other' }).valid,
    ).toBe(false)
    expect(
      verifyRevealedHand({
        ...good,
        outcome: good.outcome === 'push' ? 'player_win' : 'push',
      }).valid,
    ).toBe(false)
    // A dealer that drew when it should not (natural) or did not draw when it should is caught.
    for (let i = 0; i < 20000; i++) {
      const s = `natural-${i}`
      const ref = botReference(s, WAGER_TX_HASH, 0)
      if (handValue(ref.playerCards).blackjack && handValue([ref.deck[1], ref.deck[3]]).total < 17) {
        const drawn = [...ref.dealerCards, ref.deck[4]]
        expect(
          verifyRevealedHand({ ...revealed(s, WAGER_TX_HASH, 0), dealerCards: drawn }).valid,
        ).toBe(false)
        break
      }
    }
  })

  it('tampered dealer cards on a player bust fail verification (#380)', () => {
    let bustFound = false
    const flip = (cards: number[]) => [(cards[0] + 1) % 52, ...cards.slice(1)]
    for (let i = 0; i < 20000; i++) {
      const s = `bust-check-${i}`
      for (const hits of [1, 2, 3]) {
        const ref = botReference(s, WAGER_TX_HASH, hits)
        if (handValue(ref.playerCards).bust) {
          const goodBust = revealed(s, WAGER_TX_HASH, hits)
          expect(verifyRevealedHand(goodBust)).toEqual({ valid: true })

          // Replacing dealer cards fails verification:
          expect(
            verifyRevealedHand({ ...goodBust, dealerCards: flip(goodBust.dealerCards) }),
          ).toEqual({
            valid: false,
            reason: 'recorded dealer cards do not match the committed shuffle',
          })

          // Extra drawn card by dealer on player bust also fails:
          expect(
            verifyRevealedHand({
              ...goodBust,
              dealerCards: [...goodBust.dealerCards, ref.deck[4 + hits]],
            }),
          ).toEqual({
            valid: false,
            reason: 'recorded dealer cards do not match the committed shuffle',
          })

          bustFound = true
          break
        }
      }
      if (bustFound) break
    }
    expect(bustFound).toBe(true)
  })
})

describe('welcome item schema (#395)', () => {
  const table = {
    minWagerWei: 10n ** 16n,
    maxWagerWei: 10n ** 18n,
    feeHintWei: 6n * 10n ** 16n,
    rules: BLACKJACK_RULES_SUMMARY,
  }

  it('builds a blackjack-move welcome item with decimal-string limits and parses it back', () => {
    const item = buildBlackjackWelcomeItem(table)
    expect(item).toEqual({
      type: 'blackjack-move',
      gameId: BLACKJACK_WELCOME_GAME_ID,
      action: 'welcome',
      minWagerWei: '10000000000000000',
      maxWagerWei: '1000000000000000000',
      feeHintWei: '60000000000000000',
      rules: BLACKJACK_RULES_SUMMARY,
    })
    // Survives the JSON wire form exactly.
    expect(parseBlackjackWelcome(JSON.parse(JSON.stringify(item)))).toEqual({
      ...table,
      rules: BLACKJACK_RULES_SUMMARY.slice(0, BLACKJACK_WELCOME_RULES_MAX),
    })
  })

  it('leaves optional fields out and parses them as absent', () => {
    const item = buildBlackjackWelcomeItem({
      minWagerWei: 1n,
      maxWagerWei: 2n,
    })
    expect(Object.keys(item).sort()).toEqual(
      ['action', 'gameId', 'maxWagerWei', 'minWagerWei', 'type'].sort(),
    )
    expect(parseBlackjackWelcome(item)).toEqual({
      minWagerWei: 1n,
      maxWagerWei: 2n,
      feeHintWei: undefined,
      rules: undefined,
    })
  })

  it.each([
    ['not a welcome', { action: 'bet', minWagerWei: '1', maxWagerWei: '2' }],
    ['a missing limit', { action: 'welcome', minWagerWei: '1' }],
    ['a numeric (not string) limit', { action: 'welcome', minWagerWei: 1, maxWagerWei: 2 }],
    ['a fractional limit', { action: 'welcome', minWagerWei: '1.5', maxWagerWei: '2' }],
    ['a negative limit', { action: 'welcome', minWagerWei: '-1', maxWagerWei: '2' }],
    ['a hex limit', { action: 'welcome', minWagerWei: '0x10', maxWagerWei: '0x20' }],
    ['a zero minimum', { action: 'welcome', minWagerWei: '0', maxWagerWei: '2' }],
    ['min above max', { action: 'welcome', minWagerWei: '3', maxWagerWei: '2' }],
    [
      'an absurdly long number',
      { action: 'welcome', minWagerWei: '1', maxWagerWei: '9'.repeat(200) },
    ],
  ])('ignores the whole welcome for %s', (_name, item) => {
    expect(parseBlackjackWelcome(item)).toBeUndefined()
  })

  it('drops a malformed optional field and bounds the rules text instead of trusting it', () => {
    const parsed = parseBlackjackWelcome({
      action: 'welcome',
      minWagerWei: '1',
      maxWagerWei: '2',
      feeHintWei: 'lots',
      rules: 'x'.repeat(5000),
    })
    expect(parsed?.feeHintWei).toBeUndefined()
    expect(parsed?.rules).toHaveLength(BLACKJACK_WELCOME_RULES_MAX)
  })

  it('the reducer ignores a welcome and an unknown action, keeping a hand intact', () => {
    const inHand = reduceBlackjackState(undefined, move({ action: 'bet' }))
    const welcome = reduceBlackjackState(inHand, move({ action: 'welcome' }))
    expect(welcome).toBe(inHand)
    const unknown = reduceBlackjackState(
      inHand,
      move({ action: 'surrender' as never }),
    )
    expect(unknown).toBe(inHand)
    expect(reduceBlackjackState(undefined, move({ action: 'welcome' })).availableActions).toEqual([])
  })
})
