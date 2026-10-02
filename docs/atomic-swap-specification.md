# Atomic swap protocol specification and rationale

## Status

This document defines the design target for atomic swaps negotiated through a Frank plugin. It is
a protocol specification and research plan, not a claim that atomic swaps are currently shipped.
The first implementation target is a single-lane swap between eCash testnet and Monad testnet.

The implementation must remain testnet-only until the security gates in this document are met.
The existing `@frank/adaptor-signatures` package is experimental, has not received an external
cryptographic or side-channel audit, and must not protect assets of real value.

## Goals

The plugin should demonstrate that Frank can provide the private, authenticated transport and
durable state machine for a swap while the participating chains enforce settlement. The design
should eventually cover every unordered pairing, including same-family pairings, among three chain
families:

1. EVM account chains, initially Monad and later Ethereum-compatible networks;
2. eCash/BCH-family UTXO chains; and
3. Solana's Ed25519 account model.

The protocol should support one swap lane first and later support several UTXOs, accounts, or
participants without allowing a party to settle only the economically favorable subset.

The protocol should not require Frank relays to custody funds, possess swap secrets, decide chain
truth, or remain available after the parties have exchanged all settlement artifacts.

## Non-goals

- Mainnet deployment or protection of valuable funds.
- A decentralized exchange, order book, price oracle, or routing market.
- A claim that settlement occurs simultaneously on different chains. Cross-chain atomicity means
  that protocol outcomes are coupled and every compliant party has a unilateral recovery path.
- General token support in the first implementation. The initial pair is native XEC and native
  MON; ERC-20, CashTokens, and Solana tokens add asset-specific authorization and custody rules.
- Treating all secp256k1 or all UTXO chains as byte-for-byte compatible. Transaction serialization,
  sighashes, signature encodings, locktimes, relay policy, and finality remain chain-specific.
- Using BLS signatures for native settlement. None of the initial chain families accepts BLS as
  its ordinary account or transaction signature.

## Terminology

**Party A** and **Party B** are pair-local protocol roles assigned in `Offer` and `Accept` and
committed in the transcript before artifacts are derived. `sideA` and `sideB` each identify a chain,
network, and asset instance; A offers `sideA` and receives `sideB`, while B does the inverse. A pair
policy may require a deterministic initiator/responder or identity ordering, but both peers must
derive the same assignment. In the initial eCash/Monad policy, A offers XEC and B offers MON.
Asset-leg names should be used where a generic A/B label would be ambiguous.

A **lane** is the smallest independently scoped exchange of two specified amounts. It has its own
chain objects, deadlines or explicit absence of a refund deadline, settlement evidence, and normally
its own adaptor secret.

A **bundle** is a set of lanes intentionally coupled under one settlement capability. A bundle is
not all-or-nothing merely because its metadata says so; every leg must already be funded and every
beneficiary must hold the artifacts needed to complete it after the capability is revealed.

An **adaptor secret** is a scalar `t`; its public commitment on curve `G` is `T = tG`. Completing an
adaptor signature with `t` creates an ordinary signature. Comparing the completed signature with
the corresponding encrypted signature allows the counterparty to recover `t`.

A **settlement domain** is every transfer unlocked by one secret or signing capability. Economic
fairness is evaluated per settlement domain, not merely over the advertised order total.

**Prepared** means that transaction bytes and signatures have been validated but funds have not
necessarily been committed. **Funded** means that the chain object controlling the offered asset
exists at the required confirmation or finality level. **Completable** means that the beneficiary
already possesses everything except the secret that the other chain outcome will reveal.

The initial griefable protocol has one named exception: B funds the EVM leg against only a committed
eCash parent txid/output description while A withholds the raw signed parent. That eCash parent is
not `Prepared` from B's perspective until reveal. B explicitly accepts the risk that an invalid or
withheld parent strands B's MON without unilateral recovery; the commitment gives A no ability to
obtain that MON without B's secret.

## Security properties

An implementation claiming a **recoverable atomic swap** must establish all of the following
properties. A protocol may instead demonstrate atomic theft-safety without liveness, but the UI and
documentation must call it a **griefable cooperative exchange**, disclose permanent-lock risk, and
must not imply that either party can recover after the other disappears.

### Safety

If one party follows the protocol, the other party cannot obtain that party's offered asset while
preventing the honest party from obtaining the agreed counter-asset. A recoverable mode additionally
requires a unilateral refund. A griefable mode may lock principal forever after abort, but it must
never turn disappearance into unilateral profit. A signature promised after funding is not a refund
path. Required signatures, adaptor signatures, proofs, and transaction commitments must be received
and verified before a funding action can give the peer unilateral value. The named withheld-parent
mode may put B's own principal at unverifiable grief risk because A still cannot spend it without
`t`.

### Liveness

For a recoverable mode, assuming each chain satisfies the negotiated finality model, an online party
or its delegated watcher can eventually claim or refund without further cooperation. A griefable
mode explicitly does not satisfy this property. Liveness assumptions must name the universal items
below and every item applicable to a chain adapter or custody mechanism used by the pair. An absent
mechanism is recorded as reviewed `not applicable`, not given a fictional value:

- confirmation or finality thresholds;
- safe claim cutoffs before refund deadlines;
- fee-bumping strategy;
- EVM nonce and balance reservations, when an EVM leg is present;
- Solana blockhash or durable-nonce policy, when a Solana leg is present; and
- maximum tolerated RPC, relay, and watcher outages.

### Finality assumptions

Safety is conditional on a per-chain common-prefix or deterministic-finality assumption. The
manifest must state confirmation depths, rollback horizons, and an accepted failure probability.
`funded` and `complete` mean final only under that model. Watchers remain active through a specified
post-completion monitoring horizon; a rollback outside the accepted bound reopens observation or
enters `loss-or-protocol-violation`. No finite eCash/BCH confirmation depth is described as
mathematically irreversible.

### Transcript binding

The protocol first constructs a domain-separated **pre-artifact context hash** from canonical fields
that include at least:

- protocol name and version;
- swap and lane identifiers;
- both network identifiers and genesis or chain identifiers;
- asset identifiers and integer amounts in atomic units;
- participant identity and settlement public keys;
- exact outpoints, account addresses, and nonces when known;
- transaction digests and sighash types;
- adaptor points, but not the proofs that will challenge-bind this hash;
- deadlines and finality policy; and
- a hash of the negotiated quote and bundle manifest.

The currently cited adaptor package does not accept associated protocol context in its Fiat–Shamir
challenges. Its native proofs remain verified under their frozen formats. Once every immutable
funding, claim, refund, public-point, proof, adaptor, and native-digest artifact exists, the protocol
constructs a domain-separated **pre-funding authorization root** over the context hash and the exact
artifact bytes. Both Frank identity keys sign the same root, exchange and verify both attestations,
and durably record them before either party releases funding authorization. A change to any context,
artifact, or digest invalidates these attestations.

