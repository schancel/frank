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
commitments deliberately; those labels are not candidate encodings.

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

- a typed protocol/object namespace; and
- that protocol's opaque logical object identifier.

The owning protocol defines the identifier and whether a network is intrinsic to it. Generic fan-in
MUST NOT add or remove a network qualifier to manufacture cross-network identity. An implementation
MUST reject a value whose type and object identifier disagree rather than coerce it to a string.

### `CanonicalRevisionKey`

`CanonicalRevisionKey` identifies one immutable revision. It contains the complete
`LogicalObjectKey`, a typed revision namespace, and the owning protocol's opaque revision identifier.
For a public replicated revision, it MUST NOT contain a relay ID, source peer ID, endpoint, crawl
generation, subscription, cursor, arrival time, or source position. The same revision learned from
two relays or replayed through a later crawl generation therefore has one key.

A recipient-private delivery uses a `LogicalObjectKey` variant containing a `NetworkId`, the
network-qualified opaque destination, and the recipient-specific opaque `DeliveryId`; its
`CanonicalRevisionKey` adds the opaque delivery-revision identifier. Neither key nor its public
metadata may expose a plaintext content hash, a cross-recipient logical message ID, or another
content identity that lets a relay correlate plaintext-equivalent deliveries. Any separate
application-level association learned after decryption belongs in a local projection.

`NetworkId`, public object/revision identifiers, destinations, and delivery IDs remain typed and
opaque. Their applicable byte-encoding decisions belong to #67, #113, and #130; this document does
not choose them or infer a derivation rule from a fixture label.

### `CanonicalRevision`

A canonical revision is keyed by `CanonicalRevisionKey` and stores immutable source material. Its
commitment MUST be domain separated and commit to all of:

1. the complete typed `CanonicalRevisionKey`;
2. every immutable authenticated fact required to validate the revision;
3. the exact canonical source bytes, without decode/re-encode normalization; and
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

The observation commitment is independently domain separated from the revision commitment and MUST
bind:

1. the complete `ObservationKey`, including source instance, typed scope and generation, and source
   position;
2. the referenced `CanonicalRevisionKey` and revision commitment; and
3. all source-provided provenance and order facts used to validate that occurrence.

Local receipt time, retry counters, health scores, and quarantine administration MUST NOT enter the
observation commitment. Exact observation commitment serialization remains owned by #130.

### `LocalProjection`

A local projection is a replaceable row keyed independently from the canonical revision. Its key
includes the revision key, projection kind, and local viewer/security context needed to prevent one
recipient's state from overwriting another's. It may contain decryption status, decrypted
application material, validation caches, UI state, or a locally recovered logical-message mapping.

Changing a projection from `locked` to `decrypted` MUST NOT rewrite the revision, its commitment, an
observation, or a source cursor. Projections are reconstructible conveniences unless their owning
feature explicitly defines otherwise; they are never replicated as canonical facts.

## Ingest and conflict semantics

An ingest batch belongs to exactly one `SourceInstanceId`, typed `SourceScope`, and
`SourceGeneration`, and advances at most that source cursor. In one atomic transaction the node MUST
persist, as applicable:

- a new canonical revision or a revision-conflict variant;
- a new observation or an observation-conflict variant (including quarantine state); and
- the resulting source cursor.

A crash MUST expose either the whole transaction or none of it. A cursor MUST NOT name source work
whose evidence was not durably recorded.

An identical retry—same keys, commitments, exact bytes, provenance, and order facts—is idempotent:
it creates no new row, conflict, or output. Cursor advancement itself may also be an idempotent
write.

If an existing `CanonicalRevisionKey` is presented with different exact source bytes, immutable
authenticated facts, intrinsic order tuple, or revision commitment, the node MUST:

- preserve the existing and incoming variants as revision-conflict evidence;
- mark that revision key ambiguous and suppress it from canonical revision output and logical-object
  reduction; and
- still record the source occurrence or its quarantine result and atomically settle the cursor.

No arrival-order or relay-preference rule may select a variant.

If an existing `ObservationKey` is presented with a different revision reference/commitment, typed
scope or generation representation, source-order fact, provenance fact, or observation commitment,
the node MUST preserve both variants as observation-conflict evidence and quarantine that source
occurrence. It MUST NOT reinterpret the new body under a fabricated key. A durable quarantine MAY
advance that source's cursor to prevent infinite poison replay, but the quarantined occurrence MUST
never create canonical output. A matching revision learned through an independent valid observation
remains eligible.

## Output and reduction

The canonical revision view emits an unambiguous `CanonicalRevisionKey` at most once, regardless of
how many observations point to it. It positions revisions only by
`(IntrinsicOrderTuple, CanonicalRevisionKey)`, using the key as the deterministic final tie-breaker.
It MUST NOT use observation arrival, relay identity, source position, cursor, generation, or local
decryption time as an ordering input.

