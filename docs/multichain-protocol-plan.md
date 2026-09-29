# Simultaneous multichain protocol plan

Status: architecture decision for issue #59. This document defines public-format, routing, and
client fan-in boundaries; it does not implement them. The canonical HTTP shape is the decision in
[#169](https://github.com/schancel/frank/issues/169):
`/{chain-family}/v1/{profiles,mailbox,pubsub}/...`.

## Scope and invariants

Frank must be able to admit a message with a stamp on one chain while its encrypted entries refer
to assets or settlement on other chains. It must also be able to show events from more than one
chain at the same time. These requirements do not make unlike chain transactions interchangeable.

The following facts have independent owners and must be represented independently:

1. **Stamp network**: the `NetworkTag` whose adapter validates the mandatory admission payment or
   burn.
2. **Content-reference network**: the `NetworkTag` on each encrypted entry that refers to a chain,
   account, asset, contract, or outpoint. A text-only entry need not have one.
3. **Settlement network**: the `NetworkTag` on each settlement leg. One negotiation can have more
   than one leg, including two legs on different networks.

Equality of two tags in one message does not merge their roles. No role is inferred from another,
from the HTTP prefix, or from the adapter that happened to deliver the envelope. `NetworkTag` is
the canonical registered chain-and-network discriminator (`MONT`, `MON1`, and reserved `LTUS` are
the current examples); a URL names a chain-family router, not a mainnet/testnet variant.

The public format must use a discriminated chain-specific reference for transaction evidence. An
EVM reference can contain a transaction hash, contract address, and log index; a Lotus/UTXO
reference can contain a transaction id and output index. There is no `bytes transaction` escape
hatch and no generic transaction blob. Each adapter remains responsible for decoding and
validating its native shape.

This plan deliberately does not restore the Lotus daemon or indexer, implement an atomic swap,
standardize a DEX/game/purchase plugin, change issue #60's private-mailbox work, or change any
production route, protobuf, generated binding, configuration, database, or runtime code.

## Composite fixture: Lotus admission, Monad content and settlement

The following is a design fixture, not a proposed JSON wire encoding. Names describe the required
typed fields that a later schema ticket must encode with explicit variants.

```yaml
message_id: "msg_01J7ZQ5N6K4B2P8T0R3V9W1XCY" # stable logical protocol ID
encrypted_payload_digest: "sha256:7e..."        # content digest, not message identity
stamp:
  network_tag: "LTUS"                 # role 1: admission only
  proof:
    lotus_utxo:
      txid: "5a..."
      output_index: 2
      commitment: "sha256:7e..."      # binds the exact encrypted payload digest
entries:
  - entry_id: "terms-1"
    kind: "encrypted-protocol-content"
    reference:
      network_tag: "MONT"             # role 2: referenced asset/network
      asset:
        evm:
          asset_id: "native"
    ciphertext: "base64:..."
  - entry_id: "settlement-observation-1"
    kind: "encrypted-settlement-reference"
    settlement:
      network_tag: "MONT"             # role 3: execution/observation network
      evidence:
        evm:
          transaction_hash: "0x91..."
          contract_address: "0x42..."
          log_index: 3
    ciphertext: "base64:..."
```

The `NetworkTag` registry is the only authority for the native EVM chain ID, so the EVM variants do
not repeat it. A later typed implementation derives the chain ID from `MONT`; a chain response with
a different chain ID is a network-mismatch error, not an alternate interpretation of the entry.

The relay uses the `LTUS` tag and the `lotus_utxo` variant to validate admission. It does not
interpret the encrypted Monad entries and must not claim that the asset exists or settlement
occurred. After decryption, a cooperating client uses each entry's `MONT` tag to select the Monad
adapter and then requires the `evm` reference variant. A future two-leg swap can add a separately
tagged Lotus settlement leg; it must not reuse `stamp.network_tag` implicitly even when both values
are `LTUS`.

This fixture proves the durable hole needed by a known future atomic-swap negotiation without
building the swap protocol. The later schema must preserve unknown entry kinds as opaque encrypted
content where the existing envelope rules allow that, but an unknown transaction-evidence variant
cannot be treated as verified.

`message_id` is the stable logical identifier specified by the protocol; it is not recomputed from
serialization bytes. `encrypted_payload_digest` is commitment material and may back a secondary
integrity or legacy-lookup index, but it is never the canonical message identity.

## Provenance and authority

There are three different claims around an event:

| Claim | Authoritative source | What it proves | What it does not prove |
| --- | --- | --- | --- |
| Stamp validation | relay plus the selected chain adapter | the chain-specific admission proof satisfied the relay's declared policy and binds the envelope | authorship of encrypted content or settlement of a referenced trade |
| Relay origin | relay-authored, authenticated storage/delivery record | that this relay validated and stored or delivered an event under a particular `NetworkTag`, route version, and local source position | that content-authored chain references are true, or that another relay observed the event |
| Content reference | encrypted content author, authenticated only by the end-to-end content mechanism after decryption | what the sender asserted or proposed to the recipient | relay provenance, chain finality, asset ownership, or successful settlement |

A relay-origin tag is never copied from decrypted content. A content tag remains untrusted protocol
input until the selected adapter validates the referenced fact. A route prefix selects the family
of validators and native wire decoder; for visible outer or stamp records, the handler must reject
a supported request whose authenticated `NetworkTag` belongs to another family or unsupported
network. Encrypted per-entry tags are checked only after decryption. The prefix itself is not stored
as provenance.

If the same logical content is learned from two relays, both relay observations remain attributable.
Presentation may collapse them by content digest, but it must retain the set of origin records and
must not rewrite one relay's assertion as another's.

## Canonical routes and migration

One `cashwebd` binary may mount all three canonical namespaces below. They remain separate route
groups and storage facades: profiles are publicly fetchable relay-local records, mailbox data is
private retained delivery state, and pubsub is public replicated state. Enabling one group must not
implicitly enable another group or give federation code access to mailbox storage.

Canonical v1 resources are frozen as follows:

- `/monad/v1/profiles`, `/monad/v1/profiles/:address`,
  `/monad/v1/profiles/search`, and `/monad/v1/profiles/curated-defaults`;
- `PUT /monad/v1/mailbox/messages` for submission;
- `POST /monad/v1/mailbox/auth/:account_address` for a bounded authentication challenge;
- `GET /monad/v1/mailbox/inbox/:account_address`,
  `GET /monad/v1/mailbox/outbox/:account_address`, and
  `GET /monad/v1/mailbox/recovery/:account_address` for authenticated views;
- `GET /monad/v1/mailbox/sync/:account_address?cursor=...` for authoritative catch-up;
- `POST /monad/v1/mailbox/import/:account_address/quote` and
  `POST /monad/v1/mailbox/import/:account_address/batch` for an authenticated import quote and
  its authorized batch import; and
- `/monad/v1/pubsub/posts`, `/monad/v1/pubsub/posts/:post_id`,
  `/monad/v1/pubsub/votes`, and `/monad/v1/pubsub/topics`.

Canonical pubsub references use the stable logical post/message IDs owned by #113, #130, and #67;
they do not use a serialization or payload hash as identity. A payload digest remains useful for
integrity, presentation deduplication, and a bounded legacy secondary index only.
That index stores the matching logical ID set without overwriting collisions; the legacy lookup
succeeds only when the exact digest resolves unambiguously, while canonical lookup always uses the
logical ID.

The canonical mailbox group depends on #60's authenticated private-mailbox contract.
The durable account is `(NetworkTag, address_type, canonical_address_bytes)`; `account_address` is
only that account's canonical route encoding, parsed at the edge in the request's authenticated
`NetworkTag` context. The address is derived from and controlled by the one registered destination
public key. Pending #60's canonical recipient-address and registered-key verification is
authoritative. There is no separately issued mailbox ID, mailbox-encryption key, or stamp-payment
key; mailbox addressing, read authority, and recipient stamp derivation remain roles of that one
registered destination key.

`inbox` is recipient-retained content; `outbox` includes the sender's authoritative self-sent bytes
and delivery state; `recovery` exposes authenticated recovery facts, not secret material. A quote
does not mutate the mailbox. A batch import consumes a bound authorization and emits ordinary
journal events; it does not create an import-only replay stream.

`sync` is the only authoritative mailbox catch-up cursor. It multiplexes inbox arrivals, outbox and
delivery transitions, recovery changes, imports, and tombstones in one mailbox-scoped ordered
journal. The three view routes may use bounded snapshot-page tokens, but those tokens are not replay
cursors and cannot advance the `sync` checkpoint. A notification channel may wake a client with a
newest-cursor hint, but cannot replace `sync` or invent a competing cursor. Authentication and the
cursor both bind the exact network-qualified `account_address`.

### Current-to-target matrix

| Current route on the pinned base | Current purpose | Canonical target | Compatibility action |
| --- | --- | --- | --- |
| `PUT/GET /metadata/monad/:addr` | write/read one Monad profile | `PUT/GET /monad/v1/profiles/:address` | bounded alias preserving current request and response bytes |
| `PUT/GET /metadata/:addr` when `:addr` is Monad-form | conditional Monad dispatch through the nominal Lotus route | `PUT/GET /monad/v1/profiles/:address` | bounded conditional alias; remove only the Monad dispatch branch after its callers move |
| `PUT/GET /metadata/:addr` when `:addr` is Lotus-form | legacy Lotus metadata | future `/lotus/v1/profiles/:address` after separate Lotus-runtime design | preserve Lotus behavior; it is not part of Monad alias deletion |
| `GET /metadata/monad?since=...` | global profile registration discovery | `GET /monad/v1/profiles?cursor=...` | compatibility handler retains `since` semantics; no fabricated conversion to an opaque cursor |
| `GET /metadata/monad/search` | profile-name search | `GET /monad/v1/profiles/search` | bounded alias |
| `GET /metadata/monad/curated-defaults` | operator-curated contacts | `GET /monad/v1/profiles/curated-defaults` | bounded alias |
| `PUT /message/monad` | submit a stamped private message to the current relay | `PUT /monad/v1/mailbox/messages` | alias only for #60 recipient admission; it never authors authoritative sender-outbox state, which requires #89's authenticated client-to-home flow |
| `GET /message/monad/:payload_hash` | unauthenticated retained-message lookup | authenticated `inbox`, `outbox`, or `recovery` view | removed security surface after #60; no alias and no canonical public hash lookup |
| `GET /message/monad?since=...` | unauthenticated global timestamp feed | authenticated `GET /monad/v1/mailbox/sync/:account_address?cursor=...` | removed security surface after #60; no alias and no timestamp-cursor translation |
| #60 private inbox/recovery/auth routes | authenticated private reads on reviewed legacy prefixes | canonical auth, inbox, recovery, and sync routes above | bounded aliases using identical authorization and opaque-cursor scope; never weaken auth while forwarding |
| no current route | authenticated sender outbox/self-sent view | `GET /monad/v1/mailbox/outbox/:account_address` | canonical only; #60/#89 state is a prerequisite |
| no current route | mailbox migration quote and authorized import | canonical `POST .../import/:account_address/{quote,batch}` routes above | canonical only; depends on accepted #65/#89 import authority and #135 encoding |
| `PUT/GET /message/monad/topics` | submit/list topic posts | `PUT/GET /monad/v1/pubsub/posts` | bounded alias |
| `GET /message/monad/topics/:payload_hash` | fetch one topic post through the legacy digest index | `GET /monad/v1/pubsub/posts/:post_id` | bounded alias resolves the exact legacy digest to one stable logical `post_id`; canonical links and responses use `post_id` |
| `PUT /message/monad/topics/vote` | submit a topic vote | `PUT /monad/v1/pubsub/votes` | bounded alias |
| `GET /message/monad/topics/discover` | discover topics | `GET /monad/v1/pubsub/topics` | bounded alias |
| `/message`, `/message/:payload_hash`, `/messages...` | legacy Lotus message shapes | future `/lotus/v1/...` only after a separate Lotus-runtime design | no Monad redirect or body conversion; preserve isolated Lotus behavior |

An alias preserves the old method, body, status, response shape, authentication, and authorization
while invoking the same typed operation as the canonical handler. It does not translate a Lotus
transaction into an EVM transaction, treat `since + 1` as a cursor, or expose mailbox data through
pubsub. In particular, routing legacy `PUT /message/monad` through a canonical handler cannot
manufacture a sender outbox: until #89 lands, only recipient admission semantics are available.

### Alias ownership, removal, and rollback

The route-migration follow-up owns all Monad aliases as one inventory. Its accountable owner is
`@schancel`. The current endpoints are experimental and have no external-customer compatibility
promise, so the migration does not invent a release-count or telemetry waiting period.

Aliases may be removed only when all of these are true:

1. every in-repository Rust/TypeScript client, app, bot, and live check uses canonical routes;
2. one live integration run proves submission, authenticated inbox/outbox/recovery, sync replay,
   and pubsub/profile behavior through canonical routes; and
3. repository search plus route tests prove no supported in-repository caller uses the alias.

The global unauthenticated private-message feed and private-message payload-hash lookup are
different: #60 removes them as security surfaces before canonical mailbox routing, so no migration
stage retains or reintroduces them. That prohibition does not convert the existing public topic
digest lookup into canonical identity: it remains only a bounded pubsub alias and secondary index
until caller cutover. Tests require `404` for the removed private legacy reads and `401` for an
unauthenticated canonical private read. Alias-deletion proof for `/metadata/:addr` is
address-family-specific: a Monad-form request no longer dispatches to Monad, while a valid
Lotus-form request still reaches the legacy Lotus handler. The route itself does not become a
blanket `404`.

Rollback before alias deletion disables the canonical router and moves in-repository callers back
to the still-reviewed aliases. Mailbox rollback returns to #60's authenticated private routes; it
never restores either unauthenticated GET. After alias deletion, rollback re-enables only the exact
non-security alias inventory and rolls callers back. No rollback rewrites stored records. A route
migration that needs a database or wire rollback must stop and receive a new contract because that
contradicts this plan.

## Runtime adapter fan-in

`ActiveChain` remains useful as the per-chain facade, but the application composition root must no
longer select exactly one instance. A `MultichainEventView` owns a configured set of adapters and
depends only on their public profile/mailbox/pubsub interfaces. Adapters own chain-native parsing,
validation, addresses, amounts, transaction references, and cursors. They do not import the merge
view or another adapter.

Each adapter separates globally deduplicated immutable source content, durable stream observations,
and local projections:

```text
ImmutableSourceEvent {
  event_key: (source_network_tag, stream_kind, source_instance_id, source_event_id)
  authenticated_event_origin: immutable source-authenticated facts intrinsic to the event
  canonical_source_bytes: exact opaque encrypted/native source bytes
  content_commitment: domain-separated digest of the fields above
}

StreamObservation {
  stream_scope: (source_network_tag, stream_kind, source_instance_id,
                 authorization_scope)
  event_key: reference to ImmutableSourceEvent
  source_order: (source_order_key, source_event_id)
  observation_key: (stream_scope, event_key)
  observation_order_key: (stream_scope, source_order, event_key)
  ordering_time: { seconds: int64 represented as bigint, nanos: uint32 }
  authenticated_stream_facts: immutable facts about this occurrence in this stream
  observation_commitment: domain-separated digest of this edge and its content commitment
}

LocalEventProjection {
  event_key
  decrypted_entries
  chain_specific_decoded_view
  fetched_at
  discovered_at
  render_metadata
}
```

`source_instance_id` is an authenticated relay node/source identity, not a configured URL or local
adapter name. `canonical_source_bytes` retains the chain-specific discriminated source format; it
is not a generic transaction. Decryption, parsing, contact resolution, fetch time, discovery time,
relative time, and rendering are replaceable local projections. Fetching an event while locked and
decrypting it later changes only the `LocalEventProjection` pointing to `event_key`; the immutable
content and every observation key, commitment, source order, and canonical merge position remain
identical.

`ordering_time` is mandatory, immutable, authenticated by or deterministically derived from the
source record, and always committed. Seconds are a checked signed `int64`; nanoseconds are an
unsigned `uint32` restricted to `0..999_999_999`, consistent with #106/#133. JavaScript represents
seconds as `bigint`, never a `number` millisecond count. Mutable fetch, discovery, receipt, or render
times are local projection data and never participate in canonical ordering.

An adapter whose source has no immutable wall-clock time must define a reviewed deterministic
fallback from immutable source order. It first maps the full source-order domain injectively to a
nonnegative integer rank `r`, then computes integer `seconds = r / 1_000_000_000` and
`nanos = r % 1_000_000_000`. The conversion is checked: `seconds` must be at most `INT64_MAX` and
`nanos` at most `999_999_999`, so the greatest accepted rank is
`INT64_MAX * 1_000_000_000 + 999_999_999`; the next rank rejects as overflow. Compound chain
positions require an adapter-specified checked injective ranking with a frozen domain and bounds.
Negative ranks, lossy truncation, wrapping, and saturation reject. If no immutable time or checked
deterministic source-order rank is accepted, the adapter rejects the event rather than using
arrival or fetch time. Boundary fixtures require the maximum rank to produce
`(INT64_MAX,999_999_999)` and maximum-plus-one to reject before event persistence or cursor advance.

`content_commitment` is a domain-separated digest (for example,
`frank:immutable-source-event:v1`) over one canonical encoding of only the full four-part
`event_key`, immutable authenticated event-origin facts, and exact `canonical_source_bytes`. It
does not include subscription generation, mailbox account, source order, or observation time, so
one immutable pubsub event observed in two authorized generations is stored once rather than
misdiagnosed as a content collision.

`observation_key` is the exact retry/collision key. `observation_order_key` is its unique durable
source-order index: it binds the full stream scope to source event identity and strict order while
still allowing an altered order under the same exact observation key to be detected rather than
silently inserted as another occurrence. `observation_commitment` uses a different domain (for
example, `frank:stream-observation:v1`) and covers the complete canonical `observation_key`
(therefore the complete authorization scope), `observation_order_key`, the referenced `event_key`
and `content_commitment`, immutable `ordering_time`, and immutable authenticated stream facts. Both
digests exclude themselves and every decrypted, decoded, UI, fetch, discovery, and render projection.
Their normalized schemas and vectors land with F4 after #131 freezes canonical encoding. The
event, observation edge, both commitments, and cursor persist atomically and cannot be
reconstructed from a lossy projection.

Each authoritative source stream is scoped by `(NetworkTag, stream_kind, source_instance_id,
authorization_scope)`. Within that complete scope, `(source_order_key, source_event_id)` must be a
unique strict total order and pages must be strictly increasing by that tuple. Equal
`source_order_key` values are allowed only because immutable `source_event_id` is the required
tie-breaker. Mailbox authorization scope is the exact network-qualified `account_address`
controlled by the registered destination key; selective pubsub scope is a subscription identity
plus generation. A profile/public stream uses its declared query or global-feed scope.

`authorization_scope` is a discriminated canonical byte value, not a display label or implicit
adapter configuration. The mailbox variant encodes the durable network account, the pubsub variant
encodes subscription identity plus generation, and public-feed variants encode their accepted
query/global scope. On reload, fan-in reconstructs stream grouping, strict source order, and the
checkpoint key directly from persisted `StreamObservation` edges; it never guesses scope from an
immutable event, current UI session, or relay URL. A projection points to `event_key`, while any UI
that displays delivery or subscription provenance follows the retained observation edges.

A retained pubsub replay across subscription generations therefore has this durable shape:

```text
E1 event_key=(MONT, pubsub, relay-M, post:42) content_commitment=cE1  # stored once
O1 observation_key=(scope=(MONT,pubsub,relay-M,subscription:news:G1), E1)
   source_order=(0081,post:42) ordering_time=(1720000000,100000000)
   observation_commitment=cO1
O2 observation_key=(scope=(MONT,pubsub,relay-M,subscription:news:G2), E1)
   source_order=(0003,post:42) ordering_time=(1720000000,100000000)
   observation_commitment=cO2
```

`O1` and `O2` are distinct valid edges sharing one immutable event. Both remain attributable and
each generation advances only its own checkpoint. Their unique durable `observation_order_key` is
`(stream_scope, source_order, event_key)`; an observation's key/body scope, event, and order fields
must canonicalize to the same values before insertion.

### Two-adapter example

Assume one Lotus mailbox observation stream returns this authoritative sequence. Its equal order
keys prove the event-ID tie-breaker, and its immutable ordering time regresses:

```text
L1 event_key=(LTUS,mailbox,relay-L,lotus:0009) scope=account:LTUS:f1...
   source_order=(0009,lotus:0009) ordering_time=(1720000000,900000000)
   content_commitment=cEL1 observation_commitment=cOL1
L2 event_key=(LTUS,mailbox,relay-L,lotus:0010) scope=account:LTUS:f1...
   source_order=(0009,lotus:0010) ordering_time=(1719999999,100000000)
   content_commitment=cEL2 observation_commitment=cOL2
```

and one Monad mailbox observation stream returns:

```text
M1 event_key=(MONT,mailbox,relay-M,monad:0031) scope=account:MONT:0x31...
   source_order=(0031,monad:0031) ordering_time=(1720000000,100000000)
   content_commitment=cEM1 observation_commitment=cOM1
M2 event_key=(MONT,mailbox,relay-M,monad:0032) scope=account:MONT:0x31...
   source_order=(0032,monad:0032) ordering_time=(1720000000,300000000)
   content_commitment=cEM2 observation_commitment=cOM2
```

The deterministic canonical view is a k-way merge. Only the next unconsumed head of each source
observation stream is eligible. Among eligible observation heads, compare this tuple in order:

```text
(ordering_time, NetworkTag, stream_kind, source_instance_id, authorization_scope,
 source_order_key, source_event_id)
```

Compare `ordering_time.seconds` numerically as signed `int64`, then `ordering_time.nanos`
numerically as unsigned `uint32`. Compare only the remaining canonical byte fields bytewise.
`NetworkTag`, `stream_kind`, `source_instance_id`, `authorization_scope`, `source_order_key`, and
`source_event_id` each have a frozen canonical byte representation for this comparator; typed enum
or display forms are normalized before comparison. Encoded integer bytes are never compared
lexicographically.
Cross-language fixtures include `(-2,0) < (-1,0) < (-1,999999999) < (0,0)` so negative seconds
cannot be misordered by unsigned or encoded-byte comparison.

The result is `M1, M2, L1, L2`. `L2` can never precede `L1`, despite its regressing ordering time
and equal `source_order_key`, because it is not eligible until `L1` is consumed and its event ID is
the within-source tie-breaker. Response timing, mutable discovery time, locale, decryption state,
and JavaScript object iteration cannot affect the result.

If `relay-L` later returns the `L1` event key with altered canonical source bytes or event-origin
facts, its content commitment differs. If it returns the same observation key with altered source
order, ordering time, scope/body agreement, event binding, or authenticated stream facts, its
observation commitment differs. Either conflict preserves the prior event and edge, quarantines
the page, leaves the relay-L cursor unchanged, and marks relay-L stale/error.

This is a deterministic materialized view, not a claim of cross-chain causality. If an outage later
reveals an older source sequence, rebuilding the same immutable records produces the same k-way
order while preserving every source edge. An optional notification list may use local discovery
time, but it is not canonical event order.

State replay never uses local projection times or the cross-source canonical merge. It applies
persisted observations from each `stream_scope` in strict `(source_order_key, source_event_id)`
order and then resolves their referenced immutable events. A domain object changed by more than one
source must carry an explicit version, predecessor/causal reference, or separately specified
commutative reducer; fan-in must not manufacture state authority from timestamps.

### Identity and deduplication

`source_event_id` is defined and tested by each adapter from immutable native identity: for
example, a stable logical pubsub `post_id`, relay journal event id, or chain tuple such as
block/transaction/log position. It is not a timestamp, payload digest, display address, array
index, or cursor. An ID that is native only to an authorization scope must be
collision-disambiguated in the adapter's `source_event_id`; that adapter cannot claim cross-scope
storage sharing unless it also proves a stable event identity. The full four-part `event_key`
prevents source-local IDs from two relays or kinds from colliding.

An immutable-event retry first looks up `event_key` and compares `content_commitment`. Equality is
idempotent regardless of local locked/decrypted projection state. A different commitment under the
same event key is content equivocation or corruption: reject and quarantine the entire page,
preserve the prior event and projections, do not advance the cursor, and mark the source
stale/error.

An exact observation retry looks up `(stream_scope, event_key)` and compares
`observation_commitment`. Equality is idempotent. A pubsub replay in generation G2 has a different
scope and observation key from G1, so it validly adds a second edge to the same immutable event. By
contrast, a body supplied under an existing serialized observation key that changes or disagrees
with its scope, event binding, source order, ordering time, or authenticated stream facts is stream
equivocation or corruption: quarantine the page, preserve the prior edge and event, and do not
advance either checkpoint. Never overwrite a record or silently drop a conflict and advance.

A separate digest of decrypted content may collapse equivalent presentation projections, but it is
not exact event identity and does not alter immutable events or observation edges. All distinct
authenticated origins remain attached. If the same envelope is stamped independently on two
chains, those are two source events even when decrypted content is equal. Per-entry attribution
always comes from the decrypted entry's tag; projection deduplication never overwrites it with
`event_key.source_network_tag`.

### Checkpoints, reconnect, and partial outage

The durable fan-in checkpoint is a map keyed by `(NetworkTag, source_instance_id, stream_kind,
authorization_scope)`. The authorization scope is the network-qualified `account_address` for
mailbox sync, the subscription identity plus generation for selective pubsub, and the declared
feed/query scope for profiles or other public streams. A local `adapter_id` is not cursor authority
and is never used as a substitute for these fields. Each value is an adapter-owned opaque cursor
plus its advertised high-water mark. The cursor and server authorization are bound to the complete
key. The merge layer never decodes, compares, increments, re-scopes, or synthesizes cursors.

For each page, canonical validation, strict source-order validation, both commitment checks,
immutable-event insertion/deduplication, observation-edge insertion/deduplication, origin
attachment, and that adapter's cursor advance commit atomically. Every observation's persisted
`authorization_scope` must equal the authorized page/checkpoint scope. An existing event-key
content conflict, or an existing observation-key conflict in scope/body agreement, event binding,
order, time, or stream facts, aborts and quarantines the page before the cursor transaction. A new
scope such as pubsub G2 creates a new observation edge and does not duplicate the event. A crash
before commit replays the page; a crash after commit resumes after it. On reconnect, the adapter
resumes from its last committed cursor. If a relay reports cursor expiry or restart invalidation,
the adapter follows its declared snapshot or safe-origin replay path and relies on stable keys plus
both commitments for idempotence; it never falls back to `timestamp + 1`.

An unavailable adapter does not stop healthy adapters. Its checkpoint remains unchanged, its
source stream is marked stale with the last committed high-water mark and immutable ordering time,
and the merged view continues with an explicit partial-data status. Mutable last-fetch time may be
shown only as local status. Sends requiring the unavailable adapter fail or queue only under that
adapter's declared policy; they never fail over to another chain. When it reconnects, backlog pages
are applied atomically and the materialized k-way view updates without violating source order. The
UI clears the stale marker only after reaching the adapter's new high-water mark.

## Resource limits are not message semantics

This plan sets no 64 KiB envelope cap. Before any cap is enforced, the owning follow-up must measure
current encrypted payload sizes, existing protobuf/JSON expansion, proposed deterministic-CBOR
overhead, stamp evidence, HTTP framing, decompression, storage amplification, and catch-up page
behavior against repository fixtures and a representative retained corpus.

Limits then live in separate, explicit policy layers:

- transport: compressed and decompressed request bytes, read timeout, and concurrent bodies;
- decoding: field bytes, entry count, nesting, and chain-specific proof complexity;
- storage/abuse: per-identity or per-relay quota, retention, and admission price;
- synchronization: page bytes/event count, in-flight pages, and backpressure.

Every advertised limit is versioned server capability data with a named default and rejection
error. Changing an abuse limit must not change what a semantically valid multichain message means,
and increasing a semantic format version must not silently disable resource protection.

## Staged follow-on landings

Issue #59 owns this plan only. Decision #169 owns the route prefix decision and is complete.
`@schancel` owns unresolved product and compatibility decisions. Existing roadmap issues must
reach their stated prerequisites, and new implementation issues must be filed and accepted, before
production edits. Each row is a separate reviewed landing (or stack where stated), not hidden work
in this documentation ticket.

| Stage / owning issue | Boundary and proof | Compatibility and removal trigger |
| --- | --- | --- |
| F0 — **#131 deterministic-CBOR proof** | Freeze the language-neutral profile/framing and Rust/browser vectors before any new multichain record schema. The vectors include lossless seconds/nanoseconds and hostile canonicalization/resource cases. | No production writer changes. This is a prerequisite, not a codec implementation hidden in #59. |
| F1 — **refine #132 and #136 after #131** | In #132, define canonical-CBOR DM/message-item schemas with separate stamp, per-entry reference, and settlement roles plus discriminated EVM/UTXO references. In #136, apply the same attribution rule to topic entries that reference chains. Consistent with #113/#130/#67, public messages/posts carry stable logical IDs distinct from payload digests. Shared golden vectors include this composite fixture and reject NetworkTag/native-variant mismatch. | Preserve exact legacy bytes under their explicit legacy readers; never transcode them. Unknown supported CBOR item kinds remain opaque. No new protobuf schema or generated-binding work is prescribed here. |
| F2 — **new issue: canonical route groups and aliases** | After #60 authentication/state prerequisites, add independently mountable profiles/mailbox/pubsub routers, the complete route inventory above, route integration tests, and the bounded non-security alias inventory. Enabling durable mailbox sync/outbox/import also waits for #134 and #89 as applicable; this routing landing does not invent their records. | Canonical routes are additive. Removal is a later landing after the three alias triggers pass. The two unauthenticated legacy GETs stay removed. |
| F3 — **new issue: in-repository client route cutover** | Switch typed clients, wallet adapters, bots, frontend configuration, and live checks together; prove canonical-only client traffic against one binary with all three groups mounted and with each group disabled in turn. | Roll back clients while reviewed aliases remain. Successful live integration permits F5; there is no invented external waiting window. |
| F3a — **#134 mailbox durability predecessor** | After #131 and stable mailbox semantics, define and persist canonical mailbox immutable-event, stream-observation, and checkpoint records, including authorization scope on observations, both commitment layers, and cursor atomicity. This is the stack predecessor for any mailbox-backed fan-in adapter or durable canonical `sync`; it does not implement generic multichain merging. | Preserve exact old and new checkpoint bytes under explicit readers. A mailbox adapter in F4 cannot land ahead of this predecessor. |
| F4 — **new issue: generic multichain fan-in state and integration proof** | Introduce generic `MultichainEventView` contracts and two real adapter instances with four-part event keys, globally deduplicated immutable content, persisted committed observation edges, strict-observation-order and k-way merge tests, complete authorization-scoped checkpoints, outage/reconnect/cursor-expiry tests, and per-entry attribution checks. Fixtures prove: equal `source_order_key` is ordered by event ID; signed-second negative times order numerically; fallback rank max succeeds and max+1 rejects; observation scope reconstructs grouping/checkpoints; locked→decrypted projection preserves event and edge commitments/order; changed discovery time preserves order; pubsub G1/G2 retained replay stores one event plus two edges; event-key reuse with changed source bytes and observation-key reuse with changed scope/body, event binding, order, or ordering time quarantine without replacement or cursor advance. | The generic contract is subsystem-neutral. An actual second adapter and accepted cursor contract are required; the mailbox adapter specifically stacks on #134, while other adapters use their own durable-record owner. Adapter/runtime restoration remains separate. |
| F5 — **new issue: alias deletion** | After in-repo cutover and live proof, remove the bounded aliases. Repository scans and route tests prove old Monad routes are gone, the removed unauthenticated private reads return `404`, unauthenticated canonical reads return `401`, canonical pubsub lookup accepts logical `post_id` rather than a payload digest, Monad-form `/metadata/:addr` dispatch is gone, and Lotus-form `/metadata/:addr` still works. | Re-enable only the non-security alias inventory for rollback; never restore the global private feed or unauthenticated private-message payload-hash lookup. |
| Existing #65/#87/#88/#89/#111/#133/#134/#135 work | Federation, delivery/import, public nanosecond records, and mailbox durable records/topology consume the boundaries here but retain their own authority, storage, authentication, encoding, and replication contracts. #134 specifically owns mailbox journal/checkpoint persistence; F4 owns only generic fan-in behavior. | None may infer an entry's network from relay provenance, expose mailbox records through public federation, create a cursor outside the complete authorization scope, or let generic F4 bypass #134's mailbox record contract. |

Issue #60 remains an active, independent wallet/private-mailbox scope. This plan neither changes its
candidate nor treats it as the owner of F1–F5. Atomic-swap execution, plugin rendering/protocols,
and Lotus daemon/indexer restoration need separate accepted issues after these seams exist.

## Repository anchors and validation

This plan was checked against base `53e218b47dcd59d4826b92cb63f69b61a65de33c`:

- `packages/wallet/chain/active-chain.ts` defines the current compile-time one-chain facade and
  `packages/wallet/chain/index.ts` selects its single instance.
- `backend/cashweb/cashweb-registry/src/http/server.rs` registers the current profile, direct
  message, and topic routes listed in the matrix.
- `backend/cashweb/cashweb-registry/src/http/monad_message.rs` documents why Monad and Lotus stamp
  transactions have different native shapes.
- `backend/cashweb/cashweb-registry/proto/monad_message.proto` and
  `backend/cashweb/cashweb-registry/proto/topic_message.proto` are current legacy/new-Frank wire
  sources; the latter has a hand-kept client counterpart at
  `packages/wallet/proto/topic_message.proto`. This plan does not extend them: #130–#137 govern the
  deterministic-CBOR migration, with #131 preceding #132/#136.
- `docs/backend-topology.md` separates profile, private-mailbox, and public-pubsub ownership, while
  `docs/public-federation-plan.md` defines `NetworkTag` as protocol data and separates relay origin
  from content assertions.

Rollback of this landing is deletion of this file. It changes no runtime state, stored bytes,
public route, or public wire format.