The root binds exact bytes only for immutable preparation artifacts. Where the pair-specific policy
intentionally permits a later witness to vary, the root instead binds the canonical witness predicate,
authorized keys and sighash constraints. An observed witness is appended as settlement evidence and
must satisfy that predicate; it need not byte-match an illustrative preparation witness. Variable
witnesses never overwrite or reinterpret the originally attested preparation transcript.

Later chain evidence is appended to an audit transcript and does not require renewed peer
cooperation. Native chain signatures continue to sign only the exact digest accepted by their chain;
they are transaction authorization, not a substitute for protocol attestation. Any future primitive
that adds associated context to NIZK challenges is a new version requiring encodings, vectors, and
independent review.

No JavaScript floating-point value may represent an amount, price, deadline, chain identifier, or
nonce. Wire integers must have a canonical bounded representation. Raw transactions, public keys,
signatures, and proofs are byte strings, not hex strings with ambiguous normalization.

### Replay and substitution resistance

Artifacts for one network, fork, asset, lane, transaction, or protocol version must not verify in
another context. A party must reject changes to recipients, amounts, inputs, account lists, nonces,
blockhashes, locktimes, sighash flags, output order, or any fee outside the exact canonical policy
approved by the transcript. Where a policy intentionally permits replacement fees, it commits the
range and every otherwise immutable field rather than one signed transaction encoding.

### Cryptographic validation

All public points must be canonical, on the intended curve, non-identity, and in the required
subgroup. Every counterparty-selected adaptor point must carry a proof of knowledge. Scalars must
be canonical and nonzero. Cross-curve protocols additionally need a reviewed proof that the same
bounded integer is represented in both groups; an ordinary same-group DLEQ proof is insufficient.

### Honest status reporting

The plugin must distinguish negotiation, preparation, funding, broadcast, confirmation, finality,
refund eligibility, completion, and failure. Seeing a transaction in a mempool is not settlement.
Broadcast success is not confirmation, and confirmation on one chain is not proof that another leg
remains spendable.

## Common Frank plugin protocol

Frank supplies encrypted coordination, not consensus. The plugin should persist an append-only
event journal so a restart can reconstruct the state without repeating a signing round or reusing
a nonce.

Every message has a canonical authenticated envelope containing protocol/version, swap and lane
IDs, message type, sender identity and role, unique event ID, predecessor state/transcript hash, and
canonical payload hash. A transition table must assign each message its authorized producer,
admissible predecessor state, validation guards, durable effects, and next state. Byte-identical
duplicates are no-ops. A conflicting message for the same step is recorded as equivocation and
enters the specified violation/recovery path. Premature messages follow one specified durable-buffer
or reject-and-retransmit policy; implementations do not choose independently. Stale and
post-terminal messages never revive a signing session.

The initial message flow is:

```text
Offer
  -> Accept
  -> KeyExchange
  -> TransactionCommitments
  -> EncryptedSignatures
  -> PrefundingAuthorizationAttestations
  -> ReadyToFund
  -> FundingEvidence
  -> ReadyToSettle
  -> SettlementEvidence
  -> SecretExtraction
  -> CounterSettlementEvidence
  -> Complete | Refunded | FailedBeforeFunding
     | CooperativeRecoveryRequired | PermanentlyLockedByDesign
     | ManualRecoveryRequired | LossOrProtocolViolation
```

Messages may arrive more than once or out of order. Each transition must therefore be idempotent
and validate its predecessor state. A party must never generate a fresh cryptographic nonce merely
because a previously sent message was replayed.

### Crash and external-effect ordering

Before exposing a nonce commitment, signature share, adaptor signature, or other signing
contribution, the plugin durably records the session and nonce-consumption state. Journal state and
an immutable relay or chain outbox entry commit atomically before external send or broadcast.
Restart retries the byte-identical artifact; it never regenerates or re-signs it.

A learned secret or mempool observation and the required counter-action are durably recorded before
the plugin acknowledges or advances state. Startup reconciles journal/outbox entries with relay and
chain observations. Crash tests surround every durable commit, send, broadcast, observation, and
acknowledgement boundary.

The following are outcome states. `complete`, `refunded`, and genuinely
`permanently-locked-by-design` outcomes remain monitored and may reopen on a rollback until the
negotiated horizon expires; only then are their resources eligible for terminal cleanup:

- `complete`: all expected settlement legs reached their required finality;
- `refunded`: the tracked principal returned through the specified recovery path;
- `failed-before-funding`: no principal was committed;
- `cooperative-recovery-required`: neither party has unilateral recovery, but retained capabilities
  can still recover value if both cooperate;
- `permanently-locked-by-design`: required recovery capability is proven irretrievable, not merely
  held by an absent or uncooperative peer;
- `manual-recovery-required`: funds remain recoverable but automated assumptions expired; and
- `loss-or-protocol-violation`: observed chain state contradicts the promised safety property.

The last state must not be softened into a generic failure message. A testnet demonstration needs
to make protocol failures visible.

Cancellation is terminal only before the local party durably releases `ReadyToFund` or any unilateral
funding authorization, whichever comes first. The absence of a mempool or RPC observation never
proves that the peer has not broadcast. After that conservative cutoff, “cancel” means enter or
remain in nonterminal recovery: watchers, signed artifacts, account nonces or durable nonces, fee
reserves, and keys remain available until `complete`, `refunded`, a completed cooperative salvage,
or an explicitly acknowledged manual-recovery or irreversible-abandonment handoff. Returning to
`failed-before-funding` later requires a specified bilateral revocation that makes every funding
artifact unusable, reconciles all outboxes, and observes that invalidation through the
finality/reorg model. A hostile peer cannot cancel the other party's recovery capability.

## Amounts, multiple lanes, and multiple users

The fundamental batching invariant is:

> Every independently exercisable settlement domain must be economically fair by itself.

Suppose lane `i` exchanges `X_i` atomic eCash units for `M_i` atomic Monad units at rational price
`p / q`. An independently settleable lane must satisfy the negotiated rounding policy for:

```text
M_i * q == X_i * p
```

or a stated bounded deviation. Network fees must be assigned explicitly and must not secretly make
one lane subsidize another. The manifest defines canonical gross and net debits/credits for success
and refund, the payer and asset for every fee, fee caps, and deterministic allocation of shared
funding, CPFP, rebroadcast, and refund costs. Fairness is evaluated at the agreed worst-case fee
bounds for every reachable terminal subset. Prefer denominations that make conversion exact. If
exact conversion is impossible, allocate remainders deterministically before signing.

### Independent lanes

