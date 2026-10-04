/**
 * Experiment 3 (model). Cards from both parties' entropy, one card at a time.
 *
 * Each party commits to a hash chain before any money is locked:
 *   link[n] = random, link[k-1] = SHA-256(link[k]), commitment = link[0].
 * Draw k (0-based) uses link[k+1] of BOTH chains. A link is checked by hashing it back to the
 * last link already known, so a party can only ever reveal the one chain it committed to, and
 * revealing link k+1 says nothing about link k+2.
 *
 * The card is the (hash mod remaining)-th card still in the deck, so cards never repeat.
 */
import { sha256 } from '@noble/hashes/sha256.js'

export const CHAIN_LENGTH = 52
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16))

/** links[0] is the public commitment; links[k+1] is revealed for draw k. */
export function entropyChain(seed: Uint8Array): string[] {
  const links = new Array<string>(CHAIN_LENGTH + 1)
  let link = sha256(seed)
  for (let k = CHAIN_LENGTH; k >= 0; k--) {
    links[k] = hex(link)
    link = sha256(link)
  }
  return links
}

/** Is `link` the chain's link number `index`, given an earlier link we already trust? */
export function verifyLink(
  link: string,
  index: number,
  known: { link: string; index: number },
): boolean {
  if (!/^[0-9a-f]{64}$/.test(link) || index <= known.index) return false
  let value = unhex(link)
  for (let k = index; k > known.index; k--) value = sha256(value)
  return hex(value) === known.link
}

/** The card of draw `k`, given both links for that draw and the cards already out. */
export function drawCard(
  gameId: string,
  k: number,
  dealerLink: string,
  playerLink: string,
  drawn: readonly number[],
): number {
  const digest = sha256(
    new TextEncoder().encode(
      `frank/blackjack/draw/v1|${gameId}|${k}|${dealerLink}|${playerLink}`,
    ),
  )
  const remaining = Array.from({ length: 52 }, (_, card) => card).filter(
    card => !drawn.includes(card),
  )
  // 256 bits reduced mod at most 52: the bias is below 2^-249.
  const index = Number(BigInt('0x' + hex(digest)) % BigInt(remaining.length))
  return remaining[index]
}
