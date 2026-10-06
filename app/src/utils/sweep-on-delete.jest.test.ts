import { sweepMessageFundsOnDelete } from './sweep-on-delete'
import type { ChatMessage } from '../stores/chats'

jest.mock('@frank/wallet/monad-stamp-stealth', () => ({
  deriveMonadStampChildPrivate: jest.fn(() => ({
    address: '0xChildAddress123',
    privateKey: new Uint8Array(32).fill(7),
  })),
}))

jest.mock('@frank/wallet/monad-stamp-client', () => {
  const actual = jest.requireActual('@frank/wallet/monad-stamp-client')
  return {
    ...actual,
    sweepRecoveredMonadStampPayment: jest.fn(async () => ({
      swept: true,
      txHash: '0xSweepTxHash123',
      valueWei: 1000000000000000000n,
      destinationAddress: '0xChangeAddressBip44',
    })),
  }
})

jest.mock('@frank/cashweb/relay', () => ({
  relayChangeAddressPublicKey: jest.fn(() => new Uint8Array(33).fill(2)),
}))

describe('sweepMessageFundsOnDelete', () => {
  it('does not sweep funds for outbound messages', async () => {
    const message: ChatMessage = {
      outbound: true,
      status: 'sent',
      receivedTime: 1000,
      serverTime: 1000,
      items: [{ type: 'text', text: 'Hello' }],
      outpoints: [],
      stampPayments: [
        {
          txHash: '0xTxHash1',
          destinationAddress: '0xChildAddress123',
          valueWei: 1000000000000000000n,
        },
      ],
      senderAddress: '0xSender',
      payloadDigest: '0xDigest1',
    }

    const outcome = await sweepMessageFundsOnDelete({ message })
    expect(outcome.sweptCount).toBe(0)
    expect(outcome.sweptWei).toBe(0n)
    expect(outcome.txHashes).toEqual([])
  })

  it('sweeps Monad stamp payments to the ephemeral change account derived from seed', async () => {
    const { deriveMonadStampChildPrivate } = jest.requireMock(
      '@frank/wallet/monad-stamp-stealth',
    )
    const { sweepRecoveredMonadStampPayment } = jest.requireMock(
      '@frank/wallet/monad-stamp-client',
    )

    const message: ChatMessage = {
      outbound: false,
      status: 'received',
      receivedTime: 1000,
      serverTime: 1000,
      items: [{ type: 'text', text: 'Stamper payment' }],
      outpoints: [],
      stampPayments: [
        {
          txHash: '0xTxHash1',
          destinationAddress: '0xChildAddress123',
          valueWei: 1000000000000000000n,
        },
      ],
      senderAddress: '0xSender',
      payloadDigest:
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    }

    const mockChangePool = {
      peekNextChangeAddress: jest.fn(() => ({
        index: 3,
        address: '0xChangeAddressBip44',
      })),
      setNextUnusedIndex: jest.fn(),
    }

    const mockJournal = {
      get: jest.fn(() => ({
        payloadHashHex:
          'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        childIndex: 0,
        txHash: '0xTxHash1',
        address: '0xChildAddress123',
        valueWei: '1000000000000000000',
        status: 'discovered',
      })),
      put: jest.fn().mockResolvedValue(undefined),
    }

    const mockWallet = {
      identity: {
        toPrivateKeyHex: () => '0x' + '11'.repeat(32),
        displayAddress: '0xUserMainAddress',
      },
      changePool: mockChangePool,
      stampPaymentJournal: mockJournal,
      provider: {
        getBalance: jest.fn().mockResolvedValue(1000000000000000000n),
      },
      httpClient: {
        submit: jest.fn().mockResolvedValue('0xSweepTxHash123'),
      },
    }

    const outcome = await sweepMessageFundsOnDelete({
      message,
      wallet: mockWallet as never,
    })

    expect(deriveMonadStampChildPrivate).toHaveBeenCalledWith({
      payloadHash: expect.any(Uint8Array),
      recipientPrivateKey: expect.any(Uint8Array),
      paymentIndex: 0,
    })

    expect(sweepRecoveredMonadStampPayment).toHaveBeenCalledWith({
      payment: expect.objectContaining({
        childIndex: 0,
        address: '0xChildAddress123',
        txHash: '0xTxHash1',
      }),
      destinationAddress: '0xChangeAddressBip44',
      provider: mockWallet.provider,
      httpClient: mockWallet.httpClient,
    })

    expect(mockChangePool.setNextUnusedIndex).toHaveBeenCalledWith(4)
    expect(mockJournal.put).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'swept',
        sweepTxHash: '0xSweepTxHash123',
        sweepDestinationAddress: '0xChangeAddressBip44',
      }),
    )

    expect(outcome.sweptCount).toBe(1)
    expect(outcome.sweptWei).toBe(1000000000000000000n)
    expect(outcome.changeAddress).toBe('0xChangeAddressBip44')
    expect(outcome.txHashes).toEqual(['0xSweepTxHash123'])

    // Marked as swept
    expect((message as any).fundsSwept).toBe(true)
  })

  it('sweeps Lotus outpoints to change address when present', async () => {
    const mockLotusWallet = {
      changeKeys: [
        {
          privKey: {
            toBuffer: () => Buffer.from('22'.repeat(32), 'hex'),
            compressed: true,
          },
        },
      ],
      forwardUTXOsToPubkey: jest.fn().mockResolvedValue({}),
    }

    const message: ChatMessage = {
      outbound: false,
      status: 'received',
      receivedTime: 1000,
      serverTime: 1000,
      items: [{ type: 'text', text: 'Lotus message' }],
      outpoints: [
        {
          txHash: '0xLotusTx1',
          outIdx: 0,
          value: '1000',
          script: 'p2pkh',
        } as never,
      ],
      senderAddress: 'lotus_sender',
      payloadDigest: '0xlotusdigest',
    }

    const outcome = await sweepMessageFundsOnDelete({
      message,
      lotusWallet: mockLotusWallet as never,
    })

    expect(mockLotusWallet.forwardUTXOsToPubkey).toHaveBeenCalledWith({
      utxos: message.outpoints,
      pubkey: expect.any(Uint8Array),
    })
    expect(outcome.sweptCount).toBe(1)
    expect((message as any).fundsSwept).toBe(true)
  })

  it('skips message if already marked fundsSwept', async () => {
    const { sweepRecoveredMonadStampPayment } = jest.requireMock(
      '@frank/wallet/monad-stamp-client',
    )
    sweepRecoveredMonadStampPayment.mockClear()

    const message: ChatMessage = {
      outbound: false,
      status: 'received',
      receivedTime: 1000,
      serverTime: 1000,
      items: [{ type: 'text', text: 'Already swept' }],
      outpoints: [],
      stampPayments: [
        {
          txHash: '0xTxHash1',
          destinationAddress: '0xChildAddress123',
          valueWei: 1000000000000000000n,
        },
      ],
      senderAddress: '0xSender',
      payloadDigest: '0xalready',
    }
    ;(message as any).fundsSwept = true

    const outcome = await sweepMessageFundsOnDelete({ message })
    expect(outcome.sweptCount).toBe(0)
    expect(sweepRecoveredMonadStampPayment).not.toHaveBeenCalled()
  })
})
