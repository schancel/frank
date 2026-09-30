# Frank deterministic CBOR, version 1

Status: normative for the codec proof in issues #131 and #182. Production
protocols do not use this format until their separate migration tickets land.

The words MUST, MUST NOT, SHOULD, and MAY are normative as described by RFC 2119. Numbered rules are stable references for implementations and test
vectors.

## 1. Framing

An independently stored, signed, hashed, forwarded, or opaquely embedded Frank
object is exactly one frame:

| Offset | Size | Field                                              |
| -----: | ---: | -------------------------------------------------- |
|      0 |    4 | ASCII `FRNK` (`46 52 4e 4b`)                       |
|      4 |    1 | Frame version, `01`                                |
|      5 |    4 | CBOR body length as an unsigned big-endian integer |
|      9 |    N | The exact deterministic-CBOR envelope bytes        |

Worked example: a type-17 text item `{0: "hi"}`, 23 bytes in all.

```text
46 52 4e 4b            FRNK
01                     frame version 1
00 00 00 0e            CBOR body length 14
a4                     envelope map, 4 entries
  00 11                  type_id = 17
  01 01                  schema_version = 1
  02 01                  min_reader_version = 1
  03 45                  payload = byte string of 5 bytes
     a1 00 62 68 69        payload map {0: "hi"}
```

Worked example of retention: the same layout with `type_id` `0xffff0001`
(`00 1a ff ff 00 01`, a four-byte argument in shortest form) and payload `a0` is
`46524e4b010000000ea4001affff0001010102010341a0`. A reader that does not know
that type retains those 23 bytes unchanged, whatever `opaque_retention_allowed`
is inside an open field, or when the flag is true at the root, and never
reconstructs them.

F1. A version-1 reader MUST compare the magic before interpreting any CBOR.

F2. A reader MUST reject an unsupported frame version. A storage or forwarding
boundary that explicitly permits unknown versions MAY retain the complete
frame opaquely, but MUST NOT interpret it as version 1.

F3. The declared body length MUST equal all bytes remaining after the nine-byte
header. Truncation, concatenated frames, and trailing bytes MUST reject. A
declared length of 0 with no bytes after the header therefore passes this
check; the empty envelope is then truncated CBOR at stage 5 of section 9
(`malformed`), and a `frame` operation, which stops after stage 4, accepts it.

F4. The stage 1 limits (`route_byte_limit` and `MAX_FRAME_BYTES`) MUST be
checked before allocating or decoding the body. The type-specific frame limits
of R2 and R3 apply at stage 8.1 of section 9 instead, so a malformed or
unknown-type frame never reports them.

F5. Failure of magic, version, length, CBOR, schema, or semantic validation
MUST NOT trigger protobuf, JSON, BCS, or other codec fallback.

F6. The complete frame, including its nine-byte header, is the byte identity
used by the transcripts in section 8. The magic is recognition, not
authentication.

Decision #181 owns this framing. Typed maps nested inside a frame are ordinary
CBOR. A nested object is framed only when it has its own type/version and exact
bytes, or is independently stored, signed, hashed, forwarded, or interpreted
after its parent.

## 2. Common envelope

The body is the `frank-envelope` map in [common.cddl](common.cddl):

| Key | Name                 | Meaning                                                |
| --: | -------------------- | ------------------------------------------------------ |
|   0 | `type_id`            | Immutable object-kind identifier                       |
|   1 | `schema_version`     | Exact schema revision written                          |
|   2 | `min_reader_version` | Oldest semantic reader allowed to interpret it         |
|   3 | `payload`            | One complete canonical-CBOR data item in a byte string |

E1. All four keys are required. Other envelope keys are forbidden in version 1.
Additive evolution occurs inside the payload or in a later frame version.

E2. `schema_version` and `min_reader_version` begin at 1. A reader MUST NOT
interpret an object when its supported semantic-reader version is less than
`min_reader_version`. `min_reader_version` MUST NOT exceed `schema_version`; a violation is a
`schema` error.

E3. `payload` MUST contain exactly one data item satisfying section 3. A known
type additionally applies its CDDL and semantic rules. An unknown type, or a
schema whose `min_reader_version` is unsupported, MAY be retained and forwarded
only as the original complete frame. V6 exclusively governs a newer schema
whose minimum reader version is supported.

E4. A forwarder MUST NOT decode and re-encode a signed, hashed, committed, or
unknown object. Successful validation does not authorize reconstruction.

E5. Type identifiers are never reused. Version 1 reserves:

|    Type ID | Name                                       | Schema                                     |
| ---------: | ------------------------------------------ | ------------------------------------------ |
|          1 | Recipient-specific direct-message delivery | [direct-message.cddl](direct-message.cddl) |
|          2 | Signed directory attestation               | [directory.cddl](directory.cddl)           |
|          3 | Mailbox checkpoint                         | [checkpoint.cddl](checkpoint.cddl)         |
|          4 | Directory statement signed by type 2       | [directory.cddl](directory.cddl)           |
|          5 | Recipient-encrypted payload                | [direct-message.cddl](direct-message.cddl) |
|          6 | Decrypted message content                  | [direct-message.cddl](direct-message.cddl) |
|          7 | Key-transition statement                   | [directory.cddl](directory.cddl)           |
|          8 | Plaintext message-content revision         | [direct-message.cddl](direct-message.cddl) |
|         16 | Container message item                     | [direct-message.cddl](direct-message.cddl) |
|         17 | UTF-8 text message item                    | [direct-message.cddl](direct-message.cddl) |
| 0xffff0001 | Proof-only unknown future message item     | Opaque fixture payload                     |

The CDDL rule for each type's payload is: 1 `direct-message-delivery`; 2
`directory-attestation`; 3 `mailbox-checkpoint`; 4 `directory-statement`; 5
`recipient-encrypted-payload`; 6 `encrypted-message-content`; 7
`key-transition-statement`; 8 `message-content-revision`; 16
`container-message-item`; 17 `text-message-item`.

Unassigned identifiers remain reserved and MUST NOT be emitted. The proof-only
identifier MUST NOT appear in a production writer; it remains permanently
reserved so the unknown-item vector never acquires a different meaning.

## 3. Restricted deterministic-CBOR profile

C1. Maps use the RFC 8949 section 4.2.1 bytewise lexicographic order of each
key's deterministic encoding. Integer keys are required for extensible
protocol records. Because version 1 map keys are unsigned integers in their
shortest encoding, their encoded-byte order is also deterministic across
implementations.