Independent lanes use independent secrets and are individually fair. They are separate optional
partial-fill orders: any subset may settle, and the secret holder receives an ex-post exercise
option whose lockup and pricing must be accepted explicitly. Independent lanes MUST NOT be marketed
as one committed all-or-nothing order merely because every settled lane keeps its signed rate.

On account chains, independent lanes should use independent temporary accounts or supported nonce
lanes. Ordinary EVM transactions from one EOA have sequential nonces; a missing lower nonce blocks
higher ones. Transactions sharing an EVM nonce are alternatives, not parallel swaps.

### Coupled bundles

A coupled bundle uses one secret, or cryptographically linked secrets, to make all prepared legs
completable after any settlement reveals the capability. This can make uneven lanes fair only as a
whole. It does not force miners, validators, or participants to broadcast every leg. Before the
first **settlement revelation**—a publication or delivery that expands which actors can exercise or
derive a settlement capability:

1. every funding object must be final enough for the selected policy;
2. every counterparty must hold every required completion artifact;
3. account nonces, balances, and durable nonces must remain reserved; and
4. watchers must be able to submit all remaining legs with adequate fees.

Initial controlled possession by the party that generated a capability is not a settlement
revelation; it is governed by an exercise gate instead. The manifest computes the transitive
capability-knowledge and derivation closure for every possible reveal prefix. For every party and
every capability it initially holds or can derive at that prefix, all of that party's outgoing
obligations unlocked by those capabilities must be final and non-invalidatable before any incoming
leg becomes exercisable by that party. Counterparties withhold a funding object, parent transaction,
signature, account authorization, or another indispensable spend artifact until the relevant gate
holds. A cyclic dependency with no cryptographic or consensus gate is invalid and cannot enter
`ReadyToFund`. Generating a capability does not itself invalidate the bundle, but it must not create
an ungated exercise option.

At `ReadyToSettle`, deadline ordering must be acyclic. For every revelation leg `r` and remaining
leg `j`, the manifest must establish, in a common conservative time model:

```text
latestExposure(r) + outage + detection + broadcastAndFeeBump
  + inclusionAndFinality(j) + reorgMargin(j) < earliestRefund(j)
```

The revelation leg must also be safe against its own refund race:

```text
latestExposure(r) + relayAndFeeBump(r)
  + inclusionAndFinality(r) + reorgMargin(r) < earliestRefund(r)
```

The protocol rejects a bundle if this inequality fails for any pair. A committed multi-lane order
that promises no favorable-subset selection must use such a coupled settlement domain, align its
exercise windows, and give watchers authorization to complete every remaining leg after any reveal.

Reusing one adaptor point with multiple signers is not approved merely by this document. The
current DLC-derived ECDSA construction warns that non-DLC use needs careful analysis because an
adaptor signature exposes a Diffie-Hellman relation between signing and encryption keys. Its proof
of knowledge requirement must be retained, and multi-party reuse needs independent review.

### Multi-user batches

A multi-user match should clear at a common rational price or divide into independently fair lanes.
No participant may depend on another participant's excess value to make its own lane fair. A user
who goes offline at or beyond the conservative authorization cutoff must be replaceable by a
watcher holding already-authorized transactions; otherwise the group has only a cooperative batch,
not an atomic one.

## Chain capability model

| Family    | Native transaction authorization                 | Conditional custody       | Important constraint                                                     |
| --------- | ------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------ |
| EVM       | secp256k1 recoverable ECDSA                      | Contract or smart account | EOA nonce is sequential; native transactions have no `valid-after` field |
| eCash/BCH | secp256k1 ECDSA and chain-specific Schnorr forms | UTXO script and locktime  | Sighash, encoding, malleability, and policy differ by chain              |
| Solana    | Ed25519                                          | Program/PDA               | Message includes accounts and blockhash; ordinary blockhashes expire     |

Ed25519 is a Schnorr-family construction but is not interchangeable with BIP340 or the BCH/eCash
Schnorr variant. The common word "Schnorr" does not imply identical challenges, encodings, nonce
rules, or accepted transaction signatures.

BLS is excluded from native settlement. Its main advantage is non-interactive aggregation of
independently produced signatures, including signatures on different messages. Schnorr-family
schemes instead make multisignature and threshold production of one native signature efficient.
Solana authenticates ordinary transaction signers with Ed25519, not BLS. BLS verification in a
program would reintroduce program-controlled custody and would not create a native BLS account.

## Quantum-exposure model

One-use keys reduce exposure to a future cryptographically relevant quantum computer, but they do
not make the current chains or the Frank protocol post-quantum secure. The precise benefit depends
on whether a chain address is a hash commitment to a public key and whether that public key is
available anywhere else.

On an eCash/BCH-family P2PKH output, the chain records a 160-bit public-key hash. The public key is
normally revealed only when the output is spent. If the key is genuinely one-use and was not
published through a profile, derivation scheme, prior spend, or off-chain protocol, an attacker able
to solve elliptic-curve discrete logarithms gets only the mempool-to-confirmation interval in which
to derive the private key and race the intended spend. This is exposure reduction, not a complete
defense: the spend still reveals a vulnerable public key before finality, mempool races and
reorganizations remain relevant, and generic quantum preimage search against a 160-bit address has
only about 80 bits of idealized work.

A fresh EVM EOA has a similar but not identical property. Its address is the low 20 bytes of the
Keccak-256 hash of its uncompressed secp256k1 public key. The public key can be recovered from the
first outgoing transaction signature and remains exposed thereafter. A receive-once, spend-once
EOA therefore limits discrete-log exposure before its first spend, but address reuse removes that
benefit and the 160-bit address again bounds generic quantum preimage resistance at about 80 bits.

A normal Solana wallet does not have this hiding period. Its 32-byte address is its Ed25519 public
key, so funding the address makes the same already-public key economically valuable. One-time use
does not prevent a discrete-log-capable attacker from working on that key before the owner spends.
A Solana PDA has no private key and can be controlled by a program that verifies a post-quantum
authorization scheme, but that is program-controlled custody rather than an ordinary native signer.

Frank must also account for off-chain key publication. If a public profile exposes the secp256k1
parent or destination key from which one-time payment keys are publicly derived, hiding only the
derived key behind P2PKH does not necessarily provide a useful quantum race window: an attacker may
attack the published parent key in advance and derive the same children. Replacing message
encryption alone with a post-quantum KEM is insufficient if authentication or payment derivation
still publishes a long-lived discrete-log key. A credible migration needs separate, domain-bound
post-quantum encryption and authentication keys plus a reviewed way to derive or communicate
one-time payment destinations without revealing a reusable vulnerable parent.

The UI and documentation should therefore use terms such as "one-use key" and "reduced public-key
exposure," not "post-quantum secure," until every long-lived identity, authentication, derivation,
settlement, and recovery key in the path has a specified post-quantum replacement.

