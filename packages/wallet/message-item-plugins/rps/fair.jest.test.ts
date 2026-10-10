import type { RpsItem } from '@frank/cashweb/types/messages'

import { evaluateRps, rpsCommitment, rpsPayoutWei, verifyRpsResult } from './fair'

const salt = '5a'.repeat(16)
const mine: RpsItem = {
  type: 'rps',
  action: 'move',
  matchId: 'm1',
  commitHash: rpsCommitment('scissors', salt),
  playerMove: 'rock',
  wagerWei: '100',
}
const honest: RpsItem = {
  type: 'rps',
  action: 'resolve',
  matchId: 'm1',
  commitHash: mine.commitHash,
  playerMove: 'rock',
  botMove: 'scissors',
  secretSalt: salt,
  wagerWei: '100',
  outcome: 'win',
}

describe('rock-paper-scissors fairness', () => {
  test('an honest reveal verifies', () => {
    expect(verifyRpsResult(honest, mine)).toEqual({ ok: true })
  })

  test('a forged reveal (a move the bot did not commit to) is detected', () => {
    expect(
      verifyRpsResult({ ...honest, botMove: 'paper', outcome: 'lose' }, mine),
    ).toMatchObject({ ok: false })
    expect(
      verifyRpsResult({ ...honest, secretSalt: '6b'.repeat(16) }, mine),
    ).toMatchObject({ ok: false })
  })

  test('a changed commitment, player move, outcome or stake is detected', () => {
    for (const item of [
      { ...honest, commitHash: rpsCommitment('rock', salt) },
      { ...honest, playerMove: 'paper' as const },
      { ...honest, outcome: 'lose' as const },
      { ...honest, wagerWei: '1' },
    ])
      expect(verifyRpsResult(item, mine)).toMatchObject({ ok: false })
  })

  test('a result with no move of the player is not verified', () => {
    expect(verifyRpsResult(honest, undefined)).toMatchObject({ ok: false })
  })

  test('outcomes and payouts', () => {
    expect(evaluateRps('rock', 'scissors')).toBe('win')
    expect(evaluateRps('rock', 'paper')).toBe('lose')
    expect(evaluateRps('rock', 'rock')).toBe('tie')
    expect(rpsPayoutWei(5n, 'win')).toBe(10n)
    expect(rpsPayoutWei(5n, 'tie')).toBe(5n)
    expect(rpsPayoutWei(5n, 'lose')).toBe(0n)
  })
})
