/**
 * Cards from both sides' entropy, one card at a time. Design: `docs/protocol/blackjack-p2p.md`.
 *
 * Each side turns a secret seed into a hash chain and publishes its first link as a commitment
 * before any money moves:
 *
 *   link[CHAIN_LENGTH] = SHA-256("frank/blackjack/entropy/v1|" + seed)
 *   link[k - 1]        = SHA-256(link[k])          (over the 32 raw bytes)
 *   commitment         = link[0]
 *
 * Draw `k` (0-based) uses link `k + 1` of BOTH chains. A link is checked by hashing it back to the
 * last link already known, so a side can only ever open the one chain it committed to, and opening
 * link `k + 1` says nothing about link `k + 2`. Neither side alone fixes or foresees a card.
 *
 * Synchronous and isomorphic (node-forge), like `./deck.ts`.
 */
import * as forge from 'node-forge'

import type { Card } from './deck'

/** Links per chain beyond the commitment. One hand draws at most 22 cards from a single deck. */
export const CHAIN_LENGTH = 32

const HEX64 = /^[0-9a-f]{64}$/

function sha256OfText(text: string): string {
  const md = forge.md.sha256.create()
  md.update(text, 'utf8')
  return md.digest().toHex()
}

function sha256OfHex(hex: string): string {
  const md = forge.md.sha256.create()
  md.update(forge.util.hexToBytes(hex))
  return md.digest().toHex()
}

/** A link of a chain together with its position. Position 0 is the commitment. */
export interface OpenedLink {
  index: number
  link: string
}

/** The whole chain of a seed: `chain[0]` is the commitment, `chain[k + 1]` opens draw `k`. */
export function entropyChain(seed: string): string[] {
  const held = chains.get(seed)
  if (held) return held
  const chain = new Array<string>(CHAIN_LENGTH + 1)
  let link = sha256OfText(`frank/blackjack/entropy/v1|${seed}`)
  for (let k = CHAIN_LENGTH; k >= 0; k--) {
    chain[k] = link
    link = sha256OfHex(link)
  }
  // The chains of the few hands in play are asked for on every fold.
  if (chains.size >= 64) chains.delete(chains.keys().next().value as string)
  chains.set(seed, Object.freeze(chain) as string[])
  return chain
}
const chains = new Map<string, string[]>()

/** Link `index` of the chain an opened link belongs to, for any `index` at or below it. */
export function linkAt(opened: OpenedLink, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > opened.index)
    return undefined
  let link = opened.link
  for (let k = opened.index; k > index; k--) link = sha256OfHex(link)
  return link
}

/** Every link of an opened link's chain up to it: `links[k]` is link `k`. One pass. */
export function linksUpTo(opened: OpenedLink): string[] {
  const links = new Array<string>(opened.index + 1)
  let link = opened.link
  for (let k = opened.index; k >= 0; k--) {
    links[k] = link
    if (k > 0) link = sha256OfHex(link)
  }
  return links
}

/** Is `link` link number `index` of the chain whose earlier link `known` we already hold? */
export function verifyLink(
  link: unknown,
  index: number,
  known: OpenedLink,
): link is string {
  if (typeof link !== 'string' || !HEX64.test(link)) return false
  if (!Number.isInteger(index) || index <= known.index || index > CHAIN_LENGTH)
    return false
  return linkAt({ index, link }, known.index) === known.link
}

/** The card of draw `k`: both links for that draw pick one of the cards still in the deck. */
export function drawCard(
  gameId: string,
  k: number,
  dealerLink: string,
  playerLink: string,
  drawn: readonly Card[],
): Card {
  const digest = sha256OfText(
    `frank/blackjack/draw/v1|${gameId}|${k}|${dealerLink}|${playerLink}`,
  )
  const remaining: Card[] = []
  for (let card = 0; card < 52; card++)
    if (!drawn.includes(card)) remaining.push(card)
  // 256 bits reduced modulo at most 52: the bias is below 2^-249.
  return remaining[Number(BigInt(`0x${digest}`) % BigInt(remaining.length))]
}