## Pair matrix

| Pair                    | Curve relationship                       | Contractless direction                         | Status          |
| ----------------------- | ---------------------------------------- | ---------------------------------------------- | --------------- |
| eCash/BCH <-> EVM       | Same curve, usually ECDSA-compatible     | Joint EOA is griefable; escrow is recoverable  | Initial target  |
| EVM <-> EVM             | Same curve and ECDSA                     | Joint EOAs are griefable without timed custody | Future research |
| eCash/BCH <-> eCash/BCH | Same curve; signature dialect may differ | Scripted UTXOs or adaptor signatures           | Future          |
| eCash/BCH <-> Solana    | secp256k1 <-> Edwards25519               | Cross-curve proof plus Ed25519 joint control   | Future research |
| EVM <-> Solana          | secp256k1 <-> Edwards25519               | Cross-curve proof plus threshold signing       | Future research |
| Solana <-> Solana       | Same curve and Ed25519                   | FROST-Ed25519 temporary accounts               | Future research |

Each unordered pair is specified below. Reversing who offers which asset changes sequencing and
deadlines but does not add another matrix cell.

## eCash/BCH <-> EVM: initial implementation target

### Rationale

This pair reuses secp256k1 on both sides while exercising different transaction models and digest
rules. It is therefore the smallest useful demonstration of Frank's cross-chain negotiation model.
The eCash/BCH side can provide a timeout or recovery path in UTXO script. The EVM side can accept a
normal recoverable ECDSA signature without deploying swap-specific bytecode.

Sharing a curve does not by itself make a safe swap. A normal EVM EOA owner can consume a reserved
nonce or move its balance after presenting a pre-signed transaction. EVM transactions also have no
native future-validity field equivalent to `nLockTime`. The implementation must solve custody and
refund authorization, not merely convert `(r, s)` into Ethereum's `(yParity, r, s)` encoding.

### Initial scope

- eCash testnet and Monad testnet only;
- native XEC against native MON;
- two participants;
- one lane;
- fixed amounts agreed before transaction construction;
- explicit chain-specific confirmation policies;
- no automatic market price discovery;
- no shared adaptor secret across multiple signatures; and
- no claim of production safety.

### Required cryptographic and transaction components

1. A chain-neutral transcript and state machine owned by the plugin.
2. eCash transaction construction, exact sighash calculation, signature encoding, script policy,
   locktime behavior, and testnet broadcast/observation.
3. Monad typed-transaction construction, exact signing digest, low-`s` normalization, recovery
   parity derivation, chain-ID binding, nonce reservation, fee policy, and receipt/finality checks.
4. The secp256k1 adaptor operations currently developed on the
   `crypto-primitives-foundation` branch under `packages/adaptor-signatures`.
5. A custody protocol that prevents either participant from unilaterally invalidating the EVM leg
   after the eCash leg is funded.
6. In every mode, a unilateral success procedure after the peer can obtain the counter-asset,
   backed by a declared bounded inclusion/fee envelope or unilateral repricing. Recoverable mode
   additionally needs a unilateral refund, safe-claim window, and recovery-time fee replacement.
7. Durable secret extraction and watcher behavior. Extraction uses the exact stored presignature and
   observed chain signature, tests both `t` and `-t` against the committed adaptor point to account
   for low-`s` normalization, verifies recovery parity and the completed signature, and persists only
   the matching canonical scalar.

### EVM custody choices

The implementation chooses and documents one of these distinct models:

**Conditional EVM key-share transfer, griefable mode.** The parties create a one-use EOA with
additive public key `P = A_evm + T`, where A knows scalar share `a`, B knows adaptor scalar `t`,
`A_evm = aG`, and `T = tG`. Neither knows `a + t` before settlement. B's valid eCash success-branch
spend completes one adaptor signature under `T`, revealing `t` to A. A then derives the one-use EVM
scalar `x = a + t mod n` and can sign/reprice the payment to A without B. The full one-use EVM key
exists after settlement and must be swept and destroyed; it is not a long-lived threshold custody
design.

This mode can demonstrate ordinary native EVM signatures and atomic theft-safety, but a bare EOA
cannot enforce B's delayed refund. If B never reveals `t`, A refunds XEC after its chain timeout while
B's EVM principal remains stranded unless A later cooperates in salvage. The UI must obtain explicit
acceptance of that asymmetric griefing risk. A fixed-fee EVM success transaction is insufficient:
after B can receive XEC, A must be able to sign a fresh transaction or otherwise cover the complete
negotiated success fee envelope.

The eCash timeout is not needed for signature extraction; it exists so A can eventually recover XEC.
Omitting it creates a simpler but strictly weaker no-refund experiment in which disappearance can
lock both principals forever. It does not make the protocol more atomic. V1 therefore retains CLTV
and treats its absence as a separately labelled test mode, never the default.

**Two-party threshold ECDSA adaptor research.** A protocol that keeps the EVM private key shared even
after settlement is desirable but is not supplied by ordinary threshold ECDSA or by the current
single-key `@frank/adaptor-signatures` API. MuSig2 is not applicable because it is Schnorr. This mode
remains an unimplemented research gate pending a named, malicious-secure two-party ECDSA adaptor
protocol with dealerless key generation, distributed adaptor presigning/proofs, authenticated rounds,
durable one-use preprocessing, abort security, and Ethereum low-`s`/recovery-parity vectors.

**Smart-account or escrow, recoverable mode.** A minimal contract enforces claim and refund branches
and permits recovery-time fee policy. This requires contract support that the present wallet does
not yet expose, so it is a later implementation mode, but it is the only currently specified EVM
path eligible for a recoverable-atomic claim.

**Cooperative EOA prototype.** One participant retains the complete EOA key and promises not to
invalidate a pre-signed transaction. This may demonstrate encoding and secret extraction on
testnet, but it is not an atomic swap and the UI and documentation must label it accordingly.

The initial contractless research path is conditional one-use key-share transfer in explicitly
griefable mode. Long-lived or institutional custody must instead use a separately reviewed threshold
signing protocol or on-chain policy.

### Canonical EVM success policy

The initial protocol does not attest an informal phrase such as “reasonable fees.” It serializes a
versioned, domain-separated success-policy artifact with one canonical byte encoding. V1 permits
only an EIP-1559 type-2 transaction and commits:

- protocol and policy versions, swap and lane IDs, network genesis identity and numeric chain ID;
- the one-use sender `P`, reserved nonce, exact recipient A, exact principal value, gas limit, empty
  calldata, empty access list, and an explicit ban on blob or extension fields;
- inclusive unsigned-integer ranges for `maxFeePerGas` and `maxPriorityFeePerGas`, with
  `maxPriorityFeePerGas <= maxFeePerGas`;
