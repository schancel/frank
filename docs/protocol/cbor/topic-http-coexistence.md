# Topic HTTP CBOR coexistence

The canonical Forum server boundary is implemented by #769; #770 owns the normal wallet/bot
switch and predecessor retirement. The schema-1 CBOR and protobuf boundaries remain reachable
for their existing exact operations during that bounded transition.

| Route                             | `application/cbor`                                         | `application/x-protobuf`                              |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `PUT /message/monad/topics`       | type-10/schema-2 post: exact type-15 operation status; schema-1 post: exact type-9 response | legacy post and response |
| `PUT /message/monad/topics/vote`  | type-11 canonical Forum target: exact type-15 status; old target: empty success | legacy vote and response |
| `GET /message/monad/topics/:hash` | type-12 canonical Forum view, or exact historical schema-1 type-9 frame | legacy view, only for a semantically valid legacy row |
| topic list/discovery reads        | types 13/14 for canonical Forum rows only | legacy rows only |
| `POST /message/monad/topics/status` | type-10/11 exact request; read-only type-15 status | unsupported |

The decoder is selected only from `Content-Type`; bytes are never sniffed or retried through
another decoder. CBOR requires the exact bare `application/cbor` value, while legacy protobuf
retains its existing parameter tolerance. `Accept` must admit the corresponding response. The
frozen R6 frame cap applies to CBOR bodies only.

For an exact-post GET, the stored row's origin selects its only semantically valid representation.
An absent or wildcard `Accept` therefore returns exact CBOR for a CBOR-origin row and protobuf for
a legacy row. A request that explicitly accepts only the other format receives `404`; one that
accepts neither supported format receives `406`.
Media-range quality follows specificity precedence: an exact range overrides `application/*`,
which overrides `*/*`, so an exact `q=0` cannot be bypassed by a positive wildcard.
Because the offered representations are bare media types, media parameters before the first `q`
constrain a range and do not match. Parameters after `q` are treated as RFC 7231 accept extensions
and do not constrain the representation.
Topic list/discovery selects canonical Forum only when `Accept` admits CBOR and excludes
protobuf. Missing/wildcard/dual-format requests preserve predecessor selection. All
representation-varying GETs use `Vary: Accept`.

CBOR is enabled in wallet clients only with `topicWriteFormat: 'cbor'`. Omitting the option uses
protobuf. A CBOR vote may target only an authoritative stored canonical type-9 frame whose T1 hash
and network equal the type-11 target and network. This check happens before broadcasting.

## Storage boundary

Canonical Forum retains exact type-10/11 frames in a lazy private sibling RocksDB, with
synchronous pending admission before broadcast and atomic receipt/publication transitions.
Derived rows are rebuildable; the legacy database's column families are unchanged. See the
[private storage contract](../forum-runtime-storage.md) for closed record IDs, pending and
snapshot bounds, restart/rebuild, and actual predecessor reopening proof.

The predecessor remains protobuf-at-rest. A schema-1 CBOR row stores the projection plus its exact type-9
frame. The frame is authoritative and is never reconstructed from the projection. Repeated burns
for one type-9 frame are votes. The author is selected by the unsigned tuple `(uint64 block_number,
uint64 transaction_index, lexicographic raw stored 32-byte tx_hash)`; numeric comparison is
host-endian independent. Zero block/index fields on a non-CBOR or pre-field row mean the tuple is
absent and ineligible, not block zero. Replacing author facts preserves the original relay
timestamp. Admission of the post and mandatory initial vote is one atomic batch.

The projection's `payload_hash` is the type-9 T1 identity, not the legacy
`SHA256(encrypted_payload)`. Therefore CBOR rows are intentionally absent from legacy topic and
discovery indexes, and cannot be returned as `MonadTopicPost` protobuf views. This prevents a
semantically false legacy response. Canonical Forum pages are a separate explicit representation.

## Outcome recovery

An already-known, nonce-too-low, or otherwise ambiguous send is hashed locally, then receipt and
transaction verification continue against that exact hash. A timeout or non-definitive
infrastructure failure after broadcast returns `503` with machine-readable error
`topic_burn_outcome_unknown`. For CBOR writes, the wallet durably journals the exact signed
submission before dispatch and replays that same operation after restart. A frame-only CBOR GET
cannot prove that the current burn transaction was accepted, because the same type-9 frame may
already exist from another transaction; it is never used as confirmation. The lease remains
`in-use` while that journal entry is unresolved. Legacy recovery may use the protobuf post view
because it includes transaction-specific sender and burn-transaction evidence.

Canonical Forum status returns state0 for an exact request without retained observation,
state1 for durable pending authority, and state2 only for that exact operation's retained
successful receipt and publication. Same transaction hash/different submitted bytes never
borrows confirmation. A pending operation survives timeout/restart and consumes capacity until
reconciled by exact client replay; status itself never sends or claims. Observed receipt success
is not independently verified finality. Unknown post-broadcast outcomes remain recoverable.

Canonical page cursors bind exact query/since, epoch/revision, retained incarnation and last
tuple; URL transport is unique unpadded base64url. `since` remains signed i64 milliseconds,
inclusive, converted without precision loss. Expired/restarted cursors return410, malformed
cursors400, capacity503 and oversized snapshots/rows413. Snapshots remain immutable across
later votes. #770 owns complete-page accumulation and atomic publication in clients.

## Removal trigger

The immediate successor is **#770**: switch normal post/reply/read/list/discovery/vote and
transaction reconciliation together, prove the real Forum flow, then retire predecessor
writers/routes/readers under its explicit retained-authority disposition. #769 does not reset
development stores or delete pending protobuf/schema-1 wallet journals. Generated bindings
remain until repository/build and historical reachability proof authorizes removal. No origin
is transcoded into another identity, and #675 remains open until the complete outcome is proven.
