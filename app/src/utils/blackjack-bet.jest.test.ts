import { parseEther } from 'ethers'

import {
  BET_MESSAGE_FEE_RESERVE_WEI,
  betFundsRequired,
  deliverBetWhenReady,
  parseBetInput,
  sendBlackjackWager,
  shortAddress,
} from './blackjack-bet'

const mockSend = jest.fn()
jest.mock('../composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ wallet: 1 }),
}))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    toDisplayAmount: (n: bigint) => n.toString(),
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
  beforeEach(() => mockSend.mockReset().mockResolvedValue({ txHash: '0xabc' }))

  it('makes one transfer per call and returns a bet move naming it, with a fresh gameId each time', async () => {
    const a = await sendBlackjackWager('0xDealer', 10n ** 17n)
    const b = await sendBlackjackWager('0xDealer', 10n ** 17n)
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockSend).toHaveBeenCalledWith({
      wallet: { wallet: 1 },
      recipient: { raw: '0xDealer' },
      value: 10n ** 17n,
    })
    expect(a).toMatchObject({
      type: 'blackjack-move',
      action: 'bet',
      wagerTxHash: '0xabc',
    })
    expect(a.gameId).not.toBe(b.gameId)
  })

  it('propagates a transfer failure without producing a bet', async () => {
    mockSend.mockRejectedValue(new Error('insufficient funds'))
    await expect(sendBlackjackWager('0xDealer', 1n)).rejects.toThrow(
      'insufficient funds',
    )
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