- a reserve invariant proving `principal + gasLimit * maxFeePerGas` does not exceed the funded
  balance at the policy ceiling;
- the canonical eCash claim-intent/body predicate and funding outpoint whose first consensus-valid
  success-branch spend with an extractable A signature authorizes signing, B's advisory
  `lastSafeClaimBroadcast`, the adapter-computed `earliestRefundValidity`, A's state-based
  `successTriggerAcceptanceHorizon`, and the same-nonce replacement rule; and
- canonical lengths and big-endian encodings for every integer and byte field.

The local signer parses and validates the policy before signing. It accepts only the exact immutable
fields and fees inside both ranges, then parses the final signed bytes, recovers the sender, and
rechecks the same policy before release. Replacement uses the same nonce and template. No generic
`signTransaction` or arbitrary-recipient capability satisfies this requirement.

The eCash adapter defines `earliestRefundValidity` as the first height or median-time state in which
the exact CLTV refund can satisfy consensus, including all locktime and sequence off-by-one rules.
The signed manifest uses one conservative time model and requires:

```text
lastSafeClaimBroadcast
  + relayAndFeeBump
  + inclusionAndFinality(claim)
  + reorgMargin(claim)
  < earliestRefundValidity
```

All terms and units are committed by both attestations. This protects B only under the negotiated
common-prefix assumption; no finite margin covers a deeper out-of-model reorganization.

### Initial griefable protocol

For this subsection, A offers XEC and receives MON; B offers MON and receives XEC.

1. A samples nonzero EVM share `a`; B samples nonzero `t`. They exchange `A_evm`, `T`, and proofs of
   knowledge, reject invalid points and `P = A_evm + T` at infinity, and derive the one-use EVM
   address from `P`.
2. A constructs and signs an eCash funding transaction to a P2SH output whose success branch requires
   both A's and B's signatures and whose CLTV refund branch requires A's signature. A reveals only
   the committed txid, output index, amount, redeem script, and child-building data—not the raw signed
   parent, input signatures, scriptSigs, or anything from which B can reconstruct and broadcast it.
   From that commitment, both construct the canonical claim body and exact refund. The adapter
   freezes the redeem script, input set and sequences, funding outpoint, version, locktime, success
   recipient B, outputs and amounts, refund recipient A, fees, and refund height/time in test vectors.
   A's extractable adaptor/completed signature MUST use `SIGHASH_ALL | SIGHASH_FORKID` without
   `ANYONECANPAY`, so it alone binds the complete canonical body. B may use any consensus-valid
   sighash type whose actual signature verifies for B over that unchanged body. Claim unlocking-script
   bytes, B's signature bytes and sighash byte, and claim txid are deliberately not authoritative.
3. B produces an ordinary signature for the canonical eCash claim digest. A gives B an adaptor
   signature for A's required success-branch signature under `T`. B verifies it. A valid
   success-branch spend matching the canonical body pays only B and is the sole first-reveal action.
   B's signature bytes and consensus-valid push encodings may vary. A holds its complete refund
   artifact.
4. B constructs, but does not broadcast, exact EVM funding to `P` for the MON principal plus the
   negotiated success-fee reserve. The settlement policy fixes A's recipient, principal, allowed
   transaction type, nonce, gas limit, and maximum fee envelope while allowing A to choose a fresh
   fee within that envelope after learning `t`. Because possession of `x` ultimately controls the
   entire EOA, the quote treats the whole funded balance, including any unused reserve, as value
   transferred to A; it does not pretend residual change remains under B's control.
5. Both identities sign the pre-funding authorization root containing the exact EVM funding bytes,
   the withheld-parent txid/output commitment, canonical eCash claim intent, exact refund artifact,
   A's presignature and sighash type, the initially supplied B signature as readiness evidence, all
   public points/proofs, amounts, the predicate permitting a later valid B witness, EVM success-policy
   artifact, and conservative `lastSafeClaimBroadcast`.
   They durably record both attestations. B cannot validate the hidden parent's signatures or output
   before risking MON and explicitly accepts invalid-parent, double-spend, and non-reveal grief.
6. B broadcasts EVM funding and waits for the manifest's threshold. Only then does A reveal and
   broadcast the exact raw eCash parent. B byte-checks its txid and promised output, fully validates
   it, retains the bytes for rebroadcast, and waits until that exact txid reaches the negotiated
   eCash threshold. B never adapts the claim for a replacement outpoint. Re-signing, alternate
   encoding, malleation, non-reveal, or confirmation under another txid aborts settlement and leaves
   the disclosed grief outcome. This order gives B no broadcastable claim on XEC before MON is
   committed.
7. Honest B stops before `lastSafeClaimBroadcast` unless the exact claim can still reach negotiated
   finality plus reorganization margin strictly before `earliestRefundValidity`; this is advice, not
   a consensus expiry or revocation of A's rights. To claim, B completes A's adaptor signature with
   `t`, supplies any consensus-valid B signature and success-branch encoding, and broadcasts. On
   observation in the mempool, a block, or a reorg branch, A parses the actual spend and verifies the
   exact funding outpoint, canonical sighash-covered body, redeem script and success branch, both
   signatures, A's mandatory sighash type, and B's actual consensus-valid sighash. A extracts from the
   observed A signature and stored presignature, accepts only `t` or `-t` matching `T`, durably records
   the trigger and counter-action, computes `x = a + t mod n`, and signs a fresh EVM principal payment
   to A under the canonical success policy. A trusted local signer may reprice this payment and later
   sweep the residual reserve because it now holds the complete one-use key.
8. If B does not reveal in time, A broadcasts the eCash refund. B's EVM principal has no contractless
   unilateral refund and enters `cooperative-recovery-required` only when that refund is final under
   the rule below. A never publishes or authorizes an EVM payment to itself before observing a valid
   matching claim reveal. A's
   `successTriggerAcceptanceHorizon` remains open from EVM funding until the exact refund is final
   beyond the declared reorg horizon and the success outpoint can no longer be spent. A valid success
   first observed after B's cutoff still authorizes settlement throughout that state. Once a trigger
   is durably accepted, a later cutoff, competing refund, or reorg does not revoke EVM authorization
   and `a` never enters salvage. Only after the horizon closes with no accepted trigger may A offer
   lane-specific salvage by releasing `a` to B. B verifies `aG = A_evm`, derives `x = a + t`, and
   sweeps the one-use EOA. Releasing `a` earlier could let B recover MON while still obtaining XEC.
   If A disappears or refuses, the MON remains stranded indefinitely.

Safety invariant: before B's reveal, B cannot spend XEC and A cannot spend MON; after B obtains XEC,
A has the scalar and unilateral fee authority needed to obtain MON under the declared inclusion
assumption. Finality failures remain bounded only by the negotiated reorg model.

