# CashWeb protocol specification

Status: normative human semantics and protocol index. This document distinguishes deployed
behavior from code that exists but is not on a production path, and from the clean-break target.
It does not claim that `cashwebd`, a wallet, a bot, or the app implements a rule merely because the
rule is specified here.

The words MUST, MUST NOT, SHOULD, and MAY are normative as described by RFC 2119, but only inside
the status named for the rule. A **PROPOSED** rule is a conformance requirement for the target
cutover, not a statement about the current daemon.

Every normative paragraph or list below is governed by its nearest explicit bold status label.
A section without a label has no normative default; tables carry status per row. This prevents a
current implementation fact from silently turning a target rule into a shipped claim.

## 1. Status vocabulary and source hierarchy

**PROPOSED.**

- **SHIPPED** — reachable through a normal in-repository runtime path on this branch.
- **IMPLEMENTED-NOT-WIRED** — code and tests exist, but normal clients do not use the path.
- **PROPOSED** — accepted target semantics; implementation and cutover remain required.
- **UNALLOCATED** — a namespace or wire identifier has deliberately not been assigned.

This file owns human protocol semantics, trust boundaries, identity rules, lifecycle rules, and
the conformance index. It intentionally does not duplicate every numbered CBOR field:

1. [`protocol/cbor/*.cddl`](protocol/cbor/) owns exact record structure.
2. [`protocol/cbor/README.md`](protocol/cbor/README.md) owns the current frozen FRNK encoding,
   canonical-validation, resource-limit, transcript, and validation-order profile until each rule
   migrates here once. It is not a second system architecture.
3. [`protocol/cbor/vectors/`](protocol/cbor/vectors/) and
   [`protocol/cbor/vectors.schema.json`](protocol/cbor/vectors.schema.json) are executable proof of
   the claimed bytes and outcomes. Passing vectors proves only the operations they name.
4. [`backend-topology.md`](backend-topology.md) and
   [`public-federation-plan.md`](public-federation-plan.md) are subordinate topology and historical
   transition inputs. Their service/storage separation remains a constraint, but their protobuf,
   route, record, and exact-wire sketches do not allocate or override this specification.
5. Transitional documents, including
   [`protocol/cbor/topic-http-coexistence.md`](protocol/cbor/topic-http-coexistence.md), define a
   bounded coexistence path. They cannot silently redefine record identity or extend the target.

If prose and executable structure conflict, implementations MUST fail closed and the conflict MUST
be resolved in these sources; an implementation must not guess. The currently known intentional
difference is explicit: the frozen CBOR profile permits a directory subject to publish its
identity key as `P'`, while the **PROPOSED** clean-break wallet/profile rules below prohibit all
reuse among `P`, `M`, and `P'`. No writer may present the stronger rule as shipped before the
directory record and wallet cutover enforce it.

## 2. Current boundary and clean break

**SHIPPED.** The normal direct-message path is protobuf. It encrypts a JSON message-item payload
with the version-2 Monad envelope, derives payment children from the recipient's registered key,
durably journals the signed payment set before `PUT /message/monad`, and uses the relay's durable
outbox and recipient-scoped authenticated inbox. The same long-lived identity key currently serves
directory/profile signing, mailbox challenge authentication, DM ECDH, and the base for payment
children. That is implementation fact, not the target key model.

**SHIPPED.** Topic types 9–11 have an opt-in `application/cbor` write and exact-post read path.
Normal wallet construction defaults to protobuf. Topic lists and discovery remain protobuf-only.
The exact coexistence and removal trigger are in
[`topic-http-coexistence.md`](protocol/cbor/topic-http-coexistence.md).

**SHIPPED.** The relay accepts explicit CBOR account registrations and the wallet exports the
matching helper. Normal app and bot registration still writes protobuf; explicit helper reachability
does not make their default registration flow CBOR.

**IMPLEMENTED-NOT-WIRED.** TypeScript `@frank/codec` and Rust `frank-cbor` implement additional
FRNK/deterministic-CBOR families described in their READMEs, and `@frank/crypto-box` implements
versioned deniable envelopes. Production FRNK crypto, DM, checkpoint, wallet, bot and app paths are
not wired merely because those codec/crypto pieces exist.

**PROPOSED.** There are no customer compatibility commitments requiring a mixed protocol. The
repository's Rust relay, TypeScript clients, wallet, bots, and app will switch as one reviewed
clean break. Legacy readers may exist only where an explicit bounded migration owns them. They are
not aliases, writers, identity bridges, or permission to transcode legacy bytes into FRNK.

Issue #60 (wallet/payment persistence and runtime integration) is an active implementation mutex.
This specification is the hostile-review point before daemon work proceeds: concurrent work MUST
NOT independently allocate record types, suites, routes, or persistence semantics covered here.

## 3. Authorities, keys, and trust

### 3.1 Three independent wallet roles

**PROPOSED.** A wallet derives three independent secp256k1 roles from disjoint, fully hardened
branches of the recovery seed. The numeric derivation-path allocation is **UNALLOCATED**; the live
`m/44'/60'/1'/0/0` identity path and the CBOR README's non-normative `P'` recommendation do not
allocate the target branches.

- `P` — public directory authority. It signs directory statements and key transitions. Its secret
  is never used for ECDH, mailbox challenges, ordinary-message authentication, payment derivation,
  or chain funding.
- `M` — mailbox and ordinary-DM key. It authenticates mailbox access and participates in the
  deniable DM suite. It never signs public directory assertions or derives stamp destinations.
- `P'` — stamp-receipt key. It is the public base for recipient-controlled one-time payment
  destinations and nothing else.

All path components below the seed separation point MUST be hardened. A wallet MUST NOT reuse a
secret or public point across these roles, derive one role from another role's extended public key,
or export a role-level extended public key. A missing `M` or `P'` is an unreachable recipient, not
a request to fall back to `P` or to any legacy identity key. Restore MUST recover each role from
the seed plus its persisted/verified rotation index; ambiguity fails closed.

**SHIPPED.** Current protobuf profiles publish one key and current code reuses it across these
roles. This conflicts with the proposed target and therefore requires new directory semantics and
a coordinated rewrite; it cannot be asserted by a codec-only change.

### 3.2 Public authority and deniable messages

**SHIPPED.** Explicit CBOR account registration reaches `PUT /metadata/:addr` through the wallet's
`registerMonadIdentityCbor` helper and the relay's `verify_cbor_account_registration` verifier.
That boundary validates a type-2 attestation and its embedded type-4 schema-3 statement through
stage 10.6 and stores the exact accepted CBOR bytes.

