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
4. Transitional documents, including
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

**IMPLEMENTED-NOT-WIRED.** TypeScript `@frank/codec` and Rust `frank-cbor` implement the FRNK and
deterministic-CBOR slice described in their READMEs. `@frank/crypto-box` implements versioned
deniable encryption envelopes. The relay accepts explicit CBOR account registrations and the
wallet exports a matching helper, but the normal app and bot registration flows still write
protobuf. The normal DM, checkpoint, wallet, bot, and app paths do not thereby speak FRNK.

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

**IMPLEMENTED-NOT-WIRED.**

Directory statements and transitions are intentionally transferable public evidence. Their exact
T2/T2a transcripts, signer selection, key-type and signature-algorithm pairings are frozen in
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

Every signature, content hash, encryption operation, payment commitment, provider receipt, and
journal identity MUST use a distinct versioned ASCII domain. Its transcript MUST length-delimit
variable inputs and bind the exact network tag and operation context. Target DM authenticated data
MUST additionally bind both parties' exact `M` keys, both exact sender and recipient directory
statement hashes, and every relevant origin/destination provider-binding and descriptor-revision
hash. The delivery frame and payment identity cover that same context. A valid object from another
network, directory revision, provider binding, record family, or operation is therefore not
reusable. Callers do not choose which network or directory hash a transcript uses; those values
come from the validated records. Missing context is a failure, never an empty-string default.

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
| Directory codec structure | type 2 attests exact type 4; type 7 authorizes a subject transition | T1 of the opened type-4 statement, not the type-2 wrapper | IMPLEMENTED-NOT-WIRED |
| Target directory topology | target statement type/schema unallocated | Authority is `P` plus accepted predecessor/recovery rules | PROPOSED |
| Transitional registration profile | optional field 9 of type-4 schema 3 | Exact signed registration statement; not the target routing directory or standalone presentation profile | SHIPPED |
| Target presentation profile | standalone record; schema/type unallocated | Signed by `P`/account authority, fetched from selected provider, never public gossip by default | UNALLOCATED |
| Provider descriptor | target record naming provider identity, endpoints, capabilities, networks, pricing and expiry; type unallocated | Stable provider identity and signed descriptor revision; endpoints are not identity | UNALLOCATED |
| Mailbox-checkpoint codec structure | type 3 | `checkpoint_id` is stable identity, not a serialization hash; facts keep stable `fact_id` | IMPLEMENTED-NOT-WIRED |
| Target mailbox journal/tombstone | type-3 facts and future mailbox journal records; fact kinds/live wire unallocated | Append identity is provider-local sequence plus stable object/fact identity; tombstones target logical identity and optionally an exact revision | UNALLOCATED |
| Provider delivery/store-forward | future obligation, attempt, receipt/status and expiry records; types unallocated | Client operation ID plus exact delivery-frame hash; a provider receipt is delivery evidence, not sender authorship | UNALLOCATED |
| Topic post/submission/vote | types 9/10/11 | Current stored frame/event identity is exact type-9 T1; burn tx ID is a separate consumption key | SHIPPED |
| Target topic read/status extensions | future versioned schemas; types unallocated | Stable root/revision/status semantics require the allocations in section 12 | UNALLOCATED |

**IMPLEMENTED-NOT-WIRED.**
Unknown item kinds in an open message-item field remain exact child-frame bytes. Unknown checkpoint
sections remain exact bytes and are not interpreted merely because they resemble a frame.

## 8. Directory, provider, and profile topology

**PROPOSED.** These are separate trust and replication domains:

- The directory is a small public record mapping a network-qualified account authority `P` to
  current `M`, current/previous `P'`, and signed provider bindings. It is publicly replicated.
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
the network-qualified account, current directory authority `P`, current `M` plus its mailbox-key
generation, current `P'`, signed provider bindings and exact descriptor revision hashes, a
monotonic revision, predecessor statement hash, issue/expiry data, and recovery/transition
attachments. The statement is signed by `P` or the account authority selected by an already
accepted transition/recovery rule. Its identity is the authenticated exact statement commitment,
not its wrapper, URL, timestamp, or presentation profile. Migration from transitional type-4
schema 3 MUST create a new target statement and explicit predecessor/migration evidence; it MUST
NOT reinterpret field 9 as the target profile or silently invent `M` and descriptor hashes.

**PROPOSED.** The standalone presentation-profile schema and type ID are **UNALLOCATED**. A profile
MUST name its network-qualified account, directory-statement hash, revision/predecessor, expiry,
and exact presentation payload, and MUST be signed by `P` or the accepted account authority. It is
independently cacheable and replaceable and cannot authorize routing, mailbox access, payment
receipt, or directory succession.

