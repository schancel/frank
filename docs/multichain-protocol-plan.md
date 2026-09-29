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
envelope_id: "sha256:7e..."
stamp:
  network_tag: "LTUS"                 # role 1: admission only
  proof:
    lotus_utxo:
      txid: "5a..."
      output_index: 2
      commitment: "sha256:7e..."      # binds this envelope
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
- `/monad/v1/pubsub/posts`, `/monad/v1/pubsub/posts/:payload_hash`,
  `/monad/v1/pubsub/votes`, and `/monad/v1/pubsub/topics`.

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
| `PUT /message/monad` | submit a stamped private message | `PUT /monad/v1/mailbox/messages` | alias only after both paths use #60's one durable admission operation; never dual-write |
| `GET /message/monad/:payload_hash` | unauthenticated retained-message lookup | authenticated `inbox`, `outbox`, or `recovery` view | removed security surface after #60; no alias and no canonical public hash lookup |
| `GET /message/monad?since=...` | unauthenticated global timestamp feed | authenticated `GET /monad/v1/mailbox/sync/:account_address?cursor=...` | removed security surface after #60; no alias and no timestamp-cursor translation |
| #60 private inbox/recovery/auth routes | authenticated private reads on reviewed legacy prefixes | canonical auth, inbox, recovery, and sync routes above | bounded aliases using identical authorization and opaque-cursor scope; never weaken auth while forwarding |
| no current route | authenticated sender outbox/self-sent view | `GET /monad/v1/mailbox/outbox/:account_address` | canonical only; #60/#89 state is a prerequisite |
| no current route | mailbox migration quote and authorized import | canonical `POST .../import/:account_address/{quote,batch}` routes above | canonical only; depends on accepted #65/#89 import authority and #135 encoding |
| `PUT/GET /message/monad/topics` | submit/list topic posts | `PUT/GET /monad/v1/pubsub/posts` | bounded alias |
| `GET /message/monad/topics/:payload_hash` | fetch one topic post | `GET /monad/v1/pubsub/posts/:payload_hash` | bounded alias |
| `PUT /message/monad/topics/vote` | submit a topic vote | `PUT /monad/v1/pubsub/votes` | bounded alias |
| `GET /message/monad/topics/discover` | discover topics | `GET /monad/v1/pubsub/topics` | bounded alias |
| `/message`, `/message/:payload_hash`, `/messages...` | legacy Lotus message shapes | future `/lotus/v1/...` only after a separate Lotus-runtime design | no Monad redirect or body conversion; preserve isolated Lotus behavior |

An alias preserves the old method, body, status, response shape, authentication, and authorization
while invoking the same typed operation as the canonical handler. It does not translate a Lotus
transaction into an EVM transaction, treat `since + 1` as a cursor, or expose mailbox data through
pubsub.

### Alias ownership, removal, and rollback

The route-migration follow-up owns all Monad aliases as one inventory. Its accountable owner is
`@schancel`. The current endpoints are experimental and have no external-customer compatibility
promise, so the migration does not invent a release-count or telemetry waiting period.

Aliases may be removed only when all of these are true:

1. every in-repository Rust/TypeScript client, app, bot, and live check uses canonical routes;
2. one live integration run proves submission, authenticated inbox/outbox/recovery, sync replay,
   and pubsub/profile behavior through canonical routes; and
3. repository search plus route tests prove no supported in-repository caller uses the alias.

The global unauthenticated feed and payload-hash lookup are different: #60 removes them as security
surfaces before canonical mailbox routing, so no migration stage retains or reintroduces them.
Tests require `404` for those removed legacy reads and `401` for an unauthenticated canonical
private read. Alias-deletion proof for `/metadata/:addr` is address-family-specific: a Monad-form
request no longer dispatches to Monad, while a valid Lotus-form request still reaches the legacy
Lotus handler. The route itself does not become a blanket `404`.

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

Each adapter normalizes only the common event envelope:

```text
AdapterEvent {
  key: (source_network_tag, stream_kind, source_instance_id, source_event_id)
  source_order_key: adapter-defined immutable comparable bytes
  event_commitment: domain-separated digest of canonical normalized event bytes
  presentation_time: { seconds: bigint, nanos: uint32 }
  relay_origin: authenticated origin record
  entries: opaque or decrypted entries with their own optional NetworkTags
  native: chain-specific typed event
}
```

