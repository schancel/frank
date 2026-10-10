import type { NativeWalletHandle, ReceivedCoinSweep } from '@frank/wallet/chain'
import {
  MessageFundsNotSweptError,
  settleOutgoingPayments,
  stripReleasedPayments,
  sweepBeforeDelete,
} from './sweep-on-delete'
import type { ChatMessage } from '../stores/chats'

const mockGetWallet = jest.fn()
jest.mock('../accounts/session', () => ({
  accountSession: { getWallet: () => mockGetWallet() },
}))

const message = (overrides: Partial<ChatMessage>): ChatMessage =>
  ({
    outbound: false,
    status: 'confirmed',
    receivedTime: 1000,
    serverTime: 1000,
    items: [{ type: 'text', text: 'hi' }],
    outpoints: [],
    stampPayments: [
      { txHash: '0xtx', destinationAddress: '0xchild', valueWei: 1000n },
    ],
    senderAddress: '0xsender',
    payloadDigest: 'aa',
    ...overrides,
  } as ChatMessage)

/** The wallet seam: its ONE typed operation. Nothing else of the wallet is touched. */
function walletAnswering(answers: Record<string, ReceivedCoinSweep>) {
  const sweepReceivedCoins = jest.fn(
    async ({ payloadDigests }: { payloadDigests: readonly string[] }) =>
      Object.fromEntries(
        payloadDigests.flatMap(digest =>
          digest in answers ? [[digest, answers[digest]]] : [],
        ),
      ),
  )
  return {
    wallet: { sweepReceivedCoins } as unknown as NativeWalletHandle,
    sweepReceivedCoins,
  }
}

describe('sweepBeforeDelete', () => {
  beforeEach(() => jest.clearAllMocks())

  it('asks the wallet once, for every received message that can have brought money', async () => {
    const { wallet, sweepReceivedCoins } = walletAnswering({
      aa: { outcome: 'swept' },
      bb: { outcome: 'none' },
      cc: { outcome: 'swept' },
    })
    const clearance = await sweepBeforeDelete(
      [
        message({ payloadDigest: 'aa' }),
        message({ payloadDigest: 'bb' }),
        // A stealth payment with no stamp still brought money.
        message({
          payloadDigest: 'cc',
          stampPayments: [],
          items: [{ type: 'stealth', amount: 5 }],
        }),
        // None of these can hold a coin of this wallet: they need no wallet at all.
        message({ payloadDigest: 'dd', outbound: true }),
        message({ payloadDigest: 'ee', stampPayments: [] }),
        message({ payloadDigest: 'pending:1' }),
      ],
      wallet,
    )
    expect(sweepReceivedCoins).toHaveBeenCalledTimes(1)
    expect(sweepReceivedCoins).toHaveBeenCalledWith({
      payloadDigests: ['aa', 'bb', 'cc'],
    })
    expect(clearance.kept.size).toBe(0)
  })

  it('keeps a message whose sweep failed or is not in a block yet, with the wallet reason', async () => {
    const { wallet } = walletAnswering({
      aa: { outcome: 'swept' },
      bb: { outcome: 'failed', reason: 'node unreachable' },
      cc: { outcome: 'pending', reason: 'not in a block yet' },
    })
    const clearance = await sweepBeforeDelete(
      [
        message({ payloadDigest: 'aa' }),
        message({ payloadDigest: 'bb' }),
        message({ payloadDigest: 'cc' }),
        // The wallet gave no answer for this one: it stays too.
        message({ payloadDigest: 'dd' }),
      ],
      wallet,
    )
    expect([...clearance.kept]).toEqual([
      ['bb', 'node unreachable'],
      ['cc', 'not in a block yet'],
      ['dd', 'the wallet gave no answer'],
    ])
    expect(new MessageFundsNotSweptError(clearance.kept).message).toBe(
      "3 messages were not deleted: the money they brought could not be moved to your wallet's main account yet (node unreachable; not in a block yet; the wallet gave no answer).",
    )
  })

  it('keeps every such message when the wallet cannot be reached or throws', async () => {
    mockGetWallet.mockRejectedValueOnce(new Error('wallet is locked'))
    const locked = await sweepBeforeDelete([
      message({ payloadDigest: 'aa' }),
      message({ payloadDigest: 'bb', outbound: true }),
    ])
    expect([...locked.kept]).toEqual([['aa', 'wallet is locked']])

    const wallet = {
      sweepReceivedCoins: jest
        .fn()
        .mockRejectedValue(new Error('storage failed')),
    } as unknown as NativeWalletHandle
    const thrown = await sweepBeforeDelete(
      [message({ payloadDigest: 'aa' })],
      wallet,
    )
    expect([...thrown.kept]).toEqual([['aa', 'storage failed']])
  })

  it('needs no wallet for messages that brought nothing, and none for a wallet with no coin list', async () => {
    const nothing = await sweepBeforeDelete([
      message({ payloadDigest: 'aa', outbound: true }),
      message({ payloadDigest: 'bb', stampPayments: [] }),
    ])
    expect(nothing.kept.size).toBe(0)
    expect(mockGetWallet).not.toHaveBeenCalled()

    const other = await sweepBeforeDelete(
      [message({ payloadDigest: 'aa' })],
      {} as NativeWalletHandle,
    )
    expect(other.kept.size).toBe(0)
  })
})

describe('settleOutgoingPayments', () => {
  beforeEach(() => jest.clearAllMocks())
  const stealth = (key: string) => ({
    type: 'stealth',
    amount: 5,
    ephemeralPubKey: key,
  })

  it('asks the wallet to release or finish each payment an outgoing message carried, and nothing for received ones', async () => {
    const settleContactPayment = jest.fn().mockResolvedValue('released')
    await settleOutgoingPayments(
      [
        message({
          payloadDigest: 'aa',
          outbound: true,
          items: [stealth('02aa')] as never,
        }),
        message({
          payloadDigest: 'bb',
          outbound: false,
          items: [stealth('02bb')] as never,
        }),
        message({ payloadDigest: 'cc', outbound: true }),
      ],
      { settleContactPayment } as unknown as NativeWalletHandle,
    )
    expect(settleContactPayment.mock.calls).toEqual([['02aa']])
  })

  it('never fails the delete: a wallet that cannot be reached is logged and the wallet finishes it later', async () => {
    mockGetWallet.mockRejectedValueOnce(new Error('wallet is locked'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(
      settleOutgoingPayments([
        message({
          payloadDigest: 'aa',
          outbound: true,
          items: [stealth('02aa')] as never,
        }),
      ]),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('stripReleasedPayments', () => {
  it('keeps the bubble and removes the signed transfer, leaving an item that cannot be sent', () => {
    const released = message({
      payloadDigest: 'pending:1',
      outbound: true,
      items: [
        { type: 'text', text: 'for lunch' },
        {
          type: 'stealth',
          amount: 5,
          memo: 'lunch',
          ephemeralPubKey: '02aa',
          transactions: ['02f8signedtransfer'],
        },
      ] as never,
    })
    stripReleasedPayments(released)
    expect(released.items).toEqual([
      { type: 'text', text: 'for lunch' },
      {
        type: 'stealth',
        amount: 5,
        memo: 'lunch',
        ephemeralPubKey: '02aa',
        transactions: [],
      },
    ])
    expect(JSON.stringify(released.items)).not.toContain('signedtransfer')
  })
})
