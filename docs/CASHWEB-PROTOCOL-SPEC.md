# CashWeb protocol specification

Status: normative human semantics and protocol index. This document distinguishes deployed
behavior from code that exists but is not on a production path, and from the clean-break target.
It does not claim that `cashwebd`, a wallet, a bot, or the app implements a rule merely because the
rule is specified here.

The words MUST, MUST NOT, SHOULD, and MAY are normative as described by RFC 2119, but only inside
the status named for the rule. A **PROPOSED** rule is a conformance requirement for the target
cutover, not a statement about the current daemon.

## 1. Status vocabulary and source hierarchy

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

**SHIPPED conflict.** Current protobuf profiles publish one key and current code reuses it across
these roles. The target rule therefore requires new directory semantics and a coordinated rewrite;
it cannot be asserted by a codec-only change.

### 3.2 Public authority and deniable messages

Directory statements and transitions are intentionally transferable public evidence. Their exact
T2/T2a transcripts, signer selection, key-type and signature-algorithm pairings are frozen in
[`protocol/cbor/README.md#8-cryptographic-transcripts`](protocol/cbor/README.md#8-cryptographic-transcripts).
A relay or peer is a carrier, not an authority: consumers trust a record only after validating its
authority chain and network context.

Ordinary DMs are different. **PROPOSED:** authenticated mode uses `M` and MUST remain deniable: the
recipient can construct a ciphertext accepted as coming from the sender, so the ciphertext is not
third-party proof of authorship. Chain transactions authenticate their funding accounts and public
directory signatures authenticate `P`; neither becomes a signature over DM plaintext.

The implemented crypto-box authenticated modes have no forward secrecy against compromise of the
recipient's static `M`: there are no prekeys or ratchet, and recorded ciphertext can be decrypted
after that compromise. A stolen recipient `M` also permits key-compromise impersonation to that
recipient. Implementations and UI MUST state these limits and MUST NOT claim forward secrecy.

### 3.3 Required context binding

Every signature, content hash, encryption operation, payment commitment, provider receipt, and
journal identity MUST use a distinct versioned ASCII domain. Its transcript MUST length-delimit
variable inputs and bind the exact network tag and operation context. Target DM authenticated data
MUST additionally bind both parties' exact `M` keys, the recipient directory statement's T1 hash,
and the selected provider-descriptor/binding hash. A valid object from another network, directory
revision, provider binding, record family, or operation is therefore not reusable. Callers do not
choose which network or directory hash a transcript uses; those values come from the validated
records. Missing context is a failure, never an empty-string default.

## 4. Namespaces and allocations

Identifiers are scoped; equal integers in different columns have no relationship.

| Namespace | Current allocation | Status |
| --- | --- | --- |
| FRNK frame version | `1` | IMPLEMENTED-NOT-WIRED except opt-in topic transport |
| FRNK type IDs | `1–11`, `16`, `17`; proof-only `0xffff0001` | IMPLEMENTED-NOT-WIRED except opt-in topic types 9–11; see [CBOR E5](protocol/cbor/README.md#2-common-envelope) |
| Account key types | `1` compressed secp256k1, `2` Ed25519, `3` x-only secp256k1 | IMPLEMENTED-NOT-WIRED |
| Signature algorithms | `1` strict-DER low-S ECDSA, `2` BIP340, `3` BCH-2019 Schnorr, `16` Ed25519 | IMPLEMENTED-NOT-WIRED allocation; actual verifier support is slice-specific |
| FRNK DM encryption suites | proof-only `65535`; no production suite | **UNALLOCATED** |
| Crypto-box suites | private registry `0xFE01–0xFE04` | IMPLEMENTED-NOT-WIRED for the normal relay path; not FRNK allocations |
| Crypto-box KEM/AEAD private use | KEM `0xFF00`; XChaCha AEAD `0xFF01` | Implemented inside crypto-box only |
| Checkpoint journal fact kinds | none | **UNALLOCATED** |
| Provider/descriptor, delivery, status, reset records | no FRNK type IDs | **UNALLOCATED** |
| Target hardened wallet branches for `P`, `M`, `P'` | none | **UNALLOCATED** |

A writer MUST NOT copy a crypto-box suite ID into the FRNK encryption-suite field, emit proof-only
IDs, infer a suite from nonce length, or consume an unallocated number. Allocation requires exact
KEM, KDF, AEAD, nonce, associated-data, deniability/authentication, error, and vector rules.

## 5. FRNK and canonical validation

An independently stored, signed, hashed, forwarded, or interpreted object is one FRNK frame. The
exact nine-byte header, common envelope, deterministic-CBOR profile, resource limits, and staged
error precedence are normative in [CBOR sections 1–4](protocol/cbor/README.md#1-framing) and
[section 9](protocol/cbor/README.md#9-validation-order).

The non-negotiable system properties are:

- Validate route and global limits before allocation; validate canonical form before typed
  conversion; then schema, semantic, cryptographic, and external observations in the frozen order.
- Reject unsupported versions, length mismatch, trailing data, indefinite forms, non-minimal
  integers/lengths, non-integer keys, out-of-order keys, and duplicate keys. Never codec-sniff or
  fall back to protobuf/JSON/BCS after failure.
- The exact complete frame is the byte identity for every transcript. Forwarders MUST retain the
  original frame and MUST NOT decode and re-encode authenticated, committed, or unknown data.
- No stage may spend funds, consume a payment, advance a cursor, or persist an interpreted object
  until every applicable later stage succeeds.

## 6. Versioning and authenticated unknown fields

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
Canonical order and duplicate rejection apply at every nesting depth, including opaque values.
These rules are the system interpretation of [CBOR C12 and V1–V6](protocol/cbor/README.md#7-evolution-and-retention).

## 7. Record families and identity

Exact maps live in CDDL; this section defines what each record means and what identifies it.

| Family | Types / structure | Identity and authority | Status |
| --- | --- | --- | --- |
| Recipient delivery | type 1 wrapping type 5; decrypted type 6 wraps type 8 and items 16/17 | Delivery bytes and T3 recipient-payload digest are recipient-specific; logical message identity is type-6 `message_id`; content revision identity is T1a over type 8 | Structure IMPLEMENTED-NOT-WIRED; full checks PROPOSED |
| Directory | type 2 attests exact type 4; type 7 authorizes a subject transition | T1 of the opened type-4 statement, not the type-2 wrapper; authority is `P` plus the accepted predecessor/recovery rules | Codec slice IMPLEMENTED-NOT-WIRED; target topology PROPOSED |
| Presentation profile | currently optional field 9 of type-4 schema 3 | Signed public content fetched from selected provider; not the routing directory and not public gossip | Encoding IMPLEMENTED-NOT-WIRED; split PROPOSED |
| Provider descriptor | target record naming provider identity, endpoints, capabilities, networks, pricing and expiry | Stable provider identity and signed descriptor revision; endpoints are not identity | PROPOSED, type **UNALLOCATED** |
| Mailbox checkpoint | type 3 | `checkpoint_id` is stable identity, not a serialization hash; facts keep stable `fact_id` | Structure IMPLEMENTED-NOT-WIRED; semantics PROPOSED |
| Mailbox journal/tombstone | type-3 facts and future mailbox journal records | Append identity is provider-local sequence plus stable object/fact identity; tombstones target logical identity and optionally an exact revision | Fact kinds and live wire **UNALLOCATED** |
| Provider delivery/store-forward | future obligation, attempt, receipt/status and expiry records | Client operation ID plus exact delivery-frame hash; a provider receipt is delivery evidence, not sender authorship | PROPOSED, types **UNALLOCATED** |
| Topic post/submission/vote | types 9/10/11 | Logical post and stored frame identity are the exact type-9 T1 hash; burn tx ID is a separate consumption key | Opt-in write/exact read SHIPPED; target read/status surface PROPOSED |

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
4. Build type 5 and then type 1. Derive the T3 digest, fresh `E`, `X`, proof, child destinations,
   and T4 commitments exactly as
   [T3–T4](protocol/cbor/README.md#8-cryptographic-transcripts) require. Payments go to children of
   `P'`, never to `P`, `M`, a provider fee key, or a burn address.
5. Build and sign every payment without submitting it. Verify locally that indices are contiguous,
   destinations, amounts, transaction IDs and commitments match the frame and configured minimum.
6. Durably journal the exact type-1 frame, exact signed payment bytes, operation ID, reservations,
   directory/provider binding hashes, and retry state. Flush the journal before any transaction or
   `PUT` can leave the process.
7. `PUT` the exact journaled bytes to the selected provider. The provider validates the complete
   frame and payment set before broadcast/acceptance, durably claims the exact operation, and
   returns a status bound to that operation and frame hash.
8. On an ambiguous response, restart, timeout, or reconnect, reconcile and replay only the exact
   journaled operation. Never rebuild payments or re-encrypt under the same operation ID. A new
   attempt is allowed only after durable terminal proof that the prior exact set cannot land.

Current protobuf code already enforces the important journal-before-PUT and exact-byte replay
shape, but it does not implement the target FRNK frame, `M`/`P'` separation, or production FRNK
suite.

### 9.2 Target receiver/provider checks

Validation follows section 5 and then the full stage-10 order in the CBOR profile: decrypted type-6
frame, network and T1a, T3, binding of `P'`, DLEQ/destination derivation, independently observed
transactions and T4 commitments, and payment policy. The provider MUST bind its chain adapter to
the configured network and directory state. Encoded amounts or destinations are assertions, never
payment evidence.

Provider admission, provider delivery fees, and recipient stamp payments are distinct. A provider
fee MUST use its own domain and record; it MUST NOT be counted as the recipient stamp. Store and
forward retries are idempotent by `(client_operation_id, exact_delivery_hash)`. Reusing an
operation ID for different bytes is a conflict. A successful duplicate returns the same terminal
result and does not rebroadcast, append a second inbox row, or consume payment twice.

## 10. Mailbox journal, checkpoints, and tombstones

**PROPOSED.** A mailbox has one authoritative provider-scoped change journal. Inbox, outbox,
delivery, checkpoint and tombstone views are projections, not independent replay streams. A live
event channel only announces a new opaque cursor; recovery always pages the journal.

- The provider assigns a durable monotonic sequence. The sequence orders transport at that
  provider; it is not object identity, global time, or authority.
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

## 11. Reset, deletion, and reachability

**PROPOSED.** Reset is boundary-scoped and generation-changing. There is no generic “reset CashWeb”
operation.

- A wallet-local view reset discards derived projections/cursors only; it preserves seed material,
  operation journals, unresolved payments, and the last verified authority state, then replays.
- A mailbox reset requires authenticated mailbox authority `M`, creates a new mailbox generation,
  and cannot rewrite public directory or provider records.
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

## 12. Topic semantics and transition

For CBOR topics, the exact type-9 frame has one T1 identity. Type 10 carries the initial up-burn;
type 11 carries a later vote. Author, direction, and weight come from the independently verified
chain transaction. The transaction ID is the consumption key, so one burn counts once across
legacy and CBOR entry points.

The storage rule is frame-first: a CBOR-origin row retains the exact type-9 frame as authority and
may maintain protobuf-shaped indexes only as projections. It MUST NOT reconstruct the frame from a
projection. A CBOR-origin row cannot be returned as a semantically false legacy post. Reads select
the representation by row origin and `Accept`, as specified in the coexistence document.

**PROPOSED.** Normal-client cutover requires versioned CBOR schemas and vectors for single-post
view, topic page/list, discovery, and transaction-specific vote/recovery status. Until those exist,
the protobuf read model remains authoritative for list/discovery and the CBOR writer remains
opt-in. First-confirmed-burn authorship and the public front-running limitation remain the current
type-9 semantics unless a later schema adds an author commitment.

## 13. Replay, restart, fork, and clock rules

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

“Required proof” means evidence needed before the clean-break target can be called wired.

| Surface | Current evidence on this branch | Target required proof | Status |
| --- | --- | --- | --- |
| TypeScript codec | FRNK, restricted CBOR, stages 1–9, type-2 signature/registration slice, topic writers, shared vectors | Production DM suite, full type-1 stage 10, provider/mailbox/status records, target key binding | IMPLEMENTED-NOT-WIRED except opt-in topics |
| Rust codec | FRNK, restricted CBOR, stages 1–9, pure hashes, shared vectors | Same target structures and full checks, independently cross-checked | SHIPPED in opt-in topic and registration slices; otherwise IMPLEMENTED-NOT-WIRED |
| Relay / `cashwebd` | Protobuf DM, durable exact-set outbox, authenticated inbox; opt-in CBOR topics; explicit CBOR account-registration route | FRNK DM/directory/provider/profile/mailbox journal, exact replay/restart/fork/reset/deletion gates | SHIPPED legacy/opt-in slices; target PROPOSED |
| Wallet | Protobuf DM, deniable v2 envelope, durable payment attempts and journal-before-PUT; opt-in CBOR topics | Disjoint hardened `P`/`M`/`P'`, production suite, FRNK order, atomic mailbox replay and clean migration | SHIPPED legacy; target PROPOSED |
| Bot | Uses wallet/relay flows and persists operational state | Same protocol client as wallet, exact journal recovery, no private alternative wire | SHIPPED legacy; target PROPOSED |
| App | Uses `ActiveChain`, recipient-scoped polling, protobuf presentation/read models | Reachability UX, fork/expiry/status surfacing, scoped reset/deletion, target CBOR read models | SHIPPED legacy; target PROPOSED |
| Cross-language vectors | Shared TS/Rust/Python/browser codec corpora; account-registration and topic commitments | Full DM crypto/payment observations, provider/mailbox/status/reset cases, hostile unknown-field retention | Partial IMPLEMENTED-NOT-WIRED |

Target conformance requires the same accepted/rejected bytes and first-failure category in
TypeScript and Rust; relay production-boundary tests; wallet restart and ambiguous-outcome tests;
and bot/app tests using the same public client. Unit success in one codec is not daemon support.

## 15. Unresolved allocations and review gates

The following remain deliberately unresolved rather than inferred:

- numeric hardened paths/rotation encoding for `P`, `M`, and `P'`;
- a production FRNK DM suite ID and its exact mapping to a reviewed crypto-box construction;
- provider descriptor, delivery, receipt/status, mailbox-journal and reset record type IDs;
- checkpoint journal-fact kinds, checkpoint authorization and chunk linkage;
- provider-fee commitment/domain and delivery pricing semantics;
- directory fork resolution and recovery cryptography beyond fail-closed conflict reporting;
- CBOR topic list/discovery/status schemas and their cutover release;
- cryptographic approval of the current T3a/T3b stamp derivation and proof.

No daemon, client, or migration may allocate these locally. Each allocation updates this index,
the relevant CDDL, both codecs, independent vectors, production-boundary tests, and the conformance
matrix in one reviewed sequence.