### 8.2 Mailbox-key lifecycle

**PROPOSED.** Each `M` has a monotonically increasing mailbox-key generation recorded by the
directory. Routine rotation MAY accept the current and immediately retired generation for a
bounded, explicitly advertised delivery grace; every delivery names the selected generation and
directory hash. Compromise revocation has no grace: after acceptance, new submissions under that
`M` fail, and delayed operations are accepted only if the destination durably admitted their exact
identity before the revocation boundary. A sender `M` is accepted only when its exact current or
explicitly graced retired directory revision is named and retained.

Seed restore MUST recover the current and still-graced historical `M` secrets and verified
directory history before acknowledging mailbox replay. Erasing a retired secret is allowed only
after its grace, every referenced delivery/checkpoint is resolved, and policy accepts losing the
ability to decrypt older ciphertext. Erasure does not create forward secrecy retroactively and
does not cure impersonation performed while a compromised static `M` remained accepted.

Referenced sender/recipient directory statements, provider descriptors/bindings, and mailbox-key
generation records MUST remain available until dependent deliveries, receipts, journal entries,
checkpoints, disputes and retries are terminal, or an authenticated compact proof replaces them.

## 9. Direct-message construction and acceptance

### 9.1 Target sender order

**PROPOSED.** A sender performs this order exactly:

1. Resolve and validate the recipient's current directory state, provider binding, `M`, and `P'`.
   Pin the exact directory-statement T1 hash and provider-descriptor/binding hash. Missing,
   expired, forked, unsupported, or unbound state fails before encryption or payment.
2. Encode the ordered message items, type-8 content revision, and type-6 logical message. Compute
   T1a from the exact type-8 frame.
3. Encrypt the complete type-6 frame to recipient `M` using an allocated deniable suite. Associated
   data binds the suite, sender and recipient `M` bytes, network, protocol context, and the exact
   directory/provider context required by that suite. `E` and `X` for stamps are never reused as
   encryption keys or ephemerals.
4. Build type 5 and then type 1. The authenticated delivery carries the exact sender and recipient
   directory-statement hashes, provider binding/descriptor revision hashes, and mailbox generation;
   those fields are inside the frame and therefore its payment identity. Derive the T3 digest,
   fresh `E`, `X`, proof, child destinations, and T4 commitments exactly as
   [T3–T4](protocol/cbor/README.md#8-cryptographic-transcripts) require. Payments go to children of
   `P'`, never to `P`, `M`, a provider fee key, or a burn address.
5. Atomically claim and durably flush the complete funding-account and nonce reservation set before
   signing. Then build and sign every payment without submitting it. Verify locally that indices
   are contiguous and destinations, amounts, transaction IDs and commitments match the frame and
   configured minimum.
6. Durably journal the exact type-1 frame, exact signed payment bytes, operation ID, reservations,
   directory/provider binding hashes, and retry state. Flush the journal before any transaction or
   `PUT` can leave the process.
7. `PUT` the exact journaled bytes to the selected provider. The provider validates the complete
   frame and payment set before broadcast/acceptance, durably claims the exact operation, and
   returns a status bound to that operation and frame hash.
8. On an ambiguous response, restart, timeout, or reconnect, reconcile and replay only the exact
   journaled operation. Never rebuild payments or re-encrypt under the same operation ID. A new
   attempt is allowed only after durable terminal proof that the prior exact set cannot land.

**SHIPPED.** Current protobuf code already enforces the important reservation-before-signing,
journal-before-PUT, and exact-byte replay
shape, but it does not implement the target FRNK frame, `M`/`P'` separation, or production FRNK
suite.

### 9.2 Provider-visible admission and economics

**PROPOSED.** A provider validates only what it can verify without recipient secrets: FRNK and
typed outer structure, routing/network/directory/provider/generation bindings, T3, binding of
`P'`, DLEQ and child-destination derivation, independently observed transactions, T4 commitments,
replay/operation identity, and configured payment policy. It MUST bind its chain adapter to the
configured network and directory state. Encoded amounts or destinations are assertions, never
payment evidence. Provider admission and payment consumption occur only after every
provider-visible check passes; recipient-only checks are not prerequisites the provider can assert.

Provider admission, provider delivery fees, and recipient stamp payments are distinct. A provider
fee MUST use its own domain and record; it MUST NOT be counted as the recipient stamp. Store and
forward retries are idempotent by `(client_operation_id, exact_delivery_hash)`. Reusing an
operation ID for different bytes is a conflict. A successful duplicate returns the same terminal
result and does not rebroadcast, append a second inbox row, or consume payment twice.

