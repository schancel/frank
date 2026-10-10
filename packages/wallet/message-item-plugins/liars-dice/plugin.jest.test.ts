import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initLiarsDicePlugin } from './plugin'

describePluginContract({
  type: 'liars-dice',
  init: initLiarsDicePlugin,
  samples: [
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'create',
        buyInWei: '100',
        maxPlayers: 4,
        dicePerPlayer: 5,
      },
      preview: "Liar's Dice: Table created (t1)",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'join',
        players: [
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ],
      },
      preview: "Liar's Dice: Player joined",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'round_start',
        diceCounts: [5, 5],
        roundNumber: 1,
        activePlayer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        turnTimeoutSeconds: 30,
        serverCommit:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        playerCommits: {
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':
            'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        myDice: [1, 2, 3, 4, 6],
      },
      preview: "Liar's Dice (Perudo)",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'bid',
        currentBid: {
          bidder: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          quantity: 3,
          face: 4,
        },
      },
      preview: "Liar's Dice Bid: 3x [4]",
    },
    {
      item: { type: 'liars-dice', tableId: 't1', action: 'bid' },
      preview: "Liar's Dice (Perudo)",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'challenge',
        challenger: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      preview: "Liar's Dice: Called Liar!",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'showdown',
        serverSeed:
          'c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5',
        playerSeeds: {
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa':
            'a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb':
            'b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5',
        },
        revealedCups: {
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': [1, 1, 2],
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': [],
        },
        challengeResult: {
          bidQuantity: 3,
          bidFace: 4,
          actualCount: 2,
          wildAcesCount: 2,
          challengerWon: true,
          loserAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          eliminated: false,
        },
      },
      preview: "Liar's Dice: Showdown!",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'settle',
        winnerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        potWei: '200',
        txHash:
          '0x0101010101010101010101010101010101010101010101010101010101010101',
        stealthAddress: '0x5555555555555555555555555555555555555555',
      },
      preview: "Liar's Dice: Table Settled!",
    },
  ],
})
