import { RecoveredMonadStampPayment } from '@frank/wallet/monad-stamp-client'

import {
  recoverAndSweepEntryPayment,
  summarizeRecoveredPayments,
} from './raffle-bot.livecheck'

jest.mock('@frank/wallet/monad-stamp-client', () => ({
  ...jest.requireActual('@frank/wallet/monad-stamp-client'),
  recoverMonadStampPayments: jest.fn(),
  sweepRecoveredMonadStampPayment: jest.fn(),
}))

/**
 * Ticket #121 regression: an earlier version of `raffle-bot.livecheck.ts` read only
 * `stampPayments[0]` for an entry's value and entropy, silently undercounting (or entirely
 * mis-binding) any entry whose stamp was split across more than one on-chain payment. These
 * fixtures never touch the network -- `RecoveredMonadStampPayment` objects are constructed
 * directly, the same way `monad-stamp-client.jest.test.ts`'s own sweep tests do, since
 * `summarizeRecoveredPayments` only ever operates on an already-recovered/verified set (the
 * verification itself is `recoverMonadStampPayments`'s job, tested separately).
 */
function fakePayment(
  childIndex: number,
  valueWei: bigint,
  txHash: string,
): RecoveredMonadStampPayment {
  return {
    childIndex,
    address: `0x${childIndex.toString(16).padStart(40, '0')}`,
    privateKey: new Uint8Array(32),
    txHash,
    valueWei,
  }
}

describe('summarizeRecoveredPayments', () => {
  it('sums every member of a multi-payment entry, not just the first', () => {
    const first = fakePayment(0, 10_000n, '0xaaa')
    const second = fakePayment(1, 7_000n, '0xbbb')

    const { totalValueWei } = summarizeRecoveredPayments([first, second])

    expect(totalValueWei).toBe(17_000n)
    // The bug this replaces would have reported 10_000n (first member only).
    expect(totalValueWei).not.toBe(first.valueWei)
  })

  it('binds entropy to every member, not just the first', () => {
    const first = fakePayment(0, 10_000n, '0xaaa')
    const second = fakePayment(1, 7_000n, '0xbbb')

    const { combinedTxHash } = summarizeRecoveredPayments([first, second])

    expect(combinedTxHash).toContain(first.txHash)
    expect(combinedTxHash).toContain(second.txHash)
    // The bug this replaces would have used '0xaaa' alone as the entropy source.
    expect(combinedTxHash).not.toBe(first.txHash)
  })

  it('is independent of the array order the payments arrive in', () => {
    const first = fakePayment(0, 10_000n, '0xaaa')
    const second = fakePayment(1, 7_000n, '0xbbb')
    const third = fakePayment(2, 3_000n, '0xccc')

    const forward = summarizeRecoveredPayments([first, second, third])
    const shuffled = summarizeRecoveredPayments([third, first, second])

    expect(shuffled.totalValueWei).toBe(forward.totalValueWei)
    expect(shuffled.combinedTxHash).toBe(forward.combinedTxHash)
  })

  it('reduces to the single-payment case unchanged', () => {
    const only = fakePayment(0, 20_000_000_000_000_000n, '0xdeadbeef')

    const { totalValueWei, combinedTxHash } = summarizeRecoveredPayments([
      only,
    ])

    expect(totalValueWei).toBe(only.valueWei)
    expect(combinedTxHash).toBe(only.txHash)
  })
})

