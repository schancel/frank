# Private canonical Forum storage

This document specifies #769's private server records. It does not allocate public
frame types. The active Forum codec owns type-40 schema 2 and types 43–46. #770 owns
the normal client switch, complete-page publication and predecessor retirement.

## Ownership and rollback

The registry lazily opens a sibling RocksDB named `<legacy-db-filename>.forum-cbor-v1`.
Opening ordinary legacy routes creates no Forum database. The original database's
column families, records and manifest policy are unchanged. The sidecar is owned by
one registry instance; publication and snapshot state share a serialized boundary.
No network await occurs while that boundary is locked. A sidecar failure disables
the new Forum boundary, never selects the predecessor as a fallback.

Rollback leaves both databases and pending signed obligations intact. The required
rollback proof uses the actual pre-#769 opener against legacy fixtures before and
after populated sidecar use, comparing column-family inventory and logical bytes.
It does not compare RocksDB's physical log files or delete the sidecar.

## Version 1 private records

All values are restricted canonical CBOR, not protobuf. Closed maps reject unknown
keys at this version. A header under `h` binds `{0: 1, 1: network, 2: chain_id_u64,
3: burn_destination_bytes20}`. A mismatch is unavailable, not migration permission.

An operation key is `e || raw_transaction_hash32`. Its value is:

| Key | Value |
| --- | --- |
| 0 | Storage version 1 |
| 1 | Exact submitted type-41 or type-42 frame bytes |
| 2 | First validated-observation timestamp |
| 3 | State 1 pending, 3 counted, 2 confirmed or 4 dropped |
| 4, 5 | Verified block number and transaction index, u64 |
| 6 | Counting (publication) timestamp |

Key 6 exists exactly in states 3 and 2; keys 4 and 5 exactly in state 2. Pending:
admitted and reserved, not every burn accepted by the node. Counted: every burn of
the set was accepted by the node (`eth_sendRawTransaction` succeeded, the node
already held it, or its receipt is already on chain), so its weight is in the
aggregate and a post is visible. Confirmed: counted, and every burn has a successful
receipt. Dropped: a burn reverted, its nonce was used by another transaction, or
the set did not land within the bound below; its weight was taken back. Confirmed
and dropped are final. The store format marker is `frank-forum-kv-v2`; a store
written by a build that counted on confirmation (`frank-forum-kv-v1`) is refused
with the development reset path (it holds public posts and burn records only). Timestamps use the public seconds/nanos
shape. Sender, destination, direction, value, network and target are rederived from
the exact signed bytes under header policy; none is separately mutable authority.
For another burn of an existing post, publication time is copied from the existing
post, even if the wall clock moved backwards. Exact replay changes no count, tally,
publication time or revision. Same transaction hash with different event bytes is
a conflict; status cannot borrow its observations.

Derived prefixes are `p || T1`, `t || SHA256(topic) || ordered_time || T1`,
`d || exact_topic_UTF8`, `u/ || lead_hash` (events not yet confirmed or dropped),
`w/ || T1 || lead_hash` (every post burn of a post), and unsettled accounting `q`. Derived values are private
versioned canonical maps. Signed seconds sort after flipping their sign bit, then
unsigned nanos; a hashed topic prefix is always rechecked against exact topic text.
Derived data is rebuildable from the authoritative operation set. Corrupt authority
fails closed; corrupt/missing projections trigger bounded rebuild while reads stay
unavailable. Rebuild never rewrites event authority or discards uncertain operations.

## Admission and economic observations

Validate codec, exact network/target, signature, hash, chain, destination, T8 calldata,
type-41 up direction and value 1..i64::MAX before durable admission or broadcast.
Commit the exact pending event and capacity reservation in a synchronous WAL-backed
batch before sending. Hand every burn to the node in nonce order without waiting
for a block; when the node has accepted every burn, count the event in one
transaction and answer counted. Otherwise answer pending (or `422
topic_burn_refused` when the node definitively refused every burn); the event is
kept either way. Pending capacity is 4096 operations and 64 MiB of charged
records/accounting, whichever comes first. Exact retries can reconcile at capacity.
Uncertain operations never expire or get evicted to make space.

