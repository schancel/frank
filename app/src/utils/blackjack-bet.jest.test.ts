import { parseEther } from 'ethers'

import { formatBlackjackError } from '@frank/wallet/message-item-plugins/blackjack/game'
import {
  awaitPayment,
  BET_MESSAGE_FEE_RESERVE_WEI,
  dealerReplyFor,
  WagerBroadcastError,
  betFundsRequired,
  deliverBetWhenReady,
  parseBetInput,
  sendBlackjackWager,
  shortAddress,
} from './blackjack-bet'

const mockSend = jest.fn()
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({
    wallet: 1,
    identity: { address: { raw: '0xMe' } },
  }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    toDisplayAmount: (n: bigint) => n.toString(),
    formatAddress: (a: { raw: string }) => a.raw,
    nativeTransfers: { send: (a: unknown) => mockSend(a) },
  },
}))

describe('parseBetInput', () => {
  it.each(['0.01', '0.1', '1', '1.0', ' 0.5 ', '.5'])('accepts %s', v => {
    expect(parseBetInput(parseEther, v)).toMatchObject({ ok: true })
  })
  it('returns exact wei', () => {
    expect(parseBetInput(parseEther, '0.1')).toEqual({
      ok: true,
      wei: 10n ** 17n,
    })
  })
  it.each([
    ['0', /greater than zero/],
    ['0.0', /greater than zero/],
    ['-1', /greater than zero/],
    ['-0.5', /greater than zero/],
    ['0.009', /minimum/],
    ['1.01', /maximum/],
    ['1000', /maximum/],
    ['', /plain decimal/],
    ['abc', /plain decimal/],
    ['NaN', /plain decimal/],
    ['Infinity', /plain decimal/],
    ['1e3', /plain decimal/],
    ['0.1.2', /plain decimal/],
  ])('rejects %j', (v, msg) => {
    const r = parseBetInput(parseEther, v)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(msg)
  })
  it('rejects amounts with more than 18 decimals via the parser', () => {
    expect(parseBetInput(parseEther, '0.1234567890123456789').ok).toBe(false)
  })
})

describe('parseBetInput error codes', () => {
  it.each([
    ['0', 'zero'],
    ['0.009', 'min'],
    ['1.01', 'max'],
    ['abc', 'format'],
    ['0.1234567890123456789', 'invalid'],
  ])('%j -> %s', (v, code) => {
    expect(parseBetInput(parseEther, v)).toMatchObject({ ok: false, code })
  })
})

describe('sendBlackjackWager', () => {
  beforeEach(() =>
    mockSend.mockReset().mockImplementation(async (args: any) => {
      await args.onSigned?.({ txHash: '0xabc' })
      return { txHash: '0xabc' }
    }),
  )

  it('makes one transfer per call and returns a bet move naming it, with a fresh gameId each time', async () => {
    const a = await sendBlackjackWager('0xDealer', 10n ** 17n)
    const b = await sendBlackjackWager('0xDealer', 10n ** 17n)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend).toHaveBeenCalledWith({
      wallet: expect.objectContaining({ wallet: 1 }),
      recipient: { raw: '0xDealer' },
      value: 10n ** 17n,
      onSigned: expect.any(Function),
    })
    expect(a).toMatchObject({
      type: 'blackjack-move',
      action: 'bet',
      wagerTxHash: '0xabc',
    })
    expect(a.gameId).not.toBe(b.gameId)
  })

  it('a failure BEFORE signing propagates as is (nothing was sent)', async () => {
    mockSend.mockRejectedValue(new Error('insufficient funds'))
    const err = await sendBlackjackWager('0xDealer', 1n).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(WagerBroadcastError)
    expect(err.message).toBe('insufficient funds')
  })

  it('hands onSigned the gameId, hash and paying wallet before broadcast; a failing onSigned propagates as is', async () => {
    const seen: unknown[] = []
    await sendBlackjackWager('0xDealer', 1n, {
      onSigned: async info => void seen.push(info),
    })
    expect(seen).toEqual([
      {
        gameId: expect.stringMatching(/^bj-/),
        txHash: '0xabc',
        walletAddress: '0xMe',
      },
    ])
    const err = await sendBlackjackWager('0xDealer', 1n, {
      onSigned: async () => {
        throw new Error('disk full')
      },
    }).catch(e => e)
    expect(err).not.toBeInstanceOf(WagerBroadcastError)
    expect(err.message).toBe('disk full')
  })

  it('a failure AFTER onSigned is a WagerBroadcastError carrying the hash and gameId (payment unknown)', async () => {
    mockSend.mockImplementation(async (args: any) => {
      await args.onSigned({ txHash: '0xabc' })
      throw new Error('socket hang up')
    })
    const err = await sendBlackjackWager('0xDealer', 1n).catch(e => e)
    expect(err).toBeInstanceOf(WagerBroadcastError)
    expect(err.txHash).toBe('0xabc')
    expect(err.gameId).toMatch(/^bj-/)
    expect(err.message).toBe('socket hang up')
  })
})

