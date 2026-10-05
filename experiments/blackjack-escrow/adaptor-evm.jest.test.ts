/**
 * Experiment 1. Is the output of `@frank/adaptor-signatures` usable to authorise an EVM
 * transaction, and is such a pre-signed transaction binding?
 *
 * Result: yes to the first, no to the second.
 *  - A pre-signature over a real EIP-1559 signing digest completes to a low-s ECDSA signature that
 *    ethers accepts as the transaction's signature, recovering the signing account's address.
 *  - The adaptor secret is recovered from the signature as it would be read back from chain.
 *  - But the account's key holder can sign a second transaction with the same nonce at any time.
 *    Both are valid; the chain takes whichever arrives first. A pre-signature from a single-key
 *    account is therefore a promise, not an escrow.
 */
import { randomBytes } from 'crypto'

import {
  adaptorSign,
  compactEcdsaSignatureFromBytes,
  completeAdaptorSignature,
  extractAdaptorSecret,
  generateAdaptorSecret,
  verifyAdaptorSignature,
} from '@frank/adaptor-signatures'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { getBytes, hexlify, Transaction, Wallet } from 'ethers'

import {
  addressOf,
  CHAIN_ID,
  compactOf,
  digestOf,
  signedRawTx,
  transferTx,
} from './evm'

const rng = (n: number) => new Uint8Array(randomBytes(n))
const ok = <T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string } },
): T => {
  if (!result.ok) throw new Error(result.error.code)
  return result.value
}

describe('adaptor pre-signature on a real EVM transaction digest', () => {
  const payer = Wallet.createRandom()
  const privateKey = getBytes(payer.privateKey)
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  const winner = Wallet.createRandom().address
  const tx = transferTx({ to: winner, valueWei: 10n ** 18n, nonce: 0 })
  const digest = digestOf(tx)
  // The secret belongs to the counterparty; the payer only ever sees the point and its proof.
  const secret = ok(generateAdaptorSecret(rng))

  const presign = () =>
    ok(
      adaptorSign({
        privateKey,
        adaptorPoint: secret.point,
        adaptorProof: secret.proof,
        digest,
      }),
    )
  const transcript = (signature: ReturnType<typeof presign>) => ({
    publicKey,
    adaptorPoint: secret.point,
    adaptorProof: secret.proof,
    digest,
    signature,
  })

  it('verifies without the secret, and is not itself a transaction signature', () => {
    const pre = presign()
    expect(ok(verifyAdaptorSignature(transcript(pre)))).toBe(true)
    // R (33) || R_a (33) || s_a (32): the pre-signature's own (r, s_a) does not sign the digest.
    const r = secp256k1.ProjectivePoint.fromHex(pre.slice(0, 33)).x
    const fake = new Uint8Array(64)
    fake.set(getBytes('0x' + (r % secp256k1.CURVE.n).toString(16).padStart(64, '0')))
    fake.set(pre.slice(66, 98), 32)
    expect(() => signedRawTx(tx, fake, publicKey)).toThrow()
  })

  it('completes to a valid signed EVM transaction from the expected address', () => {
    const pre = presign()
    const completed = ok(
      completeAdaptorSignature({ ...transcript(pre), secret: secret.secret }),
    )
    const raw = signedRawTx(tx, completed, publicKey)
    const parsed = Transaction.from(raw)
    expect(parsed.from).toBe(payer.address)
    expect(parsed.from).toBe(addressOf(publicKey))
    expect(parsed.chainId).toBe(CHAIN_ID)
    expect(parsed.nonce).toBe(0)
    expect(parsed.to).toBe(winner)
    expect(parsed.value).toBe(10n ** 18n)
    // Low s, as EVM nodes require (EIP-2).
    expect(BigInt(parsed.signature!.s) <= secp256k1.CURVE.n / 2n).toBe(true)
  })

  it('gives the secret back from the signature read off the chain', () => {
    const pre = presign()
    const completed = ok(
      completeAdaptorSignature({ ...transcript(pre), secret: secret.secret }),
    )
    const raw = signedRawTx(tx, completed, publicKey)
    const onChain = ok(compactEcdsaSignatureFromBytes(compactOf(raw)))
    const extracted = ok(
      extractAdaptorSecret({ ...transcript(pre), completedSignature: onChain }),
    )
    expect(hexlify(extracted)).toBe(hexlify(secret.secret))
  })

  it('binds to chain id, nonce, recipient and amount: any change is a different digest', () => {
    const pre = presign()
    const variants = [
      transferTx({ to: winner, valueWei: 10n ** 18n, nonce: 1 }),
      transferTx({ to: winner, valueWei: 10n ** 18n + 1n, nonce: 0 }),
      transferTx({ to: payer.address, valueWei: 10n ** 18n, nonce: 0 }),
      Transaction.from({ ...tx.toJSON(), chainId: 143n }),
      // Also the fee: a pre-signed transaction cannot be repriced without signing again.
      transferTx({
        to: winner,
        valueWei: 10n ** 18n,
        nonce: 0,
        maxFeePerGas: 500n * 10n ** 9n,
      }),
    ]
    for (const other of variants) {
      expect(hexlify(digestOf(other))).not.toBe(hexlify(digest))
      expect(
        ok(verifyAdaptorSignature({ ...transcript(pre), digest: digestOf(other) })),
      ).toBe(false)
    }
  })

  it('uses a fresh nonce for every pre-signature', () => {
    const a = presign()
    const b = presign()
    expect(hexlify(a.slice(33, 66))).not.toBe(hexlify(b.slice(33, 66)))
  })

  it('is NOT binding: the key holder can spend the same nonce elsewhere', async () => {
    const pre = presign()
    const completed = ok(
      completeAdaptorSignature({ ...transcript(pre), secret: secret.secret }),
    )
    const promised = Transaction.from(signedRawTx(tx, completed, publicKey))
    // The payer drains the account back to itself with the same nonce.
    const drain = transferTx({ to: payer.address, valueWei: 10n ** 18n, nonce: 0 })
    const conflicting = Transaction.from(await payer.signTransaction(drain))
    expect(conflicting.from).toBe(promised.from)
    expect(conflicting.nonce).toBe(promised.nonce)
    expect(conflicting.hash).not.toBe(promised.hash)
    // Two valid transactions for one account nonce: only the first to be included counts.
  })
})
