# frank-cbor

Rust codec for Frank deterministic CBOR, version 1. The human semantics and
status front door is `docs/CASHWEB-PROTOCOL-SPEC.md`; the current frozen
encoding/validation profile is `docs/protocol/cbor/`, whose CDDL owns exact
structure and whose vectors are executable proof. The TypeScript reference is `@frank/codec`
(`packages/frank-codec`). The two codecs meet at
`docs/protocol/cbor/vectors/`. Cashwebd uses this crate for opt-in CBOR topics
and explicit CBOR account registration; no direct-message or mailbox path uses
it.

## Ownership

This crate owns canonical CBOR encoding and decoding, FRNK frame bytes, schema
checks through section 9 stage 9, type-2 directory signature validation at
stage 10.6, and the pure hashes T1, T1a, T3, T4, and T7. Type-1 stages
10.1–10.5 are absent. Callers pass typed values or payload bytes. They do not
hand-roll CBOR maps.

## Public entry points

`encode_frame`, `wrap_frame`, `parse_frame`, `validate_frame`,
`encode_canonical`, `decode_canonical`, `is_valid_canonical`, and `cbor_map`,
re-exported from `src/lib.rs`. Explicit CBOR account registration and opt-in
topics are production consumers. Direct-message and mailbox paths are not
wired. Type-1 decryption, T3/DLEQ/payment observation and the rest of stages
10.1–10.5 remain out of scope.

## Encryption suites

Type-5 schema 2 allocates production suite 1 to crypto-box authenticated
XChaCha20-Poly1305. Suite 65535 remains reserved for schema-1 opaque proof-vector
ciphertext and must not be emitted by a production writer. Private crypto-box
registry ids `0xFE01`, `0xFE02`, and `0xFE03` are not Frank-CBOR
encryption-suite allocations. A crypto-box envelope is not a frame. This crate marshals and unmarshals frames. A digest or
ciphertext is a byte array passed into nakamoto or crypto-box. Nakamoto still
owns the HD nodes, keys, and transactions that do the signing. Nakamoto does
not parse CBOR. Crypto-box does not parse Frank/CashWeb CBOR; it privately
parses only its fixed-schema envelope CBOR.

## Tests

From `backend/cashweb`: `cargo test -p frank-cbor`.

## Structured Forum codec

The public facade validates type9 schema2/min2 structured bodies and types12–15 read/status
frames through the existing shared traversal budgets. `ForumPostContent` distinguishes opaque
schema1 from structured content, and `ForumOperationEvidence` distinguishes unverified request
echoes from relay observations. Original frames and body bytes remain authoritative.
`encode_forum_post`, `encode_forum_read_frame`, cursor transport helpers and
`match_forum_operation` perform pure construction/comparison; they establish neither chain
finality nor wallet authority. Active TS/Rust conformance uses
`docs/protocol/cbor/vectors/forum-content-read.json`. Runtime snapshot storage/publication,
normal-client switching and predecessor removal remain under #675: server successor #769
and whole normal-path cutover/removal successor #770.

## Typed blackjack items

Type18/schema1/min-reader1 is supported by default. `BlackjackItem` combines an exact
game ID with one of nine closed `BlackjackAction` shapes. `encode_blackjack_item`
validates strict hash/decimal presentation and the same typed wire validator;
`project_blackjack_item` owns exact original frame bytes and its application value
without restarting traversal. Seed stays text and quantities use exact decimal
strings. Optional zero fee/empty rules remain distinct from absence. The active
corpus preserves90 proposal frames/79 writer inputs and genuine typed Rust/TS origins.
Root/nested4096 and existing item/depth/aggregate counters apply through the public
#789 continuation. #780 owns actual authenticated runtime/economic adoption.

Type18 schema2 adds the peer-to-peer hand items of `docs/protocol/blackjack-p2p.md`
to the nine schema-1 shapes, and is supported by default. A `BlackjackHandItem` is a
fixed-form game ID with one closed `BlackjackHandAction` (challenge as dealer or player,
accept, bet, deal, hit, stand, double, card, reveal, refund; wire action codes16..25,
disjoint from schema1's0..6, so the code alone selects the shape). A hand shape is read
only when the reader supports type18 schema2 and the frame requires reader2 (writers
emit schema2/min-reader2). In any other frame, and for a reader without schema-2
support, codes16..25 are out of range (stage8.2 `schema`); a schema-1-shaped frame
keeps its schema-1 shape whatever its envelope versions.
`encode_blackjack_hand_item`, `project_blackjack_hand_item` and
`is_blackjack_hand_frame` mirror the schema-1 facade; commitment/ref are64 bare
lowercase hex, the maximum bet a decimal string in1..10^40-1. A hand item's game ID
is exactly32 lowercase ASCII hex characters (stage8.2 `schema` otherwise, and the
writer refuses anything else); schema-1 game IDs stay1..128 bytes. No shape carries an
amount of money. Active TS/Rust conformance uses
`docs/protocol/cbor/vectors/blackjack-hand.json`.