describe('recoverAndSweepEntryPayment (#319)', () => {
  it('quotes an underpaid entry in MON, not wei', async () => {
    const { recoverMonadStampPayments } = jest.requireMock(
      '@frank/wallet/monad-stamp-client',
    )
    recoverMonadStampPayments.mockReturnValue([
      fakePayment(0, 5n * 10n ** 15n, '0xaaa'),
    ])
    const result = await recoverAndSweepEntryPayment({
      message: {} as never,
      recipientPrivateKey: new Uint8Array(32),
      minTotalValueWei: 2n * 10n ** 16n,
      destinationAddress: `0x${'11'.repeat(20)}`,
      provider: {} as never,
      httpClient: {} as never,
      identitySigner: {} as never,
      label: 'test',
    })
    expect(result).toMatchObject({ ok: false })
    const reason = (result as { reason: string }).reason
    expect(reason).toBe('payment 0.005 MON is below the required 0.02 MON')
    expect(reason).not.toMatch(/wei/)
  })

  const DUST = 2n * 10n ** 15n
  const base = () => ({
    message: {} as never,
    recipientPrivateKey: new Uint8Array(32),
    minTotalValueWei: 2n * 10n ** 16n,
    destinationAddress: `0x${'11'.repeat(20)}`,
    provider: {} as never,
    httpClient: {} as never,
    identitySigner: {} as never,
    label: 'test',
    dustToleranceWei: DUST,
  })
  const mocks = () =>
    jest.requireMock('@frank/wallet/monad-stamp-client') as {
      recoverMonadStampPayments: jest.Mock
      sweepRecoveredMonadStampPayment: jest.Mock
    }

  it('credits an entry whose swept amount is the price minus one sweep gas', async () => {
    const m = mocks()
    m.recoverMonadStampPayments.mockReturnValue([
      fakePayment(0, 2n * 10n ** 16n, '0xaaa'),
    ])
    m.sweepRecoveredMonadStampPayment.mockResolvedValue({
      swept: true,
      txHash: '0x1',
      valueWei: 2n * 10n ** 16n - DUST,
    })
    expect(await recoverAndSweepEntryPayment(base())).toMatchObject({
      ok: true,
    })
  })

  it('does NOT credit an entry whose child held less than the claimed payment (swept + gas < price)', async () => {
    const m = mocks()
    m.recoverMonadStampPayments.mockReturnValue([
      fakePayment(0, 2n * 10n ** 16n, '0xaaa'),
    ])
    m.sweepRecoveredMonadStampPayment.mockResolvedValue({
      swept: true,
      txHash: '0x1',
      valueWei: 1n * 10n ** 16n, // the claim says 0.02 but only 0.01 was there to sweep
    })
    const result = await recoverAndSweepEntryPayment(base())
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toMatch(
      /reached the raffle identity/,
    )
  })

  it('sums what was actually swept across every payment of a multi-payment entry', async () => {
    const m = mocks()
    m.recoverMonadStampPayments.mockReturnValue([
      fakePayment(0, 1n * 10n ** 16n, '0xaaa'),
      fakePayment(1, 1n * 10n ** 16n, '0xbbb'),
    ])
    m.sweepRecoveredMonadStampPayment.mockResolvedValue({
      swept: true,
      txHash: '0x1',
      valueWei: 1n * 10n ** 16n - DUST,
    })
    expect(await recoverAndSweepEntryPayment(base())).toMatchObject({
      ok: true,
    })
    m.sweepRecoveredMonadStampPayment.mockResolvedValue({
      swept: true,
      txHash: '0x1',
      valueWei: 5n * 10n ** 15n, // 2 x (0.005 + 0.002 tolerance) < 0.02
    })
    expect(await recoverAndSweepEntryPayment(base())).toMatchObject({
      ok: false,
    })
  })

  it('does not credit an entry split into more than the allowed payments, and sweeps nothing', async () => {
    const m = mocks()
    m.sweepRecoveredMonadStampPayment.mockClear()
    m.recoverMonadStampPayments.mockReturnValue(
      [0, 1, 2, 3].map(i => fakePayment(i, 6n * 10n ** 15n, `0x${i}`)),
    )
    const result = await recoverAndSweepEntryPayment(base())
    expect(result).toMatchObject({ ok: false })
    expect((result as { reason: string }).reason).toMatch(/at most 3/)
    expect(m.sweepRecoveredMonadStampPayment).not.toHaveBeenCalled()
  })

  it('credits up to the cap and reports the payment count', async () => {
    const m = mocks()
    m.recoverMonadStampPayments.mockReturnValue(
      [0, 1, 2].map(i => fakePayment(i, 7n * 10n ** 15n, `0x${i}`)),
    )
    m.sweepRecoveredMonadStampPayment.mockResolvedValue({
      swept: true,
      txHash: '0x1',
      valueWei: 7n * 10n ** 15n - DUST,
    })
    expect(await recoverAndSweepEntryPayment(base())).toMatchObject({
      ok: true,
      paymentCount: 3,
    })
  })
})