### Implementation stages

**Stage 0: deterministic transcript.** Run the full plugin state machine with deterministic fake
chain adapters. Abort at every transition. In recoverable mode, prove that no state at or beyond the
conservative authorization cutoff—including an unknown funding outcome—lacks a unilateral recovery
plan. In griefable mode, prove that disappearance cannot let either party profit unilaterally and
surface the permanent-lock outcome explicitly.

**Stage 1: cryptographic compatibility.** Connect exact eCash and Monad digests to adaptor signing,
completion, ordinary chain verification, and extraction. Establish deterministic vectors for both
signature encodings. No funds are broadcast.

**Stage 2: cooperative testnet demonstration.** Broadcast one native-asset lane with disposable
testnet keys. Demonstrate normal completion, terminal aborts strictly before the conservative
authorization cutoff, and recovery/watchers at or after the cutoff including unknown funding
outcomes. Label the EVM trust assumption if custody is still unilateral.

**Stage 3: adversarial conditional custody.** Implement and attack the conditional key-share flow
above. Exercise malformed shares, nonce invalidation, conflicting spends, stale fees, restart,
mempool secret exposure, chain reorganization, and disappearance at every step. A no-reconstruction
threshold-adaptor variant remains a separate research gate until its protocol is selected and
reviewed. Both remain griefable unless a recoverable EVM custody mode is implemented.

**Stage 4: independent lanes.** Add multiple separately funded, separately priced, separately
controlled lanes. Each lane must pass the economic fairness invariant independently and inherit the
selected griefable or recoverable custody mode explicitly.

### Exit criteria for an atomic-swap claim

The plugin may describe Stage 2/3 only as a griefable atomic-safety demonstration when theft-safety
holds and permanent lock is disclosed. A **recoverable atomic swap** claim additionally requires:

- neither party can invalidate a funded counter-leg unilaterally;
- consensus- or program-enforced refund timing; a bare pre-signed EOA refund is insufficient;
- completing one leg yields the exact secret needed for the counter-leg;
- both normal and timeout paths succeed after process restart;
- fee and nonce management cannot indefinitely block an honest recovery;
- finality and reorganization behavior are tested on both adapters; and
- a bounded fee assumption plus preauthorized replacement coverage, or unilateral recovery-time
  repricing; and
- a protocol review finds no state in which an honest party loses both settlement and refund.

## EVM <-> EVM

Both sides use secp256k1 ECDSA, so adaptor points and secrets need no cross-curve proof. The hard
problem is account control rather than signature compatibility: both sides have sequential nonces,
mutable balances, no native timelock, and no UTXO that commits value to a transaction branch.

A contractless design may use a separately funded, jointly controlled temporary EOA for each side
and lane to obtain theft-safety. Two-party ECDSA/adaptor signing prepares the success artifacts
before funding. Each account needs an independent gas reserve, and no ordinary transaction from
either account may exist outside the swap transcript. This construction has no unilateral timed
refund and is therefore griefable rather than recoverable.

Using the participants' normal wallet EOAs is rejected. A party could invalidate the protocol by
consuming a nonce, changing its balance, or replacing a transaction. Using consecutive nonces from
one account for parallel lanes is also rejected because one stalled lane blocks all later lanes.

Minimal escrow or account abstraction provides explicit deadlines and keyed nonce lanes and is
easier to analyze than contractless threshold ECDSA. It is the currently specified recoverable mode
and must not silently replace or be conflated with the native-EOA griefable mode.

## eCash/BCH <-> eCash/BCH

This is the most direct UTXO pairing. Each side can enforce hashlocks and timeouts in script, or use
adaptor signatures so cooperative success resembles an ordinary signature spend. Same-curve
adaptor secrets avoid cross-curve proofs.

The adapters must still treat the chains independently. They may differ in:

- fork-ID and sighash calculation;
- ECDSA versus chain-specific Schnorr acceptance;
- signature serialization and canonicality;
- opcode availability and standardness policy;
- absolute and relative locktime interpretation;
- transaction malleability behavior; and
- confirmation and reorganization policy.

Unlike Bitcoin SegWit, eCash/BCH-family chains cannot be assumed to provide SegWit transaction-ID
malleability guarantees. A protocol using pre-signed descendants must establish the exact txid and
malleability assumptions for each selected chain rather than inheriting a Bitcoin design unchanged.

For a swap on one UTXO chain, a single collaborative transaction can atomically reassign ownership
without an adaptor secret. PayJoin can weaken common-input and change heuristics; CoinSwap is the
closer model when the goal is to break the visible link between old and new UTXOs. Neither technique
makes ownership perfectly opaque, and multiple disjoint transactions are not group-atomic merely
because they were negotiated together.

## Solana <-> Solana

Solana authenticates ordinary transaction signers with Ed25519. A FROST-Ed25519 signing group can
control a normal Solana account and emit a standard 64-byte Ed25519 signature, so no multisig
program is required merely to express joint authorization.

FROST solves joint signing, not conditional time. A contractless design still needs a reviewed way
to make claim and refund capabilities available in the correct order. Every pre-signed Solana
transaction commits to its complete serialized message, including account addresses, instruction
order, fee payer, and recent blockhash or durable nonce. Ordinary recent-blockhash transactions are
too short-lived for a long swap. Durable nonces add lifecycle and invalidation rules that become
part of the protocol.

Independent lanes should normally use independent temporary signing groups and accounts. One
FROST-controlled account with sequential transaction dependencies recreates the head-of-line
blocking problem. A Solana program/PDA can express escrow and time conditions more directly, but
that is a program-controlled settlement mode rather than the contractless native-account mode.

## eCash/BCH <-> Solana

This pair crosses secp256k1 and Edwards25519. A shared scalar cannot be assumed merely because both
groups accept integers. Their subgroup orders differ, encodings differ, and Ed25519 has cofactor and
canonicality requirements.

A contractless design needs:

1. a safely bounded common integer secret;
2. points representing it in both groups;
3. a reviewed cross-group proof of equal discrete logarithm;
4. an eCash/BCH adaptor or script path that reveals the intended witness;
5. Ed25519 adaptor or conditional threshold-signing machinery on Solana; and
6. Solana transaction lifetime and fee handling.

Bitcoin-Monero swap research demonstrates that secp256k1-to-Edwards25519 discrete-log equality
proofs are possible, but it is prior art rather than a drop-in Solana protocol. Solana uses standard
Ed25519 transaction signatures and a different account and transaction-lifetime model from Monero.

If program custody is acceptable, an eCash/BCH HTLC paired with a Solana escrow program is much
simpler and does not need cross-curve adaptor cryptography. The plugin should present this as a
different security/privacy mode, not as the same protocol.