**IMPLEMENTED-NOT-WIRED.** Generalized directory-transition use, including independently reachable
type-7 transition workflows, is not a normal client path. Directory statements and transitions are
intentionally transferable public evidence. Their exact T2/T2a transcripts, signer selection,
key-type and signature-algorithm pairings are frozen in
[`protocol/cbor/README.md#8-cryptographic-transcripts`](protocol/cbor/README.md#8-cryptographic-transcripts).
A relay or peer is a carrier, not an authority: consumers trust a record only after validating its
authority chain and network context.

**PROPOSED.** Ordinary authenticated DMs use `M` and MUST remain deniable: the
recipient can construct a ciphertext accepted as coming from the sender, so the ciphertext is not
third-party proof of authorship. Chain transactions authenticate their funding accounts and public
directory signatures authenticate `P`; neither becomes a signature over DM plaintext.

**IMPLEMENTED-NOT-WIRED.** The crypto-box authenticated modes have no forward secrecy against
compromise of the recipient's static key: there are no prekeys or ratchet, and recorded ciphertext
can be decrypted after that compromise. A stolen recipient static key also permits key-compromise
impersonation to that recipient.

**PROPOSED.** Directory-bound `M` revisions do not change those limits. The directory hash selects
an accepted public-key revision; it does not prove authorship, restore forward secrecy, or prevent
a holder of a compromised accepted `M` from impersonating a sender to that recipient. Implementations
and UI MUST state these limits and MUST NOT claim forward secrecy.

### 3.3 Required context binding

**PROPOSED.**

Every CashWeb-defined signature, content hash, encryption operation, payment commitment, provider
receipt and journal identity MUST use a distinct versioned ASCII domain. Its transcript MUST
length-delimit variable inputs and bind the exact network tag and operation context. Target DM
authenticated data MUST additionally bind both parties' exact `M` keys, both exact sender and
recipient directory-statement hashes, and every relevant origin/destination provider-binding and
descriptor-revision hash. The delivery frame and payment identity cover that same context. A valid
object from another network, directory revision, provider binding, record family, or operation is
therefore not reusable. Callers do not choose which network or directory hash a transcript uses;
those values come from validated records. Missing context is a failure, never an empty-string
default.

Native chain signatures are not re-domained by CashWeb. A pinned chain adapter constructs the
chain's canonical replay-protected signing preimage, including the exact chain ID and transaction
type. Frank separation is supplied by the T4 or provider-fee commitment carried inside that signed
transaction. Adapters MUST prove the mapping for every supported transaction family, including
EIP-1559 typed transactions; a generic message-signing or wrong-chain preimage fails closed.

## 4. Namespaces and allocations

Identifiers are scoped; equal integers in different columns have no relationship.

| Namespace | Current allocation | Status |
| --- | --- | --- |
| FRNK frame version, explicit slices | `1` for explicit CBOR registration and opt-in topics | SHIPPED |
| FRNK frame version, other families | `1` in codecs, with no normal production route | IMPLEMENTED-NOT-WIRED |
| FRNK type IDs, explicit slices | `2`/`4` registration and `9–11` opt-in topics | SHIPPED |
| FRNK type IDs, other codec structures | `1`, `3`, `5–8`, `16`, `17`; proof-only `0xffff0001`, never production; see [CBOR E5](protocol/cbor/README.md#2-common-envelope) | IMPLEMENTED-NOT-WIRED |
| Account key type, explicit registration | type `1` | SHIPPED |
| Account key types, other codec allocations | `2` Ed25519 and `3` x-only secp256k1 | IMPLEMENTED-NOT-WIRED |
| Signature algorithm, explicit registration | algorithm `1` strict-DER low-S ECDSA | SHIPPED |
| Signature algorithms, other codec allocations | `2` BIP340, `3` BCH-2019 Schnorr, `16` Ed25519; individual operations may remain unsupported | IMPLEMENTED-NOT-WIRED |
| FRNK DM encryption suites | proof-only `65535`; no production suite | UNALLOCATED |
| Crypto-box suites | private registry `0xFE01–0xFE04`; not FRNK allocations and not used by the normal relay path | IMPLEMENTED-NOT-WIRED |
| Crypto-box KEM/AEAD private use | KEM `0xFF00`; XChaCha AEAD `0xFF01`, inside crypto-box only | IMPLEMENTED-NOT-WIRED |
| Target directory statement and standalone presentation profile | no FRNK type IDs or schemas | UNALLOCATED |
| Checkpoint journal fact kinds | none | UNALLOCATED |
| Provider/descriptor, delivery, status, reset records | no FRNK type IDs | UNALLOCATED |
| Target type-1/type-5 delivery schemas | schema revisions, required context field IDs and `min_reader_version` | UNALLOCATED |
| Target validation operations | `provider-admission` and `recipient-acceptance` contexts, error taxonomy, CDDL, codec and vector registrations | UNALLOCATED |
| Mailbox/stamp generation fields | directory-authorized mailbox-key and stamp-key generations, destination-provider mailbox-admission capabilities, plus provider-authorized instance generation encodings | UNALLOCATED |
| Account admission authorization | allowed recipient-`M` tuples, rotation class/grace bound, destination binding and predecessor/sequence fields | UNALLOCATED |
| Inter-provider destination claim | exact handoff ID/hash, signed claim receipt and reconciliation/status records | UNALLOCATED |
| Legacy-to-FRNK cutover | per-account/mailbox epoch, fence marker, tagged row states and removal evidence | UNALLOCATED |
| Partial-payment recovery | obligation/status/journal-fact/ack record types and fields | UNALLOCATED |
| Recipient-owned output lifecycle | child-derivation/import/checkpoint/ack records and exposure policy | UNALLOCATED |
| Topic logical relations | logical-root derivation; predecessor/edit/tombstone/moderation records; vote-target discriminator and migration | UNALLOCATED |
| Target hardened wallet branches for `P`, `M`, `P'` | none | UNALLOCATED |

**IMPLEMENTED-NOT-WIRED.** A codec writer MUST NOT copy a crypto-box suite ID into the FRNK
encryption-suite field, emit proof-only IDs, infer a suite from nonce length, or consume an
unallocated number. Allocation requires exact KEM, KDF, AEAD, nonce, associated-data,
deniability/authentication, error, and vector rules.

## 5. FRNK and canonical validation

**SHIPPED.** The rules in this section govern explicit CBOR registration and opt-in topic
boundaries.

An independently stored, signed, hashed, forwarded, or interpreted object is one FRNK frame. The
exact nine-byte header, common envelope, deterministic-CBOR profile, resource limits, and staged
error precedence are normative in [CBOR sections 1–4](protocol/cbor/README.md#1-framing) and
[section 9](protocol/cbor/README.md#9-validation-order).

The non-negotiable system properties are:

- Validate route and global limits before allocation; validate canonical form before typed
  conversion; then schema, semantic, cryptographic, and external observations in the frozen order.
- An unsupported frame version rejects at an interpreting boundary. A contract that explicitly
  permits exact opaque retention keeps the complete frame and stops before parsing its
  version-specific length or CBOR; it does not interpret those bytes as version 1.
- For decoded version-1 CBOR, reject length mismatch, trailing data, indefinite forms, non-minimal
  integers/lengths, non-integer keys, out-of-order keys, and duplicate keys. Never codec-sniff or
  fall back to protobuf/JSON/BCS after failure. Canonical-at-depth rules do not inspect opaque
  unsupported-version bytes.
- The exact complete frame is the byte identity for every transcript. Forwarders MUST retain the
  original frame and MUST NOT decode and re-encode authenticated, committed, or unknown data.
- Within one actor's validation boundary, no stage may spend funds, consume a payment, advance a
  cursor, or persist an interpreted object until every later check available to that actor
  succeeds. Recipient-only decryption and plaintext checks are not provider stages and cannot
  retroactively undo valid opaque delivery or its payment.

**IMPLEMENTED-NOT-WIRED.** The same validation machinery exists for other record families, but no
normal production path thereby uses those families.

## 6. Versioning and authenticated unknown fields

**SHIPPED.** The rules in this section govern explicit CBOR registration and opt-in topic
boundaries.

Payload extensions use additive unsigned-integer keys and a monotonically increasing
`schema_version`. Changing identity, ordering, cryptographic meaning, validation, or a required
field also raises `min_reader_version`. Type IDs and field numbers are never reused.

An exact supported schema rejects undeclared fields. A newer schema with
`min_reader_version <= reader_version` may be projected only through the open maps named by its
CDDL. The reader MUST preserve the exact original complete frame and the exact unknown fields, and
MUST NOT claim the unknown semantics were verified.

An intermediary MUST NOT drop an authenticated unknown field and re-sign the known projection.
It forwards the original bytes or rejects. If `min_reader_version` is too high, the object is
opaque only where the containing contract permits exact retention; otherwise it fails closed.
Canonical order and duplicate rejection apply at every nesting depth of decoded version-1 CBOR,
including unknown extension values; they do not inspect exact-retained unsupported-version bytes.
These rules are the system interpretation of
[CBOR C12 and V1–V6](protocol/cbor/README.md#7-evolution-and-retention).

**IMPLEMENTED-NOT-WIRED.** The same evolution and retention machinery exists for other record
families, but no normal production path thereby uses those families.

## 7. Record families and identity

Exact maps live in CDDL; this section defines what each record means and what identifies it.

| Family | Types / structure | Identity and authority | Status |
| --- | --- | --- | --- |
| Recipient-delivery codec structure | type 1 wrapping type 5; decrypted type 6 wraps type 8 and items 16/17 | Delivery bytes and T3 recipient-payload digest are recipient-specific; logical message identity is type-6 `message_id`; content revision identity is T1a over type 8 | IMPLEMENTED-NOT-WIRED |
| Target recipient-delivery semantics | same structure after production allocations | Complete construction, cryptographic, payment, provider and recipient checks in section 9 | PROPOSED |
| Explicit account registration | type 2 attests exact type-4 schema-3 registration | Exact accepted statement and stage-10.6 authority validation through the helper/route/verifier path | SHIPPED |
| Generalized directory codec structure | type 2 attests exact type 4; type 7 authorizes a subject transition | T1 of the opened type-4 statement, not the type-2 wrapper; generalized transition workflow is not normally reachable | IMPLEMENTED-NOT-WIRED |
| Target directory topology | target statement type/schema unallocated | Authority is `P` plus accepted predecessor/recovery rules | PROPOSED |
| Transitional registration profile | optional field 9 of type-4 schema 3 | Exact signed registration statement; not the target routing directory or standalone presentation profile | SHIPPED |
| Target presentation profile | standalone record; schema/type unallocated | Signed by `P`/account authority, fetched from selected provider, never public gossip by default | UNALLOCATED |
| Provider descriptor | target record naming provider identity, endpoints, capabilities, networks, pricing and expiry; type unallocated | Stable provider identity and signed descriptor revision; endpoints are not identity | UNALLOCATED |
| Mailbox-checkpoint codec structure | type 3 | `checkpoint_id` is stable identity, not a serialization hash; facts keep stable `fact_id` | IMPLEMENTED-NOT-WIRED |
| Target mailbox journal/tombstone | type-3 facts and future mailbox journal records; fact kinds/live wire unallocated | Append identity is provider-local sequence plus stable object/fact identity; tombstones target logical identity and optionally an exact revision | UNALLOCATED |
| Provider delivery/store-forward | future obligation, attempt, receipt/status and expiry records; types unallocated | Client operation ID plus exact delivery-frame hash; a provider receipt is delivery evidence, not sender authorship | UNALLOCATED |
| Account admission authorization | `P`-signed directory rotation or separate `P`-authorized request; type/fields unallocated | Exact recipient-`M` tuples and destination/grace constraints bound what a provider capability may install | UNALLOCATED |
| Mailbox-admission capability | destination-provider-signed generation/policy/fence record; type unallocated | Provider/descriptor, directory hash, accepted `M` set, current `P'`, instance, sequence/predecessor and expiry define local authority | UNALLOCATED |
| Inter-provider destination claim | signed claim receipt and handoff/status records; types unallocated | Inter-provider ID plus delivery and capability hashes establish the sole stamp-broadcast owner | UNALLOCATED |
| Partial-payment recovery | recipient-private obligation/status/journal-fact/ack records; types unallocated | Stable obligation and operation IDs bind exact type-1/type-5/payment evidence; never normal plaintext delivery | UNALLOCATED |
| Recipient-owned output lifecycle | derivation/import/checkpoint/ack records; types unallocated | Stamp generation plus exact type-5/T3, member index and transaction ID identify each child | UNALLOCATED |
| Legacy-to-FRNK cutover | per-account/mailbox epoch/fence and tagged-row records; types unallocated | Stable fence identity owns old/new protocol admission and target instance succession | UNALLOCATED |
| Topic post/submission/vote | types 9/10/11 | Current stored frame/event identity is exact type-9 T1; burn tx ID is a separate consumption key | SHIPPED |
| Target topic read/status extensions | future versioned schemas; types unallocated | Stable root/revision/status semantics require the allocations in section 12 | UNALLOCATED |

**IMPLEMENTED-NOT-WIRED.**
Unknown item kinds in an open message-item field remain exact child-frame bytes. Unknown checkpoint
sections remain exact bytes and are not interpreted merely because they resemble a frame.

## 8. Directory, provider, and profile topology

**PROPOSED.** These are separate trust and replication domains:

- The directory is a small public record mapping a network-qualified account authority `P` to
  current `M`, exactly one current `P'`, their generations, and signed provider bindings. It is
  publicly replicated.
- A provider descriptor is a provider-signed public record. It names stable provider identity,
  service endpoints, networks, capabilities, pricing-policy references, payment keys, and expiry.
  A directory binding pins its descriptor identity/revision; a URL alone is never provider
  identity.
- A presentation profile contains display name, biography, avatar and application fields. It is
  fetched from a selected provider, may be cached with signature verification, and is not
  automatically federated.
- Private inboxes, outboxes, delivery attempts, notification state, checkpoints and mailbox
  tombstones never enter public federation.

The current `MonadProfile` conflates several of these roles and MUST NOT be treated as the target
directory. Clock time does not choose authority: revisions, predecessor links and valid transition
authorization do. A fork is retained and surfaced as a conflict; arrival order or the largest
authored timestamp MUST NOT silently select a winner.

### 8.1 Target directory and profile records

**PROPOSED.** The target directory statement schema and type ID are **UNALLOCATED**. It MUST contain
the network-qualified account, current directory authority `P`, current `M` plus its
`mailbox_key_generation`, current `P'` plus its `stamp_key_generation`, signed provider bindings
and exact descriptor revision hashes, a monotonic revision, predecessor statement hash,
issue/expiry data, and recovery/transition
attachments. The statement is signed by `P` or the account authority selected by an already
accepted transition/recovery rule. Its identity is the authenticated exact statement commitment,
not its wrapper, URL, timestamp, or presentation profile. Migration from transitional type-4
schema 3 MUST create a new target statement and explicit predecessor/migration evidence; it MUST
NOT reinterpret field 9 as the target profile or silently invent `M`, `P'`, generation values or
descriptor hashes.

**PROPOSED.** The standalone presentation-profile schema and type ID are **UNALLOCATED**. A profile
MUST name its network-qualified account, directory-statement hash, revision/predecessor, expiry,
and exact presentation payload, and MUST be signed by `P` or the accepted account authority. It is
independently cacheable and replaceable and cannot authorize routing, mailbox access, payment
receipt, or directory succession.

### 8.2 Mailbox, stamp, and instance generations

**PROPOSED.** `mailbox_key_generation`, `stamp_key_generation` and
`mailbox_instance_generation` are independent authority sequences; their wire fields remain
**UNALLOCATED** in section 15.

- `mailbox_key_generation` identifies `M` under the account/directory authority. Clients discover
  it only from a validated directory revision. Its succession is authorized by `P` or the accepted
  account recovery/transition rule and pins the exact `M` and predecessor directory statement.
- `mailbox_instance_generation` identifies one destination-provider mailbox instance and
  capability. Clients fetch it through the directory-pinned provider descriptor/binding and accept
  only a destination-provider-signed capability linked to its predecessor or authenticated reset.
  Provider failover creates a separately identified instance; it cannot continue another
  provider's sequence by assertion.
- `stamp_key_generation` identifies the exact current `P'` under the account/directory authority.
  The directory names the desired generation, but it becomes effective independently at each bound
  destination provider through the unified mailbox-admission capability below. Stamp rotation is
  current-only at an effectively fenced provider: installation retires the prior generation for
  new admission. This clean target deliberately does not inherit frozen S10a's one-previous-key
  grace.
- Every stamped provider delivery binds all three generations. Directory-only `M` or `P'`
  operations bind their respective generation; provider-instance management binds the instance
  generation. Rotating either account key does not reset a mailbox instance, and instance reset or
  migration does not rotate, revoke or replace either account key.

A `P`-signed directory rotation, or a separate request authorized by `P`, commits the maximum
account authority a destination may install. It names every allowed recipient-`M` tuple as exact
`(directory_statement_hash, mailbox_key_generation, M)` values; rotation class `routine` or
`compromise`; maximum grace boundary; exact destination-provider identity and descriptor revision;
and authorization predecessor/sequence. Compromise authorization permits only the current tuple.
The authorization record/hash and its wire fields are **UNALLOCATED** in section 15.

Each bound destination provider signs and atomically installs one mailbox-admission capability. It
binds the account-authorization hash, provider identity and exact descriptor revision, exact
directory-statement hash, accepted recipient-`M` tuple set and policy, current
`stamp_key_generation`, `mailbox_instance_generation`, expiry, monotonic sequence and predecessor
capability hash. It MUST equal the account authorization or be a strict subset: the provider may
shorten a routine grace or remove an allowed tuple, but MUST NOT add an older generation,
substitute `M`, extend the deadline, change provider/descriptor, or relabel compromise as routine.
Its schema, fields and operation are **UNALLOCATED** in section 15. Every delivery and mailbox
challenge names the selected tuple and capability hash; recipient `M` is accepted only when that
installed capability permits the exact tuple.

Seed restore MUST recover the current and still-graced historical `M` secrets and verified
directory history before acknowledging mailbox replay. Erasing a retired secret is allowed only
after its grace, every referenced delivery/checkpoint is resolved, and policy accepts losing the
ability to decrypt older ciphertext. Erasure does not create forward secrecy retroactively and
does not cure impersonation performed while a compromised static `M` remained accepted.

A sender MUST resolve the freshest directory state and an unexpired installed mailbox-admission
capability before reserving funds. Type 5 and `provider-admission` bind both its exact hash and its
account-authorization hash. Missing, expired, mismatched, superseded, widened or uninstalled
capability fails closed. Installing the capability
serializes through one provider-local compare-and-set against both delivery-operation claims and
mailbox challenge/session issuance. If an old-generation claim wins first, that exact operation has
the bounded delivery/recovery authority recorded by its claim. If an old-generation challenge or
session wins first, it has only its recorded bounded lifetime and cannot mint a successor session.
If capability installation wins, retired `M` authorizes neither new DM admission nor new mailbox
authentication, and retired `P'` authorizes no new stamp admission. Rejection occurs before payment
exposure, credit or consumption.

Rotation is provider-effective, not globally instantaneous. Routine grace and compromise no-grace
are explicit capability policy, not clock inference. Compromise closure requires installing the
successor capability at every bound destination provider. A partitioned or unfenced provider is
explicitly not yet revoked and MUST NOT be advertised as current for the successor `M` or `P'`.
Already claimed, broadcast or confirmed old-generation operations follow their exact bounded
terminal/reconciliation/recovery state, never a normal new-admission path. The recipient retains or
seed-derives a retired `P'` secret while any exposed operation, recovery obligation or
unswept/unknown child for that generation remains reachable; it may erase the secret only under the
output-lifecycle rule in section 9.2.

This capability is destination/recipient scoped; it is not a portable fence for the sender's `M`.
A destination validates sender `M` against its freshest locally validated, unexpired sender
directory revision. Sender revocation is eventual at unrelated destinations, and a compromised
sender `M` may impersonate until the successor revision converges or the old revision expires. A
maximum sender-directory validity/freshness window is **UNALLOCATED** in section 15; after that
bound, missing fresh authority fails closed. A recipient client holding a newer validated sender
revision rejects the older revision even if its provider has not converged. A sender-home receipt
does not close remote destinations and is not portable authority; a portable origin receipt is a
future non-goal unless separately allocated.

Referenced sender/recipient directory statements, provider descriptors/bindings, mailbox key
generations, stamp generations, instance capabilities and instance generations MUST remain
available until dependent deliveries, receipts, journal entries, checkpoints, disputes, recovery
obligations and retries are terminal, or an authenticated compact proof replaces them.

## 9. Direct-message construction and acceptance

### 9.1 Target sender order

**PROPOSED.** A sender performs this order exactly:

1. Before randomness, encryption, or reservation, resolve, validate and pin both sender and
   recipient directory revisions, `M` values and `mailbox_key_generation` values; the recipient
   current `P'` and `stamp_key_generation`; both origin and destination provider identities,
   bindings, descriptor revisions and capabilities; and the destination
   `mailbox_instance_generation`. A stale, forked, revoked, expired, unsupported or mismatched
   record fails here. The sender also proves its local `M` secret/public point and generation match
   the pinned sender revision; there is no fallback.
2. Encode the ordered message items, type-8 content revision, and type-6 logical message. Compute
   T1a from the exact type-8 frame.
3. Encrypt the complete type-6 frame to recipient `M` using an allocated deniable suite. Associated
   data binds the suite, sender and recipient `M` bytes, network, protocol context, and the exact
   directory/provider/generation context pinned in step 1. `E` and `X` for stamps are never reused
   as encryption keys or ephemerals.
4. Draw fresh stamp scalar `e`, derive `E`, `X` and the DLEQ proof, then assemble and encode the
   final type-5 recipient payload. Required fields inside its exact bytes carry `E`, `X`, the proof,
   both directory-statement hashes and mailbox-key generations, the exact current `P'` and
   `stamp_key_generation`, both provider identities/binding/descriptor hashes/capabilities, the
   destination provider's mailbox-admission capability and account-authorization hashes, the
   destination instance generation, network, and every policy/context digest authoritative for
   associated data, routing and economics. Any outer copy is derived from type 5 and
   equality-checked. Compute T3 exactly once over that final type 5, then derive child destinations,
   amounts and T4 commitments exactly as
   [T3–T4](protocol/cbor/README.md#8-cryptographic-transcripts) require. Payments go to children of
   `P'`, never to `P`, `M`, a provider fee key, or a burn address.
5. Create and durably flush a pre-operation intent that owns the complete funding-account and nonce
   reservation set before signing. The intent binds the operation, final type-5/T3 identity,
   destinations, amounts and T4 commitments; no other operation may reuse any reservation.
6. Build and sign every payment without network dispatch or other external exposure, derive every
   transaction ID from the exact signed bytes, and verify member indices, destinations, amounts,
   IDs and commitments. Only then assemble, encode and locally validate the final type-1 frame.
   Atomically promote the intent to
   `signed-ready` while journaling the exact type-1 frame, exact signed transaction bytes, every
   pinned generation identity, all context and retry state. Flush before any network dispatch.
7. Submit the exact journaled bytes to the origin provider. It MAY structurally preflight and
   forward them, but MUST NOT broadcast, credit, consume or otherwise expose any recipient-stamp
   transaction. The destination provider performs `provider-admission`, durably compare-and-set
   claims the exact inter-provider identity, delivery hash, mailbox-admission capability hash and
   generations, and returns a signed claim receipt. Only that claimant may broadcast the recipient
   stamps through the idempotent exact-byte reconciliation loop in section 9.4. In the same-provider
   case the roles collapse, but claim still precedes exposure.
8. On an ambiguous response, restart, timeout, or reconnect, reconcile and replay only the exact
   journaled operation. Never rebuild payments or re-encrypt under the same operation ID. A new
   attempt is allowed only after durable terminal proof that the prior exact set cannot land.

The target type-1 and type-5 schema revisions, required context field numbers and
`min_reader_version` are **UNALLOCATED**. Existing schema 1 MUST NOT be reinterpreted or emitted as
this target, and no production writer or daemon implementation may proceed until section 15's
CDDL, codec and vector allocations land together.

Restart resumes a flushed pre-operation intent before creating another. If no signed bytes were
ever externally exposed, release requires durable proof of that fact and an atomic terminal
transition; otherwise the funding account/nonces are conservatively retired or swept under an
explicit recovery operation. A crash cannot leak a reservation indefinitely, and a reservation is
never returned to the reusable pool merely because signing or journaling was interrupted.

**SHIPPED.** Current protobuf code already enforces the important reservation-before-signing,
journal-before-PUT, and exact-byte replay shape, but it does not implement the target FRNK frame,
`M`/`P'` separation, or production FRNK suite.

### 9.2 Provider-visible admission and economics

**PROPOSED.** `provider-admission` and `recipient-acceptance` are distinct named operations with
distinct validation contexts and error namespaces. Their operation registrations, context fields,
errors, CDDL, codec support and vectors are **UNALLOCATED** in section 15; the current frozen
validation profile is unchanged, and daemon implementation is blocked until those artifacts land.

For `provider-admission`, the provider context supplies the requested route, exact network,
validated sender/recipient directory revisions and mailbox-key generations, origin/destination
provider identities and descriptor capabilities, destination instance generation, current `P'`,
stamp generation, installed mailbox-admission capability and account authorization, operation
identity, canonical finality policy, and chain observations. The provider validates, in actor order: framing
and canonical form; target schema; equality of type-5 authoritative context with its validated
context and any derived outer copies; T3; `P'`, DLEQ, destination and T4 derivation; replay; then
external payment observations and finality. Structural/context failures, cryptographic failures,
replay conflicts, payment insufficiency and provisional/finality states remain distinguishable.
The provider never invokes `recipient-acceptance` or reports its errors.

An origin provider may run the structural prefix only as preflight; it gains no economic authority.
After the destination completes all local structural, context, cryptographic and replay checks, it
atomically claims the operation and signs the claim receipt before any recipient-stamp transaction
is exposed. Only then may that destination broadcast and perform external observation/finality
stages. A failed claim has no broadcast, credit, consumption or recipient-stamp side effect.

The destination provider verifies the bound account authorization and proves its installed
mailbox-admission capability is equal or narrower before claiming the operation. It compares the
capability, directory hash and exact recipient-`M` tuple to its atomically installed generations and
policy. Capability installation,
operation claim and challenge/session issuance use the compare-and-set order in section 8.2. A
generation retired at that provider is a stale-context failure even when its proof and transactions
are otherwise valid; only an operation claimed before the fence may enter the broadcast and
terminal/recovery path below. The origin's structural preflight never creates payment authority.

Provider admission, provider delivery fees, and recipient stamp payments are distinct. A provider
fee MUST use its own domain and record; it MUST NOT be counted as the recipient stamp. Store and
forward retries are idempotent by `(client_operation_id, exact_delivery_hash)`. Reusing an
operation ID for different bytes is a conflict. A successful duplicate returns the same terminal
result and does not rebroadcast, append a second inbox row, or consume payment twice.

Each required payment member has a durable state: `reserved`, `signed`, `broadcast`,
`observed-provisional`, `ambiguous/could-still-land`, `final`, or terminal failure, with its exact
signed bytes, transaction ID, block hash/height and observations. The exposure policy deciding when
signed bytes could still land is canonical and **UNALLOCATED** in section 15; member index or
settlement order never changes the result. Aggregate state precedence is: `final` only when every
required member is final; `terminal-partial` when at least one member is final, irreversibly
recipient-owned, or exposed/could-still-land and at least one required member terminally fails;
terminal failure only when at least one member fails and every other member is proved unable to
land; otherwise pending. A later observation may refine a member and the aggregate under those
rules, but cannot erase exposure evidence.

Delivery occurs only after every required member independently reaches final with the configured
minimum and exact commitment. A `terminal-partial` aggregate never delivers: recipient-owned or
possibly landing value remains recoverable exactly once, and all evidence is retained. It creates
no automatic credit, deduction or fresh payment set. Only explicit sender acknowledgement and a new
operation may risk additional payment.

A `terminal-partial` result creates one durable recipient-private recovery obligation, not a normal
plaintext delivery. Its stable obligation ID binds the operation ID, exact authenticated type-1 and
type-5 bytes and context (including network, `X`, `P'` and `stamp_key_generation`), every final,
provisional, ambiguous or could-still-land member's signed transaction/ID/observation/finality, and
the destination provider signature. Later landings update that same obligation; they never create a
second obligation. Its record, status, journal-fact and acknowledgement encodings are
**UNALLOCATED** in section 15.

The recipient fetches obligations through an authenticated, bounded journal/page operation. Before
an idempotent acknowledgement bound to the obligation, `stamp_key_generation` and mailbox instance
generation, the wallet durably imports every child that could still land. The provider retains
exact bytes and evidence until that acknowledgement. Restart, seed restore, stamp rotation and late
landing resume the same obligation; stable member identities permit only one import/sweep effect.
Recovery never exposes plaintext or converts the obligation into normal delivery.

Every recipient-owned child, including each child of a fully successful delivery, has a durable
generation-bound derivation record keyed by `stamp_key_generation`, exact type-5/T3 identity,
member index and transaction ID, and retaining exact `X` and authenticated context. Every unswept
or unknown child is a reachability root for the retired `P'` generation, exact frame and rotation
metadata. The wallet acknowledges provider output/recovery state only after atomically importing
all such records into a durable checkpoint/restore state sufficient to reconstruct them after seed
restore. Erasure or compaction requires a verified sweep/spend, or explicit authenticated loss
acceptance naming the affected outputs. Restart, reorganization, sweep and acknowledgement replay
must produce one import and at most one spend/sweep effect. The derivation, import, checkpoint,
acknowledgement, sweep and loss-acceptance records remain **UNALLOCATED** in section 15.

Finality policy comes from the canonical network descriptor or an owner-approved pinned policy;
a provider cannot lower it. Type 5 binds the policy identity and digest. The journal retains each
transaction, block hash/height, observation and finality transition. A pre-finality reorganization
rolls back provisional member and aggregate state; no irreversible payment consumption or delivery
occurs before finality. A post-finality exceptional reorganization enters an explicit reconciliation
status, preserves evidence and cannot silently retract delivery or spend the operation again.

A valid recipient stamp pays for opaque provider delivery even if the recipient later cannot
decrypt or rejects plaintext/type-6/item semantics. The provider MUST NOT claim that payment,
storage, or a receipt proves recipient decryption, semantic acceptance, or sender authorship.

### 9.3 Recipient-only acceptance

**PROPOSED.** For `recipient-acceptance`, the recipient context supplies the exact delivery
identity, all pinned generations, retained directory/provider records, the named `M` secret and
the committed journal page/cursor. It authenticates and decrypts, opens type 6, then checks its
network, T1a/content revision, item graph and application semantics. Its structural, authentication,
deterministic plaintext and transient dependency errors are separate from provider errors.

A deterministic invalid ciphertext or plaintext becomes a durable terminal opaque
quarantine/rejection fact keyed by delivery identity, atomically with applying that row and
advancing the page cursor; it stores no plaintext. This lets a valid/poison/valid page commit both
valid rows exactly once without retrying the poison forever. A missing key generation, unresolved
directory/provider record, unavailable crypto service, storage failure or other transient
dependency does not quarantine the row and MUST NOT advance the cursor past it.

Recipient failure has no plaintext-message effect and does not roll back already valid provider
delivery or recipient stamp payment. Recipient acknowledgement, if any, is a separate authenticated
status and MUST NOT be forged by the provider.

### 9.4 Origin and destination providers

**PROPOSED.** The origin/home submission provider and destination/mailbox provider are distinct
roles; they MAY be the same provider as a degenerate case. The operation binds both stable provider
identities, their exact descriptor revisions, both sender/recipient mailbox-key generations, the
recipient stamp generation, destination instance generation, and exact delivery-frame hash. Client
submission ID, inter-provider delivery ID, destination receipt/status, origin-provider fee,
destination-provider fee, and recipient stamp each use separate domains and deduplication keys.

The durable handoff state machine is `origin-ready`, `handoff-pending`, `destination-claimed`, then
broadcast/observation/finality or terminal recovery. Only the destination compare-and-set may enter
`destination-claimed`, and its signed receipt is the evidence for that transition. No broadcast or
recipient-stamp exposure transition exists before it. These state and operation encodings are
**UNALLOCATED** in section 15.

The origin provider owns handoff retry/failover until one destination provider durably claims the
exact inter-provider operation and returns a destination-signed claim receipt binding the
inter-provider ID, exact delivery hash, mailbox-admission capability hash and all generations. The origin MAY
perform structural preflight and forward exact signed bytes, but it MUST NOT broadcast, credit,
consume or otherwise expose recipient-stamp transactions. The destination claimant is the sole
actor authorized to broadcast them. If capability installation wins the compare-and-set, the stale
handoff terminates with zero exposure. If claim wins, that exact operation remains admitted and the
destination owns an idempotent broadcast/reconciliation loop. It MAY resubmit only the exact
journaled signed bytes with the same transaction ID; it never rebuilds, re-signs or substitutes a
member. Retries converge on one durable exposure transition, one member state, one terminal/economic
effect and one destination claimant, even though the exact transaction may be submitted to a node
more than once.

After claim, failover cannot create a second owner; it queries or transfers the same durable
obligation under an authenticated protocol. Descriptor expiry or route failure permits another
destination only before ownership, or after terminal proof that the prior destination cannot
complete. An ambiguous handoff is reconciled against destination status and the signed claim
receipt; ambiguity retains the possible owner and exact bytes. If recipient-stamp bytes were exposed
despite the required order, every affected member enters the canonical `could-still-land` recovery
state rather than being retried through a new owner. Claim receipt, handoff/status and transfer
records are **UNALLOCATED** in section 15.

## 10. Mailbox journal, checkpoints, and tombstones

**PROPOSED.** A mailbox has one authoritative provider-scoped change journal. Inbox, outbox,
delivery, checkpoint and tombstone views are projections, not independent replay streams. A live
event channel only announces a new opaque cursor; recovery always pages the journal.

- The provider assigns a durable monotonic sequence. The sequence orders transport at that
  provider and `mailbox_instance_generation`; it is not object identity, global time, or authority.
  Every append, cursor, snapshot, status and receipt names that instance generation and governing
  signed capability/descriptor revision; stamped delivery facts also name both selected mailbox-key
  generations and the recipient stamp-key generation.
- Applying a page and advancing its opaque cursor is one atomic client commit. A crash before that
  commit replays the page; stable object/fact IDs make the replay idempotent.
- Logical messages deduplicate by stable `message_id`; revisions resolve by authenticated
  predecessor/version semantics, not receipt time. Recipient-specific frames remain separately
  identifiable for payment and delivery.
- Checkpoint facts sort by `(seconds, nanos, fact_id)` only for canonical encoding. Time is not a
  causal merge rule. Checkpoint authorization, linkage, and journal-fact kinds remain
  **UNALLOCATED** until their records and vectors land.
- A tombstone is an authenticated durable fact. It targets a logical family and object ID and,
  when known, an exact revision/content identity. Physical deletion is not a tombstone and cannot
  recreate one after restart.
- Cursor expiry requires a signed, content-identified snapshot naming its snapshot ID, instance
  generation, fixed high-water, page count/order/hash chain and complete manifest. The client stages
  pages in isolation, verifies signature, identity, completeness and frontier, then atomically swaps
  projection, tombstone/exclusion frontier and cursor. A crash exposes either the old committed view
  or a resumable/discardable staging set, never a partial new view. Incremental replay begins strictly
  after the snapshot high-water.

Exactly once means one durable terminal effect per stable identity despite duplicate delivery. It
does not mean the network sends a packet once. Providers, wallets and bots MUST tolerate replay,
late completion, disconnect after commit, and replacement connections.

All applicable mailbox/stamp generations and capability identity are part of every delivery
operation ID and its authenticated context. Late completion performs compare-and-set against the
unresolved operation's mailbox-key generations, stamp generation, instance generation, descriptor
capability and exact bytes; mismatch is terminal stale-generation, not a write into the replacement
mailbox. An instance reset atomically fences the old instance generation before it is acknowledged,
persists the successor generation, capabilities and reset boundary together, and only then admits
successor operations.

### 10.1 Tombstone dominance and compaction

**PROPOSED.** Within one authority and mailbox instance generation, an accepted tombstone dominates
only the named revision and descendants on its authenticated predecessor branch. A sibling head is
an explicit conflict, not a descendant and not silently deleted. A stale create on the dominated
branch is a terminal `deleted/stale` result; it is not appended, forwarded, or allowed to resurrect
the branch. Object-wide deletion needs an explicitly allocated scope covering every known head; a
later recreation needs an allocated successor identity or post-tombstone revision rule.

An expired-cursor snapshot MUST either carry authoritative tombstones and their dominance frontier,
or declare itself a complete replacement for the named instance generation at a fixed high-water
mark. A receiver MUST NOT merge a replacement snapshot with pre-boundary positive rows. Neither a
frontier nor snapshot compaction may discard a sibling head until an allocated authenticated
fork-resolution record covers every head. Exact-branch and object-wide tombstones/frontiers are
different scopes and MUST NOT be inferred from one another.

A tombstone is a deletion marker, not automatically a positive retention root for the deleted
body. Retaining tombstone `T` does not itself pin body `R`; `R` may be deleted after every other
reachability gate clears unless verification/dispute policy needs its exact bytes. Security
tombstones or a compact authenticated exclusion frontier are retained permanently across the
mailbox instance generation's authority history. Ordinary body bytes and redundant per-event
tombstones MAY be compacted only after an authenticated frontier/snapshot preserves
non-resurrection and all retry, payment, receipt, checkpoint and dispute dependencies are terminal.

## 11. Reset, deletion, and reachability

**PROPOSED.** Reset is boundary-scoped and generation-changing. There is no generic “reset CashWeb”
operation.

- A wallet-local view reset discards derived projections/cursors only; it preserves seed material,
  operation journals, unresolved payments, and the last verified authority state, then replays.
- A mailbox-instance reset requires the authenticated destination-provider capability and mailbox
  authority `M`, creates a new `mailbox_instance_generation`, and cannot rotate `M` or rewrite public
  directory/provider records. It atomically fences the old instance before acknowledging reset.
- A directory-authority reset/rotation requires `P` or an already-pinned recovery authority and a
  linked successor/tombstone. Losing `P` is not repaired by `M`, `P'`, a provider, or a clock.
- A provider-local operational reset cannot delete customer mailbox state or public authority
  records without their separate retention/deletion protocol.

Deletion is permitted only when the boundary can prove the object is unreachable from every
retained authoritative root, unresolved operation, cursor/snapshot, checkpoint, tombstone,
delivery obligation, and payment-recovery record. Exact authenticated frames are indivisible:
implementations delete the whole frame and its derived caches or keep the whole frame; they never
strip `X`, unknown fields, or other authenticated bytes. Security tombstones and unresolved
payment/delivery evidence outlive ordinary presentation or routing TTLs. A clock may enforce a
previously authenticated expiry but MUST NOT manufacture authority, settle a fork, or prove that
an ambiguous payment did not land.

Here “tombstone” is a reachability gate only when verification needs the deleted bytes; otherwise
its dominance marker remains while the body may become unreachable under section 10.1. A deletion
proof MUST cover shared references, retries, payment recovery, cross-generation late completion,
snapshot/cursor recovery, disputes, and provider receipts. Permanent security history and bounded
body compaction are separate retention policies.

### 11.1 Legacy-to-FRNK cutover fence

**PROPOSED.** Each account/mailbox has one durable legacy-to-FRNK cutover epoch and fence. The
record type, fields, row tags and terminal/removal evidence are **UNALLOCATED** in section 15; no
daemon cutover may begin before their CDDL, codecs, vectors and production-boundary tests land.

The only cutover-wide atomic action is writing the epoch/fence marker together with the admission
guard that rejects new legacy creation. Existing legacy keyspace and untagged rows committed before
the marker are legacy by rule; they do not need an unbounded atomic rewrite. Background
protocol/version tagging is paginated, idempotent and non-authoritative: a crash resumes from its
cursor, while row ownership still follows the marker and original keyspace.

General legacy dispatch pauses while the fence and admission guard install. After target admission,
a constrained legacy reconciler MAY run concurrently, but only to replay exact pre-fence rows and
write legacy terminal/recovery facts. It MUST NOT create a legacy operation, transcode, re-sign or
re-encrypt bytes, or write the target keyspace/generation. “Legacy writers quiescent” means no
legacy creation or general writer remains; it does not require the constrained reconciler to stop.
The target has a separate keyspace and a `mailbox_instance_generation` strictly after the marker,
and rejects legacy late completions rather than projecting them into that generation. Historical
messages remain a bounded read-only projection.

A crash or ambiguous completion resumes the same epoch and proves which side of the fence owns each
row. Partial payments, unread messages, delayed completion and recovery obligations retain their
original protocol/version and exact bytes until terminal. Rollback may restore legacy readers and
the constrained reconciler, never legacy creation or a general writer after the fence. Legacy
machinery is removable only when no unresolved legacy operation remains and the required
terminal/recovery evidence is retained.

## 12. Topic semantics and transition

**SHIPPED.** For the opt-in CBOR topic slice, the exact immutable type-9 post frame/revision has one
T1 event identity. Type 10 carries the initial up-burn;
type 11 carries a later vote. Author, direction, and weight come from the independently verified
chain transaction. The transaction ID is the consumption key, so one burn counts once across
legacy and CBOR entry points.

The storage rule is frame-first: a CBOR-origin row retains the exact type-9 frame as authority and
may maintain protobuf-shaped indexes only as projections. It MUST NOT reconstruct the frame from a
projection. A CBOR-origin row cannot be returned as a semantically false legacy post. Reads select
the representation by row origin and `Accept`, as specified in the coexistence document.

**PROPOSED.** A future stable logical/root post identity is distinct from every immutable revision
or event T1. Its derivation is **UNALLOCATED**. Predecessor/edit, tombstone, moderation and root
relations require explicit versioned records whose type IDs are **UNALLOCATED**. The vote-target
discriminator and migration are also **UNALLOCATED**; votes MUST eventually state whether they
target an immutable revision/event or a logical root. Until those allocations, type 11 targets
exactly the immutable type-9 T1 named by its current schema.

Normal-client cutover requires versioned CBOR schemas and vectors for single-post
view, topic page/list, discovery, and transaction-specific vote/recovery status. Until those exist,
the protobuf read model remains authoritative for list/discovery and the CBOR writer remains
opt-in. First-confirmed-burn authorship and the public front-running limitation remain the current
type-9 semantics unless a later schema adds an author commitment.

## 13. Replay, restart, fork, and clock rules

**PROPOSED.**

Across every family:

- Stable semantic IDs provide deduplication; local sequences and cursors provide transport order.
- Validation plus durable exact-ID lookup precedes append, forwarding, payment consumption, and
  terminal state. Duplicate valid input returns `already known`/the existing result.
- Record insertion and its journal/dedup row are atomic. Page application and cursor advance are
  atomic. Journal-before-send records survive restart.
- Late completion after cancellation or timeout may update only the matching unresolved durable
  operation. It cannot mutate a replacement generation or a different byte identity.
- Authenticated predecessor links expose forks. No last-write-wins clock rule is allowed.
- Authored timestamps express chronology/expiry only after signature and context validation.
  Provider receipt time is operational evidence only. Clock rollback or skew cannot resurrect a
  tombstone, lower a revision, reuse a payment, or change authority.

## 14. Conformance matrix

**PROPOSED.** “Required proof” means evidence needed before the clean-break target can be called wired.

| Surface / slice | Current evidence on this branch | Current status | Proposed required proof |
| --- | --- | --- | --- |
| TypeScript codec, registration/topics | Wallet helper emits explicit type-2/type-4-schema-3 registration; topic writers use FRNK/restricted CBOR | SHIPPED | Cross-check every production slice against Rust and hostile vectors |
| TypeScript codec, other families | Stages 1–9, generalized directory structures/transcripts and shared vectors | IMPLEMENTED-NOT-WIRED | Production DM suite, full type-1 stage 10, generalized transition path, provider/mailbox/status records, target key binding |
| Rust codec, registration/topics | Relay helper route/verifier performs explicit registration through stage 10.6; opt-in topics use FRNK/restricted CBOR | SHIPPED | Cross-check every production slice against TypeScript and hostile vectors |
| Rust codec, other families | Stages 1–9, generalized type-2/type-7 transition verification at stage 10.6, pure hashes and shared vectors | IMPLEMENTED-NOT-WIRED | Target structures and full checks independently cross-checked |
| Relay / `cashwebd` | Protobuf DM, durable exact-set outbox, authenticated inbox; opt-in CBOR topics; explicit type-2/type-4-schema-3 account registration verification | SHIPPED | FRNK DM/target directory/provider/profile/mailbox journal, unified provider-effective mailbox admission, destination-claim-before-exposure, partial-recovery and all-output obligations, exact replay/restart/fork/reset/deletion and bounded fenced cutover |
| Wallet | Protobuf DM, deniable v2 envelope, durable payment attempts and journal-before-PUT; explicit CBOR registration helper; opt-in CBOR topics | SHIPPED | Disjoint hardened `P`/`M`/`P'`, provider-effective mailbox/stamp rotation and recovery, production suite, exact FRNK order, signed destination-claim reconciliation, all-output import/ack/restore, atomic mailbox replay and bounded fenced cutover |
| Bot | Uses wallet/relay flows and persists operational state | SHIPPED | Same protocol client as wallet, exact journal recovery, no private alternative wire |
| App | Uses `ActiveChain`, recipient-scoped polling, protobuf presentation/read models | SHIPPED | Reachability UX, fork/expiry/status surfacing, scoped reset/deletion, target CBOR read models |
| Cross-language vectors | Shared TS/Rust/Python/browser codec corpora; account-registration and topic commitments | IMPLEMENTED-NOT-WIRED | Full DM crypto/payment observations, provider/mailbox/status/reset cases, hostile unknown-field retention |
| Legacy directory/broadcast federation | Legacy protobuf directory catch-up and broadcast forwarding paths are reachable | SHIPPED | Preserve only as historical migration evidence; do not treat their wire as target FRNK |
| Legacy public-store capability boundary | `PublicFederationStore` exposes only the legacy public address-directory operations; peers do not receive the generic database, profile store or mailbox store | SHIPPED | Retain the capability boundary during deletion/migration; this is not a claim or hypothesis that private mailbox data leaked |
| Target directory/descriptor/pubsub convergence | Architecture inputs exist; target FRNK convergence is not implemented | PROPOSED | Multi-node convergence, exact deduplication, offline cursor catch-up, signed snapshot recovery and fork exposure |
| Target cross-record federation isolation | Full target records and federation facades are unallocated | PROPOSED | Reachability proof that only directory, descriptor and selected pubsub records export, while profiles and every private mailbox/journal/payment record have no public-federation path |

**SHIPPED.** Current evidence supports the narrow legacy public-store capability boundary; it does
not establish a private-mailbox leak. Any prior leak hypothesis is retracted.

**PROPOSED.**
Target conformance requires the same accepted/rejected bytes and first-failure category in
TypeScript and Rust; relay production-boundary tests; wallet restart and ambiguous-outcome tests;
and bot/app tests using the same public client. Unit success in one codec is not daemon support.

**PROPOSED.** Decision-gate review MUST cover: directory/profile migration without field-9
reinterpretation; old/new type-1/type-5 schema rejection and retention; exact construction order
with both directory/provider authorities pinned before randomness; `provider-admission` operation
context/order/errors; account authorization signature, exact tuple, rotation-class, grace-bound,
destination/predecessor/sequence and capability-subset validation; provider substitution, tuple
widening, replay and fork rejection; routine `M` grace versus compromise no-grace; provider-effective `M`/`P'`
rotation, partition and restart; missing/expired capability failure, provider-by-provider compromise
closure, and capability-installation races against operation claim and challenge/session issuance;
bounded authority for a pre-fence winning claim or session; exposed old-generation
terminal/recovery handling, restore and secret erasure; fresh
`e`/`E`/`X`/DLEQ before final type 5 and exactly-one T3; intent crashes before signing, between
signing and journal promotion, and after flush; complete, partial and reorged payment sets including
post-finality reconciliation; exhaustive member-index and settlement-order permutations proving
aggregate-state precedence and one terminal-partial obligation for every exposed subset;
terminal-partial obligation fetch/import/ack across restart, seed restore, stamp rotation and late
landing with one sweep/import effect; fully successful and partial child derivation/import across
crash, reorganization, sweep, acknowledgement and restore, with unswept reachability and explicit
loss acceptance; provider-paid opaque delivery
followed by recipient rejection; deterministic poison quarantine in a valid/poison/valid page;
signed multi-page snapshot crash/resume/atomic swap; sender-directory partition/convergence,
freshness-window expiry, newer-recipient-state rejection and proof that no sender-home fence or
receipt is portable; origin structural preflight with proof of zero recipient-stamp exposure before
a destination-signed durable claim; same-provider claim ordering; destination fence-wins
zero-exposure and claim-wins idempotent broadcast/reconciliation; disconnect before node submission,
disconnect after node acceptance, already-known response and restart, each preserving exact bytes,
transaction ID, one exposure transition, member state, terminal/economic effect and claimant;
ambiguous handoff/status reconciliation, duplicate claims and accidental-exposure
`could-still-land` recovery; generation
reset racing late completion;
branch-scoped tombstone dominance, sibling forks, stale creates and object-wide deletion; permanent
exclusion history with bounded body compaction; deletion reachability across shared references and
payment recovery; EIP-1559 and every supported chain adapter's canonical replay-protected preimage,
chain ID and signed T4/provider-fee mapping; cutover of a large mailbox with paginated tagging,
page crashes and idempotent resume; marker/admission ambiguity, partial payment, unread pre-marker
row, delayed legacy completion rejected by the target generation, rollback-reader/reconciler-only
behavior, creation-writer quiescence and removal gates; topic
root/revision/relation/vote migration; legacy and target federation reachability/convergence/cursor
recovery; and proof that profiles/private mailbox records have no public-federation path. These
proofs do not allocate numeric identifiers.

## 15. Unresolved allocations and review gates

**UNALLOCATED.**

The following remain deliberately unresolved rather than inferred:

- numeric hardened paths/rotation encoding for `P`, `M`, and `P'`;
- a production FRNK DM suite ID and its exact mapping to a reviewed crypto-box construction;
- target directory-statement and standalone presentation-profile type IDs, schemas, fields,
  authority transition/recovery and migration records;
- target type-1/type-5 schema revisions, required context field IDs and `min_reader_version`, with
  explicit old/new compatibility and rejection rules;
- `provider-admission` and `recipient-acceptance` operation IDs, validation contexts, error
  taxonomy, CDDL, both codecs and independent vectors;
- `mailbox_key_generation`, `stamp_key_generation` and `mailbox_instance_generation` wire fields,
  current-only stamp semantics, unified destination-provider mailbox-admission capability/hash with
  exact provider/descriptor/directory and account-authorization-hash binding, accepted-`M`
  tuple-set/policy, expiry/sequence/predecessor,
  installation and compare-and-set against operation claims and challenge/session issuance, plus
  succession/reset/rotation records;
- `P`-signed account admission authorization or authorized request, including exact allowed
  `(directory hash, generation, M)` tuples, routine/compromise class, maximum grace boundary,
  destination provider/descriptor, predecessor/sequence, and provider-subset validation;
- maximum sender-directory validity/freshness window and expiry/convergence validation; portable
  origin receipts remain unallocated and are not authority;
- provider descriptor, delivery, receipt/status, mailbox-journal and reset record type IDs;
- inter-provider handoff ID/delivery-hash binding, destination-signed claim receipt, destination
  status/reconciliation/transfer operations, sole-broadcaster/exposure state and idempotent
  exact-byte/transaction-ID resubmission state;
- checkpoint journal-fact kinds, checkpoint authorization and chunk linkage;
- per-member/aggregate payment states, canonical exposure/could-still-land policy and state
  precedence, canonical finality-policy descriptor/digest, partial-set and
  exceptional-reconciliation status records, and provider-fee commitment/pricing semantics;
- recipient-private partial-recovery obligation/status/journal-fact/ack types and fields, bounded
  fetch operation and generation-bound acknowledgement;
- recipient-owned child derivation/import/checkpoint/ack/sweep/loss-acceptance records for complete
  and partial sets, plus their restore and reachability encoding;
- pre-operation reservation-intent and signed-ready promotion/release/retire/sweep records;
- per-account/mailbox legacy-to-FRNK cutover epoch/fence and admission guard, paginated
  protocol/version row tags, legacy terminal/recovery evidence, constrained reconciler,
  rollback/removal state, separate keyspace and target-instance succession;
- opaque quarantine facts and signed snapshot identity/page-chain/manifest/frontier records;
- branch-scoped versus object-wide tombstone/frontier encoding and authenticated fork resolution;
- directory fork resolution and recovery cryptography beyond fail-closed conflict reporting;
- topic logical-root derivation; predecessor/edit/tombstone/moderation/root relation records; vote
  target discriminator and migration; list/discovery/status schemas and their cutover release;
- cryptographic approval of the current T3a/T3b stamp derivation and proof.

**PROPOSED.** No daemon, client, or migration may allocate these locally. Each allocation updates this index,
the relevant CDDL, both codecs, independent vectors, production-boundary tests, and the conformance
matrix in one reviewed sequence.