The intrinsic tuple is supplied and validated under the owning protocol's rules. Fan-in does not
derive it from a wall clock. A protocol that cannot yet supply its final tuple must keep the tuple
typed/opaque and is not entitled to substitute observation order.

Logical-object output groups canonical revisions by `LogicalObjectKey` and calls that object's owning
protocol reducer. The reducer owns predecessor validity, create/edit/delete rules, authorization,
fork behavior, and any deterministic conflict result. Generic fan-in MUST NOT choose an edit winner,
apply last-arrival-wins, or silently linearize conflicting revisions. If no reducer is available,
revision output remains usable while logical-object output is explicitly unavailable.

## Restart and projection transitions

After restart, a node reconstructs views exclusively from committed revision rows, observation rows,
conflict/quarantine rows, projections, and per-source cursors. It MUST NOT depend on an in-memory seen
set, delivery order, transport replay timing, or an uncommitted high-water mark. Replaying the next
batch against those rows uses the same rules as first ingest.

A locked-to-decrypted transition replaces only the matching local projection. It may make a private
logical object visible to the local recipient, but it does not emit another canonical revision and
does not alter canonical ordering.

## Field ownership and commitment boundary

| Field or decision | Owner | Revision commitment | Observation commitment |
| --- | --- | --- | --- |
| Typed logical-object and revision key fields | owning application protocol; byte form #67/#113 | include | include by reference |
| Private `NetworkId`, destination, `DeliveryId` | delivery protocol; applicable byte forms #67/#113 | include | include by reference |
| Immutable authenticated facts | owning application protocol | include | only through revision commitment unless also source provenance |
| Exact canonical source bytes | protocol decoder/canonicalization work #130 | include exactly | only through revision commitment |
| Intrinsic deterministic order tuple | owning application protocol, integrated by #59 | include | include when asserted by source |
| Source instance, typed scope/generation, source position | journal/federation source (#111/#134) | exclude | include |
| Source provenance and source-order facts | journal/federation source (#111/#134) | exclude | include |
| Cursor, arrival time, retries, peer health | local ingest (#59/#134) | exclude | exclude |
| Locked/decrypted/UI/cache state | local projection owner (#59) | exclude | exclude |
| Hash/serialization algorithm and domain tags | #130 | owns encoding | owns encoding |
| Logical conflict resolution | owning protocol reducer | result is not recommitted by fan-in | exclude |

One fact has one authoritative home: revision facts in `CanonicalRevision`, source occurrence facts in
`Observation`, local mutable facts in `LocalProjection`, and replay progress in `SourceCursor`.
Indexes and materialized views MUST declare which authoritative rows derive them.

## Resource and abuse limits

An implementation MUST configure and enforce finite limits before allocating or committing:

- canonical source bytes per revision, authenticated facts, order-tuple fields, key component bytes,
  provenance bytes, and observation bytes;
- items and total bytes per atomic source batch;
- retained conflicting variants and total evidence bytes per revision and observation key;
- concurrent batches per source and total outstanding validation work; and
- projection bytes and reducer work per logical object.

Limits MUST be measured on the exact accepted bytes, not only decoded objects. Over-limit input is a
durable rejection or quarantine reason under the applicable source occurrence; it never becomes
canonical output. A node MAY advance a cursor past durably recorded poison input. It MUST retain
enough bounded evidence (key, commitment, reason, and an operator-configured bounded byte sample or
digest) to distinguish the rejection from absence. Eviction of full conflict variants MUST preserve
the fact that the key is ambiguous; eviction MUST NOT rehabilitate canonical output. Backpressure
MUST precede dropping an accepted atomic batch.

## Fixture obligations

The fixture manifest is normative for state transitions. Every fixture supplies initial persisted
rows, one ingest or local transition, expected persisted rows/conflicts/cursors, canonical revision
output, and logical-object output when a reducer applies. It covers:

- `generation-replay`: replay of one revision from `G1` into `G2`;
- `two-relay-public`: public `E1` observed from `R1` and `R2`;
- `private-create-edit`: recipient delivery `P1` creation plus its edit observed at `R2`;
- `revision-key-changed-bytes`: changed bytes under one revision key;
- `observation-key-changed-body`: changed scope/order/provenance under one observation key;
- `locked-to-decrypted`: a projection-only transition; and
- `restart-from-durable-state`: restart and retry from persisted rows/cursors only.

Symbolic values such as `bytes:E1:v1`, `commit:rev:E1:v1`, and `opaque:delivery:P1` make each case
readable without a protocol decoder. They assert equality and inequality only, not byte encoding.

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
  and commitment serialization/digest choices.
- [#134](https://github.com/schancel/frank/issues/134) owns durable mailbox replay/cursor behavior and
  must use the atomic/quarantine boundary above.

This prerequisite does not implement or authorize any of those tickets. In particular it creates no
route, schema, protobuf, migration, generated output, or production reducer.
