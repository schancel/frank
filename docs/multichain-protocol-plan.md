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
          chain_id: 10143
          asset_id: "native"
    ciphertext: "base64:..."
  - entry_id: "settlement-observation-1"
    kind: "encrypted-settlement-reference"
    settlement:
      network_tag: "MONT"             # role 3: execution/observation network
      evidence:
        evm:
          chain_id: 10143
          transaction_hash: "0x91..."
          contract_address: "0x42..."
          log_index: 3
    ciphertext: "base64:..."
```

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
- `/monad/v1/mailbox/messages`, `/monad/v1/mailbox/messages/:payload_hash`, and
  `/monad/v1/mailbox/sync`;
- `/monad/v1/pubsub/posts`, `/monad/v1/pubsub/posts/:payload_hash`,
  `/monad/v1/pubsub/votes`, and `/monad/v1/pubsub/topics`.

`sync` is the authoritative mailbox catch-up resource and takes an authenticated mailbox identity
and opaque cursor. A notification channel may later wake a client, but cannot replace `sync` or
invent a second cursor. Concrete authentication and the #60 record format are outside this plan.

### Current-to-target matrix

| Current route on the pinned base | Current purpose | Canonical target | Compatibility action |
| --- | --- | --- | --- |
| `PUT/GET /metadata/monad/:addr` | write/read one Monad profile | `PUT/GET /monad/v1/profiles/:address` | bounded alias preserving current request and response bytes |
| `GET /metadata/monad?since=...` | global profile registration discovery | `GET /monad/v1/profiles?cursor=...` | compatibility handler retains `since` semantics; no fabricated conversion to an opaque cursor |
| `GET /metadata/monad/search` | profile-name search | `GET /monad/v1/profiles/search` | bounded alias |
| `GET /metadata/monad/curated-defaults` | operator-curated contacts | `GET /monad/v1/profiles/curated-defaults` | bounded alias |
| `PUT /message/monad` | submit a stamped private message | `PUT /monad/v1/mailbox/messages` | compatibility handler; both paths must call one admission operation rather than dual-write |
| `GET /message/monad/:payload_hash` | fetch one retained message | `GET /monad/v1/mailbox/messages/:payload_hash` | bounded alias until mailbox-auth migration declares the old unauthenticated read removable |
| `GET /message/monad?since=...` | global timestamp message feed | `GET /monad/v1/mailbox/sync?cursor=...` | **not** a semantic alias; retain the legacy handler temporarily and remove it after authenticated per-mailbox sync is deployed |
| `PUT/GET /message/monad/topics` | submit/list topic posts | `PUT/GET /monad/v1/pubsub/posts` | bounded alias |
| `GET /message/monad/topics/:payload_hash` | fetch one topic post | `GET /monad/v1/pubsub/posts/:payload_hash` | bounded alias |
| `PUT /message/monad/topics/vote` | submit a topic vote | `PUT /monad/v1/pubsub/votes` | bounded alias |
| `GET /message/monad/topics/discover` | discover topics | `GET /monad/v1/pubsub/topics` | bounded alias |
| `/metadata/:addr`, `/message`, `/messages...` | legacy Lotus profile/message shapes | future `/lotus/v1/...` only after a separate Lotus-runtime design | no Monad redirect or body conversion; keep isolated compatibility behavior |

An alias preserves the old method, body, status, and response shape while invoking the same typed
operation as the canonical handler. It does not translate a Lotus transaction into an EVM
transaction, treat `since + 1` as a cursor, or expose mailbox data through pubsub.

### Alias ownership, removal, and rollback

The route-migration follow-up owns all Monad aliases as one inventory. Its accountable owner is
`@schancel`; implementation can be delegated only after that issue records the exact releases and
telemetry surface. Every alias response advertises the canonical route and deprecation deadline.

Aliases may be removed only when all of these are true:

1. every in-repository Rust/TypeScript client, app, bot, and live check uses canonical routes;
2. the canonical and alias integration suite has passed for two consecutive releases;
3. supported-deployment telemetry has observed no alias request for at least 30 days; and
4. for the global message feed, authenticated mailbox sync and its recovery proof have landed.

The removal follow-up owns a repository reference scan and route-level `404` proof for every old
path. If canonical-route errors or client rollback exceed the threshold recorded by the
implementation issue, rollback re-enables the alias router and rolls clients back; it does not
rewrite stored records. Before alias removal, rollback may disable the canonical router and leave
the legacy handler active. A route migration that needs a database or wire rollback must stop and
receive a new contract because that contradicts this plan.

## Runtime adapter fan-in

`ActiveChain` remains useful as the per-chain facade, but the application composition root must no
longer select exactly one instance. A `MultichainEventView` owns a configured set of adapters and
depends only on their public profile/mailbox/pubsub interfaces. Adapters own chain-native parsing,
validation, addresses, amounts, transaction references, and cursors. They do not import the merge
view or another adapter.

Each adapter normalizes only the common event envelope:

```text
AdapterEvent {
  key: (source_network_tag, stream_kind, source_event_id)
  source_order_key: adapter-defined immutable comparable bytes
  source_time_ms: authenticated relay/chain observation time
  relay_origin: authenticated origin record
  entries: opaque or decrypted entries with their own optional NetworkTags
  native: chain-specific typed event
}
```

`native` is a discriminated adapter-owned value, not a generic transaction. The merge layer may
index common display metadata but cannot reinterpret it.

### Two-adapter example

Assume the Lotus adapter returns:

```text
L1 key=(LTUS, mailbox, lotus:0009) order=0009 time=1720000000100
L2 key=(LTUS, pubsub, lotus:0010) order=0010 time=1720000000400
```

and the Monad adapter returns:

```text
M1 key=(MONT, mailbox, monad:0031) order=0031 time=1720000000100
M2 key=(MONT, pubsub, monad:0032) order=0032 time=1720000000300
```

For any fixed observed set, the total display order is the bytewise ascending tuple:

```text
(source_time_ms, source_network_tag, stream_kind, source_order_key, source_event_id)
```

The result is `L1, M1, M2, L2`: `L1` wins the equal-time tie because canonical `LTUS` bytes sort
before `MONT`. `source_time_ms` is relay- or chain-authenticated metadata, never an untrusted
timestamp inside encrypted content. Every field after it is an explicit tie-breaker, so iteration
order, response timing, locale, and JavaScript object ordering cannot affect the result.

This is a deterministic materialized view, not a claim of cross-chain causality. If an outage later
reveals an older event, it is inserted at its canonical position. An optional notification list may
be append-only by local discovery time, but it is not the canonical conversation/event order.

### Identity and deduplication

`source_event_id` is defined and tested by each adapter from immutable native identity: for
example, a relay journal event id or a chain tuple such as block/transaction/log position. It is
not a timestamp, display address, array index, or cursor. The `NetworkTag` and `stream_kind`
namespaces prevent equal native ids on different networks or streams from colliding.

Exact retries deduplicate on the full `key`. A separate content digest may collapse equivalent
content for presentation, but all distinct relay origins remain attached. If the same envelope is
stamped independently on two chains, those are two source events even when their content digest is
equal. Per-entry attribution always comes from that entry's tag; deduplication never overwrites it
with `key.source_network_tag`.

### Checkpoints, reconnect, and partial outage

The durable fan-in checkpoint is a map keyed by `(adapter_id, NetworkTag, relay_id, stream_kind)`.
Each value is an adapter-owned opaque cursor plus its advertised high-water mark. The merge layer
never decodes, compares, increments, or synthesizes cursors.

For each page, validated event insertion, exact-key deduplication, origin attachment, and that
adapter's cursor advance commit atomically. A crash before commit replays the page; a crash after
commit resumes after it. On reconnect, the adapter resumes from its last committed cursor. If a
relay reports cursor expiry or restart invalidation, the adapter follows its declared snapshot or
safe-origin replay path and relies on stable keys for idempotence; it never falls back to
`timestamp + 1`.

An unavailable adapter does not stop healthy adapters. Its checkpoint remains unchanged, its
network is marked stale with the last successful high-water/time, and the merged view continues
with an explicit partial-data status. Sends requiring the unavailable adapter fail or queue only
under that adapter's declared policy; they never fail over to another chain. When it reconnects,
backlog pages are applied atomically and events take their canonical positions. The UI clears the
stale marker only after reaching the adapter's new high-water mark.

## Resource limits are not message semantics

This plan sets no 64 KiB envelope cap. Before any cap is enforced, the owning follow-up must measure
current encrypted payload sizes, protobuf/JSON expansion, stamp evidence, HTTP framing,
decompression, storage amplification, and catch-up page behavior against repository fixtures and a
representative retained corpus.

Limits then live in separate, explicit policy layers:

- transport: compressed and decompressed request bytes, read timeout, and concurrent bodies;
- decoding: field bytes, entry count, nesting, and chain-specific proof complexity;
- storage/abuse: per-identity or per-relay quota, retention, and admission price;
- synchronization: page bytes/event count, in-flight pages, and backpressure.

Every advertised limit is versioned server capability data with a named default and rejection
error. Changing an abuse limit must not change what a semantically valid multichain message means,
and increasing a semantic format version must not silently disable resource protection.

## Staged follow-on landings

Issue #59 owns this plan only. Decision #169 owns the route prefix decision and is complete. The
following implementation issues must be filed and accepted before production edits; `@schancel`
owns unresolved product and compatibility decisions. Each row is a separate reviewed landing (or
stack where stated), not hidden work in this documentation ticket.

| Stage / owning issue | Boundary and proof | Compatibility and removal trigger |
| --- | --- | --- |
| F1 — **new issue: composite entry schema and golden fixtures** | Add explicit stamp, per-entry reference, and settlement-role tags plus discriminated EVM/UTXO references. Update both source protobuf copies and generated bindings in that issue. Golden encode/decode fixtures include the composite example and reject route/tag or variant/tag mismatch. | Readers preserve supported unknown encrypted entry kinds; no generic transaction blob. Old messages remain readable. No writer switches yet. |
| F2 — **new issue: canonical route groups and aliases** | Add independently mountable profiles/mailbox/pubsub routers, route integration tests, deprecation metadata, and the alias inventory above. No storage-byte change. | Canonical routes are additive. Removal is a later landing after the four alias triggers pass. Decision #169 is the authority, not an invitation to alter #60. |
| F3 — **new issue: in-repository client route cutover** | Switch generated clients, wallet adapters, bots, frontend configuration, and live checks together; prove canonical-only client traffic against one binary with all three groups mounted and with each group disabled in turn. | Roll back clients while aliases remain. This stage triggers the alias observation window; it does not remove aliases. |
| F4 — **new issue: multichain fan-in state and integration proof** | Introduce `MultichainEventView`, two real adapter instances, stable-key fixtures, atomic per-adapter checkpoints, outage/reconnect/cursor-expiry tests, and per-entry attribution checks. | Requires an actual second adapter and accepted cursor contracts. It does not restore Lotus infrastructure inside this landing; adapter/runtime restoration is its own prerequisite. The compile-time seam is removed only after all current consumers use fan-in. |
| F5 — **new issue: alias deletion** | Remove only aliases whose telemetry window and integration proof passed; prove repository references are gone and old routes return `404` without exposing another subsystem. | Re-enable the alias router for rollback. The global message feed cannot be removed until authenticated mailbox sync has landed. |
| Existing #65/#87/#88/#89/#111 work | Federation and mailbox topology may consume the boundaries here, but retains its own authority, storage, authentication, and replication contracts. | None of those issues may infer a content entry's network from relay provenance or expose mailbox records through public pubsub/federation. |

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
  `backend/cashweb/cashweb-registry/proto/topic_message.proto` are backend wire sources; the latter
  currently has a hand-kept client counterpart at `packages/wallet/proto/topic_message.proto`.
- `docs/backend-topology.md` separates profile, private-mailbox, and public-pubsub ownership, while
  `docs/public-federation-plan.md` defines `NetworkTag` as protocol data and separates relay origin
  from content assertions.

Rollback of this landing is deletion of this file. It changes no runtime state, stored bytes,
public route, or public wire format.
