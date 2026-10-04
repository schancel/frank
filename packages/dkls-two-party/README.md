# `@frank/dkls-two-party`

Two-party ECDSA over secp256k1 from oblivious transfer (the DKLs family), with
two-party adaptor pre-signatures. Two parties jointly own one ordinary key (one
EVM address) and can only sign together. Either party can take either role in
any signing session.

**Experimental. Not audited. Testnet only.** See
[Security status](#security-status).

This file is the design document (Stage A) followed by the implementation
notes. Sections marked **own construction** are ours and have no published
proof.

## 1. Protocol choice

| Candidate                                    | Verdict                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DKLs18 (ePrint 2018/499)                     | Rejected. The authors' 2023 preface calls it deprecated, withdraws its KOS transcription, calls its coalesced multiplication unproven, and points to DKLs23.                                                                                         |
| DKLs19 (ePrint 2019/523)                     | Rejected. Multiparty; subsumed by DKLs23.                                                                                                                                                                                                            |
| DKLs23 (ePrint 2023/765) with two parties    | Not used as written. Asharov shows its multiplication parameters (`log q + 2s` OTs) do not give the claimed security and that the check can be bypassed in the endemic-OT hybrid model unless the OT transcript is hashed.                           |
| **Asharov, ePrint 2026/976, Protocol 6.2**   | **Chosen.** A two-party specialisation of DKLs23 with corrected parameters, a full proof (Appendices B, C), no zero-sharing, no per-pair corrections, and a symmetric message flow. We use its VOLE "Variant II" (Protocol 4.2, Theorem B.16).        |
| Lindell 2017 (our `@frank/threshold-ecdsa`)  | The other backend. Fixed roles and seconds-long key generation, which is what this package exists to avoid.                                                                                                                                          |

### Sources actually read

All fetched as PDF through the Wayback Machine (ePrint itself returns 403 to
scripts): `https://web.archive.org/web/2id_/https://eprint.iacr.org/<year>/<n>.pdf`.

| Paper                                                                 | Parts used                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Asharov, "Revisiting DKLs Threshold ECDSA", ePrint 2026/976 (May 2026) | §2 overview; Functionality 4.1; Protocol 4.2 (VOLE Variant II); §4.5 (attack, countermeasures); §5.2, Claim 5.5 (parameters); Protocol 6.2 (signing); Table 1 |
| Doerner, Kondi, Lee, shelat, "Threshold ECDSA in Three Rounds", ePrint 2023/765 | Protocol 5.2 (the multiplication Asharov revises); §5.1 (one-message SoftSpokenOT by Fiat-Shamir, statistical parameter becomes computational) |
| Doerner, Kondi, Lee, shelat, ePrint 2018/499, revision of July 2023   | Preface §1.1 errata 2, 3, 4 (KOS withdrawn; an abort must stop all concurrent sessions of the pair and end the pairing); Appendix A, Protocol 7 (Verified Simplest OT); Functionality 3.2/3.3 (key generation with committed proofs) |
| Roy, "SoftSpokenOT", ePrint 2022/192 (revision of Nov 2025)           | §3.2, Fig. 8 (subspace VOLE); §4, Fig. 9, Theorem 4.5 (consistency check and its proof); §4.1 (why KOS/OOS/PSS proofs fail); §5, Fig. 11 (hashing to OTs, tweaks) |
| Masny, Rindal, "Endemic OT", ePrint 2019/706                           | Fig. 8, Theorem 4.1 (read; not used, see below)                                                                                |
| Chou, Orlandi, "The Simplest Protocol for OT", ePrint 2015/267        | Read for the base of VSOT                                                                                                      |
| Malavolta et al., "Anonymous Multi-Hop Locks", ePrint 2018/472 (NDSS 2019) | §IV-D, Fig. 5 (two-party ECDSA lock)                                                                                      |
| Aumayr et al., ePrint 2020/476                                        | The adaptor-signature security notion that `@frank/adaptor-signatures` cites                                                   |

**Not obtained:** Keller, Orsini, Scholl, "Actively Secure OT Extension with
Optimal Overhead" (ePrint 2015/546). The archive had no copy. KOS is not used:
both DKLs18's preface and Roy §4.1.3 advise against it.

Nothing was copied from, or structured after, any existing DKLs implementation.

## 2. Building blocks

Notation: `G` the generator, `q` the group order, `κ = 128`, `s = 60`
(statistical), `T(label, parts…)` the domain-separated transcript hash
`SHA256(SHA256(tag) ‖ SHA256(tag) ‖ len‖part …)` with
`tag = "FRANK-DKLS2P-V1/" ‖ label`. I = session initiator, R = responder.

### 2.1 Base OT: Verified Simplest OT (DKLs18 Appendix A, Protocol 7)

128 random OTs in each direction, once per key. Sender key `B = b·G` with a
Schnorr proof of knowledge; receiver sends `A_j = a_j·G + ω_j·B`; pads
`ρ⁰_j = H(b·A_j)`, `ρ¹_j = H(b·(A_j − B))`, receiver `ρ^ω_j = H(a_j·B)`; then
the verification of steps 5-8: challenge `ξ_j = H(H(ρ⁰_j)) ⊕ H(H(ρ¹_j))`,
response `H(H(ρ^ω_j)) ⊕ ω_j·ξ_j`, sender checks it and opens `H(ρ⁰_j), H(ρ¹_j)`,
receiver checks its own and the challenge. One sender key serves all 128
transfers because every hash carries the instance context and the index `j`
(the paper's remark after Protocol 7). The OT outputs are
`seed^b_j = T("vsot/seed", ctx, j, ρ^b_j)`, separate from everything revealed.

Why VSOT and not the others:

- Plain "Simplest OT" is not simulatable when composed (the receiver need not
  query the oracle before the sender needs its input extracted): DKLs18
  Appendix A and its references. VSOT's verification round is the fix.
- Endemic OT (Masny-Rindal Fig. 8) needs a random oracle onto the group
  (hash-to-curve) and its Theorem 4.1 gives stand-alone security against a
  malicious receiver. It would save rounds we do not need to save.
- VSOT realises OT **with selective failure by the sender** (it can test a
  guess of `ω_j` and is caught when wrong). In key generation that aborts the
  key generation, and the guessed correlation is thrown away with it.

Pitfalls handled: `A_j` and `B` are parsed as valid non-identity points;
`A_j = B` (which would make `b·(A_j − B)` the identity) is rejected; the
proof of knowledge of `b` is verified before any `A_j` is sent; hashes are
bound to both salts, both identities, the direction and `j`.

### 2.2 OT extension: SoftSpokenOT with k = 1 (Roy Fig. 8 + Fig. 9 + Fig. 11)

With `p = q = 2` and the repetition code of length 128 this is the IKNP shape
with Roy's consistency check. Per signing session and direction, for
`ℓ' = ℓ + m_c = 696 + 136 = 832` OTs:

- Extension receiver (holds seed pairs): `t^b_i = PRG(seed^b_i, nonce)`
  (832 bits) for `i < 128`; choice bits `x = t⁰_0 ⊕ t¹_0`; sends the syndrome
  `c_i = t⁰_i ⊕ t¹_i ⊕ x` for `i = 1…127` (Fig. 8 with `C = Rep`).
- Extension sender (holds `Δ` and `seed^{Δ_i}_i`):
  `q_i = PRG(seed^{Δ_i}_i, nonce) ⊕ Δ_i·c_i` (`c_0 = 0`), so row `j` is
  `W_j = V_j ⊕ x_j·Δ` where `V_j` is the receiver's row of the `t⁰_i`.
- Check (Fig. 9, the OOS shape Roy proves in Theorem 4.5):
  `R = [X | 1_{136}]` with `X ∈ F_2^{136×696}` expanded from
  `T("otx/check", nonce context, T(c_1…c_127))` (Fiat-Shamir as in DKLs23
  §5.1; `ε = 2^-136`). Receiver sends `ũ = R·x` (136 bits) and a hash of
  `Ṽ = R·V` (Roy's "second optimisation"). Sender recomputes
  `R·W ⊕ ũ⊗Δ` and compares the hash. The last 136 OTs are discarded.
- Pads (Fig. 11 with a unique tweak per OT, so `t_max = 1` and no second
  universal hash is needed): `T⁰_{j,c} = H(W_j)`, `T¹_{j,c} = H(W_j ⊕ Δ)`,
  receiver `S_{j,c} = H(V_j)`, where `H` hashes the full session binding
  (both salts), the direction, `j` and the column `c ∈ {0,1,2}`, reduced
  mod `q` (bias `< 2^-127` per value).

Reuse policy (isolated in `ot-extension.ts`, `extensionNonce`): the base OTs
of a key serve every signing session of that key. Each session and direction
stretches the seeds under a fresh nonce that hashes the session binding and the
extension receiver's own fresh salt; the pads additionally hash the other
party's salt, so neither party can make the other derive the same pads twice
(see 5.3). Roy's theorem is stated for one batch; treating disjoint PRG
outputs under one `Δ` as blocks of one long VOLE, each with its own check, is
standard practice (DKLs23 §5: "a fast one-time setup") but is **our reading,
not a cited theorem**.

### 2.3 Multiplication: random VOLE, Asharov Protocol 4.2 (Variant II)

Vector length 2 (nonce share and key share) plus one mask column. Sender has
`T⁰, T¹ ∈ Z_q^{696×3}`, receiver has `w = x[0..696)` and `S`.

Sender: fresh `α = (α_1, α_2, α̂)`; `Q_j = T⁰_j − T¹_j + α`;
`(χ_1, χ_2) = RO(ctx, T(extension message), T(Q))`, `χ = (χ_1, χ_2, 1)`;
`u_j = ⟨T⁰_j, χ⟩`; `v = ⟨α, χ⟩`; `H_u = T(u)`; message `(Q, H_u, v)`;
`g = RO(ctx, T(extension message), T(message))`; output
`t_c = −Σ_j g_j·T⁰_{j,c}`.

Receiver: `R_j = S_j + w_j·Q_j`; `u'_j = ⟨R_j, χ⟩ − w_j·v`; abort unless
`H_u = T(u')`; `β = ⟨g, w⟩`; `r_c = Σ_j g_j·R_{j,c}`. Then
`t_c + r_c = α_c·β`.

Parameters: `m ≥ log q + 2κ + 3s = 256 + 256 + 180 = 692`, rounded to 696
(Claim 5.5); one mask column suffices because `log q ≥ κ + 2 log m`
(Claim B.8). Both countermeasures of §4.5 are applied: the OT outputs are
random-oracle outputs the sender cannot choose (sender-random OT), and the
challenge and the gadget vector hash the concrete OT-extension transcript.

### 2.4 Commitments and proofs

Hash commitments `T("commit/…", binding, committer, payload, 32-byte nonce)`.
Schnorr proofs of knowledge and Chaum-Pedersen equality proofs, Fiat-Shamir,
bound to the session binding and the prover's identity. Rewinding extraction
only (as in `@frank/threshold-ecdsa`); a UC treatment would need Fischlin's
transform (DKLs18 §3.1).

### 2.5 Security model and assumptions

One static malicious party, security with abort, no fairness. Random-oracle
model for SHA-256 (programmable in the commitment and Fiat-Shamir steps).
Computational Diffie-Hellman in secp256k1 (VSOT), ECDSA unforgeability. The
caller's `randomBytes` is a CSPRNG. **The transport is authenticated.** No
side-channel resistance (JavaScript `bigint`).

## 3. What is set up when

| Lifetime      | What                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Per peer      | Nothing.                                                                                       |
| Per key       | Additive key shares `x_I + x_R`; 128 base OTs in each direction (the pairwise setup).           |
| Per signature | Two salts, two nonce shares, one OT-extension batch and one VOLE in each direction.            |

A fresh key per hand therefore gets a fresh pairwise setup, and "never reuse
that setup with that peer" is the same event as "this key is burned". Sharing
one setup between several keys of a pair is possible in principle (the
correlations do not depend on the key) and is deliberately not offered: two
stored keys would share secret state whose burn must be atomic across both.

## 4. Message flow

Framing: `"FDK1" ‖ protocol (1) ‖ round (1) ‖ frame binding (32) ‖ body`. The
frame binding hashes the session id, both identities in role order and, for
signing, the key id, public key, digest and encoded lock. Everything after
the first message additionally uses the **full binding**, which adds 32 fresh
bytes from each party.

The papers' protocols are in simultaneous rounds. We send messages
alternately; a party sends its round `n+1` message together with its round `n`
message only when it already holds every round-`n` message of the peer. This
packing is isolated in `keygen.ts` / `sign.ts` (`ROUNDS` tables).

### 4.1 Key generation (6 messages)

| #   | From | Contents                                                                                                   |
| --- | ---- | ---------------------------------------------------------------------------------------------------------- |
| 1   | I    | salt_I; commitment to `X_I = x_I·G`; VSOT sender key `B_I` with proof of knowledge                          |
| 2   | R    | salt_R; `X_R` with proof; VSOT sender key `B_R` with proof; 128 encoded choices `A_j` for I's instance      |
| 3   | I    | opening of `X_I` with proof; 128 encoded choices for R's instance; 128 challenges `ξ_j` for I's instance    |
| 4   | R    | 128 responses for I's instance; 128 challenges for R's instance                                            |
| 5   | I    | 128 pad openings for I's instance; 128 responses for R's instance                                          |
| 6   | R    | 128 pad openings for R's instance                                                                          |

R holds the key after processing message 5, I after message 6.
`keyId = T("key-id", full binding, X_I, X_R, B_I, B_R, T(A of I's instance), T(A of R's instance))`.

### 4.2 Signing and pre-signing (5 messages)

"X" is the VOLE in which I is the receiver, "Y" the one in which R is.
Braces mark the additions for pre-signing under lock point `L`.

| #   | From | Contents                                                                                                                                         |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | I    | salt_I; commitment to `R_I = k_I·G` {and `k_I·L`, `A_I = a_I·G`, `a_I·L`}; OT-extension message for X                                            |
| 2   | R    | salt_R; commitment to `R_R` {…}; OT-extension message for Y; VOLE message `(Q, H_u, v)` for X                                                    |
| 3   | I    | VOLE message for Y; opening of I's commitment {with equality proof}; `γ` corrections and `Γ` check points of Protocol 6.2 signing round 1        |
| 4   | R    | opening of R's commitment {with equality proof}; R's `γ`, `Γ`; R's `(u_R, w_R)` {and `z_R`}                                                      |
| 5   | I    | `(u_I, w_I)` {and `z_I`}                                                                                                                         |

I holds the result after processing message 4, R after message 5.

Protocol 6.2 for party `i` with nonce share `k_i`, key share `x_i`, VOLE
sender outputs `(α_k, α_x; t_k, t_x)` and receiver outputs `(β_i; r_k, r_x)`:

```
γ_k = k_i − α_k        γ_x = x_i − α_x        Γ_k = t_k·G        Γ_x = t_x·G
on the peer's (γ', Γ', R'):   c_k = γ'_k·β_i + r_k      c_x = γ'_x·β_i + r_x
  require  c_k·G = β_i·R' − Γ'_k   and   c_x·G = β_i·X' − Γ'_x
R = R_I + R_R,  r = R.x mod q
u_i = k_i·β_i + t_k + c_k      v_i = x_i·β_i + t_x + c_x      w_i = m·β_i + r·v_i
s = (w_I + w_R) / (u_I + u_R);  low-s normalise;  verify under X = X_I + X_R
```

The digest is fixed in the frame binding before any nonce exists, so no
message-independent presignature is ever exposed (Groth-Shoup concern).

## 5. Adaptor pre-signing (**own construction**)

### 5.1 Construction

Output: the 162-byte `R ‖ R_a ‖ s_a ‖ b ‖ c` of `@frank/adaptor-signatures`
for the joint key and lock point `L`. Additions to 4.2, all in `adaptor.ts`:

1. Each party's first commitment covers `(R_i, K_i = k_i·L, A_i = a_i·G, A'_i = a_i·L)`
   with a fresh `a_i`.
2. With its opening each party sends a Chaum-Pedersen proof that
   `log_G R_i = log_L K_i`, bound to the full binding and its identity. The
   peer verifies it **before** computing `r`.
3. `R_a = R_I + R_R`, `R = K_I + K_R`, and **`r = R.x mod q`** replaces the
   `r` of plain signing. Nothing else in 4.2 changes; `s_a = w/u` is not
   normalised.
4. Joint equality proof for the encoding: `b = H_DLEQ(R_a, L, R, A_I + A_R, A'_I + A'_R)`
   (the challenge of `@frank/adaptor-signatures`), `z_i = a_i + b·k_i`,
   `c = z_I + z_R`. `z_i` travels with `(u_i, w_i)`.
5. Each party verifies the whole pre-signature with the verifier of
   `@frank/adaptor-signatures` before outputting, and I does so before
   sending message 5.

Completion multiplies `s_a` by the inverse of the lock secret and extraction
divides, exactly as in the DLC specification; both are done by
`@frank/adaptor-signatures` (point locks) or the commitment-lock functions.

### 5.2 Argument (not a proof)

- The ideal output is what a single signer holding `x` and nonce `k` produces:
  `(R_a = k·G, R = k·L, s_a = k⁻¹(m + R.x·x), proof)`. Given it and the
  corrupt party's committed values (extractable from the hash commitment), a
  simulator sets the honest `R_h = R_a − R_adv`, `K_h = R − K_adv`, simulates
  the honest equality proof and the honest `(A_h, A'_h, z_h)` by programming
  the oracle, and then runs the simulator of Asharov Appendix C with
  `r := R.x`. That simulator only uses the linear relation `s·u = w`,
  `w = (m + r·x)·β`, in which `r` is a public scalar; it does not use where
  `r` came from. The equality proof in step 2 is what makes `r` the same
  function of `k` as in the ideal output before any honest `w_i` is released.
- `z_i = a_i + b·k_i` is a Schnorr response under a one-time nonce that was
  committed before `b` was determined; it reveals nothing about `k_i` beyond
  `R_i` and `K_i`.
- So each party's view is simulatable from the pre-signature alone. For the
  lock holder a pre-signature is as good as a signature (it knows the secret).
  For the other party it is an adaptor pre-signature in the sense of Aumayr
  et al., which gives no signature until the secret is revealed and reveals
  the secret once the signature is published.

### 5.3 Difference from Malavolta et al. (NDSS 2019, §IV-D)

Their lock sits on Lindell 2017: multiplicative nonce `k_1·k_2`, Paillier,
fixed roles, and each party checks the result with its own nonce share. Ours
has additive nonce shares over OT-based multiplication, either party in either
role, emits the DLC-specification encoding and therefore carries a joint
equality proof for a nonce neither party knows.

### 5.4 Locks

A lock is one of the two proven kinds of `@frank/threshold-ecdsa`'s `lock.ts`,
byte-compatible with it: a point lock (`L = t·G`, the 65-byte proof of
`@frank/adaptor-signatures`, an owner proof bound to key id and holder) or a
commitment lock (`C = s·G + v·H`, Okamoto opening proof, lock point
`C − i·H`). A bare caller-chosen point cannot be passed.

**Lock provenance.** The holder of a lock is always the session **responder**
(I learns the pre-signature first and is the extractor). A public proof that
names the holder can be built by anyone, including the other party with a
secret of its own. Therefore the responder must pass the lock's secret
opening when it starts a pre-signing session and the code checks
`t·G = L` / `s·G + v·H = C`; a responder never pre-signs under a lock it
cannot open. The initiator verifies the public proofs.

## 6. Every check and what its failure means

"Burn" = the key (share and pairwise setup) is wiped, its id enters the
process-wide burned set that every step of every session consults, and the
error carries `keyUnusable` and `peerFault`. The caller must record it durably.

| Where          | Check                                                                    | Failure means                                                          | Action              |
| -------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------- |
| any            | frame: magic, protocol, binding, round, size                             | stray, replayed or foreign message                                     | refuse; session lives |
| keygen 2, 3    | Schnorr proofs for `X` and `B`; opening of the commitment to `X_I`       | peer does not know its share or OT key, or changed its mind            | abort keygen        |
| keygen 2, 3    | `A_j` valid, not the identity, `≠ B`                                     | malformed choice                                                       | abort keygen        |
| keygen 4, 5    | VSOT response `= H(H(ρ⁰_j))`                                             | receiver does not hold the pad it claims                               | abort keygen        |
| keygen 5, 6    | VSOT opening matches own pad and the challenge                           | sender tested a guess of our choice bit (selective failure)            | abort keygen        |
| sign 1, 2      | OT-extension consistency check                                           | peer lied in the extension; it may have learned bits of our `Δ`        | **burn** (required) |
| sign 2, 3      | VOLE check `H_u`                                                         | peer used inconsistent rows; it may have learned ≤ s bits of this session's `w` | **burn** (DKLs18 erratum 4) |
| sign 3, 4      | commitment opening; {equality proof}; points valid                       | peer changed its nonce or lied about `K_i`                             | burn (uniform rule) |
| sign 3, 4      | `Γ` equations                                                            | peer's VOLE inputs differ from its `R_i` / `X_i`                       | burn (uniform rule) |
| sign 4, 5      | `r ≠ 0`, `u ≠ 0`, `s ≠ 0`, final (pre-)signature verifies                | peer sent wrong `u`, `w` or `z`                                        | burn (uniform rule) |
| pre-sign start | lock proofs; responder: opening matches                                  | not a proven lock, or not ours                                         | refuse to start     |

Selective abort, stated leakage. In the OT extension a cheating receiver
passes the check only if a guess about bits of `Δ` is right; guessing `k`
bits succeeds with probability `2^-k` and a wrong guess burns the key
(Roy Theorem 4.5, leakage class `Affine(F_2^128)`). In the VOLE a cheating
sender passes only if it guessed bits of that session's `w`; Asharov's proof
allows up to `s` such constraints, each halving its success probability. A
wrong guess also tells the attacker the bits, which is harmless only because
nothing derived from that setup is ever sent again: hence the burn, the
process-wide set, and the check at every step.

Burning on the last three rows is not required by the proofs; it is a uniform
rule so that no failure path needs its own analysis.

## 7. Estimates (before implementation)

Measured primitive costs on the development machine under heavy load (load
average 20 on 10 cores): fixed-base multiplication 0.3 ms, variable-base
3.3 ms (constant-shape) or 1.5 ms (`multiplyUnsafe`), SHA-256 4 µs.

| Operation      | Dominant work per party                              | Estimate          | Messages (bytes)                         |
| -------------- | ---------------------------------------------------- | ----------------- | ---------------------------------------- |
| Key generation | ~130 variable-base and ~260 fixed-base multiplications | 0.3 - 0.6 s       | 6, largest about 8.5 KB                  |
| Signing        | ~8,000 hashes, ~4,000 modular multiplications, ~10 curve multiplications | 60 - 120 ms | 13 KB / 80 KB / 67 KB / 0.3 KB / 0.1 KB  |
| Pre-signing    | signing plus ~10 curve multiplications               | 90 - 160 ms       | about the same                           |

Bandwidth is about 161 KB per signature or pre-signature. A commitment lock
with 52 candidate values is 52 pre-signatures, about 8.4 MB.