A valid recipient stamp pays for opaque provider delivery even if the recipient later cannot
decrypt or rejects plaintext/type-6/item semantics. The provider MUST NOT claim that payment,
storage, or a receipt proves recipient decryption, semantic acceptance, or sender authorship.

### 9.3 Recipient-only acceptance

**PROPOSED.** The recipient authenticates and decrypts with the named `M` generation, opens the
type-6 frame, checks the type-6 network, T1a/content revision, item graph and application semantics,
and only then commits the plaintext projection. Failure has no recipient-side message effect, but
does not roll back a provider's already valid delivery or recipient stamp payment. Recipient
acknowledgement, if any, is a separate authenticated status and MUST NOT be forged by the provider.

### 9.4 Origin and destination providers

**PROPOSED.** The origin/home submission provider and destination/mailbox provider are distinct
roles; they MAY be the same provider as a degenerate case. The operation binds both stable provider
identities, their exact descriptor revisions, the recipient mailbox generation, and the exact
delivery-frame hash. Client submission ID, inter-provider delivery ID, destination receipt/status,
origin-provider fee, destination-provider fee, and recipient stamp each use separate domains and
deduplication keys.

The origin provider owns retry/failover until one destination provider durably claims the exact
inter-provider operation. After that claim, failover cannot create a second owner; it queries or
transfers the same durable obligation under an authenticated protocol. Descriptor expiry or route
failure permits another destination only before ownership, or after terminal proof that the prior
destination cannot complete. Ambiguity retains the old owner and exact bytes.

## 10. Mailbox journal, checkpoints, and tombstones

**PROPOSED.** A mailbox has one authoritative provider-scoped change journal. Inbox, outbox,
delivery, checkpoint and tombstone views are projections, not independent replay streams. A live
event channel only announces a new opaque cursor; recovery always pages the journal.

- The provider assigns a durable monotonic sequence. The sequence orders transport at that
  provider and mailbox generation; it is not object identity, global time, or authority. Every
  append, cursor, snapshot, status and receipt names that generation and the governing capability
  or descriptor revision.
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
- Cursor expiry requires a consistent snapshot at a declared high-water mark, followed by normal
  incremental replay. Restart MUST recover the same journal generation and committed cursor.

Exactly once means one durable terminal effect per stable identity despite duplicate delivery. It
does not mean the network sends a packet once. Providers, wallets and bots MUST tolerate replay,
late completion, disconnect after commit, and replacement connections.

Mailbox generation and capability identity are part of every delivery operation ID and its
authenticated context. Late completion performs compare-and-set against the unresolved operation's
generation, descriptor capability and exact bytes; mismatch is terminal stale-generation, not a
write into the replacement mailbox. A reset atomically fences the old generation before it is
acknowledged, persists the successor generation/capabilities and reset boundary together, and only
then admits successor operations.

### 10.1 Tombstone dominance and compaction

**PROPOSED.** Within one authority and mailbox generation, an accepted tombstone dominates the
named object revision and every create/update whose authenticated predecessor is at or before that
revision. A stale create is a terminal `deleted/stale` result; it is not appended, forwarded, or
allowed to resurrect the object. A later recreation requires an explicitly allocated successor
identity or post-tombstone revision rule; none is currently allocated.

An expired-cursor snapshot MUST either carry authoritative tombstones and their dominance frontier,
or declare itself a complete replacement for the named generation at a fixed high-water mark. A
receiver MUST NOT merge a replacement snapshot with pre-boundary positive rows.

A tombstone is a deletion marker, not automatically a positive retention root for the deleted
body. Retaining tombstone `T` does not itself pin body `R`; `R` may be deleted after every other
reachability gate clears unless verification/dispute policy needs its exact bytes. Security
tombstones or a compact authenticated exclusion frontier are retained permanently across the
generation's authority history. Ordinary body bytes and redundant per-event tombstones MAY be
compacted only after an authenticated frontier/snapshot preserves non-resurrection and all retry,
payment, receipt, checkpoint and dispute dependencies are terminal.

## 11. Reset, deletion, and reachability

**PROPOSED.** Reset is boundary-scoped and generation-changing. There is no generic “reset CashWeb”
operation.

- A wallet-local view reset discards derived projections/cursors only; it preserves seed material,
  operation journals, unresolved payments, and the last verified authority state, then replays.
