/** @jest-environment jsdom */
import type { SwapRecord } from '../stores/swaps'

const mockSend = jest.fn()
jest.mock('@frank/wallet/chain', () => ({
  activeChain: { directMessages: { send: (p: unknown) => mockSend(p) } },
}))
const mockWallet = { identity: { address: { raw: '0xSelf' } } }
jest.mock('src/accounts/session', () => ({
  accountSession: { getWallet: async () => mockWallet },
}))

import { swapRecordCodec } from '@frank/wallet/message-item-plugins/swap-record/codec'
import { decodeSwapRecord, swapRecordItem } from '../stores/swaps'
import { fromHex } from '@frank/codec'
import { sendSwapNote, swapNoteMessageId } from './swap-note'

const record: SwapRecord = {
  id: 'swap-0xabc',
  timestamp: 1_800_000_000_000,
  chain: 'monad',
  chainIdentifier: 'monad-testnet',
  fromAsset: 'MON',
  toAsset: 'USDC',
  fromAmount: '0.02',
  toAmount: '≥0.019796',
  txHash: '0xabc',
  route: 'Uniswap v4',
  feeDisplay: '0.0211 MON',
  status: 'pending',
  recovery: {
    operationId: 'evm-native-v1:0000000000000001',
    venueId: 'uniswap-v4',
    account: '0xMain',
    route: { key: { fee: 500 }, zeroForOne: true },
    call: { to: '0xRouter', data: '0x00', value: '1' },
    toDecimals: 6,
  },
}

beforeEach(() => mockSend.mockReset())

describe('the note to self that records a swap', () => {
  it('is a free message to the account’s own address carrying the record, under an id fixed by the transaction', async () => {
    mockSend.mockResolvedValue({})
    await sendSwapNote(record)
    const sent = mockSend.mock.calls[0]![0]
    expect(sent.wallet).toBe(mockWallet)
    expect(sent.recipient).toEqual({ raw: '0xSelf' })
    expect(sent.stampValue).toBe(0n)
    expect(sent.messageId).toEqual(swapNoteMessageId(record))
    expect(sent.messageId).toHaveLength(16)
    expect(swapNoteMessageId({ ...record, timestamp: 5 })).toEqual(
      sent.messageId,
    )
    expect(swapNoteMessageId({ ...record, txHash: '0xdef' })).not.toEqual(
      sent.messageId,
    )
    expect(sent.items).toHaveLength(1)
    expect(sent.items[0]).toMatchObject({
      type: 'swap-record',
      swapId: 'swap-0xabc',
      txHash: '0xabc',
      fromAsset: 'MON',
      toAsset: 'USDC',
      status: 'pending',
    })
    // What another frontend needs rides in the record's own encoding: the canonical chain,
    // the venue, the account and the route. This device's operation and call do not.
    const carried = decodeSwapRecord(fromHex(sent.items[0].cborPayload))
    expect(carried.chainIdentifier).toBe('monad-testnet')
    expect(carried.recovery).toEqual({
      venueId: 'uniswap-v4',
      account: '0xMain',
      route: { key: { fee: 500 }, zeroForOne: true },
      toDecimals: 6,
    })
  })

  it('treats a note this wallet already sent as sent', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('already'), {
        name: 'DirectMessageAlreadyAttemptedError',
      }),
    )
    await expect(sendSwapNote(record)).resolves.toBeUndefined()
  })

  it('reports any other failure, so the note stays owed', async () => {
    mockSend.mockRejectedValue(new Error('relay unreachable'))
    await expect(sendSwapNote(record)).rejects.toThrow('relay unreachable')
  })

  it('carries an item the real swap-record codec accepts, for a real transaction hash', () => {
    const hash =
      '0x84564acf0ed72071cb888d0c93e8eadfb5cc8367430bd0fd0f1bd271b591b779'
    const item = swapRecordItem({
      ...record,
      id: hash.slice(2),
      txHash: hash,
      toAmount: '0.004947',
      destinationAddress: '0x1A63C39618d00e386B8872BF390DBCfEB6619Db5',
      recovery: {
        ...record.recovery!,
        route: {
          key: {
            currency0: '0x0000000000000000000000000000000000000000',
            currency1: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
            fee: 500,
            tickSpacing: 10,
            hooks: '0x0000000000000000000000000000000000000000',
          },
          zeroForOne: true,
        },
      },
    })
    // Encoding validates every field (id, amounts, transaction id, payload size) and throws
    // on the first one the item's schema refuses.
    expect(swapRecordCodec.encode(item).length).toBeGreaterThan(0)
    expect(() =>
      swapRecordCodec.encode({ ...item, toAmount: '≥0.004947' }),
    ).toThrow()
  })
})
