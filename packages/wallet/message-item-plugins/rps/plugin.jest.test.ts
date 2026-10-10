import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initRpsPlugin } from './plugin'

describePluginContract({
  type: 'rps',
  init: initRpsPlugin,
  samples: [
    {
      item: {
        type: 'rps',
        action: 'challenge',
        matchId: 'm1',
        wagerWei: '100',
        opponentAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      preview: 'Rock-Paper-Scissors Challenge',
    },
    {
      item: {
        type: 'rps',
        action: 'start',
        matchId: 'm1',
        commitHash:
          'abababababababababababababababababababababababababababababababab',
      },
      preview: 'Rock-Paper-Scissors Match',
    },
    {
      item: { type: 'rps', action: 'move', playerMove: 'rock' },
      preview: 'Rock-Paper-Scissors',
    },
    {
      item: {
        type: 'rps',
        action: 'resolve',
        playerMove: 'rock',
        botMove: 'scissors',
        secretSalt: '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
        outcome: 'win',
        txHash:
          '0x0101010101010101010101010101010101010101010101010101010101010101',
      },
      preview: 'RPS Result: You won!',
    },
    {
      item: { type: 'rps', action: 'resolve', outcome: 'lose' },
      preview: 'RPS Result: You lost',
    },
    {
      item: { type: 'rps', action: 'resolve', outcome: 'tie' },
      preview: 'RPS Result: Tie',
    },
  ],
})