## EVM <-> Solana

This pair combines the account-control difficulties of EVM with the cross-curve requirements of
Solana. EVM uses recoverable secp256k1 ECDSA; Solana uses Ed25519. A native-account design requires:

- temporary jointly controlled accounts on both chains;
- threshold ECDSA on the EVM side;
- FROST-Ed25519 or compatible threshold signing on the Solana side;
- a cross-curve proof or another reviewed mechanism coupling settlement capabilities;
- independent EVM nonce and balance reservations; and
- Solana durable-nonce or fresh-transaction handling.

This is not an initial implementation target. Sharing encrypted Frank transport and a generic swap
state machine does not justify sharing signature or transaction code between these adapters.

If smart accounts and programs are allowed, stateful escrow on both chains is simpler. A protocol
using such escrow should use a shared hash preimage and explicitly bind recipients so a mempool
observer cannot redirect a claim.

## Solana <-> each family: signature rationale

Solana's Ed25519 signature is Schnorr-like and supports efficient threshold construction, but it is
not compatible with secp256k1 signatures. FROST-Ed25519 is preferred for a contractless jointly
controlled Solana account because it produces an ordinary signature accepted by Solana's native
transaction verifier.

Joint signing supplies theft-safety, not a time condition. Unless a pair section supplies a reviewed
unilateral release/refund mechanism, the ordinary-account mode is griefable and may lock funds when
a signer disappears. A Solana program/PDA is the currently straightforward recoverable alternative.

BLS is not selected. BLS is valuable when independently generated signatures must be aggregated
non-interactively, especially across many signers or messages. Swap settlement instead needs a
native signature under the destination account key and a controlled revelation or extraction
property. A BLS aggregate would require a program to verify it and would not authorize an ordinary
Solana system account.

## Failure and race analysis

Every pair-specific implementation must test every applicable case below and record a reviewed
`not applicable` entry for each omitted chain adapter, custody mechanism, or cryptographic primitive:

- peer disappears before accepting;
- peer disappears after exchanging keys or proofs;
- malformed or rogue public key;
- wrong network, asset, amount, recipient, nonce, outpoint, or sighash;
- peer funds only part of a bundle;
- funding transaction is replaced or reorganized;
- EVM account nonce or balance changes unexpectedly;
- Solana blockhash expires or durable nonce is consumed;
- settlement is broadcast just before the safe claim cutoff;
- both success and refund artifacts appear in public mempools;
- extracted scalar has the wrong sign or normalization;
- process crashes before and after secret material is persisted;
- relay duplicates, delays, reorders, or withholds protocol messages;
- RPC endpoints disagree about confirmation or finality;
- fees rise above the reserved recovery budget; and
- one lane completes while another lane in the advertised order fails.

Secret material observed in a mempool must be treated as public even if the revealing transaction
never confirms. Safe-claim cutoffs must leave enough time to react before a competing timeout path.
The plugin must not wait until the consensus deadline to decide that a cooperative path is unsafe.

## Privacy considerations

Adaptor signatures can hide a hashlock from the cooperative on-chain path, but they do not make a
swap anonymous. Cross-chain amount correlation, timing, address funding, fee patterns, temporary
account creation, and later consolidation can identify related legs.

Independent lanes with standardized denominations can reduce unique amount fingerprints. Slightly
different amounts may instead make cross-chain matching easier. PayJoin weakens Bitcoin-family
ownership heuristics but does not conceal inputs or outputs. Funding several temporary EVM or
Solana accounts from one source also creates an observable relationship.

Frank protects negotiation contents from relays but does not hide all network metadata. The plugin
must not market encrypted negotiation as on-chain unlinkability.

## Implementation boundaries

The code should separate:

- `swap-protocol`: canonical messages, transcript hashes, state transitions, amount invariants;
- `swap-crypto`: adaptor, proof, threshold-signing, and extraction interfaces;
- `chain-adapter-ecash`: UTXO, script, sighash, broadcast, and confirmation behavior;
- `chain-adapter-evm`: typed transactions, nonce leases, fees, receipts, and finality;
- `chain-adapter-solana`: messages, blockhashes/nonces, signatures, accounts, and finality;
- `swap-watcher`: resumable observation and broadcast actions; and
- `frank-swap-plugin`: encrypted user negotiation and presentation.

The chain-neutral layer must never accept a generic `sign(bytes)` abstraction that erases the
meaning of the digest. Each adapter produces a typed transaction commitment and the crypto layer
signs the exact 32-byte digest or message required by that signature scheme.

Relays may transport and store opaque swap messages, but they are not authoritative watchers or
price oracles. A participant must be able to export a recovery package containing the transcript,
transactions, proofs, deadlines, and watcher instructions without exporting unrelated wallet keys.

Journal and recovery-package schemas classify public transcript data separately from signing
nonces, threshold shares, adaptor secrets, authorized transactions, and other spend capabilities.
Sensitive fields use vault-backed authenticated encryption bound to account, swap, lane, transcript,
and monotonic journal revision. AEAD and a counter stored in the same local database do not prove
freshness against restoration of an older authentic snapshot. Until a non-rollbackable platform or
external anchor is selected, whole-store malicious/backup rollback is outside the guarantee and an
ambiguous restore fails closed into manual recovery without signing. Restore reconciles against both
chains and relays but does not assume they reveal every previously exposed off-chain share. Export
requires an explicit disclosure boundary and contains only the minimum recovery capability. After
the negotiated reorg/recovery horizon, compaction preserves audit hashes while destroying spent or
obsolete capabilities on a best-effort basis. It MUST retain lane share `a` and the minimum salvage
record while a one-use EOA has value in `cooperative-recovery-required`, unless the owner explicitly
and separately acknowledges irreversible abandonment.

Each custody mode defines a watcher capability matrix naming the principal, exact permitted action,
immutable transaction fields, fee range, trigger evidence, validity window, revocation rule, and
compromise blast radius. In conditional key-share mode, raw `a` and completed `x` remain inside A's
trusted local signer or vault boundary. A watcher observes the trigger and requests only a
policy-conforming signature; it does not receive `x`. A delegated watcher receives preauthorized
byte-exact transactions or the narrowest operation-scoped signing capability and never receives
unrelated wallet roots. If an implementation exports `x` to a watcher, that watcher is part of the
trusted computing base: compromise can steal that lane, and the malicious-watcher non-redirection
claim does not apply. If a mode requires arbitrary repricing but cannot delegate it without broad
custody, its delegated-liveness claim remains unsatisfied. Capability tests assume a malicious
untrusted watcher and prove it cannot redirect value, act before its trigger, exceed fees, or affect
another lane.