C1a. Every map key at every depth, including inside an unknown-type or opaque
payload, MUST be an unsigned integer. A text, negative-integer, byte-string,
or other key class is a `schema` error detected in whichever stage decodes
the item, as part of the
restricted profile (pass B, section 9), so text-key ordering is never needed.

C2. Integers and lengths MUST use their shortest preferred encoding. A value
that fits in the additional-information field or a smaller integer argument
MUST NOT use a larger representation. This minimality rule applies only to the argument of an integer and to the
length or count of a string, array, or map. Tag numbers and float widths are
not examined: any tag or float is the forbidden class (`schema`) whatever its
width. A two-byte simple value `f8 xx` with `xx < 32` is `malformed` (RFC 8949
section 3.3), and with `xx >= 32` is a forbidden simple value (`schema`).

C3. All byte strings, text strings, arrays, and maps MUST have definite length.

C4. Map keys MUST be unique and already sorted. A decoder MUST reject a
duplicate or out-of-order key rather than accepting a last value.

C5. Unsigned integers, negative integers, byte strings, UTF-8 text strings,
arrays, maps, `false`, `true`, and `null` are the only permitted CBOR data
items. Floats, simple values other than those three, tags, `undefined`, and indefinite collections MUST reject. A stray break code
is `malformed`; an indefinite-length start is `noncanonical`, a pass B
verdict reached only when pass A (section 9) found the whole item, including
every chunk of an indefinite string, well formed.

C6. Text MUST be well-formed shortest-form UTF-8. Surrogates, overlong
sequences, and invalid continuation bytes MUST reject. Protocol identifiers
that a schema marks ASCII MUST contain only bytes `20` through `7e` unless that
schema narrows them further.

C7. A declared `u64` is in `0..18446744073709551615`; a declared `i64` is in
`-9223372036854775808..9223372036854775807`. TypeScript implementations MUST
expose these as `bigint`, never `number`. The `u64` upper bound cannot be
exceeded by an unsigned integer: the widest unsigned head already ends at
2^64-1, and anything wider needs a bignum tag, a forbidden class (C5, C8). A
CDDL `.le 18446744073709551615` on a `uint` therefore never fails at stage 8.2;
what it rejects there is a negative integer, and a bignum tag fails earlier as
`schema` in pass B. A negative integer below the `i64` minimum is encodable and
fails its CDDL range at stage 8.2 as `schema`.

C8. Values wider than 64 bits are fixed-width big-endian byte strings whose
width is declared by the schema. Leading zero bytes remain significant. No
bignum tag is permitted. Version-1 EVM quantities use exactly 32 bytes.

C9. Decoding MUST consume the entire envelope body and the entire payload data
item. Trailing data rejects at both levels.

C10. Canonical validation precedes typed conversion. An implementation may use
a streaming validator or compare validated input with an independent canonical
re-encoding over this restricted value set; permissive library defaults are
not the protocol. Whatever the method, it MUST reproduce the stage and
category selection of section 9, including passes A and B.

C11. Source map insertion order MUST NOT affect encoded output. A protocol set
MUST be represented as a list sorted by its declared semantic key and MUST
reject duplicate semantic keys.

C12. For an exact supported `schema_version`, an integer map key not explicitly
defined by that schema is a `schema` error. The `* uint => frank-value` CDDL
wildcards describe fields that an older reader may encounter only when V6.3
processes a newer compatible schema; they do not permit undeclared fields to be
smuggled into schema version 1. The `schema_version` of the frame whose
payload contains a map decides whether that map is read as exact or as a newer
compatible schema, and the same decision covers every wildcard map nested in
that payload (`relay-binding`, `key-transition`, `journal-fact`). An embedded
child frame's own `schema_version` governs its own maps; a parent's version
neither opens nor closes them. Maps whose CDDL has no wildcard (`payment-member`,
`account-ref`, `timestamp`, `signature-entry`, and the common envelope) are
closed (and likewise `opaque-section`): an undeclared key is a `schema` error at every schema version, so
extending one requires a new type or a raised `min_reader_version`.

## 4. Resource limits

The limits below are part of version 1, not recommendations. A narrower route
or object limit applies only at stage 1 (`route_byte_limit`) and MUST NOT
accept an object exceeding the global limits.

| Constant                |                                 Value | Applies to                                              |
| ----------------------- | ------------------------------------: | ------------------------------------------------------- |
| `MAX_FRAME_BYTES`       | 8,388,617 (8 MiB body + 9-byte frame) | Complete frame                                          |
| `MAX_BODY_BYTES`        |                     8,388,608 (8 MiB) | Envelope CBOR body                                      |
| `MAX_DEPTH`             |                                    32 | Nested CBOR arrays/maps, including envelope and payload |
| `MAX_CONTAINERS`        |                                16,384 | Arrays plus maps in one validation operation            |
| `MAX_ITEMS`             |                               131,072 | Scalars plus containers in one validation operation     |
| `MAX_MAP_ENTRIES`       |                                   256 | Entries in any one map                                  |
| `MAX_ARRAY_ELEMENTS`    |                                 8,192 | Elements in any one array                               |
| `MAX_BYTE_STRING_BYTES` |                             8,388,608 | Any byte string before type-specific limits             |
| `MAX_TEXT_STRING_BYTES` |                     262,144 (256 KiB) | Any UTF-8 text string                                   |

R1. One validation operation begins at one externally supplied root frame.
Before decoding, its complete byte length is charged once against the frame
limit; embedded frame bytes already lie inside that input and are not charged a
second time. Container and item counters start at zero and monotonically count
every decoded map, array, and scalar, including every map key and every tag
head, in the envelope, opened payload, and every
recursively opened child frame. A tag head and the item it wraps are each one
item, so a chain of tags is bounded by `MAX_ITEMS` in pass A even though every
tag is later rejected as a forbidden class (C5); a chain of more than 131,072
tags is `resource`, not `schema`. An indefinite-length string is one item, and
its chunks are not items (section 9, pass A). Logical depth starts at zero for the root
envelope; entering a map or array adds one, and the payload item is nested
inside the envelope map, so its first array or map is at depth 2 and a payload
may nest at most 31 levels. An embedded frame's envelope map is one level
deeper than the container holding its byte string, and depth returns to that
container's value when the child finishes. For example, a type-16 child's
envelope map is at depth 4 when its parent's is at depth 1, because the parent's
payload map is 2 and its items array is 3, so each further level of type-16
nesting adds 3. A child parser inherits these
counters and MUST NOT reset them. Implementations MUST fail without partially
returning a typed object when any limit is exceeded.

