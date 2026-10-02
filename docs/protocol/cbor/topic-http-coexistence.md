# Topic HTTP CBOR coexistence

The topic transport is currently a safe, opt-in CBOR predecessor. The production wallet remains
on protobuf until deterministic-CBOR read models are allocated and frozen.

| Route                             | `application/cbor`                                         | `application/x-protobuf`                              |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `PUT /message/monad/topics`       | type-10 submission; exact type-9 frame response            | legacy post and response                              |
| `PUT /message/monad/topics/vote`  | type-11 submission; empty success response                 | legacy vote and response                              |
| `GET /message/monad/topics/:hash` | exact stored type-9 frame, when the row originated as CBOR | legacy view, only for a semantically valid legacy row |
| topic list/discovery reads        | not allocated                                              | legacy rows only                                      |

The decoder is selected only from the exact `Content-Type`; bytes are never sniffed or retried
through another decoder. `Accept` must admit the corresponding response. The frozen R6 frame cap
applies to CBOR bodies only. The protobuf extractor retains its existing behavior for this
compatibility release.

For an exact-post GET, the stored row's origin selects its only semantically valid representation.
An absent or wildcard `Accept` therefore returns exact CBOR for a CBOR-origin row and protobuf for
a legacy row. A request that explicitly accepts only the other format receives `404`; one that
accepts neither supported format receives `406`.

CBOR is enabled in wallet clients only with `topicWriteFormat: 'cbor'`. Omitting the option uses
protobuf. A CBOR vote may target only an authoritative stored canonical type-9 frame whose T1 hash
and network equal the type-11 target and network. This check happens before broadcasting.

## Storage boundary

RocksDB remains protobuf-at-rest. A CBOR row stores the existing projection plus the exact type-9
frame and confirmed `(block number, transaction index)` order. The frame is authoritative and is
never reconstructed from the projection. Repeated burns for one type-9 frame are votes; the author
is selected by earliest confirmed chain order (transaction hash breaks an exact tie). Admission of
the post and mandatory initial vote is one atomic batch.

The projection's `payload_hash` is the type-9 T1 identity, not the legacy
`SHA256(encrypted_payload)`. Therefore CBOR rows are intentionally absent from legacy topic and
discovery indexes, and cannot be returned as `MonadTopicPost` protobuf views. This prevents a
semantically false legacy response while no CBOR list/read-view schema exists.

## Outcome recovery

An already-known, nonce-too-low, or otherwise ambiguous send is hashed locally, then receipt and
transaction verification continue against that exact hash. A timeout or non-definitive
infrastructure failure after broadcast returns `503` with machine-readable error
`topic_burn_outcome_unknown`. Wallet clients retire the leased account as `stuck`; they do not
report a definitive failed burn. After a CBOR post connection loss, the wallet requests
`application/cbor` and confirms only an exact byte-for-byte type-9/T1 match; legacy recovery keeps
using the protobuf post view.

## Removal trigger

Release **R** must allocate and freeze deterministic-CBOR schemas and cross-language vectors for
the single-post view, topic page, discovery list, and vote recovery/status query. R may then switch
the normal wallet and bots to CBOR while retaining both formats. R+1 disables protobuf writes after
one released-client compatibility interval. R+2 removes protobuf reads and migrates protobuf-at-
rest only after preserving every authoritative type-9 frame byte-for-byte. Until R lands, the
legacy format and generated bindings remain supported and the CBOR writer stays opt-in.
