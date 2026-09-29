import { RecoveredMonadStampPayment } from '@frank/wallet/monad-stamp-client'

import {
  evaluateLeaveRequest,
  summarizeRecoveredPayments,
} from './raffle-bot.livecheck'
import { RaffleRoundRecord } from './raffle-bot-state'

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

    const { totalValueWei, combinedTxHash } = summarizeRecoveredPayments([only])

    expect(totalValueWei).toBe(only.valueWei)
    expect(combinedTxHash).toBe(only.txHash)
  })
})

/**
 * Ticket #120 (leave/cancel entry before a round fills): `evaluateLeaveRequest` is the pure
 * decision behind that feature, split out from the network-calling refund the same way
 * `summarizeRecoveredPayments` above is split from its own sweep loop.
 */
describe('evaluateLeaveRequest', () => {
  const PLAYER_A = '0x1111111111111111111111111111111111111111'
  const PLAYER_B = '0x2222222222222222222222222222222222222222'

  function round(entrants: RaffleRoundRecord['entrants']): RaffleRoundRecord {
    return {
      raffleId: 'round-1',
      entryPriceWei: '20000000000000000',
      maxEntries: 5,
      serverSeedHash: 'commitment-hash',
      entrants,
    }
  }

  it('removes the requester and refunds exactly their entry price', () => {
    const current = round([
      { address: PLAYER_A, txHash: '0xa' },
      { address: PLAYER_B, txHash: '0xb' },
    ])

    const result = evaluateLeaveRequest({
      round: current,
      raffleId: 'round-1',
      requesterAddress: PLAYER_B,
    })

    expect(result).toEqual({
      ok: true,
      refundWei: 20000000000000000n,
      updatedRound: {
        ...round([{ address: PLAYER_A, txHash: '0xa' }]),
        leavers: [PLAYER_B],
      },
    })
  })

  it('rejects a requester who never entered the round', () => {
    const current = round([{ address: PLAYER_A, txHash: '0xa' }])

    const result = evaluateLeaveRequest({
      round: current,
      raffleId: 'round-1',
      requesterAddress: PLAYER_B,
    })

    expect(result).toEqual({
      ok: false,
      reason: 'you are not entered in the current round',
    })
  })

  it('rejects a leave naming a round that has already closed and rotated', () => {
    // Simulates the race: PLAYER_A's `leave` for 'round-1' arrives after that round already
    // drew and a fresh 'round-2' opened -- even if PLAYER_A happens to also be entered in
    // round-2, a stale leave for round-1 must never be mistaken for "leave round-2."
    const currentRoundTwo = round([{ address: PLAYER_A, txHash: '0xnew' }])
    const withNewId = { ...currentRoundTwo, raffleId: 'round-2' }

    const result = evaluateLeaveRequest({
      round: withNewId,
      raffleId: 'round-1',
      requesterAddress: PLAYER_A,
    })

    expect(result).toEqual({
      ok: false,
      reason: 'that round has already closed -- nothing to leave',
    })
    // The entrant is untouched -- no accidental removal from the round it didn't name.
    expect(withNewId.entrants).toEqual([{ address: PLAYER_A, txHash: '0xnew' }])
  })

  it('never mutates the round it was given', () => {
    const current = round([{ address: PLAYER_A, txHash: '0xa' }])
    const snapshot = JSON.parse(JSON.stringify(current))

    evaluateLeaveRequest({
      round: current,
      raffleId: 'round-1',
      requesterAddress: PLAYER_A,
    })

    expect(current).toEqual(snapshot)
  })
})
