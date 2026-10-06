import {
  createPokerTable,
  joinPokerTable,
  startNewHand,
  applyPlayerAction,
} from './game'

describe("Texas Hold'em Poker Game Engine", () => {
  it('manages blinds, streets (preflop, flop, turn, river), and showdown settlement', () => {
    const table = createPokerTable({
      tableId: 'poker_test_1',
      buyInChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    })

    expect(table.street).toBe('waiting')

    // 2 players join
    expect(joinPokerTable(table, '0xAlice').success).toBe(true)
    expect(joinPokerTable(table, '0xBob').success).toBe(true)
    expect(table.players).toHaveLength(2)

    // Start hand
    expect(startNewHand(table).success).toBe(true)
    expect(table.street).toBe('preflop')

    // In heads-up (2 players), dealer is SB (10 chips) and non-dealer is BB (20 chips)
    // SB acts first preflop!
    const sbPlayer = table.players.find(p => p.currentStreetBet === 10)!
    const bbPlayer = table.players.find(p => p.currentStreetBet === 20)!
    expect(sbPlayer.chips).toBe(990)
    expect(bbPlayer.chips).toBe(980)

    // First active player preflop is SB player
    expect(table.players[table.activePlayerIndex].address).toBe(sbPlayer.address)

    // SB calls the 20 BB (puts in 10 more chips)
    expect(applyPlayerAction(table, sbPlayer.address, 'call').success).toBe(true)
    expect(sbPlayer.currentStreetBet).toBe(20)
    expect(sbPlayer.chips).toBe(980)

    // BB checks to see the flop
    expect(applyPlayerAction(table, bbPlayer.address, 'check').success).toBe(true)

    // Flop is dealt! 3 board cards
    expect(table.street).toBe('flop')
    expect(table.boardCards).toHaveLength(3)
    expect(table.pot).toBe(40) // 20 + 20

    // Flop betting: non-dealer (BB) checks
    const activeFlop1 = table.players[table.activePlayerIndex]
    expect(applyPlayerAction(table, activeFlop1.address, 'check').success).toBe(true)

    // Other player checks
    const activeFlop2 = table.players[table.activePlayerIndex]
    expect(applyPlayerAction(table, activeFlop2.address, 'check').success).toBe(true)

    // Turn is dealt! 4 board cards
    expect(table.street).toBe('turn')
    expect(table.boardCards).toHaveLength(4)

    // Turn betting: player bets 50
    const activeTurn1 = table.players[table.activePlayerIndex]
    expect(applyPlayerAction(table, activeTurn1.address, 'bet', 50).success).toBe(true)

    // Opponent calls 50
    const activeTurn2 = table.players[table.activePlayerIndex]
    expect(applyPlayerAction(table, activeTurn2.address, 'call').success).toBe(true)

    // River is dealt! 5 board cards
    expect(table.street).toBe('river')
    expect(table.boardCards).toHaveLength(5)
    expect(table.pot).toBe(140) // 40 + 100

    // River betting: both check
    const activeRiver1 = table.players[table.activePlayerIndex]
    applyPlayerAction(table, activeRiver1.address, 'check')
    const activeRiver2 = table.players[table.activePlayerIndex]
    applyPlayerAction(table, activeRiver2.address, 'check')

    // Showdown! Hand is settled and pot is disbursed
    expect(table.street).toBe('settled')
    expect(table.pot).toBe(0)
    expect(table.winners).toBeDefined()
    expect(table.winners!.length).toBeGreaterThanOrEqual(1)

    // Total chips across both players equals 2000
    const totalChips = table.players.reduce((sum, p) => sum + p.chips, 0)
    expect(totalChips).toBe(2000)
  })

  it('immediately awards pot when all other players fold', () => {
    const table = createPokerTable({
      tableId: 'poker_test_fold',
      buyInChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
    })

    joinPokerTable(table, '0xAlice')
    joinPokerTable(table, '0xBob')
    startNewHand(table)

    const sbPlayer = table.players.find(p => p.currentStreetBet === 10)!
    const bbPlayer = table.players.find(p => p.currentStreetBet === 20)!

    // SB folds preflop
    expect(applyPlayerAction(table, sbPlayer.address, 'fold').success).toBe(true)

    // BB immediately wins pot (10 + 20 = 30 chips)
    expect(table.street).toBe('settled')
    expect(table.winners).toHaveLength(1)
    expect(table.winners![0].address).toBe(bbPlayer.address)
    expect(table.winners![0].amount).toBe(30)
    expect(bbPlayer.chips).toBe(980 + 30)
  })
})
