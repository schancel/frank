/**
 * Experiment 2. A one-off escrow account whose key is split between the two parties, built only
 * from what `@frank/adaptor-signatures` already exports (secret, point, proof of knowledge).
 *
 * Result:
 *  - The account address is derived from the SUM of the two public shares; neither share alone
 *    is its key, so neither party can sign for it.
 *  - Handing one share to the other party gives that party the whole key; it then signs an
 *    ordinary sweep at whatever fee is current. No pre-signed transaction is involved.
 *  - Without the proof of knowledge a party could choose its "share" so that it alone controls
 *    the account (rogue key). The package's mandatory proof rejects that.
 *  - A public tweak that commits the address to the hand's terms (pay-to-contract) works with
 *    these shares unchanged.
 */
import { randomBytes } from 'crypto'

import {
  adaptorPointFromBytes,
  generateAdaptorSecret,
  verifyAdaptorSecret,
} from '@frank/adaptor-signatures'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { getBytes, hexlify, Transaction, Wallet } from 'ethers'

import { addressOf, transferTx } from './evm'

const rng = (n: number) => new Uint8Array(randomBytes(n))
const N = secp256k1.CURVE.n
const Point = secp256k1.ProjectivePoint
const big = (bytes: Uint8Array) => BigInt(hexlify(bytes))
const keyHex = (x: bigint) => '0x' + x.toString(16).padStart(64, '0')
const share = () => {
  const made = generateAdaptorSecret(rng)
  if (!made.ok) throw new Error(made.error.code)
  return made.value
}
/** The escrow address two verified public shares define. */
const jointAddress = (a: Uint8Array, b: Uint8Array) =>
  addressOf(Point.fromHex(a).add(Point.fromHex(b)).toRawBytes(true))

describe('escrow account with a key split between player and dealer', () => {
  const player = share()
  const dealer = share()
  const escrow = jointAddress(player.point, dealer.point)

  it('both sides derive the same address after checking the other share proof', () => {
    expect(verifyAdaptorSecret(player.point, player.proof)).toEqual({
      ok: true,
      value: true,
    })
    expect(verifyAdaptorSecret(dealer.point, dealer.proof)).toEqual({
      ok: true,
      value: true,
    })
    expect(jointAddress(dealer.point, player.point)).toBe(escrow)
  })

  it('neither share alone is the account key', () => {
    expect(new Wallet(hexlify(player.secret)).address).not.toBe(escrow)
    expect(new Wallet(hexlify(dealer.secret)).address).not.toBe(escrow)
  })

  it('a handed-over share is checked against its public point, then sweeps the account', async () => {
    // The dealer hands its share to the player (who won this account).
    const received = dealer.secret
    expect(hexlify(Point.BASE.multiply(big(received)).toRawBytes(true))).toBe(
      hexlify(dealer.point),
    )
    const full = new Wallet(keyHex((big(player.secret) + big(received)) % N))
    expect(full.address).toBe(escrow)
    // Signed when it is broadcast, so the fee is whatever the chain asks at that moment.
    const sweep = transferTx({
      to: Wallet.createRandom().address,
      valueWei: 5n * 10n ** 17n,
      nonce: 0,
      maxFeePerGas: 321n * 10n ** 9n,
    })
    const signed = Transaction.from(await full.signTransaction(sweep))
    expect(signed.from).toBe(escrow)
  })

  it('a rogue share would capture the account; the proof of knowledge prevents it', () => {
    // The attacker sees the player's point A, picks its own key x, and offers B' = xG - A.
    const attacker = share()
    const rogue = Point.fromHex(attacker.point)
      .subtract(Point.fromHex(player.point))
      .toRawBytes(true)
    // If accepted, the "joint" account is simply the attacker's own.
    expect(jointAddress(player.point, rogue)).toBe(
      new Wallet(hexlify(attacker.secret)).address,
    )
    // It cannot be accepted: the attacker does not know the discrete log of B', and the only
    // proofs it holds are for other points.
    const roguePoint = adaptorPointFromBytes(rogue)
    if (!roguePoint.ok) throw new Error('rogue point should parse')
    for (const proof of [attacker.proof, player.proof, dealer.proof])
      expect(verifyAdaptorSecret(roguePoint.value, proof)).toEqual({
        ok: true,
        value: false,
      })
  })

  it('the address can commit to the agreed terms by a public tweak', () => {
    const joint = Point.fromHex(player.point).add(Point.fromHex(dealer.point))
    const tweak = (terms: string) =>
      big(
        sha256(
          new Uint8Array([
            ...joint.toRawBytes(true),
            ...new TextEncoder().encode(terms),
          ]),
        ),
      ) % N
    const terms = 'game 7f..01 | account stake | chain 10143 | wager 1 MON'
    const h = tweak(terms)
    const committed = addressOf(joint.add(Point.BASE.multiply(h)).toRawBytes(true))
    expect(committed).not.toBe(escrow)
    expect(
      addressOf(
        joint.add(Point.BASE.multiply(tweak(terms + '!'))).toRawBytes(true),
      ),
    ).not.toBe(committed)
    // Either party adds the public tweak to its own share; the split is otherwise unchanged.
    const full = new Wallet(
      keyHex((big(player.secret) + big(dealer.secret) + h) % N),
    )
    expect(full.address).toBe(committed)
    // Caveat shown by the arithmetic: the tweak is public, so the full key of one tweaked
    // account gives the untweaked joint key and every other tweak of it. One joint key must
    // therefore never back two accounts that go to different people.
    expect((big(getBytes(full.privateKey)) - h + N) % N).toBe(
      (big(player.secret) + big(dealer.secret)) % N,
    )
  })
})