- A mailbox reset requires authenticated mailbox authority `M`, creates a new mailbox generation,
  and cannot rewrite public directory or provider records. It atomically fences the old generation
  before acknowledging reset, as section 10 requires.
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
or event T1. Predecessor/edit, tombstone, moderation and root relations require explicit versioned
records; their type IDs are **UNALLOCATED**. Votes MUST state whether they target an immutable
revision/event or a logical root. Until a new allocation, type 11 targets exactly the immutable
type-9 T1 named by its current schema.

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
| TypeScript codec, registration/topics | Explicit registration and topic writers using FRNK/restricted CBOR | SHIPPED | Cross-check every production slice against Rust and hostile vectors |
| TypeScript codec, other families | Stages 1–9, type-2 signatures, shared vectors | IMPLEMENTED-NOT-WIRED | Production DM suite, full type-1 stage 10, provider/mailbox/status records, target key binding |
| Rust codec, registration/topics | Explicit registration and opt-in topics using FRNK/restricted CBOR | SHIPPED | Cross-check every production slice against TypeScript and hostile vectors |
| Rust codec, other families | Stages 1–9, pure hashes and shared vectors | IMPLEMENTED-NOT-WIRED | Target structures and full checks independently cross-checked |
| Relay / `cashwebd` | Protobuf DM, durable exact-set outbox, authenticated inbox; opt-in CBOR topics; explicit CBOR account registration | SHIPPED | FRNK DM/directory/provider/profile/mailbox journal, exact replay/restart/fork/reset/deletion gates |
| Wallet | Protobuf DM, deniable v2 envelope, durable payment attempts and journal-before-PUT; opt-in CBOR topics | SHIPPED | Disjoint hardened `P`/`M`/`P'`, production suite, FRNK order, atomic mailbox replay and clean migration |
| Bot | Uses wallet/relay flows and persists operational state | SHIPPED | Same protocol client as wallet, exact journal recovery, no private alternative wire |
| App | Uses `ActiveChain`, recipient-scoped polling, protobuf presentation/read models | SHIPPED | Reachability UX, fork/expiry/status surfacing, scoped reset/deletion, target CBOR read models |
| Cross-language vectors | Shared TS/Rust/Python/browser codec corpora; account-registration and topic commitments | IMPLEMENTED-NOT-WIRED | Full DM crypto/payment observations, provider/mailbox/status/reset cases, hostile unknown-field retention |
| Public federation | Architecture plan only; no target convergence claim | PROPOSED | Multi-node directory/descriptor/pubsub convergence, exact deduplication, offline cursor catch-up, expired-cursor snapshot recovery, fork exposure |
| Public/private isolation | Store classification exists; no production-boundary isolation proof | IMPLEMENTED-NOT-WIRED | Presentation profiles and every private mailbox/journal/payment record never enter public federation |

Target conformance requires the same accepted/rejected bytes and first-failure category in
TypeScript and Rust; relay production-boundary tests; wallet restart and ambiguous-outcome tests;
and bot/app tests using the same public client. Unit success in one codec is not daemon support.

**PROPOSED.** Decision-gate review MUST cover: directory/profile migration without field-9
reinterpretation; current/retired/compromised `M` and delayed delivery; provider-paid opaque
delivery followed by recipient rejection; origin/destination provider failover and duplicate
claims; generation reset racing late completion; tombstone dominance, stale create and both
snapshot modes; permanent exclusion history with bounded body compaction; deletion reachability
across shared references and payment recovery; topic root/revision/vote targeting; federation
convergence/cursor recovery; and proof that profiles/private mailboxes never federate. These proofs
do not allocate numeric identifiers.

## 15. Unresolved allocations and review gates

**UNALLOCATED.**

The following remain deliberately unresolved rather than inferred:

- numeric hardened paths/rotation encoding for `P`, `M`, and `P'`;
- a production FRNK DM suite ID and its exact mapping to a reviewed crypto-box construction;
- provider descriptor, delivery, receipt/status, mailbox-journal and reset record type IDs;
- checkpoint journal-fact kinds, checkpoint authorization and chunk linkage;
- provider-fee commitment/domain and delivery pricing semantics;
- directory fork resolution and recovery cryptography beyond fail-closed conflict reporting;
- CBOR topic list/discovery/status schemas and their cutover release;
- cryptographic approval of the current T3a/T3b stamp derivation and proof.

**PROPOSED.** No daemon, client, or migration may allocate these locally. Each allocation updates this index,
the relevant CDDL, both codecs, independent vectors, production-boundary tests, and the conformance
matrix in one reviewed sequence.
