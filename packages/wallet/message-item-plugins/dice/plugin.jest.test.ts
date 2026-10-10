import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initDicePlugin } from './plugin'

describePluginContract({
  type: 'dice',
  init: initDicePlugin,
  samples: [
    { item: { type: 'dice', action: 'table' }, preview: 'Satoshi Dice Roll' },
    {
      item: {
        type: 'dice',
        action: 'roll',
        rollId: 'r1',
        target: 32768,
        multiplier: 1.98,
        wagerWei: '10',
        userNonce: 'n',
      },
      preview: 'Satoshi Dice Roll',
    },
    {
      item: {
        type: 'dice',
        action: 'result',
        rollId: 'r1',
        luckyNumber: 12345,
        isWin: true,
        serverSecret: 's',
        payoutWei: '19',
        txHash: '0x1',
      },
      preview: 'Satoshi Dice: Rolled 12345 (Win!)',
    },
    {
      item: {
        type: 'dice',
        action: 'result',
        luckyNumber: 60000,
        isWin: false,
      },
      preview: 'Satoshi Dice: Rolled 60000 (Loss)',
    },
  ],
})
