import {
  createLiarsDiceGame,
  joinGame,
  startNextRound,
  applyBid,
  applyChallenge,
  getActivePlayer,
  getTotalDiceInPlay,
} from './game'

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
})
