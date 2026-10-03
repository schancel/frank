import { sha256 } from '@noble/hashes/sha256.js'
import {
  generateKeypair,
  generateTweak,
  verifyTweak,
  encryptedSign,
  verifyEncryptedSignature,
  decryptSignature,
  recoverTweak,
  verifyStandardEcdsaSignature,
  encodeAdaptorSignature,
  decodeAdaptorSignature,
  encodeEcdsaSignature,
  decodeEcdsaSignature,
} from './ecdsa-adaptor'
import { G, randomScalar } from './curve'

function digest(message: string): Uint8Array {
  return sha256(new TextEncoder().encode(message))
}

describe('ECDSA adaptor signatures: full round trip', () => {
  it('generates a keypair and a tweak with a verifiable proof of knowledge', () => {
    const signer = generateKeypair()
    expect(signer.publicKey.equals(G.multiply(signer.privateKey))).toBe(true)

    const tweak = generateTweak()
    expect(tweak.T.equals(G.multiply(tweak.t))).toBe(true)
    expect(verifyTweak(tweak.T, tweak.pok)).toBe(true)
  })

  it('encrypts, verifies, completes, and extracts across a realistic swap/payout scenario', () => {
    // Alice is the party whose signature is being encrypted (e.g. the blackjack bot authorizing
    // a payout, or one leg of a cross-chain atomic swap).
    const alice = generateKeypair()

    // Bob (or the game's provably-fair commitment) generates the adaptor secret and publishes T
    // plus a proof he knows its discrete log -- Alice must check this before trusting T.
    const bob = generateTweak()
    expect(verifyTweak(bob.T, bob.pok)).toBe(true)

    const messageHash = digest(
      'pay 10 MONAD to bob -- settles iff bob reveals t',
    )

    // Alice produces an adaptor signature: a signature on messageHash, encrypted under bob.T,
    // without ever learning bob.t.
    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)

    // Bob (or anyone) can verify the adaptor signature is well-formed relative to Alice's real
    // public key and T, without knowing t.
    expect(
      verifyEncryptedSignature(alice.publicKey, bob.T, messageHash, adaptorSig),
    ).toBe(true)

    // Once Bob reveals t (e.g. by broadcasting his own leg of the swap, or the game revealing the
    // outcome seed), the adaptor signature can be completed into an ordinary ECDSA signature.
    const completedSig = decryptSignature(adaptorSig, bob.t)

    // The completed signature MUST verify as a perfectly normal ECDSA signature via the standard
    // verification algorithm -- i.e. it is indistinguishable from a signature Alice could have
    // produced directly with `secp256k1.sign`, with no adaptor-specific check required.
    expect(
      verifyStandardEcdsaSignature(alice.publicKey, messageHash, completedSig),
    ).toBe(true)

    // Extraction: given the adaptor signature and the now-public completed signature (as observed
    // on-chain), recover bob's secret t. This is the step that makes atomic swaps/payouts work:
    // whoever holds the adaptor signature can pull t back out of the chain.
    const recoveredT = recoverTweak(bob.T, adaptorSig, completedSig)
    expect(recoveredT).toBe(bob.t)
  })

  it('produces a different, independently-valid adaptor signature and extraction on each run (randomized nonces)', () => {
    const alice = generateKeypair()
    const bob = generateTweak()
    const messageHash = digest('round 2')

    const sig1 = encryptedSign(alice.privateKey, bob.T, messageHash)
    const sig2 = encryptedSign(alice.privateKey, bob.T, messageHash)

    // Nonces are randomized (not deterministic per spec's nonce-generation guidance), so two
    // adaptor signatures over the same message should not collide...
    expect(sig1.Ra.equals(sig2.Ra)).toBe(false)

    // ...but both must independently verify and both must correctly extract t.
    expect(
      verifyEncryptedSignature(alice.publicKey, bob.T, messageHash, sig1),
    ).toBe(true)
    expect(
      verifyEncryptedSignature(alice.publicKey, bob.T, messageHash, sig2),
    ).toBe(true)

    const completed1 = decryptSignature(sig1, bob.t)
    const completed2 = decryptSignature(sig2, bob.t)
    expect(recoverTweak(bob.T, sig1, completed1)).toBe(bob.t)
    expect(recoverTweak(bob.T, sig2, completed2)).toBe(bob.t)
  })

  it('rejects an adaptor signature verified against the wrong public key', () => {
    const alice = generateKeypair()
    const mallory = generateKeypair()
    const bob = generateTweak()
    const messageHash = digest('rejects wrong pubkey')

    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)
    expect(
      verifyEncryptedSignature(
        mallory.publicKey,
        bob.T,
        messageHash,
        adaptorSig,
      ),
    ).toBe(false)
  })

  it('rejects an adaptor signature verified against the wrong adaptor point T', () => {
    const alice = generateKeypair()
    const bob = generateTweak()
    const eve = generateTweak()
    const messageHash = digest('rejects wrong T')

    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)
    expect(
      verifyEncryptedSignature(alice.publicKey, eve.T, messageHash, adaptorSig),
    ).toBe(false)
  })

  it('rejects an adaptor signature verified against a different message', () => {
    const alice = generateKeypair()
    const bob = generateTweak()

    const adaptorSig = encryptedSign(
      alice.privateKey,
      bob.T,
      digest('original message'),
    )
    expect(
      verifyEncryptedSignature(
        alice.publicKey,
        bob.T,
        digest('tampered message'),
        adaptorSig,
      ),
    ).toBe(false)
  })

  it('fails to complete a valid-looking signature with the wrong tweak secret', () => {
    const alice = generateKeypair()
    const bob = generateTweak()
    const messageHash = digest('wrong tweak used to decrypt')

    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)
    const wrongT = randomScalar()

    const wronglyCompleted = decryptSignature(adaptorSig, wrongT)
    expect(
      verifyStandardEcdsaSignature(
        alice.publicKey,
        messageHash,
        wronglyCompleted,
      ),
    ).toBe(false)
  })

  it('extraction fails closed if the "completed" signature does not actually correspond to the adaptor signature', () => {
    const alice = generateKeypair()
    const bob = generateTweak()
    const messageHash = digest('unrelated completion')

    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)

    // A signature with an unrelated r cannot correspond to this adaptor signature at all.
    const bogusSig = {
      r: (adaptorSig.R.x + 1n) % (1n << 256n),
      s: randomScalar(),
    }
    expect(() => recoverTweak(bob.T, adaptorSig, bogusSig)).toThrow()
  })

  it('round-trips an AdaptorSignature and an EcdsaSignature through wire encode/decode', () => {
    const alice = generateKeypair()
    const bob = generateTweak()
    const messageHash = digest('encode/decode round trip')

    const adaptorSig = encryptedSign(alice.privateKey, bob.T, messageHash)
    const encoded = encodeAdaptorSignature(adaptorSig)
    expect(encoded.length).toBe(162)
    const decoded = decodeAdaptorSignature(encoded)
    expect(decoded.R.equals(adaptorSig.R)).toBe(true)
    expect(decoded.Ra.equals(adaptorSig.Ra)).toBe(true)
    expect(decoded.sa).toBe(adaptorSig.sa)
    expect(decoded.proof.b).toBe(adaptorSig.proof.b)
    expect(decoded.proof.c).toBe(adaptorSig.proof.c)
    // Decoded copy must still verify and decrypt/extract identically to the original.
    expect(
      verifyEncryptedSignature(alice.publicKey, bob.T, messageHash, decoded),
    ).toBe(true)

    const completed = decryptSignature(adaptorSig, bob.t)
    const encodedSig = encodeEcdsaSignature(completed)
    expect(encodedSig.length).toBe(64)
    const decodedSig = decodeEcdsaSignature(encodedSig)
    expect(decodedSig).toEqual(completed)
  })

  it('rejects malformed wire input rather than silently coercing it', () => {
    expect(() => decodeAdaptorSignature(new Uint8Array(161))).toThrow()
    expect(() => decodeAdaptorSignature(new Uint8Array(163))).toThrow()
    expect(() => decodeEcdsaSignature(new Uint8Array(63))).toThrow()
    expect(() => decodeEcdsaSignature(new Uint8Array(65))).toThrow()
  })

  it('rejects an unverified/forged T that has no valid proof of knowledge', () => {
    // A malicious counterparty could try to supply a T for which they don't actually know the
    // discrete log (e.g. copied from someone else's public key). Per this package's module-level
    // caveat, callers must reject such a T via verifyTweak before ever using it.
    const someoneElsesPubkey = generateKeypair().publicKey
    const forgedPok = generateTweak().pok // a real PoK, but for a *different* T
    expect(verifyTweak(someoneElsesPubkey, forgedPok)).toBe(false)
  })
})