Use checked 256-bit magnitude arithmetic for positive and negative aggregates and
pending reservations. Reserve worst-case same-direction headroom before a burn can
spend; opposite pending votes cannot cancel reservations. Counting atomically
applies the weight once, selects the counted post burn admitted first (ties by lead
hash) as author, updates unique-post discovery/count and fulfills only that
operation's reservation. Counts and revisions must not wrap; admission reserves two
revisions for every unsettled event (counting and settlement).

## Background reconciliation

Every replica runs a pass every five seconds over `u/`. For each event it reads, per
burn, the sender's nonce at `latest` and then the receipt (so a burn that lands
between the reads is not mistaken for a replaced one), without waiting for a block:

- every receipt successful and matching the signed bytes: confirmed (a pending
  event is counted first);
- a receipt that fails verification (reverted, wrong recipient or commitment): dropped;
- no receipt but the nonce already used, once the event is over 60 seconds old (one
  upstream may show the nonce before another shows the receipt): dropped;
- not every burn landed 15 minutes after admission: dropped;
- otherwise every burn is handed to the node again, and a pending event the node now
  wholly holds is counted;
- a chain read that fails or times out decides nothing; the event waits for the next
  pass.

Dropping a counted event subtracts its weight; dropping a pending one releases its
reservation. When the dropped event authored its post, the earliest other counted
post burn becomes the author; with none the post is hidden (topic index entry,
discovery count and visible count removed) until another post burn of it counts.
Each change is one transaction on `o/` and `q`, so replicas racing on one event
change it once. Why a bound rather than waiting forever: the forum counts on
acceptance so the author sees the post at once, and the pass is what keeps it from
holding weight the chain never paid. Monad blocks are about a second apart and the
pass re-sends unlanded burns every round, so a burn the node accepted that has not
landed in 15 minutes has been lost or priced out. A burn that lands after its event
was dropped pays without counting; the author's wallet sees its own coin spent.

Confirmation means a successful exact receipt observed by this relay. It is not a
new finality-depth or reorg guarantee. Confirmed events are final: later missing
receipts cannot erase them, manufacture rejected-before-broadcast status, or permit a
fresh spend.
Status is read-only and derives unknown-state echoes from the supplied request;
post existence alone never proves a different operation confirmed.

## Retained snapshots

Every actual open/rebuild creates a fresh random 16-byte epoch; revisions start at
zero and advance only for changed visible observations. Snapshot incarnations
increase without wrapping, including failed creation attempts. Restarted, expired
or unknown incarnations return cursor-expired; no query/revision recreation fallback.

Materialize immutable rows under the publication boundary, with no long-lived
RocksDB snapshot/SST pin. Limits: 16 live snapshots, 64 MiB each, 256 MiB total,
120 seconds original monotonic TTL; no live eviction or sliding renewal. Charge
buffer capacities and index/cursor/record overhead, not only serialized length.
Allow only one bounded construction and one bounded page buffer simultaneously.

Pages enforce 128 rows, 4 MiB complete frames, cumulative codec budgets, 2 MiB views
and 2048-byte cursors. Continuation checks retained epoch/incarnation and lifetime
before query/revision and exact last-tuple membership. Echo the exact request cursor
on every continuation, including terminal pages; initial pages omit it. Return no
next cursor for an empty/terminal page. Frozen snapshots do not change when later
votes change current author/tally facts. #770 retains ownership of bounded client
accumulation and atomic publication; server proof alone does not establish it.

The server stage landed with runtime and rollback verification. The normal client
cutover additionally requires private bounded accumulation (32768 rows,64 MiB,
120 seconds; initial attempt plus two fresh bounded retries), one shared staging
slot, cursor/epoch/revision binding and atomic publication guarded by request
ownership. Client gate results must be reported separately from server evidence.

The existing wallet pool, change pool, roots and lease manager retain their object
identity. Topic ownership opens only the existing topic journal namespace under
wallet admission. Startup retirement unions stamp and all retained topic lease
references before touching in-use leases. Unsupported predecessor operations keep
exact records and signed bytes; they cannot enter canonical reconciliation or
release/settlement. Closing drains admitted topic work before closing the journal;
competing topic owners for one pool/location are rejected. No new durable wallet
identity, root role, manifest migration or financial policy is introduced.
