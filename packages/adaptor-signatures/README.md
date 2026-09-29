# @frank/adaptor-signatures

ECDSA adaptor signatures ("scriptless scripts") over secp256k1, in TypeScript, with no runtime
dependency beyond [`@noble/curves`](https://github.com/paulmillr/noble-curves) and
[`@noble/hashes`](https://github.com/paulmillr/noble-hashes). This is a standalone crypto
primitive: it does not import from `@frank/wallet`, `@frank/cashweb`, or `app/`, and nothing else
in this monorepo currently calls into it. It exists to be wired into the two Frank use cases
described at the bottom of this file, once that integration work is scheduled.

## What this is, and what it's based on

An *adaptor signature* lets a signer produce a signature on a message that is encrypted under a
public point `T = t*G`, such that:

- Anyone can verify the encrypted signature is well-formed relative to the signer's real public
  key and `T`, **without** learning `t` or seeing a normal signature.
- Whoever learns the discrete log `t` of `T` can decrypt the encrypted signature into an ordinary,
  standard ECDSA signature -- indistinguishable from one produced directly.
- Conversely, if someone already knows the encrypted signature *and* later observes the resulting
  plain ECDSA signature (e.g. because it landed on-chain), they can extract `t` from the pair.

That "reveal `t` to unlock a payment, or extract `t` from an observed payment" duality is the whole
point: it lets two parties condition a payment on some future, mutually-observable event (a game
outcome, a counterparty's half of a swap) without a smart contract or a trusted third party.

The construction implemented here is:

- The DLEQ-based ECDSA adaptor signature scheme specified in
  [discreetlogcontracts/dlcspecs' `ECDSA-adaptor.md`](https://github.com/discreetlogcontracts/dlcspecs/blob/master/ECDSA-adaptor.md),
  which is the same scheme implemented in production by Blockstream's `secp256k1-zkp`
  `ecdsa_adaptor` module (used by `rust-dlc` and other real Discreet Log Contract implementations).
  This package is an independent TypeScript implementation written directly from that spec text --
  not a port of the C/Rust code.
- That construction is itself based on Lloyd Fournier's
  ["One-Time Verifiably Encrypted Signatures A.K.A. Adaptor Signatures"](https://github.com/LLFourn/one-time-VES/blob/master/main.pdf),
  refined so that the security proof in Aumayr, Ersoy, Erwig, Faust, Hostakova, Maffei,
  Moreno-Sanchez, Riahi, ["Generalized Bitcoin-Compatible Channels"](https://eprint.iacr.org/2020/476.pdf)
  applies to it.
- The underlying non-interactive DLEQ (discrete-log-equality) proof and the Schnorr
  proof-of-knowledge (see "Non-DLC caveat" below) are both Fiat-Shamir-transformed Sigma protocols;
  see Schnorr, ["Efficient Identification and Signatures for Smart Cards"](https://www.win.tue.nl/~berry/CryptographicProtocols/LectureNotes.pdf)
  (CRYPTO '89) for the PoK, and the same background material for the DLEQ proof's *equality
  composition* of two such protocols.

**Non-DLC caveat (important, and why this package adds something the spec doesn't require):** the
dlcspecs document is explicit that this scheme is "applicable to DLCs only" without careful
analysis, because each adaptor signature leaks the Diffie-Hellman key between the signing key and
the encryption key. DLCs get away with this because the encryption key is an oracle's anticipated
signature, which the oracle structurally already "knows" the discrete log of -- so the spec safely
omits an explicit proof of knowledge of `t`. Frank's two target use cases (below) are *not* DLCs:
`T` is generated directly by whichever party will later reveal `t`, and nothing structurally
guarantees they actually know it. To stay inside the case the Aumayr et al. proof actually covers,
this package requires every tweak point to carry a Schnorr proof of knowledge of its own discrete
log (`generateTweak()` always produces one; `verifyTweak()` must be called and must pass before a
counterparty-supplied `T` is ever trusted -- see `src/tweak-pok.ts` for the detailed rationale).

## Test-vector conformance

This package's `verify`/`decrypt`/`recover` implementation is checked against the upstream
dlcspecs test vectors -- an independent, spec-authored set of known-good and known-bad inputs, not
just self-consistency checks against this package's own encrypt/decrypt/recover round trip (which
the other test files also cover).

- **Source:** vendored from
  [`discreetlogcontracts/dlcspecs` @ `fcc9619f3505afbb5a3d2f7ba3896fc4910ae08e`](https://github.com/discreetlogcontracts/dlcspecs/blob/fcc9619f3505afbb5a3d2f7ba3896fc4910ae08e/test/ecdsa_adaptor.json)
  into `test-vectors/ecdsa_adaptor.json`, unmodified.
- **Status: all 11 vectors pass**, across all three kinds the spec defines (see
  `src/dlcspecs-vectors.jest.test.ts`):
  - 3 `verification` vectors (including one deliberately-invalid "proof is wrong" case, and one
    "decrypted signature is high" / negation case).
  - 3 `recovery` vectors (including one deliberately-invalid "R value does not match" case).
  - 5 `serialization` vectors (canonical wire encoding/decoding, including edge cases like an
    `R`/`R_a` x-coordinate above the curve order, and rejecting a zero or overflowing `s_a`).
- Porting these vectors required adding a wire-format encoder/decoder
  (`encodeAdaptorSignature`/`decodeAdaptorSignature`/`encodeEcdsaSignature`/`decodeEcdsaSignature`
  in `src/ecdsa-adaptor.ts`) that didn't previously exist -- the core cryptographic logic
  (`encryptedSign`/`verifyEncryptedSignature`/`decryptSignature`/`recoverTweak`) matched the spec
  and all 11 vectors on the first run, with no correctness bugs found or fixed.

## Security status -- read before using this with real funds

**This code has NOT had an external security review.** It was written and hardened by someone who
is not a cryptographer, with LLM assistance, against the public spec text and papers cited above.
Passing the upstream test vectors and this package's own test suite is meaningful evidence of
correctness, but it is not equivalent to a cryptographer's review of the construction, the proofs,
or the implementation, and it says nothing about properties tests can't observe (e.g. actual,
measured side-channel resistance). Concretely, before this touches real funds:

- Get an actual cryptographer / security engineer to review the construction and this
  implementation.
- Get real timing measurements, not just the code-level reasoning in `src/curve.ts`'s header
  comment (see "Side-channel hardening" below) -- reasoning about which branches are
  secret-dependent is necessary but not sufficient; only measurement tells you whether it worked.

### Side-channel hardening

A self-directed hardening pass was done over every file that touches secret scalar material
(`src/curve.ts`, `src/dleq.ts`, `src/tweak-pok.ts`, `src/ecdsa-adaptor.ts`), with the concrete,
checkable goal of "no branch or loop bound in this codebase is keyed on the *value* of a private
key, tweak secret, or nonce" (as opposed to public data, where branching is fine and used freely).
Every function that touches secret material has a "Side-channel note" in its own doc comment
explaining its specific reasoning; **`src/curve.ts`'s file-level header comment is the canonical,
detailed writeup** -- start there. Summary of what changed and what didn't:

- `mod()`'s sign-correction and `decryptSignature`'s BIP62 low-S negation were rewritten branchless
  (arithmetic bit-masking instead of `if`/ternary).
- `modInv()` now uses a from-scratch Fermat's-little-theorem inversion (fixed-shape
  square-and-multiply over a fixed public exponent) instead of `@noble/curves`' scalar-field
  `Fn.inv()`, which (as of `@noble/curves` 2.4.0) uses the extended Euclidean algorithm --
  data-dependent control flow, the same class of bug behind real-world ECDSA nonce-recovery timing
  attacks.
- `scalarBytes()` now uses a fixed 32-iteration encoding loop instead of `@noble/curves`'
  `numberToBytesBE`, which round-trips through `toString(16)`/`padStart` (cost scales with leading
  zero nibbles).
- Point scalar multiplication, hashing, and secret generation are explicitly delegated to and
  trusted from `@noble/curves`/`@noble/hashes` (documented, not silently assumed) -- this package
  does not attempt to reimplement those.
- A couple of low-probability (~1-in-2^256), deliberately-accepted branches remain (`modInv`'s
  zero-input rejection; a retry loop in `sampleNonce`), documented at their call sites, because
  what they reveal is already visible through the function's ordinary return value regardless of
  timing.

### Nonce generation

Nonces (`sampleNonce` in `src/curve.ts`) use a *hedged* scheme: `H(tag, fresh random bytes,
...secret+public context)`, not pure RFC6979-style determinism (nonce as a pure function of the
secret key and message, no randomness). This was a deliberate decision, not an oversight -- see
`sampleNonce`'s doc comment in `src/curve.ts` for the full reasoning, summarized:

- The dlcspecs spec itself recommends this direction over plain determinism ("we recommend adding
  system randomness into the process as well ... or applying a more sophisticated approach as in
  [BIP340]").
- BIP340 (Schnorr) made the identical call for the identical reason: hedged nonces defend against
  fault/differential-power attacks that exploit a purely deterministic computation's repeatability,
  at effectively zero cost.
- This construction already gets RFC6979's core benefit (a broken/predictable RNG can't produce a
  low-entropy or cross-context-repeated nonce, since the hash input already includes secret,
  per-call context) while adding hedging's defense-in-depth on top.

## Wire format

`encodeAdaptorSignature`/`decodeAdaptorSignature` and `encodeEcdsaSignature`/`decodeEcdsaSignature`
(in `src/ecdsa-adaptor.ts`) implement the exact byte layout dlcspecs specifies, so an adaptor
signature produced here can interoperate on the wire with any other spec-conformant implementation
(e.g. `rust-dlc`/`secp256k1-zkp`):

```
adaptor signature (162 bytes) = R (33) || R_a (33) || s_a (32) || proof.b (32) || proof.c (32)
ECDSA signature   (64 bytes)  = r (32) || s (32)
```

`decodeAdaptorSignature`/`decodeEcdsaSignature` reject malformed input (wrong length, an invalid
curve point, a non-canonical scalar) rather than silently coercing it -- this is exactly what the
dlcspecs "serialization" test vectors check.

## API surface

```ts
import {
  // Types
  type Point, type Keypair, type Tweak, type AdaptorSignature, type EcdsaSignature,
  type DleqProof, type PokProof,
  // Curve constants
  G, CURVE_ORDER,
  // Key / tweak generation
  generateKeypair, generateTweak, verifyTweak,
  // Core adaptor-signature protocol
  encryptedSign, verifyEncryptedSignature, decryptSignature, recoverTweak,
  verifyStandardEcdsaSignature,
  // Wire format
  encodeAdaptorSignature, decodeAdaptorSignature, encodeEcdsaSignature, decodeEcdsaSignature,
  // Lower-level building blocks (only needed for advanced/custom use)
  dleqProve, dleqVerify, pokProve, pokVerify,
} from '@frank/adaptor-signatures'
```

## Running tests

```
yarn workspace @frank/adaptor-signatures test   # or: cd packages/adaptor-signatures && yarn jest
```

`tsc --noEmit -p tsconfig.json` is the type-check gate; this package follows the same
`tsconfig.json`/`tsconfig.jest.json`/`jest.config.js` shape as `@frank/wallet` and `@frank/cashweb`.
Neither those two packages nor this one has a separate lint step configured in this monorepo (only
`app/` runs ESLint, via `app-lint-and-test.yml`) -- `tsc` and `jest` are the applicable gates here.

## Frank integration points

This package is not wired into anything yet. These are the two concrete places it's meant to plug
in, with enough detail to actually do that wiring.

### 1. Blackjack-bot payout (provably-fair game settlement)

The idea: a game bot (following the pattern already established by `@frank/bot`'s Qwen-backed
chat bot -- see `packages/bot/qwen-bot-common.ts` for how it currently signs and sends Monad
payments via `@frank/wallet`) wants to pay out a bet *conditioned on* a provably-fair outcome seed
it commits to before the hand is dealt, without the player having to trust the bot not to grind a
favorable seed after the fact.

Wiring, using this package's API directly:

1. **Before the hand**, the bot calls `generateTweak()` to get `{ t, T, pok }`. `t` is the
   provably-fair outcome seed (or a value deterministically tied to it); `T` and `pok` are
   published to the player up front (e.g. as a `MessageItem` in the existing DM channel).
2. The player calls `verifyTweak(T, pok)` and refuses to play if it fails -- this is the
   non-DLC-context proof-of-knowledge requirement from "Non-DLC caveat" above; skipping it would
   reopen exactly the soundness gap that section describes.
3. Once the hand resolves, the bot builds the payout transaction (via `@frank/wallet`'s existing
   Monad account/tx machinery), hashes it (`messageHash`, 32 bytes, same convention `@frank/wallet`
   already uses for its own tx signing), and calls
   `encryptedSign(botPrivateKey, T, messageHash)` instead of signing normally.
4. The bot publishes the resulting `AdaptorSignature` (via `encodeAdaptorSignature` for the wire
   representation) to the player, who calls `verifyEncryptedSignature(botPublicKey, T, messageHash,
   adaptorSig)` -- this is the player's cryptographic proof that the payout is real and correctly
   formed *before* the bot has revealed anything about the outcome seed.
5. When the bot reveals `t` (the actual provably-fair seed reveal, e.g. posted alongside the hand's
   outcome), anyone -- the player, or the bot itself -- calls `decryptSignature(adaptorSig, t)` to
   get a normal, broadcastable Monad transaction signature.
6. If the bot ever tried to reveal a *different* `t` than what it actually used (i.e. cheat), the
   player who holds the original `adaptorSig` plus the transaction that actually lands on-chain can
   call `recoverTweak` to extract the real `t` and prove the mismatch -- this is the fraud-proof
   property described in `ECDSA-adaptor.md`'s introduction.

No blackjack game logic exists in this repo yet; this section describes how a future one would use
this package, not an existing integration.

### 2. DEX / atomic-swap settlement

Per the longer-term Frank design (topics as an order book, DMs as the negotiation channel for a
cross-chain swap's parameters -- see GitHub issue #59 for the current state of that design): two
parties negotiate a swap (e.g. "chain-A asset for chain-B asset") over DMs, then need a way to make
each leg's execution contingent on the other's, without a shared smart-contract platform. A classic
HTLC (hash-timelock contract) does this with a hashlock + timelock pair baked into each chain's
locking script. Adaptor signatures are a *scriptless* alternative to that hashlock: instead of a
contract enforcing "reveal the preimage of this hash to spend," the reveal is baked directly into
an otherwise-ordinary-looking signature.

Wiring, at the point where the negotiation moves from "agreeing terms" to "exchanging swap
parameters" in the DM thread:

1. One party (say, the one revealing second) calls `generateTweak()` and sends `{T, pok}` to the
   counterparty over the existing DM channel, in place of (or alongside) a classic hashlock's hash.
2. The counterparty calls `verifyTweak(T, pok)` before proceeding -- same non-DLC requirement as
   above, and for the same reason: nothing about a swap structurally guarantees the tweak-generating
   party actually knows `t`, unlike a DLC oracle.
3. Each side prepares their own chain's settlement transaction (leg A on chain A, leg B on chain B)
   and adaptor-signs it under the shared `T`: `encryptedSign(privateKey, T, messageHash)`. Both
   `AdaptorSignature`s (serialized via `encodeAdaptorSignature`) travel over the DM channel as the
   swap parameters, alongside whatever chain-specific transaction data each leg needs (timelocks for
   the refund path remain necessary exactly as in a classic HTLC -- adaptor signatures replace the
   hashlock, not the timeout/refund side of the contract).
4. Each side calls `verifyEncryptedSignature` on the counterparty's adaptor signature before
   committing to their own leg -- this is what makes the swap atomic: neither side broadcasts
   anything until both encrypted signatures check out.
5. Whichever leg settles first (say, on chain A) does so by someone calling
   `decryptSignature(adaptorSigA, t)` and broadcasting the resulting ordinary signature. The
   counterparty, watching chain A, calls `recoverTweak(T, adaptorSigA, observedSigA)` to pull `t`
   back out of the now-public chain-A signature, then calls `decryptSignature(adaptorSigB, t)` to
   unlock their own leg on chain B. This is the mechanism that makes the swap atomic without either
   chain needing to know about the other.

**Scope note:** per the current Frank design notes, actual swap *execution* (this kind of
settlement logic) is explicitly out of scope for Frank itself today -- Frank's present job is the
order-board (topics) and encrypted negotiation substrate (DMs) only. This package exists so the
settlement primitive is ready and tested if/when that scope decision changes, not because
execution is being built now.