Rationale for the limits: 8 MiB bounds a single frame that a phone can buffer
while leaving room for chunked media beyond R2's 1 MiB message. Depth 32 permits
a type-16 root with nine further nested type-16 levels and a text leaf (ten
container levels at three depth each, with no headroom), and only seven type-16
levels plus a leaf under a type-1 message, whose own nesting uses the first
nine levels (that path runs through the decrypted type-6 frame of stage 10.1,
so this figure is a `full` property that no `typed` vector can exercise, while
the type-16 root figure is exercised at `typed`); deeper structures are split into separately framed objects.
Containers 16,384 and items 131,072 (keys counted) let a large
R4 checkpoint of 4,096 minimal facts (13 items each) plus 4,096 minimal
sections (7 items each), about 82,000 items, fit under one counter. Map
entries 256 and array elements 8,192 exceed every allocated schema bound by a
factor of at least 2. The 8 MiB byte-string bound is deliberately the body
limit, so a long string is limited by frame size first, and 256 KiB text is the
largest single message text a client should render without chunking.

R2. The direct-message frame limit is 1 MiB, with at most 256 message items
total across the recursively opened item graph of one validation operation,
whatever its root type (a bare type 6, 8, or 16 root is bounded the same way), 64 payment members, and 512 KiB
in one encrypted payload. This deliberately permits messages larger than 64
KiB while requiring large media to be chunked or referenced rather than
embedded without bound.

R3. The directory-attestation frame limit is 256 KiB, with at most 32 relay
bindings and 16 signatures.

R4. The checkpoint frame may use the global 8 MiB limit, with at most 4,096
journal facts and, separately, at most 4,096 opaque sections. Larger state exports MUST be chunked into
independently framed checkpoints.

R5. Lengths and aggregate counters MUST be checked using arithmetic that cannot
wrap. A limit error is distinct from malformed, non-canonical, unsupported, and
schema errors as defined by the vector manifest.

## 5. Semantic ordering and uniqueness

S1. Network tags are lowercase ASCII identifiers matching
`[a-z0-9][a-z0-9._-]{0,63}`. Network tags are protocol data, not URL path
components.

S1a. Numeric values compare by mathematical value. Byte strings compare
lexicographically by unsigned byte value. Text strings compare
lexicographically by their exact UTF-8 bytes. Tuples compare the first unequal
component using its declared comparator; a shorter otherwise-equal byte/text
string sorts first. Language-native locale or UTF-16 ordering MUST NOT be used.

S2. An account reference is ordered by `(key_type, key_bytes)`. Key type is an
allocated unsigned identifier, not an inference from byte length. Version 1
allocates key type 1 to 33-byte compressed SEC1 secp256k1 public keys, 2 to
32-byte Ed25519 public keys, and 3 to 32-byte x-only secp256k1 public keys. In
every account reference, an unallocated key type is `unsupported` (stage 8.3)
and a wrong length for an allocated type is `schema` (stage 8.2).

