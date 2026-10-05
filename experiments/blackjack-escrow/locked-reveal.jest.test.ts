/**
 * Experiment 4. Adaptor pre-signatures on a JOINT account: can "open your card" and "take your
 * money" be made one act?
 *
 * The joint (two-party) key is simulated: the test holds both shares and signs with their sum.
 * `@frank/threshold-ecdsa` is expected to produce the same pre-signatures without either party
 * holding the sum. Everything else is real: EIP-1559 digests, the package's adaptor arithmetic,
 * ethers' transaction parsing.
 *
 * Construction. For one card, the dealer's contribution is a small number v* (which of the n
 * cards left), committed before any money moves as a Pedersen commitment
 *     C = s*G + v* * H            (H: a point whose discrete log nobody knows)
 * For every possible v the point T_v = C - v*H is public. The dealer knows the discrete log of
 * exactly one of them: T_{v*} = s*G. Before the card is opened, both parties pre-sign, for every
 * v, the two transfers that settle the hand if the card is v, each locked to T_v:
 *     nonce 0: escrow -> dealer   (the dealer's share if the card is v)
 *     nonce 1: escrow -> player   (the rest)
 *
 * Result:
 *  - The dealer can complete only the pair for the card it committed to, and completing it on
 *    chain IS opening the card: the player reads s (and so v*) out of the signature.
 *  - With s the player completes its own transfer for that same card, and no other.
 *  - Nobody needs the other's signature after the pre-signing. A loser cannot hold the winner's
 *    money by refusing to sign.
 *  - Still possible: the dealer never completes anything. Then its own transfer (deposit
 *    included) never happens either, and the player's money stays locked.
 *  - The package's public API cannot make these pre-signatures today: it demands a proof of
 *    knowledge for the lock point, and for 51 of 52 points nobody knows the secret.
 */
import { randomBytes } from 'crypto'

import {
  adaptorPointFromBytes,
  adaptorSign,
  generateAdaptorSecret,
} from '@frank/adaptor-signatures'
import {
  decryptSignature,
  encodeEcdsaSignature,
  encryptedSign,
  recoverTweak,
  verifyEncryptedSignature,
  type AdaptorSignature,
} from '@frank/adaptor-signatures/ecdsa-adaptor'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { hexlify, Transaction, Wallet } from 'ethers'

import { addressOf, compactOf, digestOf, signedRawTx, transferTx } from './evm'

const N = secp256k1.CURVE.n
const Point = secp256k1.ProjectivePoint
type P = InstanceType<typeof Point>
const G = Point.BASE
const scalar = () => BigInt(hexlify(randomBytes(32))) % (N - 1n) + 1n

/** A second generator with no known discrete log: the first x = SHA-256(tag | counter) on the
 * curve. Anyone can recompute it; nobody chose it. */
const H: P = (() => {
  for (let counter = 0; ; counter++) {
    const x = sha256(new TextEncoder().encode(`frank/blackjack/pedersen-h/v1|${counter}`))
    try {
      return Point.fromHex('02' + Buffer.from(x).toString('hex'))
    } catch {
      // Not an x coordinate of the curve: try the next.
    }
  }
})()

const CARDS_LEFT = 49
const WAGER = 10n ** 17n
const FEE_CAP = 500n * 10n ** 9n

