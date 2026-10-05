import { CHAIN_LENGTH, drawCard, entropyChain, linkAt, verifyLink } from './entropy'

const seedOf = (n: number) => n.toString(16).padStart(64, '0')
const GAME = '00112233445566778899aabbccddeeff'

describe('entropy chains', () => {
  const chain = entropyChain(seedOf(1))
  const commitment = { index: 0, link: chain[0] }

  it('is fixed by the seed (pinned vector)', () => {
    expect(chain).toHaveLength(CHAIN_LENGTH + 1)
    expect(entropyChain(seedOf(1))).toEqual(chain)
    expect(chain[0]).toBe(
      '11029d4a4070feea8db2f98b39fbe4871925c93fe52db0d9a83617585213ac6d',
    )
    expect(chain[CHAIN_LENGTH]).toBe(
      '864ab5cb7721623e7e860d7322d570b1b88c2e0667a834c041f8d0185548215a',
    )
    expect(entropyChain(seedOf(2))[0]).not.toBe(chain[0])
  })

  it('accepts a link only at its own position of the committed chain', () => {
    expect(verifyLink(chain[3], 3, commitment)).toBe(true)
    expect(verifyLink(chain[4], 4, { index: 3, link: chain[3] })).toBe(true)
    expect(verifyLink(chain[CHAIN_LENGTH], CHAIN_LENGTH, commitment)).toBe(true)
    // Wrong position, another chain, a link already open, beyond the chain, not a hash.
    expect(verifyLink(chain[3], 4, commitment)).toBe(false)
    expect(verifyLink(chain[4], 3, commitment)).toBe(false)
    expect(verifyLink(entropyChain(seedOf(2))[3], 3, commitment)).toBe(false)
    expect(verifyLink(chain[3], 3, { index: 3, link: chain[3] })).toBe(false)
    expect(verifyLink(chain[2], 2, { index: 3, link: chain[3] })).toBe(false)
    expect(verifyLink(chain[1], CHAIN_LENGTH + 1, commitment)).toBe(false)
    expect(verifyLink(chain[3].toUpperCase(), 3, commitment)).toBe(false)
    expect(verifyLink(undefined, 3, commitment)).toBe(false)
    expect(verifyLink(chain[3], 2.5, commitment)).toBe(false)
  })

  it('gives every earlier link of an opened one, and no later one', () => {
    const opened = { index: 5, link: chain[5] }
    for (let k = 0; k <= 5; k++) expect(linkAt(opened, k)).toBe(chain[k])
    expect(linkAt(opened, 6)).toBeUndefined()
    expect(linkAt(opened, -1)).toBeUndefined()
  })
})

describe('drawing cards from both chains', () => {
  const dealer = entropyChain(seedOf(11))
  const player = entropyChain(seedOf(12))

  it('deals without repeats, the same for both sides (pinned vector)', () => {
    const deal = () => {
      const drawn: number[] = []
      for (let k = 0; k < CHAIN_LENGTH; k++)
        drawn.push(drawCard(GAME, k, dealer[k + 1], player[k + 1], drawn))
      return drawn
    }
    const cards = deal()
    expect(new Set(cards).size).toBe(CHAIN_LENGTH)
    expect(cards.every(card => Number.isInteger(card) && card >= 0 && card < 52)).toBe(true)
    expect(deal()).toEqual(cards)
    expect(cards.slice(0, 6)).toEqual([17, 47, 11, 26, 5, 24])
  })

  it.each([
    ['dealer', (n: number) => drawCard(GAME, 0, dealer[1], entropyChain(seedOf(n))[1], [])],
    ['player', (n: number) => drawCard(GAME, 0, entropyChain(seedOf(n))[1], player[1], [])],
  ])('leaves a %s that fixed its own chain with a card it cannot steer', (_side, draw) => {
    // Over the other side's possible chains the card is uniform: about 1 in 52 each.
    const counts = new Array<number>(52).fill(0)
    const trials = 52 * 60
    for (let n = 100; n < 100 + trials; n++) counts[draw(n)] += 1
    expect(Math.min(...counts)).toBeGreaterThan(25)
    expect(Math.max(...counts)).toBeLessThan(105)
  })

  it('binds the card to the game, the draw and both links', () => {
    const card = (game: string, k: number, d: string, p: string) =>
      Array.from({ length: 12 }, (_, i) => drawCard(game, k + i, d, p, []))
    const base = card(GAME, 0, dealer[1], player[1])
    expect(card(GAME.replace('0', '1'), 0, dealer[1], player[1])).not.toEqual(base)
    expect(card(GAME, 1, dealer[1], player[1])).not.toEqual(base)
    expect(card(GAME, 0, dealer[2], player[1])).not.toEqual(base)
    expect(card(GAME, 0, dealer[1], player[2])).not.toEqual(base)
  })
})
