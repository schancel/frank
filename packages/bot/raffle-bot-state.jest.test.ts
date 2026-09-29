import { hasRaffleEntrant, RaffleRoundRecord, removeRaffleEntrant } from './raffle-bot-state'

const PLAYER_A = '0x1111111111111111111111111111111111111111'
const PLAYER_B = '0x2222222222222222222222222222222222222222'
const PLAYER_C = '0x3333333333333333333333333333333333333333'

function round(entrants: RaffleRoundRecord['entrants']): RaffleRoundRecord {
  return {
    raffleId: 'round-1',
    entryPriceWei: '100',
    maxEntries: 5,
    serverSeedHash: 'commitment-hash',
    entrants,
  }
}

describe('removeRaffleEntrant', () => {
  it('removes the named entrant while preserving the join order of the rest', () => {
    const before = round([
      { address: PLAYER_A, txHash: '0xa' },
      { address: PLAYER_B, txHash: '0xb' },
      { address: PLAYER_C, txHash: '0xc' },
    ])

    const after = removeRaffleEntrant(before, PLAYER_B)

    expect(after.entrants).toEqual([
      { address: PLAYER_A, txHash: '0xa' },
      { address: PLAYER_C, txHash: '0xc' },
    ])
    // The input record is never mutated -- the caller decides whether/when to persist the result.
    expect(before.entrants).toHaveLength(3)
  })

  it('is address-case-insensitive, matching hasRaffleEntrant', () => {
    const before = round([{ address: PLAYER_A, txHash: '0xa' }])
    // Only the hex digits vary in case (mirroring a real EIP-55 checksum) -- canonicalization
    // requires the literal lowercase '0x' prefix (see `canonicalMonadEnvelopeAddress`'s own regex).
    const checksumCased = `0x${PLAYER_A.slice(2).toUpperCase()}`

    const after = removeRaffleEntrant(before, checksumCased)

    expect(after.entrants).toEqual([])
    expect(hasRaffleEntrant(before, PLAYER_A)).toBe(true)
    expect(hasRaffleEntrant(after, PLAYER_A)).toBe(false)
  })

  it('is a no-op for an address that never entered', () => {
    const before = round([{ address: PLAYER_A, txHash: '0xa' }])

    const after = removeRaffleEntrant(before, PLAYER_B)

    expect(after.entrants).toEqual(before.entrants)
  })

  it('leaves every other field of the round untouched', () => {
    const before = round([{ address: PLAYER_A, txHash: '0xa' }])

    const after = removeRaffleEntrant(before, PLAYER_A)

    expect(after.raffleId).toBe(before.raffleId)
    expect(after.entryPriceWei).toBe(before.entryPriceWei)
    expect(after.maxEntries).toBe(before.maxEntries)
    expect(after.serverSeedHash).toBe(before.serverSeedHash)
  })
})
