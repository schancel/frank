import { RecoveredMonadStampPayment } from '@frank/wallet/monad-stamp-client'

import { summarizeRecoveredPayments } from './raffle-bot.livecheck'

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
