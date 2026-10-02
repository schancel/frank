# Topic HTTP CBOR coexistence

The Monad topic write routes accept two explicitly declared media types during the migration:

| Route                            | `application/cbor`            | `application/x-protobuf` |
| -------------------------------- | ----------------------------- | ------------------------ |
| `PUT /message/monad/topics`      | Frank type-10 post submission | legacy `MonadTopicPost`  |
| `PUT /message/monad/topics/vote` | Frank type-11 vote submission | legacy `MonadTopicVote`  |

The decoder is selected only from `Content-Type`. The relay never sniffs the body and never retries
failed input with the other decoder. Unsupported or missing media types receive `415`. CBOR input
is validated canonically and semantically before the burn transaction can be broadcast. Its
network must equal the relay's configured Frank-CBOR network, and the signed transaction must use
the paired EVM chain ID and the version-2 topic commitment.

Updated wallet clients always write deterministic CBOR. A post's public forum payload remains
opaque type-9 `body` bytes for now; the topic frame, rather than the body alone, is the post's
identity. A post's initial burn is always an up-vote, as required by T8.

## Storage boundary

This stage does not rewrite RocksDB. The existing protobuf stored-post projection remains the
index and tally source. For a CBOR post it contains the type-9 T1 hash in `payload_hash`, while the
exact authoritative type-9 frame is retained in the additive `cbor_post_frame` field. It must
never be reconstructed from the projection.

## Read boundary and removal trigger

The frozen topic schema currently allocates only type 9 (post), type 10 (post submission), and
type 11 (vote submission). It does not allocate relay-derived read models for sender, transaction
hash, storage timestamp, vote tally, topic pages, or discovery statistics. Consequently, CBOR
writes explicitly request the legacy protobuf response, and all topic GET routes remain protobuf
during this bounded stage. A write with `Accept: application/cbor` but no acceptable protobuf
range receives `406`; the relay never places protobuf bytes behind a CBOR-only negotiation.

The successor must allocate and freeze deterministic-CBOR read schemas and cross-language vectors
for the single-post view, topic page, and discovery list. That release is **R**. R ships frontend
and bot readers for those responses while retaining both HTTP formats. R+1 disables legacy
protobuf writes. R+2 removes protobuf HTTP reads and the protobuf-at-rest projection, but only
after an at-rest migration has preserved every stored `cbor_post_frame` byte exactly. Thus each
legacy HTTP direction has one full released-client compatibility interval; this is not an
open-ended dual-format mode.
