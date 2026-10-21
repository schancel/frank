import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initDicePlugin } from './plugin'
import {
  encodeCanonical,
  encodeFrame,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type Encodable,
} from '@frank/codec'
import { MessageItemDecodeError, MessageItemEncodeError } from '../registry'
import {
  registryWith,
  standaloneDecodeContext,
} from '../shared/plugin-contract.testutil'
import { diceCodec } from './codec'
import { decodeItemFrames } from '../wire'

describePluginContract({
  type: 'dice',
  init: initDicePlugin,
  samples: [
    {
      item: {
        type: 'dice',
        action: 'rejected',
        rollId: 'original-roll',
        rejectionReason: 'payout-limit',
      },
      preview: 'Satoshi Dice: No roll was made',
    },
    { item: { type: 'dice', action: 'table' }, preview: 'Satoshi Dice Roll' },
    {
      item: {
        type: 'dice',
        action: 'roll',
        rollId: 'r1',
        target: 32768,
        multiplier: 1.98,
        wagerWei: '10',
        commitment:
          'abababababababababababababababababababababababababababababababab',
        clientSeed: '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
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
        serverSecret: '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
        payoutWei: '19',
        nextRollId: 'r2',
        nextCommitment:
          'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
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

describe('dice rejection schema', () => {
  it.each([
    new Map<number, string>([
      [0, 'rejected'],
      [1, 'original-roll'],
    ]),
    new Map<number, string>([
      [0, 'rejected'],
      [13, 'payout-limit'],
    ]),
    new Map<number, string>([
      [0, 'rejected'],
      [1, 'original-roll'],
      [13, 'unknown-reason'],
    ]),
    new Map<number, string>([
      [0, 'unknown-action'],
      [1, 'original-roll'],
    ]),
    new Map<number, string>([
      [0, 'table'],
      [13, 'payout-limit'],
    ]),
    new Map<number, string>([
      [0, 'rejected'],
      [1, 'original-roll'],
      [9, '100'],
      [13, 'payout-limit'],
    ]),
  ])(
    'rejects malformed rejection facts with a typed decode failure',
    fields => {
      expect(() =>
        diceCodec.decode(encodeCanonical(fields), standaloneDecodeContext()),
      ).toThrow(MessageItemDecodeError)
    },
  )

  it('requires correlation and reason before encoding an outbound rejection', () => {
    expect(() =>
      diceCodec.encode({ type: 'dice', action: 'rejected' }),
    ).toThrow(MessageItemEncodeError)
  })

  it('retains an unknown envelope version without interpreting its rejection', () => {
    const data = diceCodec.encode({
      type: 'dice',
      action: 'rejected',
      rollId: 'r1',
      rejectionReason: 'payout-limit',
    })
    const frame = encodeFrame(
      { typeId: 27, schemaVersion: 999, minReaderVersion: 999 },
      new Map<number, Encodable>([
        [0, 'dice'],
        [1, data],
      ]),
    )
    const revision = validateFrame(
      encodeFrame(
        { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
        new Map<number, Encodable>([
          [0, 'frank'],
          [1, [frame]],
        ]),
      ),
    )
    if (revision.kind !== 'parsed' || revision.typed?.type !== 20)
      throw new Error('expected a revision')
    expect(
      decodeItemFrames(
        registryWith('dice', initDicePlugin),
        revision.typed.items,
        standaloneItemBudget(),
      ),
    ).toEqual([
      {
        type: 'unsupported',
        reason: 'unknown-type',
        frameType: 27,
        frame: toHex(frame),
      },
    ])
  })
})
