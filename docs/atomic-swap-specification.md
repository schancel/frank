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
should eventually cover the Cartesian product of three chain families:

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

**Party A** initially offers eCash and receives the EVM or Solana asset. **Party B** initially
offers the account-chain asset and receives eCash. Pair-specific sections may use more descriptive
names where needed.

A **lane** is the smallest independently recoverable exchange of two specified amounts. It has its
own chain objects, deadlines, settlement evidence, and normally its own adaptor secret.

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

## Security properties

An implementation claiming an atomic swap must establish all of the following properties.

### Safety

If one party follows the protocol, the other party cannot obtain that party's offered asset while
preventing the honest party from obtaining the agreed counter-asset or exercising a unilateral
refund. A signature promised after funding is not a refund path. Required signatures, adaptor
signatures, proofs, and transaction commitments must be received and verified before funding.

### Liveness

Assuming each chain continues producing finalized blocks, an online party or its delegated watcher
can eventually claim or refund without further cooperation. Liveness assumptions must name:

- confirmation or finality thresholds;
- safe claim cutoffs before refund deadlines;
- fee-bumping strategy;
- EVM nonce and balance reservations;
- Solana blockhash or durable-nonce policy; and
- maximum tolerated RPC, relay, and watcher outages.

### Transcript binding

Every signature, proof, and transaction commitment must be bound to a canonical transcript that
includes at least:

- protocol name and version;
- swap and lane identifiers;
- both network identifiers and genesis or chain identifiers;
- asset identifiers and integer amounts in atomic units;
- participant identity and settlement public keys;
- exact outpoints, account addresses, and nonces when known;
- transaction digests and sighash types;
- adaptor points and proofs;
- deadlines and finality policy; and
- a hash of the negotiated quote and bundle manifest.

No JavaScript floating-point value may represent an amount, price, deadline, chain identifier, or
nonce. Wire integers must have a canonical bounded representation. Raw transactions, public keys,
signatures, and proofs are byte strings, not hex strings with ambiguous normalization.

### Replay and substitution resistance

Artifacts for one network, fork, asset, lane, transaction, or protocol version must not verify in
another context. A party must reject changes to recipients, amounts, fees, inputs, account lists,
nonces, blockhashes, locktimes, sighash flags, or output order after approving a transcript.

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

The initial message flow is:

```text
Offer
  -> Accept
  -> KeyAndProofExchange
  -> TransactionCommitments
  -> EncryptedSignatures
  -> ReadyToFund
  -> FundingEvidence
  -> ReadyToSettle
  -> SettlementEvidence
  -> SecretExtraction
  -> CounterSettlementEvidence
  -> Complete | Refunded | Failed
```

Messages may arrive more than once or out of order. Each transition must therefore be idempotent
and validate its predecessor state. A party must never generate a fresh cryptographic nonce merely
because a previously sent message was replayed.

The following states are terminal from the plugin's perspective:

- `complete`: all expected settlement legs reached their required finality;
- `refunded`: the tracked principal returned through the specified recovery path;
- `failed-before-funding`: no principal was committed;
- `manual-recovery-required`: funds remain recoverable but automated assumptions expired; and
- `loss-or-protocol-violation`: observed chain state contradicts the promised safety property.

The last state must not be softened into a generic failure message. A testnet demonstration needs
to make protocol failures visible.

## Amounts, multiple lanes, and multiple users

The fundamental batching invariant is:

> Every independently exercisable settlement domain must be economically fair by itself.

Suppose lane `i` exchanges `X_i` atomic eCash units for `M_i` atomic Monad units at rational price
`p / q`. An independently settleable lane must satisfy the negotiated rounding policy for:

```text
M_i * q == X_i * p
```

or a stated bounded deviation. Network fees must be assigned explicitly and must not secretly make
one lane subsidize another. Prefer denominations that make conversion exact. If exact conversion is
impossible, allocate remainders deterministically before signing and ensure a party cannot improve
its effective rate by choosing a subset.

### Independent lanes

