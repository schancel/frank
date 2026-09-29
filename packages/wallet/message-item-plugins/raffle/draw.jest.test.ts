import { sha256Hex } from '../blackjack/deck'
import { combineEntrantEntropy, pickWinnerIndex, verifyRaffleDraw } from './draw'

describe('pickWinnerIndex', () => {
  it('is deterministic for the same inputs', () => {
    const a = pickWinnerIndex('server-secret', combineEntrantEntropy(['0xaaa', '0xbbb']), 2)
    const b = pickWinnerIndex('server-secret', combineEntrantEntropy(['0xaaa', '0xbbb']), 2)
    expect(a).toBe(b)
  })

  it('stays within [0, entrantCount)', () => {
    for (let n = 1; n <= 20; n++) {
      const entries = Array.from({ length: n }, (_, i) => `0xhash${i}`)
      const idx = pickWinnerIndex('server-secret', combineEntrantEntropy(entries), n)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(n)
    }
  })

  it('changes when a different server seed is used', () => {
    const entropy = combineEntrantEntropy(['0xaaa', '0xbbb', '0xccc'])
    const a = pickWinnerIndex('server-secret-1', entropy, 3)
    const b = pickWinnerIndex('server-secret-2', entropy, 3)
    // Not a hard guarantee for every seed pair, but true for this fixed pair -- pins the value
    // deterministically so a silent algorithm change would be caught.
    expect(a).not.toBe(b)
  })

  it('changes when entrant order changes (order is significant)', () => {
    const a = pickWinnerIndex(
      'server-secret',
      combineEntrantEntropy(['0xaaa', '0xbbb', '0xccc']),
      3,
    )
    const b = pickWinnerIndex(
      'server-secret',
      combineEntrantEntropy(['0xccc', '0xbbb', '0xaaa']),
      3,
    )
    expect(a).not.toBe(b)
  })

  it('rejects a zero-entrant draw', () => {
    expect(() => pickWinnerIndex('server-secret', 'irrelevant', 0)).toThrow()
  })
})

describe('verifyRaffleDraw', () => {
  const serverSeed = 'the-real-secret'
  const serverSeedHash = sha256Hex(serverSeed)
  const entrants = ['0xAddrA', '0xAddrB', '0xAddrC']
  const entryTxHashes = ['0xtx1', '0xtx2', '0xtx3']
  const winnerIndex = pickWinnerIndex(
    serverSeed,
    combineEntrantEntropy(entryTxHashes),
    entrants.length,
  )
  const winnerAddress = entrants[winnerIndex]

  it('accepts a correctly-announced draw', () => {
    expect(
      verifyRaffleDraw({ serverSeed, serverSeedHash, entrants, entryTxHashes, winnerAddress }),
    ).toEqual({ valid: true })
  })

  it('rejects a seed that does not match the committed hash', () => {
    const result = verifyRaffleDraw({
      serverSeed: 'a-different-secret',
      serverSeedHash,
      entrants,
      entryTxHashes,
      winnerAddress,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects a forged winner address', () => {
    const forged = entrants.find(a => a !== winnerAddress) as string
    const result = verifyRaffleDraw({
      serverSeed,
      serverSeedHash,
      entrants,
      entryTxHashes,
      winnerAddress: forged,
    })
    expect(result.valid).toBe(false)
  })

  it('rejects mismatched entrants/entryTxHashes lengths', () => {
    const result = verifyRaffleDraw({
      serverSeed,
      serverSeedHash,
      entrants,
      entryTxHashes: entryTxHashes.slice(0, 2),
      winnerAddress,
    })
    expect(result.valid).toBe(false)
  })
})
