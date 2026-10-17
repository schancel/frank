import {
  createLiarsDiceGame,
  joinGame,
  startNextRound,
  setPlayerRoundCommit,
  setPlayerRoundSecret,
  verifyLiarsDiceReveal,
  foldLiarsDiceState,
  applyBid,
  applyChallenge,
  getActivePlayer,
  getTotalDiceInPlay,
} from './game'
import { commitSeed } from './dice'

describe("Liar's Dice Game State Machine", () => {
  it('handles full lifecycle: table creation, joining, bidding, challenge, elimination and victory', () => {
    const game = createLiarsDiceGame({
      tableId: 'table_test_1',
      hostAddress: '0xHost',
      buyInWei: 1000n,
      maxPlayers: 3,
      dicePerPlayer: 2, // short 2-dice game for fast unit testing
    })

    expect(game.status).toBe('waiting_for_players')
    expect(game.potWei).toBe(0n)

    // Player joins
    expect(joinGame(game, '0xAlice').success).toBe(true)
    expect(joinGame(game, '0xBob').success).toBe(true)
    expect(game.potWei).toBe(2000n)
    expect(getTotalDiceInPlay(game)).toBe(4)

    // Cannot join twice
    expect(joinGame(game, '0xAlice').success).toBe(false)

    // Start Round 1
    expect(startNextRound(game).success).toBe(true)
    expect(game.status).toBe('round_active')
    expect(game.roundNumber).toBe(1)

    // Active player is Alice (index 0)
    expect(getActivePlayer(game)?.address).toBe('0xAlice')

    // Alice bids 2 threes
    const bid1 = applyBid(game, '0xAlice', 2, 3)
    expect(bid1.success).toBe(true)
    expect(game.currentBid).toEqual({ bidder: '0xAlice', quantity: 2, face: 3 })

    // Active player is Bob (index 1)
    expect(getActivePlayer(game)?.address).toBe('0xBob')

    // Bob raises to 2 fours
    const bid2 = applyBid(game, '0xBob', 2, 4)
    expect(bid2.success).toBe(true)

    // Alice calls Liar!
    const challenge = applyChallenge(game, '0xAlice')
    expect(challenge.success).toBe(true)
    expect(game.status).toBe('showdown')
    expect(challenge.resolution).toBeDefined()

    // Verify showdown reveal is cryptographically valid
    expect(verifyLiarsDiceReveal(game).verified).toBe(true)

    // Loser has lost 1 die
    const loser = game.players.find(p => p.address === challenge.resolution!.loserAddress)!
    expect(loser.diceCount).toBe(1)
    expect(loser.eliminated).toBe(false)

    // Start Round 2
    expect(startNextRound(game).success).toBe(true)
    const activeRound2 = getActivePlayer(game)!

    // Bidding in round 2
    applyBid(game, activeRound2.address, 1, 2)
    const otherPlayer = game.players.find(p => p.address !== activeRound2.address)!

    // Other player challenges
    const challenge2 = applyChallenge(game, otherPlayer.address)
    expect(challenge2.success).toBe(true)

    // Check if someone was eliminated or continue until 1 winner
    if (!game.winnerAddress) {
      // Continue rounds until resolved
      let safetyCounter = 0
      while (game.status !== 'resolved' && safetyCounter < 10) {
        safetyCounter++
        startNextRound(game)
        const currentActive = getActivePlayer(game)!
        applyBid(game, currentActive.address, 1, 2)
        const opponent = game.players.find(p => !p.eliminated && p.address !== currentActive.address)!
        applyChallenge(game, opponent.address)
      }
    }

    expect(game.status).toBe('resolved')
    expect(game.winnerAddress).toBeDefined()
    expect(game.players.filter(p => !p.eliminated)).toHaveLength(1)
    expect(game.players.find(p => !p.eliminated)!.address).toBe(game.winnerAddress)
  })

  it('verifies multi-party committed seeds and rejects tampered dice cups or mismatched seed reveals', () => {
    const game = createLiarsDiceGame({
      tableId: 'table_fair_1',
      hostAddress: '0xAlice',
      buyInWei: 1000n,
      dicePerPlayer: 3,
    })
    joinGame(game, '0xAlice')
    joinGame(game, '0xBob')
    startNextRound(game, 'server-secret-xyz')

    const aliceSeed = 'alice-secret-seed'
    const bobSeed = 'bob-secret-seed'
    expect(setPlayerRoundCommit(game, '0xAlice', commitSeed(aliceSeed)).success).toBe(true)
    expect(setPlayerRoundCommit(game, '0xBob', commitSeed(bobSeed)).success).toBe(true)

    // Mismatched player seed reveal is rejected
    expect(setPlayerRoundSecret(game, '0xAlice', 'wrong-seed').success).toBe(false)
    expect(setPlayerRoundSecret(game, '0xAlice', aliceSeed).success).toBe(true)
    expect(setPlayerRoundSecret(game, '0xBob', bobSeed).success).toBe(true)

    applyBid(game, '0xAlice', 2, 3)
    const challenge = applyChallenge(game, '0xBob')
    expect(challenge.success).toBe(true)

    const validCheck = verifyLiarsDiceReveal(game)
    expect(validCheck.verified).toBe(true)

    // Tamper with Alice's dice cup
    const origDie = game.players[0].currentDice![0]
    game.players[0].currentDice![0] = (origDie % 6) + 1
    const tamperedCheck = verifyLiarsDiceReveal(game)
    expect(tamperedCheck.verified).toBe(false)
    expect(tamperedCheck.reason).toMatch(/dice/i)
    game.players[0].currentDice![0] = origDie
  })

  it('deterministically folds Liars Dice state from mailbox messages and flags tampered reveals', () => {
    const game = createLiarsDiceGame({
      tableId: 'ld_fold_1',
      hostAddress: '0xAlice',
      buyInWei: 500n,
      dicePerPlayer: 3,
    })
    joinGame(game, '0xAlice')
    joinGame(game, '0xBob')
    startNextRound(game, 'server-seed-fold', {
      '0xAlice': 'alice-seed-fold',
      '0xBob': 'bob-seed-fold',
    })

    const roundStartCups = {
      '0xAlice': [...game.players[0].currentDice!],
      '0xBob': [...game.players[1].currentDice!],
    }
    const roundStartCommits = { ...game.playerCommits }
    const roundStartSeeds = { ...game.playerSeeds }

    applyBid(game, '0xAlice', 2, 4)
    const res = applyChallenge(game, '0xBob')
    expect(res.success).toBe(true)
    const r = res.resolution!

    const messages = [
      {
        type: 'liars-dice' as const,
        tableId: game.tableId,
        action: 'create' as const,
        buyInWei: '500',
        dicePerPlayer: 3,
        players: ['0xAlice'],
        diceCounts: [3],
      },
      {
        type: 'liars-dice' as const,
        tableId: game.tableId,
        action: 'join' as const,
        players: ['0xAlice', '0xBob'],
        diceCounts: [3, 3],
      },
      {
        type: 'liars-dice' as const,
        tableId: game.tableId,
        action: 'round_start' as const,
        roundNumber: 1,
        players: ['0xAlice', '0xBob'],
        diceCounts: [3, 3],
        activePlayer: '0xAlice',
        serverCommit: game.serverCommit,
        playerCommits: roundStartCommits,
      },
      {
        type: 'liars-dice' as const,
        tableId: game.tableId,
        action: 'bid' as const,
        currentBid: { bidder: '0xAlice', quantity: 2, face: 4 },
        activePlayer: '0xBob',
      },
      {
        type: 'liars-dice' as const,
        tableId: game.tableId,
        action: 'showdown' as const,
        players: ['0xAlice', '0xBob'],
        diceCounts: game.players.map(p => p.diceCount),
        challenger: '0xBob',
        serverSeed: game.serverSeed,
        playerSeeds: roundStartSeeds,
        revealedCups: roundStartCups,
        challengeResult: {
          bidQuantity: r.bid.quantity,
          bidFace: r.bid.face,
          actualCount: r.totalMatchingDice,
          wildAcesCount: r.wildAcesCount,
          challengerWon: r.challengerWon,
          loserAddress: r.loserAddress,
          eliminated: r.eliminated,
        },
      },
    ]

    const folded = foldLiarsDiceState(messages)
    expect(folded).toBeDefined()
    expect(folded!.verified).toBe(true)
    expect(folded!.status).toBe('showdown')
    expect(folded!.lastResolution?.loserAddress).toBe(r.loserAddress)

    // Tamper with revealedCups in the showdown message
    const tamperedMessages = [
      ...messages.slice(0, 4),
      {
        ...messages[4],
        revealedCups: {
          ...roundStartCups,
          '0xAlice': [6, 6, 6],
        },
      },
    ]
    const foldedTampered = foldLiarsDiceState(tamperedMessages)
    expect(foldedTampered).toBeDefined()
    expect(foldedTampered!.verified).toBe(false)
    expect(foldedTampered!.verificationError).toBeDefined()
  })
})
