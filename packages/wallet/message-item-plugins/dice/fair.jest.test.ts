import type { SatoshiDiceItem } from '@frank/cashweb/types/messages'

import {
  diceCommitment,
  dicePayoutWei,
  diceRoll,
  verifyDiceResult,
} from './fair'

const secret = '5a'.repeat(32)
const clientSeed = 'c3'.repeat(16)
const bet: SatoshiDiceItem = {
  type: 'dice',
  action: 'roll',
  rollId: 'r1',
  commitment: diceCommitment(secret),
  clientSeed,
  target: 32768,
  wagerWei: '1000',
}
function honest(): SatoshiDiceItem {
  const luckyNumber = diceRoll(secret, clientSeed)
  const isWin = luckyNumber < 32768
  return {
    type: 'dice',
    action: 'result',
    rollId: 'r1',
    commitment: bet.commitment,
    clientSeed,
    target: 32768,
    wagerWei: '1000',
    serverSecret: secret,
    luckyNumber,
    isWin,
    payoutWei: (isWin ? dicePayoutWei(1000n, 32768) : 0n).toString(),
  }
}

describe('dice fairness', () => {
  test('an honest result verifies', () => {
    expect(verifyDiceResult(honest(), bet)).toEqual({ ok: true })
  })

  test('the roll depends on both the secret and the player value', () => {
    expect(diceRoll(secret, clientSeed)).toBe(diceRoll(secret, clientSeed))
    const rolls = new Set(
      Array.from({ length: 64 }, (_, i) => diceRoll(secret, `${i}`.padStart(32, '0'))),
    )
    expect(rolls.size).toBeGreaterThan(32)
  })

  test('a forged reveal (another secret) is detected', () => {
    const forged = { ...honest(), serverSecret: '6b'.repeat(32) }
    expect(verifyDiceResult(forged, bet)).toMatchObject({ ok: false })
  })

  test('a result with no bet of the player is not verified', () => {
    expect(verifyDiceResult(honest(), undefined)).toMatchObject({ ok: false })
  })

  test('a swapped commitment, seed, number, outcome, stake or payout is detected', () => {
    const other = diceCommitment('7c'.repeat(32))
    const tampered: SatoshiDiceItem[] = [
      { ...honest(), commitment: other },
      { ...honest(), clientSeed: 'd4'.repeat(16) },
      { ...honest(), luckyNumber: (honest().luckyNumber! + 1) % 65536 },
      { ...honest(), isWin: !honest().isWin },
      { ...honest(), wagerWei: '1' },
      { ...honest(), payoutWei: '999999' },
      { ...honest(), target: 100 },
    ]
    for (const item of tampered)
      expect(verifyDiceResult(item, bet)).toMatchObject({ ok: false })
  })

  test('a commitment used for a second roll is detected', () => {
    const first = honest()
    const again: SatoshiDiceItem = { ...honest(), rollId: 'r2' }
    expect(verifyDiceResult(first, bet, [first, again])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('more than one roll'),
    })
  })

  test('the payout keeps the house edge and never exceeds the fair payout', () => {
    expect(dicePayoutWei(1000n, 32768)).toBe(1962n)
    expect(dicePayoutWei(0n, 32768)).toBe(0n)
  })
})