describe('a card opened by taking the money', () => {
  // The joint account. In production neither party ever holds `joint`.
  const playerShare = scalar()
  const dealerShare = scalar()
  const joint = (playerShare + dealerShare) % N
  const jointPublic = G.multiply(joint)
  const escrow = addressOf(jointPublic.toRawBytes(true))
  const dealer = Wallet.createRandom().address
  const player = Wallet.createRandom().address

  // The dealer's commitment for this card, made before any money moved.
  const s = scalar()
  const committed = 17
  const C = G.multiply(s).add(H.multiply(BigInt(committed)))
  const lockPoint = (v: number): P =>
    v === 0 ? C : C.subtract(H.multiply(BigInt(v)))

  /** What the hand pays if the card is `v` (any fixed public rule works; here: odd cards lose). */
  const settlement = (v: number) => {
    const dealerWins = v % 2 === 1
    return {
      toDealer: transferTx({
        to: dealer,
        valueWei: dealerWins ? 4n * WAGER : 2n * WAGER,
        nonce: 0,
        maxFeePerGas: FEE_CAP,
      }),
      toPlayer: transferTx({
        to: player,
        valueWei: dealerWins ? WAGER : 3n * WAGER,
        nonce: 1,
        maxFeePerGas: FEE_CAP,
      }),
    }
  }

  // Both parties pre-sign every possible card's pair, before the card is opened.
  const presigned = Array.from({ length: CARDS_LEFT }, (_, v) => {
    const T = lockPoint(v)
    const { toDealer, toPlayer } = settlement(v)
    return {
      v,
      T,
      toDealer,
      toPlayer,
      dealerPre: encryptedSign(joint, T, digestOf(toDealer)),
      playerPre: encryptedSign(joint, T, digestOf(toPlayer)),
    }
  })

  const complete = (tx: Transaction, pre: AdaptorSignature, secret: bigint) =>
    signedRawTx(tx, encodeEcdsaSignature(decryptSignature(pre, secret)), jointPublic.toRawBytes(true))

  it('every pre-signature verifies against its own lock point, without any secret', () => {
    for (const p of presigned) {
      expect(verifyEncryptedSignature(jointPublic, p.T, digestOf(p.toDealer), p.dealerPre)).toBe(true)
      expect(verifyEncryptedSignature(jointPublic, p.T, digestOf(p.toPlayer), p.playerPre)).toBe(true)
    }
    // A pre-signature is bound to its card: it does not verify under another card's point.
    expect(
      verifyEncryptedSignature(jointPublic, lockPoint(3), digestOf(presigned[4].toDealer), presigned[4].dealerPre),
    ).toBe(false)
    expect(presigned).toHaveLength(CARDS_LEFT)
  })

  it('the dealer completes the transfer of the card it committed to, and only that one', () => {
    const mine = presigned[committed]
    const raw = complete(mine.toDealer, mine.dealerPre, s)
    const tx = Transaction.from(raw)
    expect(tx.from).toBe(escrow)
    expect(tx.nonce).toBe(0)
    expect(tx.to).toBe(dealer)
    // Every other card's transfer stays out of reach: with s it does not become a signature of
    // the escrow account.
    for (const other of presigned) {
      if (other.v === committed) continue
      expect(() => complete(other.toDealer, other.dealerPre, s)).toThrow(
        'does not recover',
      )
    }
  })

  it('completing it on chain opens the card to the player, who then takes its own share alone', () => {
    const mine = presigned[committed]
    const onChain = complete(mine.toDealer, mine.dealerPre, s)
    // Cards with the same result give the very same transfer, so the transaction alone does not
    // name the card (and the chain does not show it). The signature does: its r is the r of
    // exactly one of the pre-signatures the player holds.
    const landed = Transaction.from(onChain)
    expect(
      presigned.filter(p => p.toDealer.unsignedHash === landed.unsignedHash).length,
    ).toBeGreaterThan(1)
    const compact = compactOf(onChain)
    const r = BigInt(hexlify(compact.slice(0, 32)))
    const seen = presigned.filter(p => p.dealerPre.R.x % N === r)
    expect(seen.map(p => p.v)).toEqual([committed])
    const extracted = recoverTweak(mine.T, mine.dealerPre, {
      r: BigInt(hexlify(compact.slice(0, 32))),
      s: BigInt(hexlify(compact.slice(32))),
    })
    expect(extracted).toBe(s)
    // It is the opening of the commitment the dealer made before the hand.
    expect(G.multiply(extracted).add(H.multiply(BigInt(committed))).equals(C)).toBe(true)
    // With it the player completes its own transfer for that card, without the dealer...
    const payout = Transaction.from(complete(mine.toPlayer, mine.playerPre, extracted))
    expect(payout.from).toBe(escrow)
    expect(payout.nonce).toBe(1)
    expect(payout.to).toBe(player)
    // ...and no better one: the pre-signatures of the other cards stay locked.
    for (const other of presigned) {
      if (other.v === committed) continue
      expect(() => complete(other.toPlayer, other.playerPre, extracted)).toThrow(
        'does not recover',
      )
    }
  })

  it('all the dealer transfers share one account nonce, so at most one can ever land', () => {
    expect(new Set(presigned.map(p => p.toDealer.nonce))).toEqual(new Set([0]))
    expect(new Set(presigned.map(p => p.toPlayer.nonce))).toEqual(new Set([1]))
    // And every transfer names the same fee cap: a pre-signed transfer cannot be repriced.
    expect(new Set(presigned.map(p => p.toDealer.maxFeePerGas))).toEqual(new Set([FEE_CAP]))
  })

  it('a party that knows only one share cannot make any of these signatures', () => {
    const alone = presigned[committed]
    const forged = encryptedSign(dealerShare, alone.T, digestOf(alone.toDealer))
    expect(verifyEncryptedSignature(jointPublic, alone.T, digestOf(alone.toDealer), forged)).toBe(false)
    expect(() => complete(alone.toDealer, forged, s)).toThrow('does not recover')
  })

  it('is not something the package API can produce today: it wants a proof for the lock point', () => {
    const other = adaptorPointFromBytes(lockPoint(3).toRawBytes(true))
    const real = generateAdaptorSecret(n => new Uint8Array(randomBytes(n)))
    if (!other.ok || !real.ok) throw new Error('setup')
    // Nobody knows the discrete log of T_3, so nobody can prove knowledge of it; a proof for
    // another point is refused.
    const refused = adaptorSign({
      privateKey: Uint8Array.from(Buffer.from(joint.toString(16).padStart(64, '0'), 'hex')),
      adaptorPoint: other.value,
      adaptorProof: real.value.proof,
      digest: digestOf(presigned[3].toDealer),
    })
    expect(refused).toEqual({ ok: false, error: { code: 'invalid-proof' } })
  })
})
