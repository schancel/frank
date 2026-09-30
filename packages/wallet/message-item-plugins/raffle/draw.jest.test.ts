import { sha256Hex } from '../blackjack/deck'
import {
  buildRaffleDrawItem,
  combineEntrantEntropy,
  pickWinnerIndex,
  verifyRaffleDraw,
  verifyRaffleDrawAgainstThread,
} from './draw'

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
      verifyRaffleDraw({
        serverSeed,
        serverSeedHash,
        entrants,
        entryTxHashes,
        winnerAddress,
      }),
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

describe('buildRaffleDrawItem and verifyRaffleDrawAgainstThread', () => {
  const SEED = 'round-secret'
  const HASH = sha256Hex(SEED)
  const ENTRANTS = ['0xa1', '0xb2', '0xc3']
  const TXS = ['0xt1', '0xt2', '0xt3']
  const announce = {
    type: 'raffle',
    raffleId: 'r1',
    action: 'announce',
    serverSeedHash: HASH,
  } as const
  const draw = () =>
    buildRaffleDrawItem({
      raffleId: 'r1',
      entryPriceWei: '20',
      serverSeed: SEED,
      entrants: ENTRANTS,
      entryTxHashes: TXS,
    })

  it('the built draw carries the commitment hash, the winner and the pot', () => {
    const item = draw()
    expect(item.serverSeedHash).toBe(HASH)
    expect(item.potWei).toBe('60')
    expect(ENTRANTS).toContain(item.winnerAddress)
  })

  it('verifies against a commitment announced earlier in the thread', () => {
    expect(verifyRaffleDrawAgainstThread(draw(), [announce])).toEqual({
      valid: true,
    })
  })

  it('makes no claim without a prior commitment (a hash arriving with the draw proves nothing)', () => {
    expect(verifyRaffleDrawAgainstThread(draw(), [])).toBeNull()
    expect(verifyRaffleDrawAgainstThread(draw(), [{ ...announce, raffleId: 'other' }])).toBeNull()
  })

  it('only the pre-entry announce counts as a commitment: not joined (sent after the entrant paid), draw or enter', () => {
    expect(
      verifyRaffleDrawAgainstThread(draw(), [
        { ...announce, action: 'joined' },
        { ...announce, action: 'draw' },
        { ...announce, action: 'enter' },
      ]),
    ).toBeNull()
  })

  it('fails when the revealed seed does not open the earlier commitment', () => {
    const lied = {
      ...draw(),
      serverSeed: 'a-different-seed',
      serverSeedHash: sha256Hex('a-different-seed'),
    }
    const result = verifyRaffleDrawAgainstThread(lied, [announce])
    expect(result?.valid).toBe(false)
  })

  it('fails when the draw names a different commitment than the announced one', () => {
    const result = verifyRaffleDrawAgainstThread({ ...draw(), serverSeedHash: 'x' }, [announce])
    expect(result).toEqual({
      valid: false,
      reason: 'the draw names a different commitment than the one announced',
    })
  })

  it('fails when the announced winner is not what the draw computes', () => {
    const item = draw()
    const other = ENTRANTS.find(e => e !== item.winnerAddress)!
    const result = verifyRaffleDrawAgainstThread({ ...item, winnerAddress: other }, [announce])
    expect(result?.valid).toBe(false)
  })

  it('fails on conflicting commitments for one round', () => {
    const result = verifyRaffleDrawAgainstThread(draw(), [
      announce,
      { ...announce, serverSeedHash: 'other-hash' },
    ])
    expect(result?.valid).toBe(false)
    expect(result?.reason).toMatch(/conflicting/)
  })

  describe('draw shape', () => {
    const sized = { ...announce, maxEntries: 3 }
    const bad = (over: object) => verifyRaffleDrawAgainstThread({ ...draw(), ...over }, [sized])

    it('accepts a full, well-formed round of the announced size', () => {
      expect(verifyRaffleDrawAgainstThread(draw(), [sized])).toEqual({
        valid: true,
      })
    })

    it('rejects a duplicated entrant address (case-insensitively) or entry payment', () => {
      expect(bad({ entrants: ['0xa1', '0xA1', '0xc3'] })?.reason).toMatch(
        /same entrant more than once/,
      )
      expect(bad({ entryTxHashes: ['0xt1', '0xT1', '0xt3'] })?.reason).toMatch(
        /same entry payment more than once/,
      )
    })

    it('rejects a count that differs from the announced round size', () => {
      expect(
        verifyRaffleDrawAgainstThread(
          {
            ...draw(),
            entrants: ENTRANTS.slice(0, 2),
            entryTxHashes: TXS.slice(0, 2),
          },
          [sized],
        )?.reason,
      ).toMatch(/2 entrants but the round announced 3/)
      expect(verifyRaffleDrawAgainstThread(draw(), [{ ...announce, maxEntries: 2 }])?.valid).toBe(
        false,
      )
    })

    it('rejects entrants/tx-hash length mismatch and a pot that is not price times entrants', () => {
      expect(bad({ entryTxHashes: TXS.slice(0, 2) })?.valid).toBe(false)
      expect(bad({ potWei: '61' })?.reason).toMatch(/pot is not the entry price/)
      expect(bad({ entryPriceWei: 'abc' })?.reason).toMatch(/not a number/)
    })

    it('rejects conflicting announced sizes', () => {
      expect(
        verifyRaffleDrawAgainstThread(draw(), [sized, { ...sized, maxEntries: 4 }])?.reason,
      ).toMatch(/conflicting sizes/)
    })
  })
})

// Known-answer vectors, computed independently (Python: HMAC-SHA256 keyed by the seed over the
// tx hashes joined with ':', first 8 hex chars as an integer, modulo the entrant count). They pin
// the winner derivation so a change shared by the builder and the verifier cannot pass unnoticed.
describe('winner derivation known answers', () => {
  it.each([
    ['seed-committed-before-any-entry', ['0xtx0', '0xtx1', '0xtx2', '0xtx3', '0xtx4'], 1],
    ['round-secret', ['0xt1', '0xt2', '0xt3'], 2],
  ])('%s -> index %i', (seed, txs, expected) => {
    expect(
      pickWinnerIndex(
        seed as string,
        combineEntrantEntropy(txs as string[]),
        (txs as string[]).length,
      ),
    ).toBe(expected)
  })

  it('the built draw names the vector winner (0xb2 for the five-entrant vector)', () => {
    const item = buildRaffleDrawItem({
      raffleId: 'r1',
      entryPriceWei: '20',
      serverSeed: 'seed-committed-before-any-entry',
      entrants: ['0xa1', '0xb2', '0xc3', '0xd4', '0xe5'],
      entryTxHashes: ['0xtx0', '0xtx1', '0xtx2', '0xtx3', '0xtx4'],
    })
    expect(item.winnerAddress).toBe('0xb2')
  })
})