`native` is a discriminated adapter-owned value, not a generic transaction. The merge layer may
index common display metadata but cannot reinterpret it. `source_instance_id` is an authenticated
relay node/source identity, not a configured URL or local adapter name. Time uses lossless signed
seconds plus `0..999_999_999` nanoseconds, consistent with #106/#133; JavaScript represents seconds
as `bigint`, never a `number` millisecond count.

`event_commitment` is a domain-separated digest (for example,
`frank:normalized-adapter-event:v1`) over the canonical normalized bytes containing the full
four-part key, `source_order_key`, authenticated origin facts, and exact entry/native content. It
also binds `presentation_time` when that time is an immutable source fact. Local render labels,
relative-time strings, and any other mutable presentation-only field are excluded. The normalized
schema and digest vectors land with F4 after #131 freezes canonical encoding. The commitment is
persisted atomically with the event and cannot be recomputed from a lossy UI model.

Each authoritative source stream is scoped by `(NetworkTag, stream_kind, source_instance_id,
authorization_scope)`. Its adapter yields events in immutable `source_order_key` order. Mailbox
authorization scope is the exact network-qualified `account_address` controlled by the registered
destination key; selective pubsub scope is a subscription identity plus generation. A
profile/public stream uses its declared query or global-feed scope.

### Two-adapter example

Assume one Lotus mailbox source returns this authoritative sequence, including a regressing
presentation timestamp:

```text
L1 key=(LTUS, mailbox, relay-L, lotus:0009) order=0009 commit=cL1 time=(1720000000,900000000)
L2 key=(LTUS, mailbox, relay-L, lotus:0010) order=0010 commit=cL2 time=(1719999999,100000000)
```

and one Monad mailbox source returns:

```text
M1 key=(MONT, mailbox, relay-M, monad:0031) order=0031 commit=cM1 time=(1720000000,100000000)
M2 key=(MONT, mailbox, relay-M, monad:0032) order=0032 commit=cM2 time=(1720000000,300000000)
```

The deterministic presentation view is a k-way merge. Only the next unconsumed head of each source
stream is eligible. Among eligible heads, compare this tuple bytewise (and compare the timestamp as
the exact seconds/nanoseconds pair):

```text
(presentation_time, NetworkTag, stream_kind, source_instance_id,
 source_order_key, source_event_id)
```

The result is `M1, M2, L1, L2`. `L2` can never precede `L1`, even though its timestamp regresses,
because it is not eligible until `L1` is consumed. Every comparison has explicit tie-breakers, so
response timing, locale, and JavaScript object iteration cannot affect the result. Presentation
time is relay- or chain-authenticated metadata, never an untrusted timestamp inside encrypted
content.

If `relay-L` later returns the `L1` key with altered content and commitment `cL1-prime`, the fan-in
does not treat it as a duplicate: it preserves the stored `L1/cL1`, quarantines that page, leaves
the relay-L cursor unchanged, and marks relay-L stale/error.

This is a deterministic materialized view, not a claim of cross-chain causality. If an outage later
reveals an older source sequence, rebuilding the same set produces the same k-way order while
preserving every source edge. An optional notification list may be append-only by local discovery
time, but it is not the canonical conversation/event order.

State replay never uses `presentation_time` or the cross-source presentation merge. It applies each
source in `source_order_key` order. A domain object changed by more than one source must carry an
explicit version, predecessor/causal reference, or separately specified commutative reducer; the
fan-in layer must not manufacture state authority from timestamps.

### Identity and deduplication

`source_event_id` is defined and tested by each adapter from immutable native identity: for
example, a relay journal event id or a chain tuple such as block/transaction/log position. If the
native identifier is narrower than `stream_kind`, the adapter includes its authorization scope in
the bytes so it is unique within that source instance and kind. It is not a timestamp, display
address, array index, or cursor. Exact observation identity is always the full `(NetworkTag,
stream_kind, source_instance_id, source_event_id)` tuple; source-local identifiers from two relays
therefore cannot collide.

Exact retries first look up the full `key` and then compare `event_commitment`. Equal commitments
are an idempotent retry. Reuse of an existing key with a different commitment is source
equivocation or corruption: reject and quarantine the entire page, preserve the prior event, do
not advance that source cursor, and mark the source stale/error for operator and client visibility.
The merge must never overwrite the event or silently drop the conflicting body and advance.

A separate content digest may collapse equivalent content for presentation, but all distinct relay
origins remain attached. If the same envelope is stamped independently on two chains, those are
two source events even when their content digest is equal. Per-entry attribution always comes from
that entry's tag; deduplication never overwrites it with `key.source_network_tag`.

