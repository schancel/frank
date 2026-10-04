# Private canonical Forum storage

This document specifies #769's private server records. It does not allocate public
frame types. The active Forum codec owns type-9 schema 2 and types 12–15. #770 owns
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
| 1 | Exact submitted type-10 or type-11 frame bytes |
| 2 | First validated-observation timestamp |
| 3 | State 1 pending or 2 confirmed/published |
| 4, 5 | Verified block number and transaction index, u64 |
| 6 | Immutable publication timestamp |

Keys 4–6 exist together exactly in state 2. Timestamps use the public seconds/nanos
shape. Sender, destination, direction, value, network and target are rederived from
the exact signed bytes under header policy; none is separately mutable authority.
For another burn of an existing post, publication time is copied from the existing
post, even if the wall clock moved backwards. Exact replay changes no count, tally,
publication time or revision. Same transaction hash with different event bytes is
a conflict; status cannot borrow its observations.

Derived prefixes are `p || T1`, `t || SHA256(topic) || ordered_time || T1`,
`d || exact_topic_UTF8`, and pending accounting `q`. Derived values are private
versioned canonical maps. Signed seconds sort after flipping their sign bit, then
unsigned nanos; a hashed topic prefix is always rechecked against exact topic text.
Derived data is rebuildable from the authoritative operation set. Corrupt authority
fails closed; corrupt/missing projections trigger bounded rebuild while reads stay
unavailable. Rebuild never rewrites event authority or discards uncertain operations.

## Admission and economic observations

Validate codec, exact network/target, signature, hash, chain, destination, T8 calldata,
type-10 up direction and value 1..i64::MAX before durable admission or broadcast.
Commit the exact pending event and capacity reservation in a synchronous WAL-backed
batch before sending. Pending capacity is 4096 operations and 64 MiB of charged
records/accounting, whichever comes first. Exact retries can reconcile at capacity.
Uncertain operations never expire or get evicted to make space.

Use checked 256-bit magnitude arithmetic for positive and negative aggregates and
pending reservations. Reserve worst-case same-direction headroom before a burn can
spend; opposite pending votes cannot cancel reservations. Publication atomically
records receipt facts, applies the vote once, selects the earliest unsigned
`(block, index, raw_tx_hash)` author, updates unique-post discovery/count and fulfills
only that operation's reservation. Counts and revisions must not wrap.

Confirmation means a successful exact receipt observed by this relay. It is not a
new finality-depth or reorg guarantee. Later missing receipts cannot erase retained
confirmation, manufacture rejected-before-broadcast status, or permit a fresh spend.
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

Implementation status: storage/HTTP work is in progress. This contract is not a
claim that runtime or rollback gates have passed.