describe('deliverBetWhenReady', () => {
  it('waits for the chat to go idle, then sends once', async () => {
    let busy = true
    const send = jest.fn().mockResolvedValue(true)
    const p = deliverBetWhenReady({
      betAddress: 'a',
      currentAddress: () => 'a',
      isBusy: () => busy,
      send,
      pollMs: 1,
    })
    await new Promise(r => setTimeout(r, 10))
    expect(send).not.toHaveBeenCalled()
    busy = false
    await p
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses when the chat already changed, before sending', async () => {
    const send = jest.fn()
    await expect(
      deliverBetWhenReady({
        betAddress: 'a',
        currentAddress: () => 'b',
        isBusy: () => false,
        send,
      }),
    ).rejects.toThrow(/chat changed/)
    expect(send).not.toHaveBeenCalled()
  })

  it('never delivers to a different chat if it changes while waiting', async () => {
    let current = 'a'
    const send = jest.fn()
    await expect(
      deliverBetWhenReady({
        betAddress: 'a',
        currentAddress: () => current,
        isBusy: () => {
          const wasA = current === 'a'
          current = 'b'
          return wasA
        },
        send,
        pollMs: 1,
      }),
    ).rejects.toThrow(/chat changed/)
    expect(send).not.toHaveBeenCalled()
  })

  it('throws (not delivered) when the send pipeline reports failure', async () => {
    await expect(
      deliverBetWhenReady({
        betAddress: 'a',
        currentAddress: () => 'a',
        isBusy: () => false,
        send: async () => false,
      }),
    ).rejects.toThrow(/could not be sent/)
  })

  it('a send that never settles times out (so the wager record is not hidden forever)', async () => {
    await expect(
      deliverBetWhenReady({
        betAddress: 'a',
        currentAddress: () => 'a',
        isBusy: () => false,
        send: () => new Promise<boolean>(() => undefined),
        sendTimeoutMs: 20,
      }),
    ).rejects.toThrow(/taking too long/)
  })

  it('gives up waiting for a stuck busy chat after the timeout, without sending', async () => {
    const send = jest.fn()
    await expect(
      deliverBetWhenReady({
        betAddress: 'a',
        currentAddress: () => 'a',
        isBusy: () => true,
        send,
        pollMs: 1,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/still busy/)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('bet funds and address helpers', () => {
  it('requires wager + stamp + fee reserve', () => {
    expect(betFundsRequired(10n ** 17n, 10n ** 16n)).toBe(
      10n ** 17n + 10n ** 16n + BET_MESSAGE_FEE_RESERVE_WEI,
    )
  })
  it('abbreviates an address', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef1234abcd')).toBe(
      '0x1234...abcd',
    )
    expect(shortAddress('0xabc')).toBe('0xabc')
  })
})

describe('awaitPayment', () => {
  it('returns as soon as the payment is confirmed or failed', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('confirmed')
    await expect(
      awaitPayment(get, { pollMs: 1, timeoutMs: 1000 }),
    ).resolves.toBe('confirmed')
    await expect(
      awaitPayment(async () => 'failed', { pollMs: 1 }),
    ).resolves.toBe('failed')
  })
  it('gives up after the bounded time with the last status (pending/unknown), never "confirmed"', async () => {
    await expect(
      awaitPayment(async () => 'unknown', { pollMs: 1, timeoutMs: 15 }),
    ).resolves.toBe('unknown')
    await expect(
      awaitPayment(async () => 'pending', { pollMs: 1, timeoutMs: 15 }),
    ).resolves.toBe('pending')
  })
  it('a lookup error is treated as pending, not as "nothing was paid"', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc'))
      .mockResolvedValueOnce('confirmed')
    await expect(
      awaitPayment(get, { pollMs: 1, timeoutMs: 1000 }),
    ).resolves.toBe('confirmed')
    await expect(
      awaitPayment(
        async () => {
          throw new Error('rpc')
        },
        { pollMs: 1, timeoutMs: 15 },
      ),
    ).resolves.toBe('pending')
  })
})

describe('dealerReplyFor', () => {
  const inbound = (item: Record<string, unknown>) => ({
    outbound: false,
    items: [item],
  })
  const err = (g: string, text: string) =>
    inbound({ type: 'text', text: formatBlackjackError(g, text) })
  it('none / accepted / unconfirmed / rejected, for this game only, ignoring our own messages', () => {
    expect(dealerReplyFor([], 'g')).toBe('none')
    expect(
      dealerReplyFor(
        [{ outbound: true, items: [{ type: 'blackjack-move', gameId: 'g' }] }],
        'g',
      ),
    ).toBe('none')
    expect(
      dealerReplyFor(
        [inbound({ type: 'blackjack-move', gameId: 'g', action: 'deal' })],
        'g',
      ),
    ).toBe('accepted')
    expect(
      dealerReplyFor(
        [inbound({ type: 'blackjack-move', gameId: 'x', action: 'deal' })],
        'g',
      ),
    ).toBe('none')
    expect(
      dealerReplyFor(
        [
          err(
            'g',
            'this wager transaction has already authorized a blackjack game',
          ),
        ],
        'g',
      ),
    ).toBe('accepted')
    expect(
      dealerReplyFor(
        [
          err(
            'g',
            'could not verify your wager transaction on-chain (unconfirmed, or the hash was wrong)',
          ),
        ],
        'g',
      ),
    ).toBe('unconfirmed')
    expect(
      dealerReplyFor([err('g', 'wager is below the table minimum')], 'g'),
    ).toBe('rejected')
    expect(
      dealerReplyFor([err('other', 'wager is below the table minimum')], 'g'),
    ).toBe('none')
  })
  it('the latest reply wins (unconfirmed, then a dealt hand after a retry)', () => {
    expect(
      dealerReplyFor(
        [
          err('g', 'unconfirmed'),
          inbound({ type: 'blackjack-move', gameId: 'g', action: 'deal' }),
        ],
        'g',
      ),
    ).toBe('accepted')
  })
})
