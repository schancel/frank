# `@frank/threshold-ecdsa`

Two-party threshold ECDSA over secp256k1: two parties jointly own one ordinary
key (one EVM address) and can only sign together. On top of that, two-party
adaptor pre-signing in the encrypted-signature format of
`@frank/adaptor-signatures`.

**Experimental. Not audited. Testnet only.** See
[Security status](#security-status).

## In plain words

- Two people run key generation once. Each ends up with a _share_; the address
  belongs to both. Neither can sign alone and neither ever sees the whole key.
- Roles are fixed when the key is made. The **initiator** starts every signing
  session and learns every result first. The **responder** is the one who may
  hold secrets that a payout must reveal.
- To sign, they exchange five small messages. The result is a normal ECDSA
  signature (low-s, with recovery bit) that any EVM node accepts.
- They can instead produce an _adaptor pre-signature_ tied to a _lock_ made by
  the responder: the responder can turn it into a real signature, and doing so
  reveals the lock's secret to the initiator.
- A lock can be a commitment to a hidden value (a card). The two then pre-sign
  one transaction per possible value, and the responder can complete only the
  one for the value it committed to.
- The address can be _tweaked_ by a 32-byte commitment (for example a hash of
  the game state) without running key generation again.

## Protocol choice

The package implements **Lindell, "Fast Secure Two-Party ECDSA Signing"**
(CRYPTO 2017, ePrint 2017/552) with fixed roles, exactly as in the paper: the
key's initiator is P1 (it owns the Paillier key), the responder is P2.

| Candidate                       | Verdict                                                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lindell 2017 (Paillier)         | **Chosen.** Small, fully specified, signing is 4 messages and tens of milliseconds, and every building block (Paillier, three zero-knowledge proofs, hash commitments, Schnorr proofs) can be written directly on native `bigint` and `@noble` with no new dependency. |
| DKLs18 / DKLs19 / DKLs23 (OT)   | Rejected for this package. No Paillier and cheap key generation, but needs base oblivious transfer, an OT extension and the DKLs multiplication with its consistency checks: several thousand lines of subtle code with no TypeScript reference to check against.      |
| "Simple" multiplicative sharing | Rejected. Constructions that skip the range proof, the modulus proof or the abort rule are exactly what the 2023 BitForge/TSSHOCK and Lindell17-abort disclosures broke.                                                                                               |

Known attacks on implementations of this family, and what this one does:

- **Missing Paillier checks (BitForge, 2023).** The verifier requires a
  2048-bit odd modulus with no prime factor below 6370, a proof that
  `gcd(N, phi(N)) = 1`, a range proof for the encrypted share, and a proof that
  the ciphertext encrypts the discrete log of the public share.
- **Weak Fiat-Shamir / too few repetitions (TSSHOCK, 2023).** Every transcript
  hash length-prefixes each field and is bound to the session, both identities
  and the prover. The modulus proof uses 11 repetitions (error below 2^-128).
  The cut-and-choose range proof is interactive with a pre-committed 80-bit
  challenge, never Fiat-Shamir.
- **Lindell17 abort attack (CVE-2023-33242).** If the decrypting party keeps
  signing after it decrypted something that did not give a valid signature, the
  other party learns its share one bit per failure. Here that failure burns the
  key share: its secrets are wiped, every handle and stored copy of it is
  refused for the rest of the process, and the error says `keyShareBurned`. The
  caller must make that durable (below). A zero-knowledge proof that the
  ciphertext is well-formed would remove the need to burn; it costs 0.3 to
  0.6 s per signature and is another tailored proof, so it is not implemented.
- **One Paillier key for several peers.** Unsound: a second peer could submit
  ciphertexts built from the first peer's encrypted share. Each key generation
  makes its own Paillier key, derived from that session's context.

### Security assumptions

- ECDSA over secp256k1 is unforgeable; discrete log is hard in secp256k1.
- Paillier with a 2048-bit modulus is IND-CPA secure (decisional composite
  residuosity). For simulation-based security Lindell additionally needs his
  "Paillier-EC" assumption (paper Section 5); the game-based proof does not.
- SHA-256 behaves as a random oracle (commitments, Fiat-Shamir, nonce hedging,
  the storage MAC key, the second generator H).
- The range proof has statistical soundness 2^-80 per key-generation attempt.
- The caller's `randomBytes` is a CSPRNG.
- **The transport is authenticated.** See rule 1 below.
- No side-channel resistance: JavaScript `bigint` is not constant-time. An
  attacker who can time this process is out of scope.
- Secrets are kept in byte arrays that are wiped when a session finishes or
  aborts and when a share is burned or destroyed. Intermediate `bigint` values
  cannot be wiped in JavaScript and remain until garbage collection.

### What is from a paper and what is this package's own

From papers: key generation and plain signing (Lindell 2017, sequential
sessions); the modulus proof (Goldberg, Reyzin, Sagga, Baldimtsi, ePrint
2018/057); the shape of two-party adaptor pre-signing on Lindell 2017
(Malavolta, Moreno-Sanchez, Schneidewind, Kate, Maffei, "Anonymous Multi-Hop
Locks", NDSS 2019); the opening proof of commitment locks (Okamoto, CRYPTO
'92); the adaptor format and its security (dlcspecs; Aumayr et al., ePrint
2020/476).

This package's own, each with the argument we rely on below:

1. **The tweak inside the Paillier step.** See [Key tweak](#key-tweak).
2. **The joint equality proof in adaptor pre-signing.** See
   [Adaptor pre-signing](#adaptor-pre-signing).
3. **Commitment locks** as adaptor points. See [Locks](#locks).
4. **Engineering changes to Lindell's key generation** that do not touch its
   proofs: 80 range-proof rounds instead of 40, hashed range-proof commitments,
   per-party salts, key confirmation.

### Deliberately not provided

- More than two parties; thresholds other than 2-of-2.
- Both role assignments on one key. If two users need each to be the
  initiator, they run two key generations and get two independent joint keys
  (two addresses, independent shares).
- Identifiable abort beyond the `peerFault` flag: you learn that the peer sent
  something that failed a check, not a proof of it a third party could verify.
- Proactive share refresh and share recovery. If a share is lost or burned, the
  key is gone; the application needs its own exit.
- Fairness: the initiator always learns the result first.
- Presignatures (a message-independent first phase). Not offered, on purpose:
  with a per-hand key tweak, fixing the nonce before the digest and tweak are
  known is the setting in which ECDSA with additive key derivation loses
  security (Groth and Shoup, EUROCRYPT 2022). Here digest, tweak and lock are
  hashed into the session before any nonce exists.
- Any networking, storage, or transaction building.

## Cost

Measured under jest on the development machine (Apple silicon, Node 26, single
thread) **while the machine was heavily loaded by other jobs**; expect better
on an idle machine and worse on a phone:

| Operation           | Initiator | Responder | Messages | Largest message  |
| ------------------- | --------- | --------- | -------- | ---------------- |
| Key generation      | 7.0 s     | 6.4 s     | 8        | 46,230 bytes max |
| Signing             | 66 ms     | 71 ms     | 5        | 550 bytes        |
| Adaptor pre-signing | 134 ms    | 120 ms    | 5        | 582 bytes        |
| `restoreKeyShare`   | about 1 s | fast      | -        | -                |

Key generation is dominated by the 80-round range proof: the initiator makes
160 Paillier encryptions (with its private CRT speed-up), the responder
verifies about 120 without it. Two steps block for 6 to 8 s each (the
initiator's handling of message 2 and the responder's of message 5).
**Run key generation in a Web Worker.** Signing can run on the main thread.

**Amortise it:** one key generation per pair of players and role assignment,
then any number of signatures, tweaks and locks.

Message sizes including the 38-byte header:

| Protocol     | 1   | 2   | 3     | 4   | 5               | 6   | 7   | 8   |
| ------------ | --- | --- | ----- | --- | --------------- | --- | --- | --- |
| Key gen      | 102 | 200 | 3,784 | 624 | 25,750 - 46,230 | 166 | 135 | 70  |
| Sign         | 70  | 136 | 168   | 550 | 103             |     |     |     |
| Adaptor sign | 70  | 234 | 266   | 582 | 200             |     |     |     |

Key-generation message 5 is about 36 KB on average. Anything above 47,000
bytes is rejected before parsing.

Stored sizes: an exported share is about 1.3 KB (initiator) or 1.0 KB
(responder), secret; the public record for `restoreKeyShare` is about 1.0 KB;
an exported in-flight signing session is under 1.3 KB, secret.

## API

Everything returns `ThresholdResult<T>`:

```ts
type ThresholdResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: {
        code: ThresholdErrorCode
        sessionAborted: boolean // this session is dead; use a new session id
        keyShareBurned: boolean // this key share must never sign again
        peerFault: boolean // the peer's message failed a check
      }
    }
```

All byte inputs are copied on entry; all outputs are fresh arrays. Errors
never contain data.

```ts
type RandomBytes = (length: number) => Uint8Array

interface Step<Session, Result> {
  session: Session // pass to the next step call
  outgoing: Uint8Array | null // deliver to the other party
  result: Result | null // non-null once this party is done
}

// Key generation -----------------------------------------------------------
function startKeygen(input: {
  role: 'initiator' | 'responder' // fixed for the life of the key
  sessionId: Uint8Array // 32 bytes, agreed
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
  role: 'initiator' | 'responder'
  burned: boolean
}>
function exportKeyShare(share: KeyShare): ThresholdResult<Uint8Array> // SECRET
function importKeyShare(bytes: Uint8Array): ThresholdResult<KeyShare>
function exportKeyShareRecord(share: KeyShare): ThresholdResult<Uint8Array> // public, MACed
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

// Locks (responder only) -----------------------------------------------------
type AdaptorLock =
  | {
      kind: 'point'
      point: AdaptorPoint
      proof: AdaptorSecretProof
      ownerProof: Uint8Array
    }
  | {
      kind: 'commitment'
      commitment: Uint8Array
      proof: Uint8Array
      index: number
    }

function createPointLock(input: {
  keyShare: KeyShare
  randomBytes: RandomBytes
}): ThresholdResult<{ secret: AdaptorSecret; lock: AdaptorLock }>
function createCommitmentLock(input: {
  keyShare: KeyShare
  value: number // 0 .. 2^32 - 1
  randomBytes: RandomBytes
}): ThresholdResult<{
  secret: Uint8Array
  commitment: Uint8Array
  proof: Uint8Array
}>
function commitmentLockPoint(
  commitment: Uint8Array,
  index: number,
): ThresholdResult<Uint8Array>
function completeCommitmentLock(input: {
  publicKey: Uint8Array
  commitment: Uint8Array
  index: number
  digest: Uint8Array
  adaptorSignature: AdaptorSignatureBytes
  secret: Uint8Array
}): ThresholdResult<{ signature: Uint8Array; recovery: 0 | 1 }>
function extractCommitmentLockSecret(input: {
  publicKey: Uint8Array
  commitment: Uint8Array
  index: number
  digest: Uint8Array
  adaptorSignature: AdaptorSignatureBytes
  completedSignature: Uint8Array
}): ThresholdResult<Uint8Array>
function recoveryBit(
  publicKey: Uint8Array,
  digest: Uint8Array,
  signature: Uint8Array,
): 0 | 1 | null

// Signing and adaptor pre-signing --------------------------------------------
function startSign(input: {
  keyShare: KeyShare // its role is this party's role
  sessionId: Uint8Array // 32 bytes, agreed, never reused with this key
  digest: Uint8Array // 32 bytes
  tweakCommitment?: Uint8Array // 32 bytes: sign for the tweaked key
  lock?: AdaptorLock // pre-sign for this lock instead
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
let step = must(startSign({ keyShare, sessionId, digest, randomBytes }))
if (step.outgoing) transport.send(step.outgoing)
while (step.result === null) {
  const next = signStep(step.session, await transport.receive())
  if (!next.ok) {
    if (next.error.keyShareBurned) await storage.markBurned(keyId) // durable
    if (next.error.peerFault) await storage.distrust(peerId)
    if (next.error.sessionAborted) throw new Error(next.error.code) // new session id
    continue // a stray frame; the session is still usable
  }
  step = next.value
  if (step.outgoing) transport.send(step.outgoing)
}
```

Both parties end up holding the same result: the initiator when it processes
message 4, the responder when it processes message 5. In key generation the
responder gets its share at message 7 and the initiator at message 8, after
each has seen the other's key confirmation.

Completing and extracting:

- Point lock: `completeAdaptorSignature` and `extractAdaptorSecret` from
  `@frank/adaptor-signatures`, with `publicKey` from the result and the lock's
  `point` and `proof`. The completed signature has no recovery bit; get it
  with `recoveryBit`.
- Commitment lock: `completeCommitmentLock` and `extractCommitmentLockSecret`
  from this package. (The other package's functions demand a proof of
  knowledge for the exact lock point, which cannot exist for a commitment lock
  without revealing which candidate is the real one; these two call the same
  underlying verify, decrypt and recover routines.)

## Rules for callers

These are not suggestions. Breaking any of them can leak the key or lose it.

1. **Authenticate the transport. Mandatory.** Every message must be verified
   to come from the other party before it is passed to a step function.
   Identities here are only bytes hashed into transcripts. The package cannot
   tell an injected message from the peer's own, and the consequence is not
   just a failed session: a forged round-4 signing frame that carries a
   well-formed ciphertext **permanently burns the initiator's share**, and with
   it access to the funds. `peerFault` is only meaningful over an
   authenticated transport.
2. **Stored shares and records are integrity-critical.** Both export formats
   carry a MAC keyed from the secret share, and import and restore verify it
   before using anything. That protects against someone who can modify storage
   but not read the secrets. Do not strip it, do not "repair" a record that
   fails, and store the secret export encrypted. (Without the MAC, replacing
   the responder's stored copy of the initiator's encrypted share let the
   initiator read the responder's share out of a single ordinary-looking
   signature.)
3. **A burned share stays burned.** On `keyShareBurned`, record it durably
   against the `keyId`, delete every stored copy, and never import or restore
   it again. Inside one process the package enforces this for every handle and
   stored copy of that share; across restarts only your record can.
4. **Session ids.** Signing session ids must never repeat for a key: after
   _any_ error with `sessionAborted`, retry with a new id. Key-generation
   session ids should also be new each time, but a repeat cannot make you
   reuse a share: each party mixes 32 fresh random bytes of its own into the
   session and into the derivation of a seeded share.
5. **One state object, one message.** `keygenStep` and `signStep` consume the
   state they are given and return a new one. A used state is refused
   (`state-already-used`).
6. **Persistence rules** (only if you use `exportSignSession`):
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
   - `importSignSession` recomputes the session binding, public key, tweak and
     lock from the key share and the stored inputs and refuses state whose
     parts do not agree. It cannot detect an old state.
   - If you cannot guarantee this, do not export sessions: after a crash,
     abandon in-flight sessions and start new ones. Signing costs about 0.1 s.
   - Key-generation sessions cannot be exported. After a crash, start again.
     No funds exist at the address before key generation finishes.
7. **Run sessions for one key one after another** to stay inside what the
   paper proves. Concurrent sessions are outside its proof and untested.
8. **After `peerFault` in key generation, do not simply retry with the same
   peer.** Each attempt gives a cheating initiator a 2^-80 chance at the range
   proof and costs you seconds of CPU.

### Roles

The initiator learns each result first and can refuse to send message 5.

- Plain signing: the initiator can keep a valid signature to itself and
  broadcast it. Make the initiator the party for whom that is harmless.
- Adaptor pre-signing: locks are created by the **responder**, who holds the
  secret. The **initiator** is the party that later extracts it. A withholding
  initiator then holds a pre-signature it cannot complete, and the responder
  can complete nothing it was not sent. The package enforces this direction:
  `createPointLock` and `createCommitmentLock` refuse an initiator share, and
  lock proofs are bound to the responder's identity.

## Key tweak

```
h  = SHA256(SHA256(tag) || SHA256(tag) || P || commitment) mod n
P' = P + h*G          tag = "FRANK-TECDSA-V1/tweak", P = 33-byte compressed key
```

`h` is public. The key behind `P'` is `x1 * x2 + h`. Shares here are
multiplicative, so the tweak cannot be folded into a share (that would need
`h / x2`, which nobody knows). With additive shares one party would simply add
`h` to its share; that does not apply here.

Instead **no share changes** and the responder adds `r*h` to the message term:

```
c3 = Enc(rho*n + k2^-1 * (m + r*h))  (+)  (k2^-1 * r * x2) (*) c_key
Dec(c3) = k2^-1 * (m + r*(x1*x2 + h))  mod n
```

Why this is sound: the messages are those of the unmodified protocol run on
the scalar `m' = m + r*h` instead of `m`. Neither party sees anything new, so
the paper's simulation applies with `m'`; and `(r, s)` satisfies the ECDSA
equation for `m` under `x + h` exactly when it does for `m'` under `x`. What
remains is the unforgeability of ECDSA when signatures under additively
related keys are available. This is the analysed case of Groth and Shoup
(EUROCRYPT 2022): the tweak hash commits to the base key, there are no
presignatures, and the digest is computed locally by each party. The
commitment and `P'` are hashed into the session binding before either nonce
share is drawn, and the initiator verifies the final signature against `P'`.
Two parties that disagree on the commitment compute different bindings and
reject each other's first message.

## Adaptor pre-signing

The output is byte-for-byte the 162-byte encrypted signature of
`@frank/adaptor-signatures` (`R || R_a || s_a || b || c`) for the joint (or
tweaked) key and the lock point `T`.

The structure is the ECDSA lock of Malavolta et al. (NDSS 2019) on Lindell 2017. With joint nonce `k = k1*k2`: `R_a = k*G`, `R = k*T`, `r = R.x`,
`s_a = k^-1 * (m + r*x)`. The Paillier step is the same as in plain signing
with this `r`. Each party sends its nonce share over both bases (`k_i*G`,
`k_i*T`) with a session-bound equality proof, so both know `R = k*T` is right.

**Where this differs from the published lock:** there, each party checks the
pre-signature using its own nonce share and nothing more is needed. The
dlcspecs encoding, which this package must emit so that the existing verifier
and extractor work unchanged, additionally carries one discrete-log-equality
proof `(b, c)` for the _joint_ nonce, which neither party knows. It is built
like this (I = initiator, R = responder; `a1`, `a2` fresh random scalars):

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

## Locks

An adaptor signature under a point `T` is only safe if someone provably knows
the discrete log of `T`. A bare, caller-chosen `T` is never accepted: `lock`
must be one of the following, and its proofs are verified in `startSign`
before any nonce is drawn.

**Point lock.** `T = t*G` with two proofs of knowledge of `t`:

- the 65-byte proof of `@frank/adaptor-signatures`. Limitation of that format:
  its challenge is `H(T, R)` only, so anyone who has seen a `(T, proof)` pair
  can present it as their own. That package's format is fixed by the DLC
  specification and is not changed here;
- an **owner proof**, added by this package: a Schnorr proof of knowledge of
  `t` bound to the key id (which covers both identities and all key-generation
  material) and to the responder's identity. A copied pair cannot be given an
  owner proof without knowing `t`. The whole lock is also hashed into each
  session binding together with the session id.

**Commitment lock.** `C = s*G + v*H`, a Pedersen commitment to a value `v`
with fresh secret `s`, plus a proof of knowledge of an opening `(s, v)` bound
to the key id and the responder. For each candidate value `i` the lock point is

```
T_i = C - i*H = s*G + (v - i)*H
```

`T_v = s*G`: the pre-signature for the committed value completes with `s`, and
completing it reveals `s` to the initiator. For `i != v`, completing needs the
discrete log of `s*G + (v - i)*H`; together with `(s, v)` that would give
`log_G(H)`, which nobody knows. `C`, `H`, the proof and `i` are bound into the
session.

- `H` is the curve point with even `y` whose `x` is
  `SHA256("FRANK-TECDSA-V1/pedersen-H" || counter)` for the first 4-byte
  big-endian counter (from 0) that gives a point:
  `0227760f010449dd266567f5a439f620e8211c89ba01dbcaf43a31f76c8de02e43`.
- The opening proof is Okamoto's two-generator proof (97 bytes), not a 1-of-N
  OR-proof. An OR-proof would also show that `v` is one of N allowed values,
  at N times the size. That is not needed for safety: a responder that commits
  to a value outside the range the game pre-signs for can complete none of the
  pre-signatures, which is the same as refusing to reveal. **The game must
  make "no reveal" lose.**
- **Every commitment (every card) needs its own fresh `s`.** Reusing `s`
  makes one reveal open the others. `createCommitmentLock` always draws a new
  one.
- The commitment hides `v` perfectly; it binds the responder to `v` only as
  long as `log_G(H)` is unknown.

## Deterministic shares

Allowed. With `secretSeed`, the share (and the initiator's Paillier primes) is
derived from the seed, the session id, both identities, this party's identity
and **32 fresh random bytes this party draws itself** in each key generation.
The peer therefore cannot make you derive the same share or Paillier key twice
by repeating a session id (which would otherwise hand a cheating peer one
abort bit about your share per repetition).

What must be stored: the **public record** (`exportKeyShareRecord`, about
1.0 KB). It holds the derivation context (including your salt), the initiator's
Paillier modulus and encrypted share, and a MAC. It contains no secret, but
see rule 2: its integrity matters. `restoreKeyShare(seed, record)` re-derives
the share, verifies the MAC under a key derived from that share before using
any other field, then rebuilds everything (1 to 2 s for the initiator).

## Tests and vectors

`yarn test` runs six suites:

- `primitives`: bytes, RNG handling, integer arithmetic, point and scalar
  parsing, commitments, both sigma proofs, Paillier (including the owner's CRT
  encryption against the plain one), the modulus proof (including a modulus
  with a small factor and one with `p | q - 1`), the range proof (including a
  cheating prover that passes only when it guesses the whole challenge).
- `keygen`: an honest run, key confirmation, share export/import/restore, the
  stored-record replacement attack, salt freshness, and a malicious
  counterpart for every message.
- `sign`: honest runs cross-checked with `@noble/curves` and `ethers` (a real
  EIP-1559 transaction recovers to the joint and the tweaked address); a
  malicious counterpart for every message; the abort rule across handles and
  stored copies; nonce freshness; crash recovery and inconsistent state.
- `adaptor-sign`: point locks (verify, complete and extract with
  `@frank/adaptor-signatures`; owner-proof binding; replayed lock refused),
  commitment locks (only the committed value completes; extraction; malformed
  opening proofs refused before a session exists), and a malicious counterpart
  for every message.
- `vectors`: regenerates `test-vectors/threshold_ecdsa.json` byte for byte.
- `timing`: prints the numbers in the cost table.

`test-vectors/threshold_ecdsa.json` holds one full key generation and four
signing transcripts (plain, plain tweaked, point lock, commitment lock on a
tweaked key) produced from a documented seeded byte stream, with every
message, both exported shares and all results. The point lock is an input of
its vector because `@frank/adaptor-signatures` generates its proof with
ambient randomness.

## Security status

No external audit. One independent review found and this version fixes a
key-extraction path through unauthenticated stored records; it found no break
of the core protocol, the joint equality proof or the tweak, and that is not
the same as an audit. Section and protocol numbers cited in the source were
written from memory of the papers and must be confirmed against the PDFs.

**"Testnet only" means:** use it only with keys that hold assets of no value.
Do not point it at a mainnet address, do not reuse seeds or shares from it on
mainnet later, and assume that anyone who can time or inspect the process can
recover a share.

**Required before real funds:**

1. A constant-time big-integer backend (for example a WebAssembly build of an
   audited library) for Paillier and scalar arithmetic.
2. Replacing this package's own constructions with published, proven ones
   where they exist, or having the remaining ones (tweak in the Paillier step,
   joint equality proof, commitment locks as adaptor points) analysed and
   written up.
3. Soundness of at least 80 bits everywhere (done for the range proof) and a
   decision on burn-on-failure versus a proof of correct ciphertext.
4. Test vectors confirmed by a second, independent implementation.
5. An external cryptographic and implementation audit, including concurrent
   sessions, state persistence and the caller rules above.

### Review first

1. The joint discrete-log-equality proof (`sign.ts`, rounds 3 and 4).
2. Commitment locks: the opening proof, its binding, and the claim that only
   `T_v` is completable (`lock.ts`).
3. The tweak inside the Paillier step.
4. Range proof: hashed commitments, 80 rounds, pre-committed challenge, and
   the ordering that opens the L_PDL challenge only after it verified
   (`paillier-proofs.ts`, `keygen.ts`).
5. The modulus proof does not show that N has exactly two prime factors. We
   argue the protocol only needs encryption to be a bijection and the
   plaintext not to wrap; both are enforced.
6. The storage MAC is keyed from the secret share; salts and key confirmation
   in key generation.
7. The process-wide burned-share set is the package's only module-level state
   and does not survive a restart.
8. Concurrent sessions; timing of `modPow` and `modInverse` on secrets.