Changing the active Frank account does not delete or orphan an operation at or beyond its
conservative authorization cutoff, including one with an unknown funding or dispatch outcome.
Account replacement is blocked while such nonterminal obligations exist unless their account-bound
journal and capabilities are atomically detached into a watcher store with a durably verified resume
path. A Codex32 master does not regenerate swap-session nonces, adaptor secrets, or already-authorized
transactions.

## Verification plan

The first implementation should provide:

1. deterministic transcript and state-machine fixtures;
2. upstream adaptor-signature vectors plus Frank-specific adversarial vectors;
3. exact eCash sighash and signature acceptance checked against an eCash testnet-compatible node;
4. exact Monad transaction recovery checked by both Frank and the target RPC;
5. tests proving mutation of every bound transaction field invalidates acceptance;
6. crash/restart tests on both sides of every durable commit, relay send, chain broadcast, secret
   observation, and acknowledgement;
7. abort tests at every state, proving terminal cleanup only before the conservative authorization
   cutoff and watcher/recovery survival at or after it, including unknown funding outcomes;
8. chain reorganization simulations before and after counter-leg finality, including rollback beyond
   the declared assumption;
9. multi-lane tests over every reachable success/refund subset using net values and worst-case fees,
   plus late revelation against the slowest coupled leg; for every partial-funding and
   reveal/derivation prefix, compute the transitive capability closure, give every newly empowered
   party all exchanged completion artifacts, and prove it cannot claim incoming value until all of
   its outgoing obligations are final; capability generation alone remains a valid prefix but never
   creates an ungated exercise option;
10. account-replacement tests proving every old-account swap at or beyond its conservative
    authorization cutoff—including unknown funding outcomes—retains the mode-specific claim, refund,
    monitoring, and cooperative-salvage capabilities after restart, or replacement is blocked;
11. fee-ceiling tests proving unilateral success coverage in every mode and refund coverage across
    the recoverable envelope, including peer claim, fee spike, and disappearance;
12. canonical EVM policy tests in which two differently priced in-range type-2 transactions pass,
    while mutation of every immutable field, either fee bound, the priority/base relationship, the
    reserve ceiling, encoding, recovered sender, trigger predicate, acceptance horizon, or nonce
    fails;
13. withheld-parent tests proving B cannot reconstruct or broadcast the eCash parent from disclosed
    preparation data, and that alternate parent encodings, signatures, or txids never retarget the
    claim outpoint;
14. claim-malleability tests proving a fresh valid B signature, every accepted push encoding, and B
    sighash variants including `ALL | FORKID | ANYONECANPAY` still trigger extraction from A's fixed
    `ALL | FORKID` signature, while any body mutation or A-sighash mutation fails; the original
    authorization root remains unchanged;
15. post-refund salvage tests proving `a` is never released before refund finality, is retained across
    restart while MON remains, verifies against `A_evm`, and recovers only the one-use EOA for B;
16. cutoff-race tests in which a claim first appears after `lastSafeClaimBroadcast`, a claim and
    refund race in either order, a shallow refund reorganizes to a claim, and a restart crosses the
    cutoff; every externally observed valid reveal—winning, losing, evicted, or reorged—remains
    authorized and permanently excludes salvage, while final refund with no observed trigger retires
    signing and enables salvage; cutoff rejection applies only to B's local broadcast decision;
17. deadline-boundary tests proving a claim broadcast at the cutoff reaches negotiated finality and
    reorg margin strictly before refund validity under worst-case declared delays, one unit later is
    rejected, and a pre-finality claim reorg followed by refund is never classified safe;
18. authentic old-snapshot restore tests that either verify an external freshness anchor or fail
    closed without signing; malicious-watcher capability tests; and
19. a live testnet griefable-mode completion/lockout demonstration or recoverable-mode
    completion/refund demonstration, using disposable keys and negligible value and labelled
    accordingly; and
20. generic bundle boundary tests that reject `ReadyToSettle` when the remaining-leg inequality passes
    but the revelation leg cannot itself reach finality and reorg margin before its refund, including
    equality and one-unit failures.

Passing functional tests is not a substitute for cryptographic review. Each threshold-signature
scheme, cross-curve proof, adaptor-point reuse pattern, or other primitive actually used by a
pair—and the final settlement state machine—requires independent review before moving beyond a
research demonstration.

## Decisions recorded

- Frank will specify the full chain-pair matrix but implement eCash testnet to Monad testnet first.
- Native assets and one lane come before tokens, routing, bundles, or multiple users.
- A plain pre-signed transaction from a counterparty-controlled EVM EOA is not atomic custody.
- The initial joint EVM EOA uses conditional one-use key-share transfer: B's eCash claim reveals its
  EVM share to A. It can demonstrate theft-safety but not B's unilateral timed refund and is
  explicitly griefable.
- Two-party signing that emits one ordinary EVM signature is 2-of-2 threshold ECDSA, not an on-chain
  2-of-2 contract and not MuSig2; the current adaptor package is not a threshold-adaptor protocol.
- FROST-Ed25519 is the preferred joint-signing direction for ordinary Solana accounts.
- BLS aggregation is not a native settlement mechanism for these chains.
- Same-curve pairs avoid cross-curve proofs but still require chain-specific transaction adapters.
- Each independently revealed secret must correspond to an independently fair exchange.
- Strict all-or-nothing behavior across disjoint transactions requires more than shared metadata.
- The plugin is a coordinator and recovery interface, never a custodian or source of chain truth.

## References

- [DLC ECDSA adaptor signature specification](https://github.com/discreetlogcontracts/dlcspecs/blob/master/ECDSA-adaptor.md)
- [One-Time Verifiably Encrypted Signatures](https://github.com/LLFourn/one-time-VES/blob/master/main.pdf)
- [Bitcoin-Monero cross-chain atomic swap](https://eprint.iacr.org/2020/1126.pdf)
- [BCH-family transaction signing](https://reference.cash/protocol/blockchain/transaction/transaction-signing)
- [BCH-family Schnorr specification](https://reference.cash/protocol/forks/2019-05-15-schnorr)
- [Bitcoin P2PKH transaction model](https://developer.bitcoin.org/devguide/transactions.html)
- [Ethereum transaction fields and sequential nonces](https://ethereum.org/developers/docs/transactions/)
- [Ethereum Yellow Paper address and signature definitions](https://ethereum.github.io/yellowpaper/paper.pdf)
- [Solana account addresses](https://solana.com/docs/references/terminology)
- [Solana transaction signature pipeline](https://solana.com/docs/core/transactions/transaction-pipeline)
- [Solana partial signing and transaction lifetime](https://solana.com/docs/core/transactions/partial-signing)
- [RFC 9591: FROST, including Ed25519](https://www.rfc-editor.org/rfc/rfc9591.html)
- [Solana SIMD-0388 BLS12-381 proposal](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0388-bls12-381-syscalls.md)
