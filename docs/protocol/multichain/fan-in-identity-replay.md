# Multichain fan-in identity and replay

Status: normative prerequisite for [#59](https://github.com/schancel/frank/issues/59).
This document fixes the encoding-independent storage and replay model. It does not choose a wire
encoding, hash function, identifier byte layout, chain address encoding, or protocol-specific edit
winner.

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe requirements on a future
implementation. Names written in `PascalCase` are typed values, not proposed protobuf messages or
database column names. Values described as opaque remain owned by the linked follow-up ticket.

The executable examples are the adjacent
[fan-in fixture manifest](./fan-in-fixtures.json). The manifest uses readable symbolic bytes and
commitments deliberately; those labels are not candidate encodings. Dotted-string object and
revision types in this document and the manifest (for example `public.topic-post`) are readable
labels. Their mapping to the numeric frame type ids of the
[deterministic CBOR spec](../cbor/README.md) is owned by the later migration tickets (#67, #113,
#130) and is not assumed here.

## Required shape

Fan-in has two identity levels and two non-identity record types:

```text
LogicalObjectKey
    └── CanonicalRevisionKey ──> CanonicalRevision
              ▲                         │
              │                         └── LocalProjection (replaceable, local only)
              └── Observation ── SourceCursor
                    │
                    └── source occurrence and provenance (never revision identity)
```

### `LogicalObjectKey`

`LogicalObjectKey` identifies the protocol object whose revisions may be reduced. It contains:

- the `NetworkTag` (an opaque value; it is explicit authenticated data and the sole network
  authority, as in the CBOR spec);
- a typed authority namespace (for a public object the authenticated author/authority; for a
  recipient-private delivery the recipient destination, see below);
- a typed protocol/object namespace; and
- that protocol's opaque logical object identifier.

An identifier reused under a different authority or `NetworkTag` is a different key, not a
conflict (Decision #205). Values remain opaque and typed; byte forms are owned by #67/#113/#130.
An implementation MUST reject a value whose type and object identifier disagree rather than coerce
it to a string.

### `CanonicalRevisionKey`

`CanonicalRevisionKey` identifies one immutable revision. It contains the complete
`LogicalObjectKey` (therefore the authority namespace and `NetworkTag`), a typed revision
namespace, and the owning protocol's opaque revision identifier. Creation, edit, and
deletion/tombstone revisions each have their own revision identifier under the one logical object;
a tombstone never reuses the key of the revision it supersedes.
For a public replicated revision, it MUST NOT contain a relay ID, source peer ID, endpoint, crawl
generation, subscription, cursor, arrival time, or source position. The same revision learned from
two relays or replayed through a later crawl generation therefore has one key.

**Private deliveries (Decision #203).** A recipient-private canonical object is exactly one
delivery with exactly one revision. Its `LogicalObjectKey` authority is the recipient destination
(the account address, see the assumption below), and its object identifier is the
recipient-specific opaque `DeliveryId`. Consistent with CBOR section 6, the message id, type-8
revision, and content digest live inside encrypted content, and each recipient receives different
bytes. Therefore:

- there is no plaintext predecessor field, chain id, or edit relation on any relay-visible record,
  and an edit of a private message is a second, unrelated delivery with its own `DeliveryId`;
- edit linkage exists only in the decrypted `LocalProjection`;
- while locked, logical-object output for a private delivery is a `locked-opaque` item carrying no
  relation to any other item; and
- neither key nor public metadata may expose a plaintext content hash, cross-recipient logical
  message ID, or other identity that lets a relay correlate deliveries. A relay-visible pseudonymous
  chain id may be added later as a new optional field; removing one later would be much harder.

**Assumption needing owner confirmation (Decision #206).** The destination in the private key is the
recipient's account address. Key rotation (CBOR type-7 transitions) is assumed not to change the
account address, so rotation does not split a chain or a private key. If a transition does change
the destination account, this must be revisited (an alias map is the recorded fallback).

### Canonical source bytes

"Canonical source bytes" means the **complete FRNK frame** (CBOR F6: the whole frame including its
nine-byte header) of the identity-bearing object type that the owning protocol names for that
revision, exactly as received, without decode/re-encode normalization. A wrapper around that object
(for example a type-2 signature wrapper around a type-4 statement) is observation provenance, not
revision identity: extra, stripped, or reordered signature entries change the wrapper but not the
revision, exactly as CBOR section 6 keys directory records on the opened type-4 statement. An
unknown type, or a frame whose minimum reader version is unsupported, is retained only as an
observation of opaque bytes (CBOR E3, and T1: no content hash is defined for an unknown type) and
MUST NOT become a `CanonicalRevision`.

### `CanonicalRevision`

A canonical revision is keyed by `CanonicalRevisionKey` and stores immutable source material. Its
commitment MUST be domain separated and commit to all of:

1. the complete typed `CanonicalRevisionKey`;
2. every immutable authenticated fact required to validate the revision;
3. the canonical source bytes defined above; and
4. the complete intrinsic deterministic event-order tuple defined by the owning protocol.

The revision commitment MUST exclude source/relay identity, endpoint, crawl or subscription scope,
generation, source cursor or position, arrival time, retry count, peer trust, transport headers,
validation cache state, decryption state, presentation state, and every other node-local field.

The exact serialization and digest algorithm are intentionally unspecified. #130 owns canonical
commitment bytes; #67 and #113 own identifier and network byte forms. Until those decisions land,
implementations and fixtures MUST carry the commitment input as typed fields and opaque exact bytes,
not invent a concatenation.

### `Observation`

An observation is a separately keyed edge saying where a node encountered a revision. Its
`ObservationKey` is the tuple `(SourceInstanceId, SourceScope, SourceGeneration, SourcePosition)`.
`SourceScope` is a tagged value (for example a public stream or recipient mailbox scope), and
`SourceGeneration` is a typed opaque generation under that scope. None of these fields enters public
revision identity.

**Difference from the #177 contract.** The accepted solution contract on #177 defines the
`ObservationKey` as including the canonical revision key. This model deliberately excludes it: the
key is only where the source said the occurrence is, and the revision it points to is a committed
attribute. Otherwise a source that re-points one position at a different revision would create a
second, apparently unrelated key instead of a detectable same-key conflict. The revision key and
commitment are still bound by the observation commitment, so nothing the contract wanted to bind is
lost. This is a stated deviation for maintainer sign-off.

The observation commitment is independently domain separated from the revision commitment and binds
**only**:

1. the complete `ObservationKey`;
2. the referenced `CanonicalRevisionKey` and revision commitment; and
3. the source-authenticated position/order assertion the source made for that occurrence.

Peer path, page, relay receipt, local validation status, receipt time, retry counters, health
scores, and quarantine administration are **non-committed local metadata**: they are stored beside
the observation, never enter its commitment, and never decide retry equality. Retry equality is
judged on the observation commitment. Exact serialization remains owned by #130.

**Batch trust.** An item's key source, scope, and generation MUST equal the authenticated batch's.
Otherwise the batch is rejected and nothing is persisted under that key (or any other item of the
batch, including the cursor); a source cannot write evidence under another source's identity.

### `LocalProjection`

A local projection is a replaceable row keyed independently from the canonical revision. Its key
includes the revision key, projection kind, and local viewer/security context needed to prevent one
recipient's state from overwriting another's. It may contain decryption status, decrypted
application material, validation caches, UI state, the decrypted edit relation between private
deliveries, or a locally recovered logical-message mapping.

Changing a projection from `locked` to `decrypted` MUST NOT rewrite the revision, its commitment, an
observation, or a source cursor. Projections are reconstructible conveniences unless their owning
feature explicitly defines otherwise; they are never replicated as canonical facts.

## Ingest and conflict semantics

An ingest batch belongs to exactly one authenticated `SourceInstanceId`, typed `SourceScope`, and
`SourceGeneration`, and advances at most that source cursor. Generation authorization is owned by
the owning protocol: an observation from a generation the protocol does not authorize is
quarantined, not output-eligible. In one atomic transaction the node MUST persist, as applicable:

- a new canonical revision or a revision-conflict variant;
- a new observation or a quarantined observation variant; and
- the resulting source cursor.

A crash MUST expose either the whole transaction or none of it. If any item fails (invalid key, limit,
write failure), the whole batch including its cursor rolls back.

**Cursors.** A cursor is monotonic per `(source, scope, generation)`, advances only atomically with
the batch, and names only a position that has a durable observation row or a durable quarantine row.
A batch that rejects wholesale leaves the cursor where it was.

An identical retry, judged on commitments (revision commitment; observation commitment) with the
same keys, is idempotent: it creates no new row, conflict, quarantine row, or output.

### Revision conflicts and ambiguity (Decisions #201, #202)

If an existing `CanonicalRevisionKey` is presented with different source bytes, immutable
authenticated facts, order tuple, or commitment, the outcome depends on authentication:

- **The variant authenticates under the owning protocol.** Two authenticated variants of one key are
  equivocation. Preserve both as revision-conflict evidence, mark the key ambiguous, and suppress
  it from canonical revision output and logical-object reduction. The ambiguity marker is durable:
  eviction of variant bytes MUST NOT clear it. Any edit whose predecessor key is ambiguous is
  withheld from output and reported as blocked, not silently dropped.
- **The variant fails owning-protocol validation.** It is an invalid observation quarantined on its
  source. It never creates an ambiguity marker, so one hostile relay cannot hide a real revision.

No arrival-order or relay-preference rule may select a variant. There is no convergence mechanism
now: output is a deterministic function of the evidence a node holds, and it is independent of
arrival order. Nodes holding different evidence may differ; an evidence-exchange rule is a possible
later follow-up and nothing here blocks it.

### Observation conflicts (Decision #204)

If an existing `ObservationKey` (already matched against the authenticated batch identity) is
presented with a different commitment, for example the same position asserted for a different
revision or a changed source-authenticated order fact, the node stores the new one as a separate
**quarantined variant**. The first valid row stays valid and the key is **not** ambiguous. A
revision reachable only through a quarantined observation is not output-eligible; it becomes
eligible through any independent valid observation. A durable quarantine row lets the cursor
name that position, but the cursor never moves backward and stays at the last recorded position
when the variant shares the position of the valid row.

## Output and reduction

The canonical revision view emits an unambiguous, output-eligible `CanonicalRevisionKey` at most
once, regardless of how many observations point to it. It positions revisions only by
`(IntrinsicOrderTuple, CanonicalRevisionKey)`. The tuple is compared element-wise as typed unsigned
values (a value of a different type never compares equal); ties are broken by the bytewise canonical
key bytes, whose byte encoding is owned by the migration ticket #130. This mirrors CBOR S5/S6:
numeric fields first, then bytewise bytes; unlike S5, equal tuples are legal here and tie-broken
(as S6's `fact_id` tiebreaker) because the key is unique. It MUST NOT use observation arrival, relay
identity, source position, cursor, generation, or local decryption time.

The intrinsic tuple is supplied and validated under the owning protocol's rules. Fan-in does not
derive it from a wall clock. A protocol that cannot yet supply its final tuple must keep the tuple
typed/opaque and is not entitled to substitute observation order.

Logical-object output groups canonical revisions by `LogicalObjectKey` and calls that object's owning
protocol reducer. The reducer owns predecessor validity, create/edit/delete rules, authorization,
fork behavior, and any deterministic conflict result. Generic fan-in MUST NOT choose an edit winner,
apply last-arrival-wins, or silently linearize conflicting revisions. If no reducer is available,
revision output remains usable while logical-object output is explicitly unavailable. Private
deliveries have no relay-visible reducer; their output is `locked-opaque` items until a local
projection is decrypted.

**Consumers.** Value-bearing consumers (payouts, pots) MUST read only the reduced canonical view,
never observation counts or the number of relays that saw a revision. If a revision already emitted
is later found ambiguous (a second authenticated variant arrives), the view emits a retraction for
it and for every revision withheld as blocked behind it; consumers MUST treat emission as
provisional unless the owning protocol defines finality, and reversing an external effect is that
protocol's responsibility.

## Restart and projection transitions

After restart, a node reconstructs views exclusively from committed revision rows, observation rows,
conflict/quarantine rows, projections, and per-source cursors. It MUST NOT depend on an in-memory seen
set, delivery order, transport replay timing, or an uncommitted high-water mark. A restart from a
conflicted or quarantined state reproduces the same output, and replaying an identical batch uses the
same rules as first ingest.

A locked-to-decrypted transition replaces only the matching local projection. It may reveal an edit
relation between two private deliveries to the local recipient, but it does not emit another
canonical revision and does not alter canonical ordering.

## Field ownership and commitment boundary

| Field or decision                                                           | Owner                                             | Revision commitment                 | Observation commitment           |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- | -------------------------------- |
| Typed logical-object and revision key fields (authority, `NetworkTag`, ids) | owning application protocol; byte form #67/#113   | include                             | include by reference             |
| Private destination (account address), `DeliveryId`                         | delivery protocol; applicable byte forms #67/#113 | include                             | include by reference             |
| Immutable authenticated facts                                               | owning application protocol                       | include                             | only through revision commitment |
| Canonical source bytes (complete identity-bearing FRNK frame)               | protocol decoder/canonicalization work #130       | include exactly                     | only through revision commitment |
| Intrinsic deterministic order tuple                                         | owning application protocol, integrated by #59    | include                             | exclude                          |
| Source instance, typed scope/generation, source position                    | journal/federation source (#111/#134)             | exclude                             | include                          |
| Source-authenticated position/order assertion                               | journal/federation source (#111/#134)             | exclude                             | include                          |
| Peer path, page, relay receipt, local validation status                     | local ingest (#59/#134)                           | exclude                             | exclude (local metadata)         |
| Cursor, arrival time, retries, peer health                                  | local ingest (#59/#134)                           | exclude                             | exclude                          |
| Locked/decrypted/UI/cache state, private edit relation                      | local projection owner (#59)                      | exclude                             | exclude                          |
| Hash/serialization algorithm and domain tags, key-byte tie-break            | #130                                              | owns encoding                       | owns encoding                    |
| Generation authorization                                                    | owning protocol                                   | exclude                             | exclude                          |
| Logical conflict resolution                                                 | owning protocol reducer                           | result is not recommitted by fan-in | exclude                          |

One fact has one authoritative home: revision facts in `CanonicalRevision`, source occurrence facts in
`Observation`, local mutable facts in `LocalProjection`, and replay progress in `SourceCursor`.
Indexes and materialized views MUST declare which authoritative rows derive them.

## Resource and abuse limits

An implementation MUST configure and enforce finite limits before allocating or committing:

- canonical source bytes per revision, authenticated facts, order-tuple fields, key component bytes,
  provenance bytes, and observation bytes;
- items and total bytes per atomic source batch;
- observations per revision and observations per source;
- generations and cursors per `(source, scope)`;
- ambiguity markers and quarantine rows (per source and in total);
- retained conflicting variants and total evidence bytes per revision and observation key;
- revisions per logical object and the pending-predecessor buffer (edits waiting for a predecessor);
- concurrent batches per source and total outstanding validation work; and
- projection bytes and reducer work per logical object.

Limits MUST be measured on the exact accepted bytes, not only decoded objects. Input over a quota is
rejected as a whole batch and that source's cursor is held: it never becomes canonical output, and
the node MUST NOT evict an ambiguity marker to make room (variant bytes may be evicted, markers may
not). Before rejecting, a node MAY durably record a bounded quarantine row (key, commitment, reason,
and a bounded byte sample or digest) so the rejection is distinguishable from absence, but only if
the quarantine quota has room; otherwise it holds the cursor. Backpressure MUST precede dropping an
accepted atomic batch.

## Fixture obligations

The fixture manifest is normative for state transitions. Every fixture supplies initial persisted
rows, one ingest or local transition, expected persisted rows/conflicts/cursors, canonical revision
output, and logical-object output when a reducer applies. It covers:

- `generation-replay`: replay of one revision from `G1` into `G2`;
- `two-relay-public`: public `E1` observed from `R1` and `R2`;
- `authority-namespace-key`: the same ids under a different authority are a different key;
- `public-post-edit`: public post `E1` creation plus its edit;
- `tombstone-identity`: a tombstone has its own revision key under the same logical object;
- `private-create-edit`: two private deliveries with distinct ids and no plaintext predecessor;
- `revision-key-changed-bytes`: an authenticated variant under one revision key suppresses it;
- `unauthenticated-variant-quarantined`: a variant failing owning-protocol validation suppresses
  nothing;
- `retract-on-late-ambiguity`: an emitted revision, and its dependent edit, retracted;
- `observation-key-changed-body`: same observation key, one changed fact, quarantined variant;
- `batch-key-mismatch-rejected`: an item key not equal to the batch identity;
- `crash-atomicity-batch-rollback`: second item fails, whole batch and cursor roll back;
- `locked-to-decrypted`: a projection-only transition revealing the local edit relation;
- `restart-from-durable-state`: restart and retry from persisted rows/cursors only; and
- `restart-from-quarantined-state`: restart from a conflicted/quarantined state.

Symbolic values such as `frame:post:E1:v1`, `commit:revision:E1:v1`, and `opaque:delivery:P1` make each
case readable without a protocol decoder. They assert equality and inequality only, not byte
encoding. A fixture runner is a follow-up; the manifest is checked by an ad hoc script until then.

## Delivery map

- [#59](https://github.com/schancel/frank/issues/59) consumes this model for the unified multichain
  fan-in view, atomic ingest, ordering, projection boundary, and protocol-reducer dispatch.
- [#67](https://github.com/schancel/frank/issues/67) owns its applicable network-qualified
  identifier/address byte decisions; their values stay opaque here.
- [#111](https://github.com/schancel/frank/issues/111) supplies validated Monad journal events and
  their intrinsic/source order facts; it must not promote relay position into canonical identity.
- [#113](https://github.com/schancel/frank/issues/113) owns its applicable logical/delivery
  identifier byte decisions; this model requires the resulting private identifier to remain
  recipient-specific without prescribing its derivation.
- [#130](https://github.com/schancel/frank/issues/130) owns exact canonical bytes, domain separation,
  commitment serialization/digest choices, and the key-byte tie-break encoding.
- [#134](https://github.com/schancel/frank/issues/134) owns durable mailbox replay/cursor behavior and
  must use the atomic/quarantine boundary above.

This prerequisite does not implement or authorize any of those tickets. In particular it creates no
route, schema, protobuf, migration, generated output, or production reducer.

## Decisions

- [#201](https://github.com/schancel/frank/issues/201): a revision is suppressed as ambiguous only
  by an authenticated variant; an unauthenticated variant is a quarantined observation.
- [#202](https://github.com/schancel/frank/issues/202): no convergence mechanism for ambiguity
  evidence yet; output is a deterministic function of held evidence.
- [#203](https://github.com/schancel/frank/issues/203): private edits are local decrypted relations,
  not relay-visible chains.
- [#204](https://github.com/schancel/frank/issues/204): a conflicting observation is a quarantined
  inert variant; the first valid row stands.
- [#205](https://github.com/schancel/frank/issues/205): authority and `NetworkTag` are part of the
  public revision key.
- [#206](https://github.com/schancel/frank/issues/206): the private destination is the account
  address and rotation does not split chains (assumption pending owner confirmation).

## #177 acceptance criteria

| Criterion                                                                                                   | Where met                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Normative keys and commitments for events and observation edges, relay-independent versus provenance fields | `CanonicalRevisionKey`, `CanonicalRevision`, `Observation`, field ownership table                |
| Mailbox/private and public identity rules differ                                                            | private deliveries under `CanonicalRevisionKey`; `private-create-edit`                           |
| One-output projection across relays or generations, with canonical position                                 | Output and reduction; `generation-replay`, `two-relay-public`                                    |
| Strict per-source ordering, atomic cursor, no cross-source replay authority                                 | Ingest (Cursors); `crash-atomicity-batch-rollback`                                               |
| Revision identity keeps logical id, no event-identity reuse                                                 | `CanonicalRevisionKey`; `public-post-edit`, `tombstone-identity`                                 |
| Retry versus equivocation for revision rows and observation edges separately                                | Revision conflicts; Observation conflicts; changed-bytes and changed-body fixtures               |
| Fixtures: G1 to G2, R1 and R2, post plus edit, changed bytes, changed observation, locked to decrypted      | fixture list above                                                                               |
| Checkpoint reconstruction after restart from persisted records                                              | Restart; `restart-from-durable-state`, `restart-from-quarantined-state`                          |
| Map to #59 and the #111/#113/#134 boundaries                                                                | Delivery map                                                                                     |
| Maintainer sign-off before production work                                                                  | Not met; required. Also needed: sign-off on the ObservationKey deviation and the #206 assumption |
