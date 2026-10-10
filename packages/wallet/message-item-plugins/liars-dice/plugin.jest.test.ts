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
        players: ['0xA', '0xB'],
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
        activePlayer: '0xA',
        turnTimeoutSeconds: 30,
        serverCommit: 'cc',
        playerCommits: { '0xB': 'bb', '0xA': 'aa' },
        myDice: [1, 2, 3, 4, 6],
      },
      preview: "Liar's Dice (Perudo)",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'bid',
        currentBid: { bidder: '0xA', quantity: 3, face: 4 },
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
        challenger: '0xB',
      },
      preview: "Liar's Dice: Called Liar!",
    },
    {
      item: {
        type: 'liars-dice',
        tableId: 't1',
        action: 'showdown',
        serverSeed: 'ss',
        playerSeeds: { '0xA': 'sa', '0xB': 'sb' },
        revealedCups: { '0xA': [1, 1, 2], '0xB': [] },
        challengeResult: {
          bidQuantity: 3,
          bidFace: 4,
          actualCount: 2,
          wildAcesCount: 2,
          challengerWon: true,
          loserAddress: '0xA',
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
        winnerAddress: '0xB',
        potWei: '200',
        txHash: '0x1',
        stealthAddress: '0xS',
      },
      preview: "Liar's Dice: Table Settled!",
    },
  ],
})
