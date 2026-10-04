# Canonical Forum HTTP boundary

The normal Forum flow uses canonical CBOR for post, reply, vote, view, topic pages,
discovery and operation status. The historical filename is retained for existing links.

| Route | Canonical response |
| --- | --- |
| `PUT /message/monad/topics` | type-10/schema-2 submission; type-15 exact operation status |
| `PUT /message/monad/topics/vote` | canonical type-11 submission; type-15 exact operation status |
| `GET /message/monad/topics/:hash` | type-12 canonical view for the exact 32-byte T1 target |
| topic list/discovery reads | type-13/type-14 complete bounded pages |
| `POST /message/monad/topics/status` | exact type-10/11 request; read-only type-15 status |

Writes require bare `application/cbor`; missing, parameterized and protobuf content
types receive415. Bodies are never sniffed or retried through another decoder.
The frozen frame cap applies before admission. `Accept` must admit bare CBOR;
otherwise the response is406. Missing or wildcard `Accept` selects CBOR.
Exact media ranges override application and global wildcards, including `q=0`.
Parameters before `q` constrain the representation; accept extensions after `q`
do not. Representation-varying reads use `Vary: Accept`.
Schema-1 posts and noncanonical vote targets are rejected before admission/RPC.
Historical rows cannot be reached through normal view, list or discovery routes.

## Retained authority

Canonical operations live in a lazy private sibling RocksDB, with synchronous
pending admission before broadcast and atomic receipt/publication transitions.
See the [private storage contract](../forum-runtime-storage.md) for bounds,
restart, rebuild and predecessor reopening. Ordinary predecessor column families
and exact records remain unchanged; no origin is transcoded into another identity.

Wallet journal records explicitly marked `forum-cbor` use the canonical operation
flow. Existing records with absent format or historical `cbor` format remain exact,
unsupported retained obligations, including signed bytes and lease references.
Normal runtime skips them before decoding, funding, signing, broadcasting, status,
retry, release, settlement, deletion or compaction. Their lease references protect
startup retirement. Recovery/export of those obligations requires separate authority.
Generated historical bindings remain while storage/test/history reachability exists.

## Outcome recovery

The wallet journals exact signed submissions before dispatch and replays identical
bytes. Unknown outcomes keep the lease in use. Both post and vote obligations are
reconciled before another normal paid write. State0/3 are unverified echoes; state1
is retained pending authority; state2 is the exact retained successful receipt and
publication. Same transaction hash with different bytes cannot borrow confirmation.
Status never sends or claims. Before settlement the wallet independently matches
its operation and checks provider transaction/receipt facts and configured policy.
Post existence alone cannot confirm another burn. Receipt observation does not add
a finality-depth or reorg guarantee.

## Complete client snapshots

Cursors bind exact query/since, epoch/revision, retained incarnation and last tuple;
transport is unique unpadded base64url. Signed i64 millisecond `since` is lossless.
Expired/restarted cursors return410, malformed cursors400, capacity503 and oversized
snapshots/rows413. Server pages allow128 rows and4 MiB complete frames.

Clients privately stage at most32768 rows and64 MiB for120 seconds per attempt,
with at most two fresh bounded retries after expiry or snapshot races. A shared
read slot bounds simultaneous staging. Publication replaces one complete query
snapshot atomically, including updated authors and exact signed256-bit tally;
failed or superseded requests cannot publish partial/stale rows or clear newer
loading ownership. Epoch/revision and exact count/amount values remain lossless.
The actual app/browser and integrated persistence gates establish runtime proof;
this document itself does not claim those gates have passed.
