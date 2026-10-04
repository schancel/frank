# `@frank/threshold-ecdsa`

Two-party threshold ECDSA over secp256k1: two parties jointly own one ordinary
key (one EVM address) and can only sign together. On top of that, two-party
adaptor pre-signing in the encrypted-signature format of
`@frank/adaptor-signatures`.

**Experimental. Not audited. Not for real funds.** See
[Security status](#security-status) and [Review first](#review-first).

## In plain words

- Two people run key generation once. Each ends up with a _share_; the address
  belongs to both. Neither can sign alone and neither ever sees the whole key.
- To sign, they exchange five small messages. The result is a normal ECDSA
  signature (low-s, with recovery bit) that any EVM node accepts.
- They can instead produce an _adaptor pre-signature_ locked to a point `T`:
  whoever knows the secret `t` behind `T` can turn it into a real signature,
  and doing so reveals `t` to the other party.
- The address can be _tweaked_ by a 32-byte commitment (for example a hash of
  the game state) without running key generation again.

## Protocol choice

The package implements **Lindell, "Fast Secure Two-Party ECDSA Signing"**
(CRYPTO 2017, ePrint 2017/552), with the Paillier setup done in both
directions so that either party can take either signing role.

| Candidate                       | Verdict                                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lindell 2017 (Paillier)         | **Chosen.** Small, fully specified, signing is 4 messages and tens of milliseconds, and every building block (Paillier, three zero-knowledge proofs, hash commitments, Schnorr proofs) can be written directly on native `bigint` and `@noble` with no new dependency.                             |
| DKLs18 / DKLs19 / DKLs23 (OT)   | Rejected for this package. No Paillier and cheap key generation, but needs base oblivious transfer, an OT extension (KOS or SoftSpokenOT) and the DKLs multiplication with its consistency checks: several thousand lines of subtle code with no reference vectors to check against in TypeScript. |
| "Simple" multiplicative sharing | Rejected. Constructions that skip the range proof, the modulus proof or the abort rule are exactly what the 2023 BitForge/TSSHOCK and Lindell17-abort disclosures broke.                                                                                                                           |

Known attacks on implementations of this family, and what this one does:

- **Missing Paillier checks (BitForge, 2023).** A malicious modulus with small
  factors, or with `gcd(N, phi(N)) != 1`, lets the key owner read the other
  party's share out of decryptions. Here the verifier requires a 2048-bit odd
  modulus with no prime factor below 6370, a proof that
  `gcd(N, phi(N)) = 1`, a range proof for the encrypted share, and a proof that
  the ciphertext encrypts the discrete log of the public share.
- **Weak Fiat-Shamir / too few repetitions (TSSHOCK, 2023).** Every transcript
  hash length-prefixes each field and is bound to the session, both identities
  and the prover. The modulus proof uses 11 repetitions (error below 2^-128).
  The cut-and-choose range proof is interactive with a pre-committed 40-bit
  challenge, never Fiat-Shamir.
- **Lindell17 abort attack (CVE-2023-33242).** If the party that decrypts keeps
  signing after it decrypted something that did not give a valid signature, the
  other party learns its share one bit per failure. Here that failure burns the
  key share: its secrets are wiped, the handle refuses to sign or export, and
  the error says `keyShareBurned`. The caller must make that durable (below).

### Security assumptions

- ECDSA over secp256k1 is unforgeable; discrete log is hard in secp256k1.
- Paillier with a 2048-bit modulus is IND-CPA secure (decisional composite
  residuosity). For simulation-based security Lindell additionally needs his
  "Paillier-EC" assumption (paper Section 5); the game-based proof does not.
- SHA-256 behaves as a random oracle (commitments, Fiat-Shamir, nonce hedging).
- The range proof has statistical soundness 2^-40 per key-generation attempt
  (the paper's parameter). A failed attempt aborts key generation, so a
  cheater gets one try per attempt and the other party sees every failure.
- The caller's `randomBytes` is a CSPRNG.
- No side-channel resistance: JavaScript `bigint` is not constant-time. An
  attacker who can time this process is out of scope.
- Secrets are kept in byte arrays that are wiped when a session finishes or
  aborts and when a share is burned or destroyed. Intermediate `bigint` values
  cannot be wiped in JavaScript and remain until garbage collection.

### What the paper proves and what this package adds on its own

Proven in the paper (for sequential sessions): key generation and plain
signing in one direction. Added here without a published proof, each with the
argument we rely on, and each listed under [Review first](#review-first):

1. **Both directions at once.** Each direction is the paper's protocol
   unchanged; the two share only the secret shares. Both shares are therefore
   restricted to `[n/3, 2n/3)` (the paper restricts only P1's).
2. **The tweak.** See [Key tweak](#key-tweak).
3. **Two-party adaptor pre-signing.** See [Adaptor pre-signing](#adaptor-pre-signing).

### Deliberately not provided

- More than two parties; thresholds other than 2-of-2.
- Identifiable abort: when a session fails you learn that it failed, not a
  proof of who cheated that a third party could check.
- Proactive share refresh and share recovery. If a share is lost or burned, the
  key is gone; the application needs its own exit (for example a pre-signed
  refund).
- Fairness: one party always learns the result first
  ([Who should initiate](#who-should-initiate)).
- Presignatures (a message-independent first phase). Not offered, on purpose:
  with a per-hand key tweak, letting the nonce be fixed before the digest and
  tweak are known is the setting in which ECDSA with additive key derivation is
  known to lose security (Groth and Shoup, "On the Security of ECDSA with
  Additive Key Derivation and Presignatures", EUROCRYPT 2022). Here the digest,
  tweak and adaptor point are hashed into the session before any nonce exists.
  To save round trips, run several sessions side by side and put their
  same-numbered messages into one transport message (see the caveat on
  concurrency below).
- Any networking, storage, or transaction building.

## Cost

Measured under jest on the development machine (Apple silicon, Node 26, single
thread, machine busy with other work):

| Operation                         | Time per party                      | Messages | Largest message |
| --------------------------------- | ----------------------------------- | -------- | --------------- |
| Key generation                    | 8 to 9 s (15 s with machine loaded) | 7        | 45,293 bytes    |
| Signing                           | 60 ms (100 ms loaded)               | 5        | 550 bytes       |
| Adaptor pre-signing               | 110 ms (195 ms loaded)              | 5        | 582 bytes       |
| `restoreKeyShare` (re-derivation) | 1 to 2 s                            | -        | -               |

Key generation is dominated by the cut-and-choose range proof (about 80
Paillier encryptions to prove and 60 to verify, each a 2048-bit exponentiation
modulo a 4096-bit number). Paillier prime generation itself is about 0.5 s.

**Amortise it:** one key generation per pair of players, then any number of
signatures and tweaks. **Run key generation in a Web Worker**; the two slow
steps block for about 5 s each. Signing can run on the main thread.

Exact message sizes, including the 38-byte header:

| Protocol     | 1   | 2      | 3      | 4               | 5               | 6   | 7   |
| ------------ | --- | ------ | ------ | --------------- | --------------- | --- | --- |
| Key gen      | 102 | 44,712 | 45,293 | 12,211 - 23,731 | 11,758 - 23,278 | 231 | 103 |
| Sign         | 70  | 136    | 168    | 550             | 103             |     |     |
| Adaptor sign | 70  | 234    | 266    | 582             | 200             |     |     |

Every message is below 46,000 bytes and anything longer is rejected before
parsing. If the transport needs smaller pieces, split and reassemble the two
45 KB key-generation messages outside this package.

Stored sizes: an exported key share is about 2.0 KB (secret); the public record
for `restoreKeyShare` is about 1.7 KB; an exported in-flight signing session is
under 1 KB (secret).

## API

Everything returns `ThresholdResult<T>`:
`{ ok: true, value } | { ok: false, error: { code, sessionAborted, keyShareBurned } }`.
All byte inputs are copied on entry; all outputs are fresh arrays. Errors never
contain data.

```ts
type RandomBytes = (length: number) => Uint8Array

interface Step<Session, Result> {
  session: Session // pass to the next step call
  outgoing: Uint8Array | null // deliver to the other party
  result: Result | null // non-null once this party is done
}

// Key generation -----------------------------------------------------------
function startKeygen(input: {
  role: 'initiator' | 'responder'
  sessionId: Uint8Array // 32 bytes, agreed, never reused
  localId: Uint8Array // 1..64 bytes
  peerId: Uint8Array // 1..64 bytes, different
  secretSeed?: Uint8Array // 32 bytes: derive the share instead of drawing it
  randomBytes: RandomBytes
}): ThresholdResult<Step<KeygenSession, KeyShare>>
function keygenStep(
  session: KeygenSession,
  message: Uint8Array,
): ThresholdResult<Step<KeygenSession, KeyShare>>
function abortKeygen(session: KeygenSession): void

// Key shares ---------------------------------------------------------------
function describeKeyShare(share: KeyShare): ThresholdResult<{
  keyId: Uint8Array // 32 bytes, equal on both sides
  publicKey: Uint8Array // 33 bytes compressed
  address: Uint8Array // 20 bytes, EVM
  localId: Uint8Array
  peerId: Uint8Array
  burned: boolean
}>
function exportKeyShare(share: KeyShare): ThresholdResult<Uint8Array> // SECRET
function importKeyShare(bytes: Uint8Array): ThresholdResult<KeyShare>
function exportKeyShareRecord(share: KeyShare): ThresholdResult<Uint8Array> // public
function restoreKeyShare(input: {
  secretSeed: Uint8Array
  record: Uint8Array
}): ThresholdResult<KeyShare>
function destroyKeyShare(share: KeyShare): ThresholdResult<true>

// Tweak ----------------------------------------------------------------------
function tweakPublicKey(
  publicKey: Uint8Array, // 33 bytes
  commitment: Uint8Array, // 32 bytes
): ThresholdResult<{
  publicKey: Uint8Array
  address: Uint8Array
  tweak: Uint8Array
}>

// Signing and adaptor pre-signing --------------------------------------------
function startSign(input: {
  keyShare: KeyShare
  role: 'initiator' | 'responder'
  sessionId: Uint8Array // 32 bytes, agreed, never reused with this key
  digest: Uint8Array // 32 bytes
  tweakCommitment?: Uint8Array // 32 bytes: sign for the tweaked key
  adaptor?: { point: AdaptorPoint; proof: AdaptorSecretProof } // pre-sign instead
  randomBytes: RandomBytes
}): ThresholdResult<Step<SignSession, SignResult>>
function signStep(
  session: SignSession,
  message: Uint8Array,
): ThresholdResult<Step<SignSession, SignResult>>
function abortSign(session: SignSession): void

type SignResult =
  | {
      kind: 'signature'
      publicKey: Uint8Array // the (tweaked) key it verifies under
      address: Uint8Array
      signature: Uint8Array // r (32) || s (32), low-s
      recovery: 0 | 1 // EIP-1559 yParity
    }
  | {
      kind: 'adaptor-signature'
      publicKey: Uint8Array
      address: Uint8Array
      adaptorSignature: AdaptorSignatureBytes // 162 bytes
    }

// Crash recovery for signing -------------------------------------------------
function exportSignSession(session: SignSession): ThresholdResult<Uint8Array> // SECRET
function importSignSession(input: {
  state: Uint8Array
  keyShare: KeyShare
  randomBytes: RandomBytes
}): ThresholdResult<SignSession>
```

Typical loop, identical for key generation and signing:

```ts
let step = must(startSign({ keyShare, role, sessionId, digest, randomBytes }))
if (step.outgoing) transport.send(step.outgoing)
while (step.result === null) {
  const next = signStep(step.session, await transport.receive())
  if (!next.ok) {
    if (next.error.keyShareBurned) await storage.markBurned(keyId) // durable
    if (next.error.sessionAborted) throw new Error(next.error.code) // new session id
    continue // a stray frame; the session is still usable
  }
  step = next.value
  if (step.outgoing) transport.send(step.outgoing)
}
```

Both parties end up holding the same result: the initiator when it processes
message 4, the responder when it processes message 5.

To complete an adaptor pre-signature, or to extract the secret from the
completed signature, use `completeAdaptorSignature` and `extractAdaptorSecret`
from `@frank/adaptor-signatures` with `publicKey` set to the `publicKey` of the
result. The completed signature is 64 bytes without a recovery bit; for an EVM
transaction try `yParity` 0 and 1 and keep the one that recovers the address
(the test suite does exactly this).

## Rules for callers

These are not suggestions. Breaking any of them can leak the key.

1. **Session ids are single-use.** Both parties must agree on a 32-byte id that
   was never used before with the same pair (key generation) or the same key
   (signing). After _any_ error with `sessionAborted`, the session is dead;
   retry with a new id. The package stores nothing and cannot detect reuse.
2. **A burned share stays burned.** On `keyShareBurned`, record it durably
   against the `keyId`, delete every stored copy of the share, and never
   `importKeyShare` or `restoreKeyShare` it again. The in-memory handle already
   refuses; a copy reloaded from disk would not know.
3. **An aborted key generation must not be retried with the same share.** Its
   abort can tell the other party one bit about your share. With `secretSeed`
   the share is a function of the seed, the session id and both identities, so
   a new session id gives a new share automatically. Never reuse a key
   generation session id.
4. **One state object, one message.** `keygenStep` and `signStep` consume the
   state they are given and return a new one. A used state is refused
   (`state-already-used`).
5. **Persistence rules** (only if you use `exportSignSession`):
   - Persist the exported new state **before** you send that step's `outgoing`
     message or act on its `result`, overwriting the previous state of that
     session. For the initiator this starts with the state returned by
     `startSign`: it already contains the nonce behind message 1.
   - After a crash, load only the most recent state and re-send the `outgoing`
     you stored with it.
   - Never load an older state of a session once a newer one exists, and never
     load one state into two processes. The dangerous case is concrete: an
     initiator state that is waiting for message 2, fed two different message
     2s, signs twice with the same nonce share against two different joint
     nonces, and two such signatures give the responder the private key.
   - If you cannot guarantee this, do not export sessions: after a crash,
     abandon in-flight sessions and start new ones. Signing costs about 0.1 s.
   - Key-generation sessions cannot be exported. After a crash, start again
     with a new session id. No funds exist at the address before key generation
     finishes.
6. **Run sessions for one key one after another** if you want to stay inside
   what the paper proves. Batching several sessions in the same round trips is
   outside its proof; see [Review first](#review-first).
7. **Authenticate the transport.** Identities are only bytes hashed into the
   transcript. They bind messages to a session; they do not prove who sent
   them.

### Who should initiate

The initiator learns the result first and can refuse to send message 5.

- Plain signing: the initiator can keep a valid signature to itself and
  broadcast it. Pick as initiator the party for whom that is harmless.
- Adaptor pre-signing: **the party that must later extract the secret should
  be the initiator**, and the party that knows the secret the responder. Then a
  withholding initiator holds a pre-signature it cannot complete, and the
  responder can complete nothing it was not sent. With the roles the other way
  round, the secret holder could complete and broadcast while the other party
  never received the pre-signature it needs for extraction.

Because key generation sets up both directions, the roles can differ per
session.

## Key tweak

```
h  = SHA256(SHA256(tag) || SHA256(tag) || P || commitment) mod n
P' = P + h*G          tag = "FRANK-TECDSA-V1/tweak", P = 33-byte compressed key
```

`h` is public. The key behind `P'` is `x_A * x_B + h`. Shares here are
multiplicative, so the tweak cannot be folded into a share (that would need
`h / x_B`, which nobody knows). With additive shares one party would simply add
`h` to its share; that does not apply here.

Instead **no share changes** and the responder adds `r*h` to the message term:

```
c3 = Enc(rho*n + k2^-1 * (m + r*h))  (+)  (k2^-1 * r * x_R) (*) c_key
Dec(c3) = k2^-1 * (m + r*(x_I*x_R + h))  mod n
```

Why this is sound: the messages are those of the unmodified protocol run on
the scalar `m' = m + r*h` instead of `m`. Neither party sees anything new, so
the paper's simulation applies with `m'`; and `(r, s)` satisfies the ECDSA
equation for `m` under `x + h` exactly when it does for `m'` under `x`. What
remains is the unforgeability of ECDSA when signatures under additively
related keys are available, which holds when the tweak is fixed before the
nonce (Groth and Shoup 2022, without presignatures). Here the commitment and
`P'` are hashed into the session binding before either nonce share is drawn,
and the initiator verifies the final signature against `P'`. Two parties that
disagree on the commitment compute different bindings and reject each other's
first message.

## Adaptor pre-signing

The output is byte-for-byte the 162-byte encrypted signature of
`@frank/adaptor-signatures` (`R || R_a || s_a || b || c`) for the joint (or
tweaked) key. `verifyAdaptorSignature`, `completeAdaptorSignature` and
`extractAdaptorSecret` accept it unchanged; the tests check all three. Nothing
had to be made incompatible.

With joint nonce `k = k1*k2`: `R_a = k*G`, `R = k*T`, `r = R.x`,
`s_a = k^-1 * (m + r*x)`. The Paillier step is the same as in plain signing
with this `r`. Each party sends its nonce share over both bases (`k_i*G`,
`k_i*T`) with a session-bound equality proof, so both know `R = k*T` is right.

The format also needs one discrete-log-equality proof `(b, c)` for the _joint_
nonce, which neither party knows. It is built like this (I = initiator, R =
responder; `a1`, `a2` fresh random scalars):

```
I commits to  A1 = a1*G, A1T = a1*T          (inside the message-1 commitment)
R sends       A2 = a2*G, A2T = a2*T          (message 2)
both compute  A_G = A1 + k1*A2 = A1 + a2*R1,   A_T = A1T + k1*A2T = A1T + a2*R1T
              b   = H_DLEQ(R_a, T, R, A_G, A_T)
R sends       z2 = a2 + b*k2                 (message 4)
I checks      z2*G = A2 + b*R2  and  z2*T = A2T + b*R2T
I sets        c  = a1 + k1*z2                (then c*G = A_G + b*R_a, c*T = A_T + b*R)
```

Why we believe it is safe (an argument, not a proof):

- `z2` is a Schnorr response for `k2` under a one-time nonce `a2`; given
  `A2` it reveals nothing about `k2` beyond `R2`.
- `c = a1 + k1*z2` has two fresh unknowns (`a1`, `k1`) and satisfies the
  publicly checkable relation `c*G = A1 + z2*R1`, so it reveals nothing about
  `k1` beyond `R1`. Releasing `c` without the mask `a1` would be fatal
  (`k1 = c / z2`); the mask is the point of `A1`.
- The initiator commits to `A1` before seeing `A2`, and checks `z2` against
  `A2` before using it, so neither side can steer the other's contribution.
- The result is a standard Fiat-Shamir proof over the standard statement, so a
  third party gets the usual soundness.

## Deterministic shares

Allowed, with conditions. With `secretSeed`, the share and the Paillier primes
are derived from `(seed, session id, both identities, own identity)`; proofs
still use `randomBytes`. Use a seed derived from the wallet root for this
purpose only, and a session id that encodes your context (peer, table, attempt
counter).

What must still be stored: the **public record** (`exportKeyShareRecord`,
about 1.7 KB, no secrets). It holds the other party's verified Paillier
modulus and encrypted share, which cannot be re-derived, only re-obtained by
running key generation again. `restoreKeyShare(seed, record)` rebuilds the
share in about a second and fails unless everything matches.

Rule 3 above is the safety condition: one seed-derived share per key-generation
session id, never retried.

## Tests and vectors

`yarn test` runs six suites, 76 tests (about 4 minutes; key generation is slow):

- `primitives`: bytes, RNG handling, integer arithmetic, point and scalar
  parsing, commitments, both sigma proofs, Paillier, the modulus proof
  (including a modulus with a small factor and one with `p | q - 1`), the range
  proof (including a cheating prover that passes only when it guesses the whole
  challenge).
- `keygen`: an honest run, share export/import/restore, and a malicious
  counterpart for every one of the seven messages.
- `sign`, `adaptor-sign`: honest runs in both role assignments, cross-checked
  with `@noble/curves`, `ethers` (a real EIP-1559 transaction recovers to the
  joint and the tweaked address) and `@frank/adaptor-signatures`; a malicious
  counterpart for every message; the abort rule; nonce freshness; crash
  recovery.
- `vectors`: regenerates `test-vectors/threshold_ecdsa.json` byte for byte.
- `timing`: prints the numbers in the cost table.

`test-vectors/threshold_ecdsa.json` holds one full key generation and four
signing transcripts (plain and adaptor, both role assignments, with and
without tweak) produced from a documented seeded byte stream, with every
message, both exported shares and all results. The adaptor point and its proof
are inputs of the vector because `@frank/adaptor-signatures` generates that
proof with ambient randomness.

## Security status

No external cryptographic or side-channel review. Passing tests is evidence of
correctness, not of security. Section and protocol numbers cited in the source
were written from memory of the papers (the build environment could not fetch
them) and must be confirmed against the PDFs during review.

### Review first

1. **The joint discrete-log-equality proof in adaptor pre-signing**
   (`sign.ts`, rounds 3 and 4). Own construction; argued above, not proven.
2. **Running Lindell's protocol in both directions with the same shares**, and
   restricting both shares to `[n/3, 2n/3)`.
3. **The tweak inside the Paillier step**, and reliance on ECDSA with additive
   key derivation.
4. **Interactive range proof with a pre-committed 40-bit challenge**
   (`keygen.ts`, `paillier-proofs.ts`): soundness 2^-40 per attempt; the
   message ordering that reveals the L_PDL challenge only after the range proof
   verified.
5. **The modulus proof does not show that N has exactly two prime factors.**
   We argue the protocol only needs encryption to be a bijection and the
   plaintext not to wrap (2048-bit N against values below n^3), both of which
   are enforced. Confirm.
6. **Concurrent sessions.** The paper's proof is for sequential sessions.
7. **Burn-on-failure and state rollback** depend on the caller's storage
   discipline; the package cannot enforce them.
8. **Timing.** `modPow` and `modInverse` on secret exponents and values are
   not constant-time.