### Checkpoints, reconnect, and partial outage

The durable fan-in checkpoint is a map keyed by `(NetworkTag, source_instance_id, stream_kind,
authorization_scope)`. The authorization scope is the network-qualified `account_address` for
mailbox sync, the subscription identity plus generation for selective pubsub, and the declared
feed/query scope for profiles or other public streams. A local `adapter_id` is not cursor authority
and is never used as a substitute for these fields. Each value is an adapter-owned opaque cursor
plus its advertised high-water mark. The cursor and server authorization are bound to the complete
key. The merge layer never decodes, compares, increments, re-scopes, or synthesizes cursors.

For each page, canonical validation, commitment verification, event-plus-commitment insertion,
exact-key/commitment deduplication, origin attachment, and that adapter's cursor advance commit
atomically. Any unequal commitment for an existing key aborts and quarantines the page before the
cursor transaction. A crash before commit replays the page; a crash after commit resumes after it.
On reconnect, the adapter resumes from its last committed cursor. If a relay reports cursor expiry
or restart invalidation, the adapter follows its declared snapshot or safe-origin replay path and
relies on stable keys plus commitments for idempotence; it never falls back to `timestamp + 1`.

An unavailable adapter does not stop healthy adapters. Its checkpoint remains unchanged, its
source stream is marked stale with the last successful high-water mark and lossless timestamp, and
the merged view continues with an explicit partial-data status. Sends requiring the unavailable
adapter fail or queue only under that adapter's declared policy; they never fail over to another
chain. When it reconnects, backlog pages are applied atomically and the materialized k-way view is
updated without violating source order. The UI clears the stale marker only after reaching the
adapter's new high-water mark.

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
| F1 — **refine #132 and #136 after #131** | In #132, define canonical-CBOR DM/message-item schemas with separate stamp, per-entry reference, and settlement roles plus discriminated EVM/UTXO references. In #136, apply the same attribution rule to topic entries that reference chains. Shared golden vectors include this composite fixture and reject NetworkTag/native-variant mismatch. | Preserve exact legacy bytes under their explicit legacy readers; never transcode them. Unknown supported CBOR item kinds remain opaque. No new protobuf schema or generated-binding work is prescribed here. |
| F2 — **new issue: canonical route groups and aliases** | After #60 authentication/state prerequisites, add independently mountable profiles/mailbox/pubsub routers, the complete mailbox surface above, route integration tests, and the bounded non-security alias inventory. No storage-byte change. | Canonical routes are additive. Removal is a later landing after the three alias triggers pass. The two unauthenticated legacy GETs stay removed. |
| F3 — **new issue: in-repository client route cutover** | Switch typed clients, wallet adapters, bots, frontend configuration, and live checks together; prove canonical-only client traffic against one binary with all three groups mounted and with each group disabled in turn. | Roll back clients while reviewed aliases remain. Successful live integration permits F5; there is no invented external waiting window. |
| F4 — **new issue: multichain fan-in state and integration proof** | Introduce `MultichainEventView`, two real adapter instances, four-part exact observation keys, canonical event commitments, lossless timestamp vectors, k-way order tests with regressing times, complete authorization-scoped checkpoints, outage/reconnect/cursor-expiry tests, and per-entry attribution checks. A key-reuse/different-body fixture proves the prior event and cursor survive, the page is quarantined, and the source becomes stale/error. | Requires an actual second adapter and accepted cursor contracts. Adapter/runtime restoration is its own prerequisite. The compile-time seam is removed only after all current consumers use fan-in. |
| F5 — **new issue: alias deletion** | After in-repo cutover and live proof, remove the bounded aliases. Repository scans and route tests prove old Monad routes are gone, the removed unauthenticated reads return `404`, unauthenticated canonical reads return `401`, Monad-form `/metadata/:addr` dispatch is gone, and Lotus-form `/metadata/:addr` still works. | Re-enable only the non-security alias inventory for rollback; never restore the global feed or public payload-hash lookup. |
| Existing #65/#87/#88/#89/#111/#133/#135 work | Federation, import/delivery, public nanosecond records, and mailbox topology consume the boundaries here but retain their own authority, storage, authentication, encoding, and replication contracts. | None may infer an entry's network from relay provenance, expose mailbox records through public federation, or create a cursor outside the complete authorization scope. |

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
