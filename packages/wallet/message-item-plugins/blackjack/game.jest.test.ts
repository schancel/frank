import { deriveDeck, handValue, sha256Hex } from './deck'
import {
  BlackjackGameState,
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
    expect(state.availableActions).toEqual(['hit', 'stand'])

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
    expect(state.availableActions).toEqual(['hit', 'stand'])

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