Independent lanes use independent secrets and are individually fair. Any subset may settle without
changing the agreed rate. This is the preferred model for partial fills and for the first multi-lane
implementation.

On account chains, independent lanes should use independent temporary accounts or supported nonce
lanes. Ordinary EVM transactions from one EOA have sequential nonces; a missing lower nonce blocks
higher ones. Transactions sharing an EVM nonce are alternatives, not parallel swaps.

### Coupled bundles

A coupled bundle uses one secret, or cryptographically linked secrets, to make all prepared legs
completable after any settlement reveals the capability. This can make uneven lanes fair only as a
whole. It does not force miners, validators, or participants to broadcast every leg. Before the
secret is exposed:

1. every funding object must be final enough for the selected policy;
2. every counterparty must hold every required completion artifact;
3. account nonces, balances, and durable nonces must remain reserved; and
4. watchers must be able to submit all remaining legs with adequate fees.

Reusing one adaptor point with multiple signers is not approved merely by this document. The
current DLC-derived ECDSA construction warns that non-DLC use needs careful analysis because an
adaptor signature exposes a Diffie-Hellman relation between signing and encryption keys. Its proof
of knowledge requirement must be retained, and multi-party reuse needs independent review.

### Multi-user batches

A multi-user match should clear at a common rational price or divide into independently fair lanes.
No participant may depend on another participant's excess value to make its own lane fair. A user
who goes offline after funding must be replaceable by a watcher holding already-authorized
transactions; otherwise the group has only a cooperative batch, not an atomic one.

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

| Pair                    | Curve relationship                       | Contractless direction                              | Status          |
| ----------------------- | ---------------------------------------- | --------------------------------------------------- | --------------- |
| eCash/BCH <-> EVM       | Same curve, usually ECDSA-compatible     | UTXO timeout plus adaptor or shared-key EVM custody | Initial target  |
| EVM <-> EVM             | Same curve and ECDSA                     | Temporary jointly controlled EOAs                   | Future research |
| eCash/BCH <-> eCash/BCH | Same curve; signature dialect may differ | Scripted UTXOs or adaptor signatures                | Future          |
| eCash/BCH <-> Solana    | secp256k1 <-> Edwards25519               | Cross-curve proof plus Ed25519 joint control        | Future research |
| EVM <-> Solana          | secp256k1 <-> Edwards25519               | Cross-curve proof plus threshold signing            | Future research |
| Solana <-> Solana       | Same curve and Ed25519                   | FROST-Ed25519 temporary accounts                    | Future research |

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
6. Unilateral success and refund procedures with an explicit safe-claim window.
7. Durable secret extraction and watcher behavior.

### EVM custody choices

The implementation must choose and document one of these models before calling the result atomic:

**Temporary jointly controlled EOA.** The parties create a one-use account whose public key is
jointly controlled. They use two-party ECDSA/adaptor signing, or a reviewed conditional key-share
transfer protocol, so neither participant can spend or invalidate the account alone. The funded
account contains only the lane amount plus its gas reserve.

**Smart-account or escrow fallback.** A minimal contract enforces the branches. This is simpler to
analyze but requires contract support and is not the preferred initial demonstration.

**Cooperative EOA prototype.** One participant retains the complete EOA key and promises not to
invalidate a pre-signed transaction. This may demonstrate encoding and secret extraction on
testnet, but it is not an atomic swap and the UI and documentation must label it accordingly.

The preferred contractless research path is the temporary jointly controlled EOA. Two-party ECDSA
that emits one ordinary EVM signature is itself threshold ECDSA even when the threshold is exactly
two. It is materially more complex than Schnorr or Ed25519 threshold signing because ECDSA signing
contains nonlinear inversion.

### Implementation stages

**Stage 0: deterministic transcript.** Run the full plugin state machine with deterministic fake
chain adapters. Abort at every transition and prove that no state marked `funded` lacks a recorded
unilateral recovery plan.