S2a. Version 1 allocates signature algorithm 1 to strict-DER, low-S secp256k1
ECDSA over the 32-byte SHA-256 transcript digest; 2 to BIP340 Schnorr over that
digest, including BIP340's tagged challenge construction; and 16 to RFC 8032
Ed25519 over the complete common transcript, verified cofactorlessly by RFC
8032 section 5.1.7 with canonical `S < L` and canonical encodings of `A` and
`R` required; a small-order `A` is not otherwise excluded. Algorithm 3 is Bitcoin Cash's
[May-2019 Schnorr profile](https://documentation.cash/protocol/forks/2019-05-15-schnorr.html)
over the 32-byte SHA-256 transcript digest, including its `(r,s)` encoding,
compressed SEC1 key, and distinct challenge construction. Signatures from
algorithms 2 and 3 are never interchangeable merely because both use
secp256k1.

S2b. Algorithm 1 requires key type 1 and a strict-DER signature of 8 through 72
bytes; algorithm 2 requires key type 3 and exactly 64 signature bytes;
algorithm 3 requires key type 1 and exactly 64 signature bytes; algorithm 16
requires key type 2 and exactly 64 signature bytes. Any other
algorithm/key-type/length combination is unsupported, not a signature failure.
This pairing applies to every entry that carries an algorithm, a signer
account, and signature bytes: each type-2 `signature-entry` and each type-4
`key-transition` entry (fields 1, 2, and 3), at stage 8.3.

S2c. Encryption-suite identifier 65535 is reserved for opaque proof-vector
ciphertext and MUST NOT be emitted by a production writer. Production suites
are allocated only with their nonce, key-agreement, authentication/deniability,
and failure rules. The codec does not infer a suite from nonce length.

S3. Payment members are ordered by numeric `child_index`, then bytewise
`transaction_id`. Child indices and transaction identifiers MUST each be
independently unique. Child indices are non-hardened BIP32 indices in
`0..2147483647`. Amounts need not be equal. Independently verified values are
added with checked unsigned 256-bit arithmetic; overflow rejects. Their sum
MUST be greater than or equal to the applicable minimum. Each encoded amount
MUST exactly equal the independently observed value in its verified chain
transaction, and every member's observed value MUST be greater than zero
(`semantic`, checked in 10.5 after the equality); an encoded assertion is
never payment evidence by itself.

S4. Relay bindings are ordered by bytewise `relay_id`, then UTF-8-bytewise
`endpoint`, and unique by `relay_id`. Endpoints are exact opaque URI strings
for signing, equality, and ordering. An endpoint MUST begin with a scheme
matching `[A-Za-z][A-Za-z0-9+.-]*:` and contain only bytes `21` through `7e`
excluding `"`, `<`, `>`, `\`, `^`, backtick, `{`, `|`, and `}`; a violation is a
`schema` error at stage 8.2. The codec performs no case,
default-port, percent-escape, Unicode-host, or trailing-slash normalization. A
consumer separately validates allowed schemes before use. Signatures are
ordered by numeric `algorithm`, numeric `signer_key_type`, then bytewise
`signer_key_bytes`, and unique by that complete tuple.

S4a. Offline recovery authorities are ordered by numeric key type, then
bytewise key bytes, and unique by that complete account-reference tuple. A
transition may use only an authority present in the last accepted statement,
not one introduced by the statement being authorized.

S5. Key transitions are ordered by the numeric revision, numeric new-key type,
and bytewise new-key bytes parsed from their type-7 statement frame. Two
transitions with the same revision are invalid rather than tie-broken.

S6. Checkpoint journal facts are ordered by numeric `(seconds, nanoseconds)`,
then bytewise `fact_id`. Timestamps do not create identity: `fact_id` remains
the stable tiebreaker and MUST be independently unique within a checkpoint.

S7. Opaque checkpoint sections are ordered by numeric `(section_type,
schema_version)` and MUST have independently unique `section_type` values.

S8. A type-1 delivery's network (field 0) and destination account (field 1)
MUST equal the opened type-5 payload's network (field 0) and recipient account
(field 2); this is a stage 9 `semantic` check. For `full`, the decrypted type-6
frame's network (field 0) MUST equal the type-5 network (`semantic`), and its
digest (field 3) MUST equal the T1a digest of its opened type-8 frame (field 2)
(`cryptographic`); these are steps 10.2 and 10.3 of section 9. A framed field
whose schema requires a specific type (type-1 field 2 is type 5, type-2 field 0
is type 4, a key-transition's field 0 is type 7, type-6 field 2 is type 8) MUST
carry that `type_id`, otherwise `semantic`, reported at stage 8.4 of the parent as section 9 orders it;
such a field
is never an open field. Message-item array
order is authored semantic order, not a set to be resorted.

S9. The type-1 destination account MUST be key type 1 (otherwise `semantic`). For each payment, the T3 digest, destination account
key, and child index derive, by T3a, the exact child public key and chain
address. Payment field 3 MUST equal that canonical address,
the independently observed transaction destination MUST equal field 3, and
payment field 3 values MUST be independently unique, a stage 9 `semantic` list
check like S3's index and transaction-ID uniqueness. Value and commitment checks
from S3 and T4 remain separately required.

S10. The validation context's prior statement is the last accepted type-4
statement. Only a type-2 root has one, so S10 is checked in a type-2 parent's
stage 9; a type-4 frame validated as a root, with no type-2 parent, is not
checked against S10 whatever its field 5 holds. A non-bootstrap statement's revision MUST be greater than the prior
revision, and its network MUST equal the prior network, regardless of whether
the subject changes. Field 5 MUST be absent when the subject is unchanged and
for bootstrap. When the subject changes, field 5 MUST contain exactly one
entry, so extra, unlinked, and chained (A to B to C) transitions in one update
are `semantic` errors. That entry MUST link the previous statement to the new
statement: the type-7
network equals both statement networks; `directory_subject` equals the previous
subject; `revision` equals the new statement revision and exceeds the previous
revision; and `new_key` equals the new statement subject. Its prior authority
must satisfy S4a/T2a. A valid transition for another network, subject, revision,
or successor does not authorize the update. Revision `2^64-1` is terminal, since
no greater revision exists. Whether that is acceptable, the trust anchor and
freshness of a bootstrap record, expiry enforcement (statement field 6 and
relay-binding field 3 are timestamps with no validation here, because the
context has no clock), recovery-authority precedence or timelocks, and
transition replay across a reset verifier are policy owned by the directory
migration (#133), not decided by this codec specification.

## 6. Fixture schemas and identity boundaries

The CDDL files describe the three proof families required by #131. CDDL cannot
express framing, canonical byte order, regexes, aggregate limits, cross-field
equality, or cryptographic validation; the numbered prose rules remain
normative.

### Direct messages and recursive items

The type-1 delivery contains one type-5 recipient-encrypted-payload frame, its
T3 digest, and a sorted payment set. The decrypted plaintext of type 5 is a
complete type-6 message-content frame. One valid payment member is
permitted when the wallet cannot economically source the preferred two or more.
`message_id`, the type-8 plaintext revision frame, and its T1a content digest
belong inside encrypted content; they are not relay-visible delivery identity.
Each recipient may therefore have different encrypted bytes and a different
payload digest for the same logical message.

A type-16 container message item holds complete child frames as byte strings;
type 17 is a text item. Unknown item types remain exact child-frame bytes. A
type-5 ciphertext is never opened before stage 10.1, so at `typed` a type-1 root
reaches no message item: its item graph exists only in `full`, and `typed`
vectors reach a message-item graph through a type 6, 8, or 16 root. The
proof fixture MUST contain at least two levels and the permanently reserved
proof-only unknown type `0xffff0001`.

Direct-message stamps are payments to recipient-derived addresses. They are not
burns. A payment member commits to this recipient-specific encrypted-payload
frame and its distinct child index, so an existing transaction cannot authorize
a different payload.

### Directory attestations

Type 4 is the complete framed statement. Type 2 wraps that exact frame and a
sorted signature set, avoiding a signature-containing-itself cycle. A
signature authenticates the complete type-4 frame through section 8. Every
signature entry MUST verify, and every attestation MUST contain a verified signature whose signer exactly equals the
statement subject, proving possession of the claimed current key. The
signature set is outside every signature, so an extra valid entry, or a
stripped one, changes the type-2 bytes and its T1 hash without changing the
statement. Consumers that deduplicate, cache, or order directory records MUST
key them on the T1 hash of the opened type-4 statement, never on the type-2
hash. A bootstrap
record needs no predecessor. If an update changes the currently registered
subject, it additionally needs a valid T2a transition authorized by the prior
key or a registered offline recovery authority. Merely carrying a valid
signature from an unrelated key never authorizes a directory record. The proof
fixture contains two relay bindings, `u64::MAX` revision, and a seconds plus
nanoseconds timestamp.

### Mailbox checkpoints

Type 3 records a checkpoint identity, ordered journal facts, and sorted opaque
extension sections. A tombstone is a durable fact, not physical deletion. Each
opaque section value is retained as exact bytes and is never opened in version
1, even when it happens to hold a Frank frame; interpreting a section kind is
the job of a later schema. Version 1 allocates no journal-fact `kind`
values: every fact is retained exactly, none is interpreted or rejected for its
kind, and `tombstone-fact-payload` is unbound until the checkpoint migration
(#134) allocates a kind for it. Facts are in S6 order (numeric time, then `fact_id`), which is
not a causal or merge order. Checkpoint authorization, chunk linkage for R4
exports, and tombstone replay semantics are owned by #134. The proof fixture contains an unknown section and an unknown nested
message item whose exact bytes survive every round trip.

## 7. Evolution and retention

V1. Adding an optional integer-keyed payload field increments
`schema_version`. It need not raise `min_reader_version` when the older reader
can safely process the known projection while retaining the original frame.

V2. Changing cryptographic meaning, validation, identity, ordering, or a
required field raises `min_reader_version`. Existing frames never change
meaning retroactively.

V3. An implementation that does not understand a type, schema, field, message
item, key algorithm, or extension MAY retain it only when its containing
contract explicitly allows opaque retention. It MUST NOT report unsupported
semantics as verified.

V4. Exact retention means preserving every byte of the original complete
frame. Re-encoding an equivalent data model is not retention.

V5. Existing protobuf and JSON objects are never relabeled or transcoded into
the same identity. A later migration uses explicit routes/content types or a
bounded version transition. Hostile bytes are never codec-guessed.

V6. After generic validation, a reader applies this mandatory decision:

1. Unknown `type_id`, unsupported frame version, or
   `min_reader_version > reader_version`: opaque retention only where the
   containing contract permits it; otherwise reject as unsupported.
   For the root frame this is `opaque_retention_allowed`; unknown children of
   open schema fields are retained as stage 8.4 states. A child in an open
   field is retained for any of the three conditions. They all produce the same
   retained bytes, so precedence matters only to a reason an implementation may
   record: it is the first that applies of unsupported frame version (stage 3),
   unknown type, then `min_reader_version` above the reader's.
2. Known type and `schema_version <= highest_supported_schema`: interpret the
   exact supported schema, retaining the original frame alongside the typed
   projection.
3. Known type, newer `schema_version`, and
   `min_reader_version <= reader_version`: interpret only fields defined by the
   reader's highest supported schema, retain unknown fields plus the original
   frame, and never reconstruct that frame for forwarding or verification.

An application MUST NOT claim that unknown semantics were verified. This
decision is identical in TypeScript and Rust.

## 8. Cryptographic transcripts

All lengths below are unsigned big-endian integers. `utf8(x)` is the exact UTF-8
encoding of the already schema-validated string; the transcript performs no
additional normalization. `frame` is the complete bytes from section 1.
Concatenation is written `||`.

The common transcript is:

```text
u16be(len(domain)) || ascii(domain)
|| u16be(len(network_tag)) || utf8(network_tag)
|| u32be(len(frame)) || frame
|| context
```

T1. The content hash is SHA-256 of the common transcript with domain
`frank/content-hash/v1` and empty context. Its network argument is mandatory and
is selected without caller discretion:

|             Type | T1 network source                               |
| ---------------: | ----------------------------------------------- |
| 1, 3, 4, 5, 6, 7 | The validated payload's field 0                 |
|                2 | The opened type-4 statement's validated field 0 |
|        8, 16, 17 | The literal `frank`                             |

Content hashes are undefined for an unknown type. A pure opaque forwarder
therefore retains unknown bytes but does not invent a verified content hash.

T1a. A stable plaintext `content_digest` is SHA-256 of the common transcript
with domain `frank/message-content/v1`, where `frame` is the complete type-8
message-content-revision frame and context is empty. The type-8 frame excludes
recipient encryption and logical `message_id`, so recipient fanout preserves
content identity while edits produce a new digest. Its transcript network tag
is the literal `frank`, matching the type-8 field, so a composite message's
logical content remains independent of which settlement rail delivered it;
individual chain-bearing entries retain their own network tags.

T2. A directory signature uses the common transcript with domain
`frank/directory-signature/v1`, where `frame` is the complete type-4 directory
statement frame. Algorithms 1, 2, and 3 sign its 32-byte SHA-256 digest;
algorithm 16 signs the transcript bytes directly as required by S2a. Its network
argument is the type-4 frame's field 0 (T5). The
algorithm identifier lives in the type-2 signature entry and selects its exact
signing/verification rules. Schnorr identifiers distinguish BIP340 from
BCH-2019 Schnorr and other incompatible challenge hashes. `context` is empty.

T2a. A key-transition authorization uses the common transcript with domain
`frank/key-transition-signature/v1`, where `frame` is the complete type-7
key-transition-statement frame and the network argument MUST equal its network
field. The statement binds the directory subject, prior authority, revision,
and new key. The signature entry outside that frame names the algorithm; its
signer MUST exactly equal `prior_authority`, and that authority MUST be the
currently registered key or a separately registered offline recovery authority.
`context` is empty.

T3. The recipient payload digest used as the stamp stealth root is SHA-256 of
the common transcript with domain `frank/recipient-payload/v1`, where `frame`
is the complete type-5 recipient-encrypted-payload frame, its network argument
is that frame's field 0 (T5), and context is empty.
The accepted #60 derivation then adds this digest as a secp256k1 scalar to the
recipient public key and derives the non-hardened BIP32 path
`m/44/145/child_index/0`; this codec does not redesign that math. As in #60,
zero or a value greater than or equal to the secp256k1 group order rejects
rather than reducing modulo the order; a sender constructs fresh encrypted
payload bytes instead.

T3a. The #60 derivation referenced by S9 is byte-exact:

1. Interpret the 32-byte T3 digest as an unsigned big-endian integer `h`.
   Require `1 <= h < n`, where `n` is the secp256k1 group order.
2. Parse the destination account's 33-byte compressed SEC1 key as point `P`.
   The stamp root public point is `P + h*G`; reject infinity. The root chain
   code is the exact 32-byte T3 digest.
3. Starting from that public point and chain code, apply non-hardened BIP32
   public CKD to the numeric path `m/44/145/child_index/0`. At each component
   `i`, compute `I = HMAC-SHA512(chain_code,
compressed_parent_point || u32be(i))`; interpret `I[0..32]` as unsigned
   big-endian `IL`, require `1 <= IL < n`, set the child point to
   `parent_point + IL*G` (reject infinity), and set the next chain code to
   `I[32..64]`.
4. Serialize the final child point uncompressed, remove its `04` prefix, hash
   the remaining 64 bytes with Keccak-256, and use the final 20 bytes as the EVM
   destination address.
5. Every child index MUST be a non-hardened `uint31` (`< 2^31`); the CDDL
   range makes a violation a `schema` error at stage 8.2. A payment set's
   sorted child indices MUST be exactly contiguous `0..member_count-1`; a
   violation is `semantic`.
6. Any of `h` out of range, an unparseable destination point, infinity, or an
   invalid `IL` rejects the delivery as `cryptographic`; implementations do not
   skip to another index.

The recipient reconstructs the same spend key by setting the root private
scalar to `(recipient_private + h) mod n` (reject zero) and applying the same
non-hardened CKD components and rejection rules. This key-recovery rule does
not make the relay capable of deriving recipient private keys. Because every
offset is derivable from the type-5 frame, which the sender, relays, and
mailbox holders have, disclosure of any stamp child private key to one of them
reveals the recipient's registered identity key; as accepted on #60, child
private keys are identity-grade secrets, used transiently and never made
relay-visible. A separate stamp key is a change to #60's accepted derivation
and is not made here.

T4. Each payment member's on-chain commitment is
`SHA256(ascii("frank:dm-stamp-payment:v1") || T3_digest ||
u32be(child_index))`. The exact 32-byte value MUST be present in the verified
transaction commitment field and field 4 of that payment member. The field's
chain-specific layout (for Monad, calldata of a lokad identifier, a version
byte, and the 32-byte commitment) belongs to the chain adapter defined by the
Monad direct-message migration (#132), not to the codec. A missing or
different value rejects. Changing the payload frame, network, versions, or
child index therefore prevents transaction reuse for another message. Relay
delivery fees use a separate domain and are not part of this transcript.

T5. Protocol signatures and commitments MUST bind the network tag passed to
the transcript and MUST confirm it equals the frame's typed network field.

T6. A one-byte change anywhere in a bound frame changes the transcript. The
golden-vector proof MUST demonstrate changed hashes and failed verification;
canonical encoding alone is not authentication.

## 9. Validation order

A version-1 implementation runs the stages below in order, and within a stage
runs the listed checks in order. The first failing check determines the
category, and an implementation MUST NOT continue to report a later failure.

1. **Root limits.** The frame length exceeds `route_byte_limit` or
   `MAX_FRAME_BYTES`: `resource`. No implementation limit other than
   `route_byte_limit` applies here.
2. **Header.** Fewer than nine bytes or bad magic: `frame`. An embedded child
   of fewer than nine bytes never reaches this check: the parent's CDDL
   `framed-object` bound (`bstr .size (9..8388617)`) rejects it first as a
   stage 8.2 `schema` error, so this check applies to a root and to a child of at
   least nine bytes.
3. **Version.** An unsupported frame version is `unsupported`. Where the
   containing contract permits retention (F2), the outcome is instead a
   retained frame: the length field is not interpreted, later stages do not run,
   and every byte is kept.
4. **Length.** Declared length differs from the remaining bytes, including
   truncation, concatenation, and trailing bytes: `frame`.
5. **Envelope CBOR.** The CBOR passes A then B below.
6. **Envelope.** Exact envelope keys, types, and scalar ranges, and
   `min_reader_version <= schema_version`: `schema`.
7. **Payload CBOR and V6 decision.** The payload's single item passes A then B
   below. Byte strings are not opened as child frames at this stage. Then V6
   selects the outcome. A type is known exactly when the context's
   `supported_schemas` lists it, so a supported-schema list that omits a type
   makes that type unknown to the reader, and a required-type child (8.4) of an
   unlisted type is `unsupported`. An unknown root `type_id` or a `min_reader_version` above
   the reader's version is retained when `opaque_retention_allowed` is true and
   otherwise `unsupported`; either outcome ends the operation, so `generic`
   can yield them. A known type continues to stage 8, with the exact supported
   schema (V6.2) or, for a newer compatible schema, its highest-supported
   projection ignoring wildcard fields (V6.3).
8. **Typed structure**, for a known type only, in this order:
   1. type-specific limits: the root frame length against R2's 1 MiB for type 1
      and R3's 256 KiB for type 2 (type 3 uses the global limit), and the counts
      named by R2 through R4 read from the decoded fields before typed
      conversion: `resource`. R2's cumulative 256-item total is not an 8.1 check; it is
      charged in 8.4. The CDDL bounds that restate these limits, and so are
      `resource` when exceeded, are exactly: 64 payment members, 256 message
      items per array, the 524,288-byte ciphertext, 32 relay bindings, 16
      signatures, 4,096 journal facts, and 4,096 opaque sections. Every other
      CDDL bound, including a lower bound such as `[1*64]` given no items and
      the upper bounds of `[1*16 key-transition]` and `[1*8 account-ref]`, is `schema`;
   2. the type's CDDL structure and range rules, including network-tag,
      ASCII-identifier, and endpoint-ASCII syntax (S1, C6, S4), and C12 unknown
      keys: `schema`. A CDDL cardinality or `.size` bound that merely restates an
      R2 through R4 limit is `resource`, checked in 8.1, not `schema`;
   3. allocated-identifier checks (S2b, S2c; every encryption suite other than
      65535 is unallocated in version 1): `unsupported`;
   4. recursive opening of only the byte-string fields that the schema declares
      as framed objects (never opaque sections). Each child is an embedded
      frame with the root operation's shared counters (R1), not charged against
      `route_byte_limit`, and runs as follows:
      - Before opening each child of a message-item array (an open field), charge
        it against R2's 256-item total for the whole operation. Every such child
        counts, whether its type is known, unknown, or retained, and a
        required-type child (type 5, 6, or 8) never does. The first child over
        256 fails `resource` before that child's stage 2. The rule applies to any
        root and is labelled stage 8.4.
      - In an open field (a message item), a child of an assigned type other than
        16 or 17 (types 1 through 8) is `semantic`, checked after its stage 6
        like a required-type mismatch. Otherwise the child runs stages 2
        through 9 with V6 applied to it. Children open depth-first in array
        order, and the first failure wins. An unknown type, an unknown frame version, or a
        `min_reader_version` above the reader's (each V6.1) is
        retained as exact bytes whatever `opaque_retention_allowed` says and is
        not a failure; that flag governs only the root frame (V6.1).
      - In a required-type field (S8) and for the decrypted frame (10.1), the
        child runs stages 2 through 6, then its `type_id` MUST equal the
        required type, otherwise `semantic` (an unknown type is `semantic`
        too), then stages 7 through 9. V6.1 retention never applies; an unknown
        frame version at stage 3 or a `min_reader_version` above the reader's
        is `unsupported`, the latter at the child's stage 7 V6 decision.
9. **Semantics** needing only the root frame, its opened children, and, for a
   type-2 case, the context's prior statement (a `typed` or `full` case always
   supplies it). A child's own stage 9 covers only checks needing neither its
   parent nor the prior statement; a parent's stage 9 runs after its children
   have finished and first checks its own ordering and uniqueness. S10 and the
   prior-authority selection run in the type-2 parent's stage 9, not in the
   type-4 child's. The checks are ordering, uniqueness, cross-field, network,
   and S10, the presence of an entry signed by the statement subject,
   selection of the prior authority (S4a, T2a), the S9 requirement that the
   destination be key type 1, and T3a.5 index contiguity: `semantic`. No signature or digest is
   verified here.
10. **Cryptographic and external checks**, `full` only, in this order. A root
    other than type 1 or type 2 runs no stage 10 check. For every root other than
    type 1, `payment_policy` and `decrypted_frame_hex` MUST be null, and for every
    root other than type 2, `prior_directory_statement_frame_hex` MUST be null:
    1. Decrypted content: the supplied decrypted frame is an embedded child of
       the type-5 payload sharing its counters and not charged against
       `route_byte_limit`, but its length is checked against `MAX_FRAME_BYTES`
       (`resource`). It runs as a required-type child (8.4) of type 6. Only after the child
       passes stage 9, for suite 65535, its bytes MUST equal the ciphertext
       field, otherwise `cryptographic`.
    2. S8's type-6 network equality: `semantic`.
    3. S8's T1a digest equality: `cryptographic`.
    4. The type-1 field 3 T3 digest, T3a derivation, S9 destination equality:
       `cryptographic`.
    5. Payment observations: each member's transaction ID MUST have an
       observation whose destination, value, and commitment equal the encoded
       member, otherwise `cryptographic`; an observation with no member is
       ignored. Then the S3 rules: an observed value of zero, a checked-sum
       overflow, or a sum below the minimum is `semantic`. The consumption key of
       a stamp, that is what identifies it as spent, is the pair (T3 digest,
       child index); set-level uniqueness, distinct funders, and other
       relay-side policy belong to the relay and the migration tickets (#60,
       #132), not to the codec.
    6. Every signature entry and transition authorization verifies, not only the
       subject's: `cryptographic`.

Passes A and B of the CBOR stages. Pass A is a streaming syntax pass that
proceeds in byte order and fails at the first item that violates a resource
counter (`resource`) or is malformed (`malformed`). A declared length or count
is checked against the limits when its header is read, before its content is
examined, so an oversize declared length is `resource` even if the input is also
truncated. The element and entry limits also count the elements of an indefinite
collection as they are read. Extra data after the single item (C9) is `malformed` and belongs to
pass A. Pass A also scans an indefinite-length string, which C5 later rejects in
pass B: its chunks MUST be definite-length strings of the same major type and it
MUST end with a break, otherwise it is `malformed` (so a truncated `7f 61 61` is
`malformed`, and only a complete one is `noncanonical`). The string head is one
item and its chunks are not items; each chunk's declared length and the running
total of chunk lengths are checked against the string limit of section 4
(`resource`). A tag head is charged as an item (R1). Only if pass A succeeds does pass B run, in byte order, failing at the
first violation. Within one item, a non-minimal or indefinite encoding or a
duplicate or out-of-order key is `noncanonical` and is reported before a
forbidden class, including a non-uint map key (C1a), which is `schema`. So
`78 05 61` (truncated, with a non-minimal header) is `malformed`, and
`{"b":1,"a":2}` fails at its first key as `schema`, not as an ordering error.
"Within one item" includes the item's own head: the map `a1 78 01 61 01`, whose
key is a text string with a non-minimal length head, is `noncanonical`, not
`schema`. The non-uint class of that key is reported only when its head is
minimal.

No stage may consume funds, mark a payment used, advance a mailbox cursor, or
persist an interpreted record before every applicable later stage succeeds.

## 10. Vector manifest

[vectors.schema.json](vectors.schema.json) defines the committed corpus index.
Every case names its source implementation, complete frame hex, outcome, and
normative rules. A `reject` case names its stable error category and MAY name the stage that
determined it (`error_stage`, below). An `accept`
case run through `typed` or `full` additionally names the type/schema and
expected content hash. A `retain` case names the exact retained frame bytes and
does not claim interpreted semantics. Hostile vectors retain their input bytes
even when parsing fails so both implementations test the same input.

Each case's `validation_context` is normative input, not commentary, so no
ambient chain, database, reader, or decryption state can change its outcome.
`operation` selects the final section-9 stage: `frame` stops after stage 4,
`generic` after stage 7, `typed` after stage 9, and `full` includes stage 10.
`route_byte_limit` is the stage 1 caller limit, at most `MAX_FRAME_BYTES`.
`reader_version`, one highest supported schema per type, and
`opaque_retention_allowed` drive V6. Each supported type has schema versions
`1..highest`, and an object interprets by its own exact version's CDDL; until a
later schema is allocated the corpus has no schema-version-2 fixtures beyond
proof frames that carry `schema_version` 2 to exercise V6.3 against a reader
whose context supports only schema 1.

The operation bounds the categories a case may expect: `frame` allows `frame`,
`unsupported`, and `resource`; `generic` adds `malformed`, `noncanonical`, and
`schema`; `typed` adds `semantic`; only `full` allows `cryptographic`. A
`retain` case requires `opaque_retention_allowed: true`, but the flag only
permits retention and never turns an interpretable frame into one: a case whose
frame the operation fully validates, for example a version-1 frame under `frame`,
is `accept` whatever the flag says. Under `frame` a retain case is
valid only for an unsupported frame version (stage 3); an unknown root type is
retained at stage 7, which `frame` never reaches. The supported-schema list is sorted by
numeric type ID and has independently unique type IDs.

`error_stage` is the section 9 stage label of the failing check: `1` through
`7`, `8.1` through `8.4`, `9`, or `10.1` through `10.6`. Every check has exactly
one stage and one category, so a stage never changes a category. A failure inside
an opened child carries the child's own stage label (a child runs stages 2
through 9), except a check the parent makes about the child, which is the
parent's: the wrong-type, assigned-open-field-type, and R2-total checks are stage
`8.4`. The property is optional in the schema; when a case carries it, a runner
MUST compare it with the stage its implementation reports, and the committed
corpus carries it on every `reject` case. It is not allowed on `accept` or
`retain` cases.

Every `typed` or `full` case carries `prior_directory_statement_frame_hex`, and
every full case, including rejections and frames whose type is not yet known,
additionally carries `payment_policy` and `decrypted_frame_hex`; each is `null`
when it does not apply. A
`full` case whose frame is type 1 MUST have non-null `payment_policy` and
`decrypted_frame_hex`; a type-2 frame MAY have a null prior statement only for
bootstrap. For type 1, `payment_policy` provides the 32-byte minimum and
authoritative chain observations keyed by independently unique transaction ID;
the encoded payment assertions must match those observations. The
`decrypted_frame_hex` value is the exact authenticated decryption result to
validate as type 6. For proof-only encryption suite 65535, it is also exactly
the bytes carried in the ciphertext field; this is a deterministic codec
fixture, not a production cipher.

For a type-2 case, `prior_directory_statement_frame_hex` is either `null`
for bootstrap or the exact last accepted type-4 frame used for revision,
subject, transition, and offline-authority checks. These context fields make
acceptance or rejection a pure function of the manifest case.

The positive `full` type-1 direct-message case MUST also record
`content_digest_hex`, `payload_digest_hex`, and every
`payment_commitments_hex` value. Implementations compare those outputs with T1a,
T3, T4, the encoded payment member, and the simulated verifier-visible
transaction commitment. `payment_commitments_hex` position `i` corresponds
exactly to payment member position `i` after the S3 sort; it is not independently
sorted.

`paired_case` relationships are reciprocal: both named cases MUST exist, name
each other, and carry the same `pair_relation`. `one_byte_mutation` requires
equal-length `frame_hex` values differing at exactly one byte and demonstrates
T6. `insertion_order_equivalent` relates independently constructed values whose
canonical frames must be identical. `cross_language_roundtrip` relates the
TypeScript- and Rust-origin copies of the same frame. `opaque_retention` relates
an input and retained output whose bytes must be identical. A `retain` case's
`retained_frame_hex` MUST equal its `frame_hex` byte for byte.

Stable error categories are: `frame`, `unsupported`, `resource`, `malformed`,
`noncanonical`, `schema`, `semantic`, and `cryptographic`. Public APIs may give
more detail but MUST preserve this cross-language category. When bytes violate
multiple rules, the validation order in section 9 selects the first category;
implementations MUST NOT continue merely to report a later failure. Passes A
and B in section 9 define the order within CBOR validation.

| Failure                                                                                                                                                                                                                                                                                                                                                                              | Category        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| Frame or route length over a limit; any byte/depth/container/item limit; R2 through R4 type-specific limits, including a CDDL bound that restates them                                                                                                                                                                                                                               | `resource`      |
| Short header, bad magic, declared-length mismatch, concatenated frame, bytes outside the declared body                                                                                                                                                                                                                                                                               | `frame`         |
| Unknown frame version or uninterpretable type/schema without permitted retention; unallocated key type, algorithm, encryption suite, or algorithm/key-type/length pairing                                                                                                                                                                                                            | `unsupported`   |
| Truncated/invalid CBOR syntax, invalid UTF-8, reserved additional information, or extra CBOR item in body/payload                                                                                                                                                                                                                                                                    | `malformed`     |
| Non-minimal integer/length, indefinite value, duplicate/out-of-order map key, or another alternate encoding of an allowed value                                                                                                                                                                                                                                                      | `noncanonical`  |
| Forbidden CBOR class (float, tag, forbidden simple value; a stray break code is `malformed`; non-uint map key), envelope/CDDL type mismatch, undeclared key (C12), missing/extra required key, scalar range violation, network-tag/ASCII-identifier/endpoint syntax violation, wrong key length for an allocated key type, or `min_reader_version` above `schema_version`            | `schema`        |
| Wrong `type_id` in a required-type framed field; list order/uniqueness, revision or network versus the prior statement, transition count/linkage, missing subject-signed entry, unregistered prior authority, cross-field or network equality, key shape, contiguity, decrypted frame not type 6, type-6 network mismatch, or S3 overflow, zero observed value, or sum below minimum | `semantic`      |
| Digest, hash, or signature mismatch; ciphertext not equal to the suite-65535 decrypted bytes; T3a scalar/point failure; wrong derived destination; transaction observation or commitment mismatch                                                                                                                                                                                    | `cryptographic` |

Vector case IDs MUST be unique. `paired_case`, when present, MUST name a
different existing case, be reciprocal, and indicate two cases whose
relationship is asserted by their descriptions (for example, an accepted frame
and its one-byte cryptographic mutation). Dangling, self, one-way, and duplicate
pairs make the manifest invalid.

JSON Schema cannot express the following manifest-validity rules, so a
conforming corpus checker MUST enforce them and treat a violation as an invalid
manifest, not as a case outcome: unique case IDs; the pairing rules above;
`supported_schemas` sorted by `type_id` with unique type IDs; unique
`transaction_id_hex` values in `observations`; `retained_frame_hex` equal to
`frame_hex`; `route_byte_limit` not below the frame length unless the case
expects `resource`; non-null full-case context whenever the frame's type
requires it; a `prior_directory_statement_frame_hex` that is a valid type-4
frame, meaning it passes stages 1 through 9 as a type-4 root (in a deployment the
caller asserts it was accepted by full validation of the attestation that carried
it, which a corpus without a full case cannot show); and a `retain` case under `frame`
whose frame version byte is `01` (`frame` retention is valid only for an
unsupported version). It MUST also reject: an accept case whose `type_id` or
`schema_version` differs from its frame's envelope; a `payment_commitments_hex`
whose length differs from the frame's payment-member count; a non-null
`payment_policy` or `decrypted_frame_hex` for a root other than type 1, or a
non-null `prior_directory_statement_frame_hex` for a root other than type 2; a `retain` case whose root type is known, `min_reader_version` does not
exceed `reader_version`, and frame version is `01`; and any rule ID that is not a numbered
rule in this README. Every reject vector for a rule SHOULD have an accept twin
or a `paired_case`, and each limit rule SHOULD have an at-limit accept and a
one-over reject.

Some properties are outside what a decode manifest can assert and are verified
by each codec's own unit tests: writer-side canonical encoding (C1, C2, C11)
beyond `cross_language_roundtrip` pairs; the C7 `bigint` surface; R1's
no-partial-result guarantee; the section 9 no-side-effects rule; T3a branches
that need a digest with `h = 0`, `h >= n`, or an invalid `IL`, which no
producible input reaches; and retention of unknown children and of the original
frame after a V6.3 projection, which a future manifest field may assert.
