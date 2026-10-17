import {
  createPokerTable,
  joinPokerTable,
  startNewHand,
  applyPlayerAction,
  setPokerPlayerCommit,
  setPokerPlayerSeed,
  verifyPokerShowdown,
  foldPokerState,
} from './game'
import { commitSeed } from './deck'

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

    // Showdown verification succeeds on untampered state
    const check = verifyPokerShowdown(table)
    expect(check.verified).toBe(true)
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

  it('verifies multi-party committed seeds and rejects tampered hole cards or mismatched seed reveals', () => {
    const table = createPokerTable({
      tableId: 'poker_fair_1',
      buyInChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
      serverSeed: 'dealer-secret-999',
    })
    joinPokerTable(table, '0xAlice')
    joinPokerTable(table, '0xBob')

    const aliceSeed = 'alice-secret-111'
    const bobSeed = 'bob-secret-222'
    expect(setPokerPlayerCommit(table, '0xAlice', commitSeed(aliceSeed)).success).toBe(true)
    expect(setPokerPlayerCommit(table, '0xBob', commitSeed(bobSeed)).success).toBe(true)

    // Mismatched seed reveal is rejected
    expect(setPokerPlayerSeed(table, '0xAlice', 'wrong-alice-seed').success).toBe(false)
    expect(setPokerPlayerSeed(table, '0xAlice', aliceSeed).success).toBe(true)
    expect(setPokerPlayerSeed(table, '0xBob', bobSeed).success).toBe(true)

    expect(
      startNewHand(table, 'dealer-secret-999', {
        '0xAlice': aliceSeed,
        '0xBob': bobSeed,
      }).success,
    ).toBe(true)

    expect(verifyPokerShowdown(table).verified).toBe(true)

    // Tamper with Alice's hole cards
    const originalCard = table.players[0].holeCards[0]
    table.players[0].holeCards[0] = (originalCard + 1) % 52
    const tamperedCardCheck = verifyPokerShowdown(table)
    expect(tamperedCardCheck.verified).toBe(false)
    expect(tamperedCardCheck.reason).toMatch(/hole cards/i)
    table.players[0].holeCards[0] = originalCard

    // Tamper with serverSeed
    const badServerCheck = verifyPokerShowdown({
      ...table,
      serverSeed: 'forged-server-seed',
    })
    expect(badServerCheck.verified).toBe(false)
    expect(badServerCheck.reason).toMatch(/server seed/i)
  })

  it('deterministically folds table state from mailbox messages and flags tampered reveals', () => {
    const table = createPokerTable({
      tableId: 'poker_fold_log',
      buyInChips: 1000,
      smallBlind: 10,
      bigBlind: 20,
    })
    joinPokerTable(table, '0xAlice')
    joinPokerTable(table, '0xBob')
    startNewHand(table, 'server-seed-abc', {
      '0xAlice': 'alice-seed-abc',
      '0xBob': 'bob-seed-abc',
    })

    // Play out to showdown via all-in and call
    const first = table.players[table.activePlayerIndex].address
    const second = table.players.find(p => p.address !== first)!.address
    applyPlayerAction(table, first, 'all_in')
    applyPlayerAction(table, second, 'call')
    expect(table.street).toBe('settled')

    const validMessages = [
      {
        type: 'poker' as const,
        tableId: table.tableId,
        action: 'create' as const,
        smallBlind: 10,
        bigBlind: 20,
        pot: 0,
      },
      {
        type: 'poker' as const,
        tableId: table.tableId,
        action: 'deal' as const,
        smallBlind: 10,
        bigBlind: 20,
        pot: 30,
        street: 'preflop' as const,
        serverCommit: table.serverCommit,
        playerCommits: table.playerCommits,
        holeCardCommits: table.holeCardCommits,
        players: table.players.map((p, idx) => ({
          address: p.address,
          chips: 980,
          currentStreetBet: 20,
          totalHandBet: 20,
          folded: false,
          isAllIn: false,
          isDealerButton: idx === table.dealerIndex,
          isSmallBlind: idx === table.dealerIndex,
          isBigBlind: idx !== table.dealerIndex,
        })),
      },
      {
        type: 'poker' as const,
        tableId: table.tableId,
        action: 'showdown' as const,
        smallBlind: 10,
        bigBlind: 20,
        pot: 2000,
        street: 'showdown' as const,
        boardCards: table.boardCards,
        serverSeed: table.serverSeed,
        playerSeeds: table.playerSeeds,
        holeCardSalts: table.holeCardSalts,
        players: table.players.map((p, idx) => ({
          address: p.address,
          chips: p.chips,
          currentStreetBet: 0,
          totalHandBet: 1000,
          folded: false,
          isAllIn: true,
          isDealerButton: idx === table.dealerIndex,
          isSmallBlind: idx === table.dealerIndex,
          isBigBlind: idx !== table.dealerIndex,
          holeCards: [...p.holeCards],
        })),
        winners: table.winners?.map(w => ({
          address: w.address,
          amount: w.amount,
        })),
      },
    ]

    const foldedValid = foldPokerState(validMessages)
    expect(foldedValid).toBeDefined()
    expect(foldedValid!.verified).toBe(true)
    expect(foldedValid!.boardCards).toEqual(table.boardCards)

    // Now tamper with a hole card in the showdown message
    const tamperedMessages = [
      validMessages[0],
      validMessages[1],
      {
        ...validMessages[2],
        players: validMessages[2].players.map((p, idx) =>
          idx === 0
            ? { ...p, holeCards: [(p.holeCards![0] + 1) % 52, p.holeCards![1]] }
            : p,
        ),
      },
    ]
    const foldedTampered = foldPokerState(tamperedMessages)
    expect(foldedTampered).toBeDefined()
    expect(foldedTampered!.verified).toBe(false)
    expect(foldedTampered!.verificationError).toBeDefined()
  })
})
