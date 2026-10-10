import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initPokerPlugin } from './plugin'

const base = {
  type: 'poker' as const,
  tableId: 't1',
  smallBlind: 1,
  bigBlind: 2,
  pot: 0,
}
const player = {
  address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  chips: 100,
  currentStreetBet: 2,
  totalHandBet: 2,
  folded: false,
  isAllIn: false,
  isDealerButton: true,
  isSmallBlind: false,
  isBigBlind: true,
}

describePluginContract({
  type: 'poker',
  init: initPokerPlugin,
  samples: [
    {
      item: { ...base, action: 'create', buyInWei: '100' },
      preview: "Texas Hold'em Table created (t1)",
    },
    {
      item: { ...base, action: 'join' },
      preview: "Texas Hold'em: Player joined",
    },
    {
      item: {
        ...base,
        action: 'deal',
        pot: 3,
        street: 'preflop',
        currentBet: 2,
        minRaise: 2,
        activePlayer: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        boardCards: [],
        players: [
          player,
          {
            ...player,
            address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            holeCards: [1, 2],
          },
        ],
        myHoleCards: [10, 11],
        sidePots: [
          {
            amount: 1,
            eligiblePlayers: ['0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
          },
        ],
      },
      preview: "Texas Hold'em: Hand dealt (pot: 3)",
    },
    {
      item: {
        ...base,
        action: 'action',
        lastAction: {
          player: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          action: 'raise',
          amount: 6,
        },
      },
      preview: 'Poker: 0xAAAAAA raise 6',
    },
    {
      item: {
        ...base,
        action: 'action',
        lastAction: {
          player: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          action: 'check',
        },
      },
      preview: 'Poker: 0xAAAAAA check',
    },
    { item: { ...base, action: 'action' }, preview: "Texas Hold'em Poker" },
    {
      item: {
        ...base,
        action: 'showdown',
        street: 'showdown',
        winners: [
          {
            address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            amount: 3,
            handDescription: 'Pair',
            best5Cards: [1, 2, 3, 4, 5],
          },
          { address: '0xcccccccccccccccccccccccccccccccccccccccc', amount: 1 },
        ],
      },
      preview: "Texas Hold'em: Showdown!",
    },
    {
      item: {
        ...base,
        action: 'settle',
        winnerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        txHash:
          '0x0101010101010101010101010101010101010101010101010101010101010101',
        stealthAddress: '0x5555555555555555555555555555555555555555',
      },
      preview: "Texas Hold'em: Hand settled!",
    },
  ],
})
