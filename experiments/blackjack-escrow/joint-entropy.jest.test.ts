/**
 * Experiment 3. Per-card entropy from both parties.
 *
 * Result: neither party alone fixes or foresees a card. Whoever holds only one chain sees a
 * uniformly distributed card as the other chain varies; a party cannot substitute a link; and an
 * undrawn card stays unknown to both until both links for that draw are out.
 */
import { randomBytes } from 'crypto'

import { CHAIN_LENGTH, drawCard, entropyChain, verifyLink } from './joint-entropy'

const seed = () => new Uint8Array(randomBytes(32))
const GAME = '00112233445566778899aabbccddeeff'

describe('joint per-card entropy', () => {
  it('a revealed link is accepted only if it hashes back to the commitment', () => {
    const chain = entropyChain(seed())
    const commitment = { link: chain[0], index: 0 }
    expect(verifyLink(chain[3], 3, commitment)).toBe(true)
    expect(verifyLink(chain[4], 4, { link: chain[3], index: 3 })).toBe(true)
    // Wrong position, another chain's link, a replayed earlier link: all rejected.
    expect(verifyLink(chain[3], 4, commitment)).toBe(false)
    expect(verifyLink(entropyChain(seed())[3], 3, commitment)).toBe(false)
    expect(verifyLink(chain[3], 3, { link: chain[3], index: 3 })).toBe(false)
  })

  it('deals a whole deck without repeats, the same on both sides', () => {
    const dealer = entropyChain(seed())
    const player = entropyChain(seed())
    const deal = () => {
      const drawn: number[] = []
      for (let k = 0; k < CHAIN_LENGTH; k++)
        drawn.push(drawCard(GAME, k, dealer[k + 1], player[k + 1], drawn))
      return drawn
    }
    const cards = deal()
    expect(new Set(cards).size).toBe(52)
    expect(deal()).toEqual(cards)
  })

  it('a party that fixes its own chain cannot steer the card', () => {
    // The dealer picks the best chain it can. The player's link is unknown to it, and over the
    // player's possible chains the card is uniform: about 1/52 each.
    const dealer = entropyChain(seed())
    const counts = new Array<number>(52).fill(0)
    const trials = 52 * 200
    for (let i = 0; i < trials; i++)
      counts[drawCard(GAME, 0, dealer[1], entropyChain(seed())[1], [])] += 1
    // Expected 200 per card, standard deviation about 14.
    expect(Math.min(...counts)).toBeGreaterThan(130)
    expect(Math.max(...counts)).toBeLessThan(270)
  })

  it('knowing every link revealed so far says nothing about the next card', () => {
    // Links up to draw 2 are public. The next player link is the preimage of a public value;
    // two chains that agree on nothing but being unknown give unrelated cards.
    const dealer = entropyChain(seed())
    const seen = new Set<number>()
    for (let i = 0; i < 400; i++)
      seen.add(drawCard(GAME, 3, dealer[4], entropyChain(seed())[4], [0, 1, 2]))
    expect(seen.size).toBeGreaterThan(40)
  })

  it('the game and the draw number are part of the card', () => {
    const dealer = entropyChain(seed())
    const player = entropyChain(seed())
    const differs = (a: number[], b: number[]) => a.some((card, i) => card !== b[i])
    const run = (game: string, shift: number) =>
      Array.from({ length: 20 }, (_, k) =>
        drawCard(game, k + shift, dealer[k + 1], player[k + 1], []),
      )
    expect(differs(run(GAME, 0), run(GAME.replace('0', '1'), 0))).toBe(true)
    expect(differs(run(GAME, 0), run(GAME, 1))).toBe(true)
  })
})