**Stage 1: cryptographic compatibility.** Connect exact eCash and Monad digests to adaptor signing,
completion, ordinary chain verification, and extraction. Establish deterministic vectors for both
signature encodings. No funds are broadcast.

**Stage 2: cooperative testnet demonstration.** Broadcast one native-asset lane with disposable
testnet keys. Demonstrate normal completion and every pre-funding abort. Label the EVM trust
assumption if custody is still unilateral.

**Stage 3: adversarial custody.** Replace unilateral EVM control with the selected joint-control
protocol. Exercise nonce invalidation, conflicting spends, stale fees, restart recovery, deadline
races, mempool secret exposure, chain reorganization, and one party disappearing at every step.

**Stage 4: independent lanes.** Add multiple separately funded, separately priced, separately
recoverable lanes. Each lane must pass the economic fairness invariant independently.

### Exit criteria for an atomic-swap claim

The plugin must not describe Stage 2 as atomic unless all of the following are demonstrated:

- neither party can invalidate a funded counter-leg unilaterally;
- all refund artifacts exist before the first funding broadcast;
- completing one leg yields the exact secret needed for the counter-leg;
- both normal and timeout paths succeed after process restart;
- fee and nonce management cannot indefinitely block an honest recovery;
- finality and reorganization behavior are tested on both adapters; and
- a protocol review finds no state in which an honest party loses both settlement and refund.

## EVM <-> EVM

Both sides use secp256k1 ECDSA, so adaptor points and secrets need no cross-curve proof. The hard
problem is account control rather than signature compatibility: both sides have sequential nonces,
mutable balances, no native timelock, and no UTXO that commits value to a transaction branch.

A contractless design therefore needs a separately funded, jointly controlled temporary EOA for
each side and lane. Two-party ECDSA/adaptor signing must prepare both outcomes before funding. Each
account needs an independent gas reserve, and no ordinary transaction from either account may exist
outside the swap transcript.

Using the participants' normal wallet EOAs is rejected. A party could invalidate the protocol by
consuming a nonce, changing its balance, or replacing a transaction. Using consecutive nonces from
one account for parallel lanes is also rejected because one stalled lane blocks all later lanes.

If contract support becomes acceptable, minimal escrow or account abstraction provides explicit
deadlines and keyed nonce lanes and is easier to analyze than contractless threshold ECDSA. That is
a separate settlement mode and must not silently replace the native-EOA protocol.

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

BLS is not selected. BLS is valuable when independently generated signatures must be aggregated
non-interactively, especially across many signers or messages. Swap settlement instead needs a
native signature under the destination account key and a controlled revelation or extraction
property. A BLS aggregate would require a program to verify it and would not authorize an ordinary
Solana system account.

## Failure and race analysis

Every pair-specific implementation must test at least these cases:

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

## Verification plan

The first implementation should provide:

1. deterministic transcript and state-machine fixtures;
2. upstream adaptor-signature vectors plus Frank-specific adversarial vectors;
3. exact eCash sighash and signature acceptance checked against an eCash testnet-compatible node;
4. exact Monad transaction recovery checked by both Frank and the target RPC;
5. tests proving mutation of every bound transaction field invalidates acceptance;
6. crash/restart tests around every transition that creates or learns a secret;
7. abort tests at every protocol state;
8. chain reorganization and conflicting-spend simulations;
9. multiple-lane tests showing that every possible completed subset has the negotiated rate; and
10. a live testnet demonstration of completion and refund using disposable keys and negligible
    value.

Passing functional tests is not a substitute for cryptographic review. Threshold ECDSA,
cross-curve proofs, adaptor-point reuse, and the final settlement state machine require independent
review before moving beyond a research demonstration.

## Decisions recorded

- Frank will specify the full chain-pair matrix but implement eCash testnet to Monad testnet first.
- Native assets and one lane come before tokens, routing, bundles, or multiple users.
- A plain pre-signed transaction from a counterparty-controlled EVM EOA is not atomic custody.
- Two-party signing that emits one ordinary EVM signature is 2-of-2 threshold ECDSA, not an on-chain
  2-of-2 contract.
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
