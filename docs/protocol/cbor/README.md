# Frank deterministic CBOR, version 1

Status: the current normative encoding and validation profile for the codec
proof in issues #131 and #182 and for the topic-event schemas of issue #136.
[`../../CASHWEB-PROTOCOL-SPEC.md`](../../CASHWEB-PROTOCOL-SPEC.md) is the
single human-semantics and status front door. This file owns frozen FRNK/CBOR
detail until its rules migrate there once; the CDDL owns structure and the
vectors are executable proof. The Monad topic write transport uses types 9–11
as described in [topic HTTP coexistence](topic-http-coexistence.md); other
production paths require their separate migration tickets.

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
of R2, R3, and R6 apply at stage 8.1 of section 9 instead, so a malformed or
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

|    Type ID | Name                                        | Schema                                     |
| ---------: | ------------------------------------------- | ------------------------------------------ |
|          1 | Recipient-specific direct-message delivery  | [direct-message.cddl](direct-message.cddl) |
|          2 | Signed directory attestation                | [directory.cddl](directory.cddl)           |
|          3 | Mailbox checkpoint                          | [checkpoint.cddl](checkpoint.cddl)         |
|          4 | Directory statement signed by type 2        | [directory.cddl](directory.cddl)           |
|          5 | Recipient-encrypted payload, with stamp E/X | [direct-message.cddl](direct-message.cddl) |
|          6 | Decrypted message content                   | [direct-message.cddl](direct-message.cddl) |
|          7 | Key-transition statement                    | [directory.cddl](directory.cddl)           |
|          8 | Plaintext message-content revision          | [direct-message.cddl](direct-message.cddl) |
|          9 | Topic post                                  | [topic.cddl](topic.cddl)                   |
|         10 | Topic post submission (post plus its burn)  | [topic.cddl](topic.cddl)                   |
|         11 | Topic vote submission                       | [topic.cddl](topic.cddl)                   |
|         16 | Container message item                      | [direct-message.cddl](direct-message.cddl) |
|         17 | UTF-8 text message item                     | [direct-message.cddl](direct-message.cddl) |
| 0xffff0001 | Proof-only unknown future message item      | Opaque fixture payload                     |

The CDDL rule for each type's payload is: 1 `direct-message-delivery`; 2
`directory-attestation`; 3 `mailbox-checkpoint`; 4 `directory-statement`
(schema 2; schema 1 is `directory-statement-v1`; schema 3, the registration
profile of section 11, is `directory-statement-v3`); 5
`recipient-encrypted-payload-v1` at schema 1 or
`recipient-encrypted-payload-v2` at schema 2; 6 `encrypted-message-content`; 7
`key-transition-statement`; 8 `message-content-revision`; 9 `topic-post`; 10 `topic-post-submission`; 11
`topic-vote-submission`; 16 `container-message-item`; 17 `text-message-item`.

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
that payload (`relay-binding`, `key-transition`, `journal-fact`, and section
11's `profile-entry` and `profile-header`). An embedded
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

R6. The topic-event frame limits are 1 MiB (1,048,576 bytes) for a type-9 post
and for a type-10 post submission, 64 KiB (65,536 bytes) for a type-11 vote
submission, and 512 KiB (524,288 bytes) in one type-9 body. The body bound is
`resource` at stage 8.1, like the type-5 ciphertext. The 1 MiB limit is
deliberately the direct-message limit (R2): a post is public content that a
phone can buffer, and larger media is chunked or referenced. Topic text
(1 through 512 bytes) and burn transactions (1 through 16,384 bytes) are plain
CDDL bounds, so exceeding them is `schema`.

These choices (type ids 9, 10, and 11, the 512-byte topic and 512 KiB body caps,
the 16 KiB burn-transaction bound, and the Monad calldata version byte `02`) are
chosen for version 1; changing any of them requires a new schema version, not an
edit to this one.

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

S2c. Encryption-suite identifier 65535 is reserved for schema-1 opaque
proof-vector ciphertext and MUST NOT be emitted by a production writer.
Type-5 schema 2 allocates suite `1` to `@frank/crypto-box` authenticated mode:
DHKEM(secp256k1, HKDF-SHA256) private-use KEM `0xFF00`, HKDF-SHA256 KDF
`0x0001`, and XChaCha20-Poly1305 private-use AEAD `0xFF01` with its 24-byte
derived nonce. The complete deterministic-CBOR crypto-box v2 envelope is field
4 and MUST repeat suite `1`; an outer/inner mismatch is `cryptographic` at stage
10.1. Private library suite IDs `0xFE01` through `0xFE03` are not Frank-CBOR
allocations and MUST NOT appear on this wire. A crypto-box envelope is not a
FRNK frame. The codec never infers a suite from a nonce or ciphertext length.

S2d. Suite 1 passes the canonical deterministic-CBOR encoding of
`dm-crypto-context-v1` to crypto-box as its `context`. The context binds, in
numeric-key order: domain `frank/dm-crypto-context/v1`; network; routing sender
and recipient account references; the exact opened sender and recipient
directory-statement T1 hashes; the distinct sender and recipient message-DH
keys `M`; recipient stamp key `P'`; `E`, `X`, and the DLEQ proof; suite `1`;
object type `5`; schema `2`; and minimum reader `2`. Account references use the
common two-field schema and every `M`/`P'` entry MUST be key type 1 with a
33-byte compressed SEC1 point. No context field is optional. The sender and
recipient public keys supplied separately to crypto-box MUST byte-match fields
6 and 7. A context, key, outer/inner suite, envelope-version, KEM, or routing
mismatch fails as one non-oracular `cryptographic` result at stage 10.1 before
payment ownership, durable storage, or forwarding. The recipient can construct
the same authenticated-mode transcript and therefore no ciphertext is a
transferable proof of sender authorship.

Because this context is the complete schema-2 field contract, a reader that supports type 5
through schema 2 MUST reject a higher type-5 schema as `unsupported` at stage 7 rather than
apply V6.3 projection. Likewise, a reader supporting only type-5 schema 1 MUST reject schema 2.
A type-5 schema-2 frame whose `min_reader_version` is not exactly 2 is also `unsupported` at
stage 7; the header value may not differ from the value authenticated by S2d.
A future type-5 schema must allocate an updated authenticated context (and raise its reader
requirement) before adding fields. This type-specific fail-closed rule prevents retained extension
bytes from falling outside the AEAD transcript.

S3. Payment members are ordered by numeric `child_index`, then bytewise
`transaction_id`. Child indices and transaction identifiers MUST each be
independently unique. Because T3a.4 also requires the child indices to be exactly contiguous
`0..member_count-1` and unique, the `transaction_id` tie-break can never decide
an order; a verifier still checks both rules, and every violation is `semantic`. Child indices are `uint31` values in
`0..2147483647` (a range kept from the #60 design; no BIP32 derivation is involved, T3a). Amounts need not be equal. Independently verified values are
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

S8. A type-1 delivery's network (field 0) MUST equal the opened type-5
payload's network (field 0); this is a stage 9 `semantic` check. Its
destination account (field 1) is the stamp key `P'` of S9, which is a payment
key and is not compared with the type-5 recipient account (field 2); that
field stays the routing recipient identity (no codec rule relates the two). For `full`, the decrypted type-6
frame's network (field 0) MUST equal the type-5 network (`semantic`), and its
digest (field 3) MUST equal the T1a digest of its opened type-8 frame (field 2)
(`cryptographic`); these are steps 10.2 and 10.3 of section 9. A framed field
whose schema requires a specific type (type-1 field 2 is type 5, type-2 field 0
is type 4, a key-transition's field 0 is type 7, type-6 field 2 is type 8,
type-10 field 1 is type 9) MUST
carry that `type_id`, otherwise `semantic`, reported at stage 8.4 of the parent as section 9 orders it;
such a field
is never an open field. Message-item array
order is authored semantic order, not a set to be resorted.

S9. The type-1 destination account (field 1) is the recipient stamp key `P'`
that the sender used, and MUST be key type 1 (otherwise `semantic`). Which key
`P'` may be, its binding to the recipient's directory statement, belongs to
S10a and is checked at stage 10.4, not by this rule. For each payment, the
type-5 fields `E` (6), `X` (7) and proof (8) verify by T3b, and `X`, the
network, `P'` and the child index derive, by T3a, the exact child public key
and chain address. Payment field 3 MUST equal that canonical address, the
independently observed transaction destination MUST equal field 3, and payment
field 3 values MUST be independently unique, a stage 9 `semantic` list check
like S3's index and transaction-ID uniqueness. Value and commitment checks from
S3 and T4 remain separately required.

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

S10a. The stamp key. Directory-statement field 8, `stamp_key`, is the
recipient's stamp key `P'`. It is mandatory: there is no identity-key fallback
(owner decision on #198, superseding the optional-field design and the
downgrade pin of #207 and #211).

1. Statement shape and version. Field 8 is required in type 4
   `schema_version` 2 (with `min_reader_version` 2, because adding a required
   field raises it, V2) and is undefined in `schema_version` 1, where it is a
   `schema` error (C12). A schema-2 statement without field 8 is a `schema`
   error (missing required key). Field 8 MUST be key type 1, otherwise
   `semantic` in the type-4 statement's own stage 9. Whether the 33 bytes are a
   valid curve point is not a statement check: an invalid point makes every
   delivery to it fail at T3a.6. The protocol requires nothing about how `P'`
   was derived, and does not reject `P'` equal to the subject (the identity
   key); reusing the identity key forfeits the blast-radius protection of the
   rationale below and SHOULD NOT be done. Field 8 lies inside the signed type-4
   frame and changes only in a new revision; the codec inherits nothing from
   the prior statement.
2. Old statements and schema order. A schema-1 statement carries no stamp
   key, so an account whose current statement is schema 1 cannot receive
   stamped direct messages. A consumer's binding (item 4) has no candidate
   `P'` and rejects every one (`cryptographic`, stage 10.4). A sender holding
   only such a statement MUST NOT build a delivery, MUST NOT fall back to the
   identity key or any other key, and MUST fail with the distinct sender-side
   error `recipient_stamp_key_missing`, cross-language category `semantic`.
   That outcome is a sender API result, not a frame outcome, so the manifest
   has no vector for it and each codec's unit tests cover it. A reader whose
   `reader_version` is below 2 cannot interpret a schema-2 statement (V6.1);
   as a required-type child it is `unsupported`. A same-subject statement
   whose `schema_version` is lower than the prior statement's is `semantic`
   (S10, type-2 stage 9), so a subject cannot drop a stamp key it published; a
   new subject (S10) starts fresh. The way out of the schema-1 state is to
   publish a schema-2 statement (migration UX: open question below).
3. Same-subject update. A revision that adds field 8 (schema 1 to 2) or
   rotates it with an unchanged subject is a same-subject update under S10
   (revision strictly greater, field 5 absent, so a key transition present
   with an unchanged subject is `semantic`), because a stamp key confers no
   authority over the directory. A change of subject needs the S10 transition,
   and the successor states its own field 8: a stamp key does not survive a
   subject change.
4. Binding of `P'`. A consumer (a relay verifying a stamp, or the recipient)
   MUST require the type-1 field 1 key `P'` to equal exactly one of: (a) the
   recipient's current stamp key, field 8 of the recipient's current
   statement; or (b) the previous stamp key (item 5). Any other `P'` is a
   `cryptographic` reject at stage 10.4, a check distinct from the point, DLEQ
   and destination checks there: a key the sender chose, the identity key
   (unless it is field 8), a key two or more rotations old, and every key when
   the current statement is schema 1. Decision #207 calls this a "distinct
   reject category"; this specification deliberately keeps the category set
   unchanged and makes it a distinct check, isolated by construction in the
   vectors (everything else in the case is valid). The input is the validation
   context's `recipient_directory_state` (section 10). The rule runs in `full`
   only: a `typed` case never evaluates it, so `typed` accepts a frame whose
   `P'` is not the recipient's key. It is stage 10, not stage 9, because it
   needs directory state that is neither the frame nor the prior statement, as
   payment observations do. No recipient entry (a null state) fails closed
   with the same reject. Which statement is current, and how fresh it is,
   stays with the directory migration (#133).
5. Rotation and the previous key. The consumer tracks, per subject, the
   current stamp key and the previous stamp key, and each accepted statement
   updates them exactly so: if its field 8 equals the current stamp key,
   nothing changes (previous never equals current); otherwise previous becomes
   the old current stamp key (null when there was none, that is, after a
   schema-1 statement or a new subject) and current becomes the statement's
   field 8. Both are consumer state and MUST be persisted; a restart that
   loses them, or a verifier handed an old statement, recomputes them from the
   statement it holds and fails closed (an old schema-1 statement rejects
   stamped deliveries; freshness is owned by #133). A sender whose statement is
   one rotation stale still delivers. A sender whose statement is two or more
   rotations stale pays on chain to a child of a key the consumer rejects: the
   payment is not accepted as a stamp and the sender cannot recover it (a
   stranded-funds risk; only a recipient still holding the retired secret can
   move it). The staleness can also run forward: a sender holding the newest
   statement while the relay has not yet seen it is rejected by item 4, and
   the recipient can still spend on chain, so that is a delivery reject, not a
   loss.
   Decision (#211): the grace is the immediately previous stamp key only, and
   a rotation done because a stamp secret leaked MUST be followed by a second
   rotation to close the window. Until then a holder of the leaked secret can
   build valid frames with `P'` equal to the previous key, pay its own stamps
   into children of it and sweep them back, and sweep honest senders' late
   stamps. Bounding the grace by time (needs a clock) and by a revision count
   were rejected for now; changing this is a text change to this paragraph and
   its vectors. How a sender learns of a rotation is owned by #132 and #133.
6. Accepted gap. Nothing proves that the subject controls the secret behind
   field 8 (no proof of possession), so a subject can publish a key it cannot
   spend with. The consequence is spam or confusion (stamps to an address the
   recipient cannot move, or another key's owner can), not theft from a third
   party.

Why a separate key. Child keys are `t_i*d'` with `t_i` computable by every
holder of the frame (T3a), so a leaked child private key reveals `d'` (T3a
exposure). If `d'` were the identity key, one leaked stamp key would hand over
directory, transition and mailbox authority, so the base must be a key whose
exposure is tolerable: `P'`. This cannot be avoided by a cleverer derivation: a
scheme where the relay computes child public keys from the base public key and
public data alone uses a public homomorphic tweak, and under any such tweak the
child secret is a public function of the base secret, so a child leak reveals
the base. Hardened BIP32 escapes only by needing the parent private key, which
the relay never has.

Wallet convention (non-normative: the wire requires only a valid key-type-1
point in field 8, and says nothing about how it was made, so a client MAY use
any independent key). Recommended, so that `P'` is recoverable from the seed and
no extra secret is stored: derive `d'` as a hardened child of the wallet seed at
`m/44'/60'/2'/0'/{rotation}'` (every level hardened; `2'` is unclaimed, `0'` is
the burner pool and change, `1'` the identity). Hardening matters because with
a non-hardened child, its private key plus the parent chain code reveals the
parent private key; a hardened path makes `d'` reveal neither the identity key
nor any sibling. `rotation` starts at 0 and increases by one per rotation; a
wallet restored from seed finds the current index by matching derived keys
against field 8 of its own statement. It SHOULD NOT export an extended public
key at `m/44'/60'/2'`, which would let its holder compute every `P'`. It
SHOULD NOT publish the identity key as `P'`, and `P'` SHOULD NOT be computable
from public data. A wallet keeps retired stamp secrets for as long as it
accepts stamps to them (item 5).

Open questions for S10a (recorded, not decided here):

- DLEQ encoding: the primitive (a Chaum-Pedersen equality proof over
  secp256k1) is standard, and BIP-374 specifies it with test vectors and an
  optional message input that could carry the network binding. T3b instead
  uses a bespoke encoding (its own domain-separation strings, challenge layout,
  deterministic nonce derivation, and the network folded into the hash). This
  is an open question for the cryptographer: adopting BIP-374 verbatim would
  narrow the review to how Frank uses the proof. Details of BIP-374 here are
  from memory and must be checked against the BIP text before any change. Not
  decided; the T3b encoding in this document is what the vectors pin.
- Cryptographer review is still required for the DLEQ construction (T3b), the
  stamp-child derivation (T3a) and the mandatory separate key, before any
  implementation ships.
- Migration UX: existing accounts with a schema-1 statement receive no stamped
  messages until they republish a schema-2 statement; how the wallet prompts,
  batches and times that republish (and how senders learn of it) is unspecified
  (#133 and #132). Recommendation: the wallet republishes automatically on next
  unlock and shows the account as "not yet reachable" until then.
- Rotation: whether the wallet should rotate on a schedule, on suspected
  leak only, or never; the one-key grace of item 5 means a leak rotation needs
  a second rotation to close it (#211). Recommendation: rotate only on
  suspected leak or explicit request.

S11. A type-10 post submission's network (field 0) MUST equal the opened
type-9 payload's network (field 0): a stage 9 `semantic` check. A type-11 vote
submission has no opened child, so its network is bound only by T7 and T8.

S12. Topic identity and structure. The identity of a post is the T1 content
hash of its complete type-9 frame. Field 2 of a type 9 (the parent post) and
field 1 of a type 11 (the target post) each hold such a hash. A top-level post
omits field 2; a `null` value is a `schema` error, so every post has exactly one
canonical encoding. The codec cannot check that a parent or target exists, and
a post cannot name itself (its hash would depend on its own bytes). The topic
is exact UTF-8 text: no case folding, trimming, segment splitting, or Unicode
normalization is applied, so a consumer that wants any of those states its
policy explicitly (as S4 does for endpoints). The body is an opaque byte string
in this version; the topic in a type-9 frame is authoritative for routing, and a
body that repeats a topic or parent is not cross-checked by the codec.

Known property, first-burner authorship. A post has no author field and no
nonce: its identity is its T1 hash and its author is the sender of the first
confirmed burn that carries its T7 commitment (T8). Anyone who sees a public
post can submit the byte-identical frame with their own burn; the first burn to
confirm is the author, and the original author's burn then counts only as a
vote. Front-running from the mempool alone is not possible, because the
commitment hides the content until the post is public. Adding an author or a
nonce to the post would close the race but changes the schema, so it is a
candidate for a later schema version, not a version-1 rule.

## 6. Fixture schemas and identity boundaries

The CDDL files describe the three proof families required by #131 and, in
[topic.cddl](topic.cddl), the topic events of #136. CDDL cannot
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

Stamp destinations (decided on #198, superseding the #60 derivation): the
sender picks a fresh scalar `e` and puts `E = e*G`, `X = e*P'` and a
Chaum-Pedersen (DLEQ) proof that both use the same `e` in the type-5 frame, so
the T3 digest and T4 commitment cover them. Child `i` is `t_i*P'` with `t_i`
hashed from the network and `X`, and the proof is bound to the network too, so
a copied `(E, X, proof)` on another network fails and its addresses are not
reused (decided on #208; type-5 field 2 is deliberately not bound, which keeps
the stamp key independent of the routing identity). The relay verifies the proof and derives every child from
public points, so it checks that each payment lands on a recipient-controlled
address with no interaction; the recipient computes `X = d'*E` and spends with
`t_i*d'`. No scalar is delivered, so a sender cannot burn funds by withholding
one. The construction is multiplicative rather than additive, and uses no BIP32,
chain code, or HMAC. A cryptographic review of the DLEQ construction is
required before any implementation ships it.

`schema_version` stays 1 for type 1. Type 5 schema 1 remains the proof-only
nonce/ciphertext layout; production writers MUST emit type 5 with
`schema_version = 2` and `min_reader_version = 2`, carrying the complete
crypto-box envelope in field 4 and stamp fields in 5 through 7. Type 4 gets
`schema_version` 2 with
`min_reader_version` 2, per V1 and V2, because the stamp key is a required
field (S10a.1): schema 1 is the statement layout without field 8 and stays
readable by a schema-2 reader, and a reader below version 2 retains a schema-2
statement opaquely and never treats it as a statement without a stamp key.
Section 11's registration profile is type-4 `schema_version` 3 and keeps
`min_reader_version` 2 per V1, because its field 9 is optional: a schema-2
reader projects a schema-3 statement through V6.3 and retains field 9.

Migration. Profiles registered today are protobuf profiles and carry no field
8; until the directory migration (#133) lets a subject publish a schema-2
statement, every such account has no stamp key and cannot receive stamped
direct messages, and a sender MUST fail rather than fall back to the identity
key (S10a.2). #198 supersedes the #60 stamp derivation, and #132's reliance on
it, for the CBOR profile; #132 carries the implementation (codecs, wallet, Rust
registry).

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

### Topic events

Type 9 is a public post: a network, a topic, an optional parent post hash, and
an opaque body. It carries no burn, author, or vote. Type 10 wraps the exact
type-9 frame together with the raw signed transaction that burns for it, and
type 11 carries a raw signed burn for an existing post together with that post's
hash. The wrapper exists because a burn commits to the identity of the post
(T7), and a frame cannot contain a commitment to itself; this is the same
reason a directory signature lives in type 2 outside the type-4 statement. The
author, the vote direction, and the vote weight are properties of the verified
chain transaction (T8). Neither wrapper repeats them, so there is one source of
truth and nothing for a relay to reconcile.

A post is public content, so the body is not encrypted. Its payload is opaque in
this version: the forum payload migration (#113) will define what a body holds.
The protobuf path keeps working unchanged until that migration's explicit
cutover; the two encodings never share an identity (V5), because a CBOR post is
identified by its T1 hash and a protobuf post by the SHA-256 of its payload. A
protobuf object is never transcoded into a type 9, 10, or 11, or the reverse.

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

|                        Type | T1 network source                               |
| --------------------------: | ----------------------------------------------- |
| 1, 3, 4, 5, 6, 7, 9, 10, 11 | The validated payload's field 0                 |
|                           2 | The opened type-4 statement's validated field 0 |
|                   8, 16, 17 | The literal `frank`                             |

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

T3. The recipient payload digest is SHA-256 of the common transcript with
domain `frank/recipient-payload/v1`, where `frame` is the complete type-5
recipient-encrypted-payload frame, its network argument is that frame's field 0
(T5), and context is empty. It is the payload identity that T4 commits to. It no
longer enters the derivation of stamp keys; because the frame includes `E`, `X`
and the proof, the digest and every T4 commitment cover them, so a payment
authorizes exactly one stamp derivation for one payload.

T3a. Stamp destination derivation, byte-exact. `n` is the secp256k1 group order,
`G` its generator, and all points are 33-byte compressed SEC1 encodings in
every hash input. `P'` is the type-1 field 1 key (S9), `E` the type-5 field 6,
`X` the type-5 field 7, and `network` the type-5 field 0. Both hashes below
(here and in T3b) start with the section 8 domain-and-network prefix
`u16be(len(domain)) || ascii(domain) || u16be(len(network)) ||
utf8(network)`, so every variable-length input carries its length.

1. Sender: pick a fresh uniformly random `e` in `1..n-1` for every type-5
   frame, set `E = e*G` and `X = e*P'`, and produce the T3b proof. A fresh `e`
   is a MUST: a repeated `e` repeats `E`, `X` and every child address, and
   links the payloads. A relay SHOULD flag a repeated `E` for the same `P'` as
   a linking warning; anyone who sees a frame can copy its `E`, so the warning
   MUST NOT attribute anything to the sender. `E` MUST NOT double as an encryption ephemeral of the
   payload's suite, and `X` MUST NOT be used as a key of any kind; it only
   feeds `t_i`.
2. For child index `i` (a `uint31`), `t_i` is SHA-256 of `u16be(20) ||
ascii("frank/stamp-child/v1") || u16be(len(network)) || utf8(network) ||
X || u32be(i)`, read as an unsigned big-endian integer. Require `1 <= t_i <
n`; there is no modular reduction and no skipping to another index.
3. The child public point is `t_i*P'`; reject infinity (unreachable for valid
   inputs). Serialize it uncompressed, remove the `04` prefix, hash the
   remaining 64 bytes with Keccak-256, and use the final 20 bytes as the EVM
   destination address.
4. A payment set's sorted child indices MUST be exactly contiguous
   `0..member_count-1`; a violation is `semantic` (stage 9).
5. Recipient: with stamp secret `d'` (`P' = d'*G`), compute `X = d'*E` (this
   MUST equal the frame's field 7), then the spend scalar for child `i` is
   `t_i*d' mod n` (reject zero, which cannot occur for `1 <= t_i < n` and
   `d' != 0`), and its public point is `t_i*P'`.
6. A `P'` that is not a valid non-infinity curve point, `t_i` out of range, or
   a derived address that differs from payment field 3 rejects the delivery as
   `cryptographic` (stage 10); an implementation does not skip to another index.
   Whether `P'` is the recipient's key is S10a.4, not derivation.

Exposure. Any leaked child private key `k_i = t_i*d' mod n` reveals
`d' = k_i * t_i^-1 mod n`, because every holder of the frame can compute `t_i`.
Holding `d'`, an attacker can spend the stamps of the frames it also holds
(spending needs `X = d'*E` from each frame), and no others; a relay or mailbox
operator holds the frames it stores. That is the whole blast radius when `P'` is
an independent stamp key (S10a, "Why a separate key"): directory signatures,
key transitions and mailbox authority are unaffected. If a subject nevertheless
publishes its identity key as field 8, the same leak reveals the identity key
itself; the protocol permits that and it SHOULD NOT be done.
A relay or mailbox holding the frame can already compute every child public key
from `P'`, `X` and the network, but not any private key. Whoever knows `e` (the
sender) cannot spend, since spending needs `d'`.

Precision and data minimization (decided on #198). Recovering `d'` from a
leaked child key needs both the child private key `k_i` and that message's `X`:
`t_i = H(domain || network || X || i)`, so `k_i` alone reveals nothing, and `X`
is held by the sender, the relay and the recipient but never appears on chain.
The realistic adversary is therefore a compromised or logging relay combined
with a wallet-side key leak. To keep that combination unlikely:

- `X` is required field 7 of the type-5 frame, so a relay holds it inside the
  stored frame bytes, and a stored frame MUST NOT be edited (the digests and
  the proof cover `X`). A relay SHOULD therefore delete the entire stored frame,
  and any derived index or cache that holds `X`, once the stamp payments of the
  frame have settled or the message has expired. This is a retention limit on
  the whole record; it does not permit stripping `X` from a frame that is
  kept. The rule is about `X`; `E` is public and the recipient (any device
  holding the seed) re-derives `X = d'*E` on demand, so restoring a second
  device from the seed and its mailbox messages needs no separately stored `X`.
- A wallet SHOULD NOT persist child private keys. It SHOULD derive `t_i*d'` just
  in time from the seed, sign with deterministic nonces, wipe the value, and
  SHOULD sweep confirmed stamp outputs promptly.
- `X` sits in the mailbox message and in the wallet's payment journal or
  caches. The wallet SHOULD NOT keep `X` in the journal or any cache longer than
  the payment journal needs; this concerns those copies and never permits
  modifying a frame.

Considered and not adopted: hash-chain tweaks (whoever holds the frame can
derive every `t_i` anyway); using the identity key as the scan key with `P'`
only as spend key (it moves identity-key use into the scanning loop and mixes
signing and ECDH on one key); a separate non-spending scan key (a second
published key); and binding the proof, the tweaks or `X` to a relay key or
relay receipts (small gain against relay-migration and retry complexity; the
proof stays relay-independent).

T3b. The stamp DLEQ proof (Chaum-Pedersen over secp256k1, made non-interactive
by Fiat-Shamir with SHA-256) shows that `E` and `X` use the same secret `e`
without revealing it, that is `E = e*G` and `X = e*P'`. It is the 64-byte
type-5 field 8: `c || s`, each a 32-byte big-endian scalar.

- Encoding rules (all `schema`, stage 8.2): fields 6 and 7 are exactly 33 bytes
  whose first byte is `02` or `03`, whose x coordinate is below the field prime
  `p`, and which lie on the curve (the point at infinity has no compressed
  encoding, so an all-zero or `00`-prefixed value is invalid); field 8 is exactly
  64 bytes with `c` and `s` each in `1..n-1`. Non-canonical scalars (`0`, or `n`
  and above) are never reduced.
- Challenge: `c = SHA-256( u16be(19) || ascii("frank/stamp-dleq/v1") ||
u16be(len(network)) || utf8(network) || G || P' || E || X || R1 || R2 )` read
  as a big-endian integer, where `network` is the type-5 field 0 (the same
  prefix style as T3a step 2), and `R1` and `R2` are defined below. Points are
  compressed (fixed 33 bytes), so the concatenation is unambiguous.
- Proving (sender): choose the nonce `k` in `1..n-1` either uniformly at random
  or as `k = SHA-256( u16be(25) || ascii("frank/stamp-dleq-nonce/v1") ||
u16be(len(network)) || utf8(network) || e || P' || E || X )` (`e` as 32 bytes), taking a fresh random `k` in the 2^-128
  case that value is out of range. `k` is sender-private and not on the wire.
  The network is in the hash so that one `e` on two networks cannot reuse `k`
  under two challenges, but `e` must still be fresh per frame (T3a step 1). The same `k` under two different challenges reveals `e` (`e = (s1 - s2) /
(c1 - c2) mod n`), and a predictable or biased `k` leaks it; a constant, a
  counter, or a hash without `e` is therefore not allowed. `e` discloses nothing about
  `d'` (`E` and `X` are public), but whoever learns it can mint valid proofs for
  the same `(E, X)` on another network or frame, which defeats the network
  binding for that pair. Set `R1 = k*G`, `R2 = k*P'`, compute `c` as above, and
  `s = k + c*e mod n`. If `c` is not in `1..n-1` or `s = 0` (probability about
  2^-128), choose a new random `k`.
- Verifying (relay and recipient): parse `P'`, `E`, `X` (T3a step 6 covers an
  invalid `P'`), reject infinity, parse `c` and `s` under the encoding rules,
  set `R1 = s*G - c*E` and `R2 = s*P' - c*X`, reject if either is infinity,
  recompute the challenge and compare it with the encoded `c` as 32 bytes.
  Any failure, including a well-formed `X` that is not `e*P'` for the `e` behind
  `E`, is `cryptographic`.

This binds `G`, `P'`, `E`, `X` and the network by including them in the hash,
so a proof cannot be replayed for another recipient key, another point pair or
another network. The range checks on `c` and `s` are redundant with the hash
comparison for acceptance (an out-of-range scalar could only match by
accident), so they are observable only as a category (`schema` at 8.2 rather
than `cryptographic`), which is what the manifest vectors pin. Within one
network a copied `(E, X, proof)` gives the same child addresses again; T4 stops
another message reusing the transactions, and the repeated-`E` warning (T3a
step 1) is the linkage signal. The proof is not a signature over the frame; the
frame binding is T3 and T4. The construction needs cryptographic review before
implementation.

T4. Each payment member's on-chain commitment is
`SHA256(ascii("frank:dm-stamp-payment:v1") || T3_digest ||
u32be(child_index))`. The exact 32-byte value MUST be present in the verified
transaction commitment field and field 4 of that payment member. The field's
chain-specific layout (for Monad, calldata of a lokad identifier, a version
byte, and the 32-byte commitment) belongs to the chain adapter defined by the
Monad direct-message migration (#132), not to the codec. A missing or
different value rejects. Changing the payload frame (including `E`, `X` and the proof), network, versions, or
child index therefore prevents transaction reuse for another message. T4 is
otherwise unchanged by #198: `T3_digest` is the T3 digest of the whole type-5
frame. Relay
delivery fees use a separate domain and are not part of this transcript.

T5. Protocol signatures and commitments MUST bind the network tag passed to
the transcript and MUST confirm it equals the frame's typed network field.

T6. A one-byte change anywhere in a bound frame changes the transcript. The
golden-vector proof MUST demonstrate changed hashes and failed verification;
canonical encoding alone is not authentication.

T3c. Worked example of T3a and T3b, generated by a reference implementation
(pure Python, own secp256k1 and Keccak) and reproduced independently with
`@noble/curves`; the reference also checks sender-side and recipient-side
derivation, rejects tampered proofs and a proof copied to another network, and
asserts these constants. The values are inputs for the vector corpus, not
production keys: `d'` and `e` are the SHA-256 of fixed ASCII strings, `k` is the
deterministic nonce of T3b, and the network is `monad`.

```text
network                     monad
d' (recipient stamp secret) 1a57e32fda8d40f4cac284d87c5517018b9686966999baf04e380e71071cfd54
P' = d'*G                   03f7fc9b839b4c4c8ff821777ecc410b461d6ca6b36e931ddbfadda8b37a55ae33
e  (sender scalar)          dc99a5298a2008c5d8980f5f2524335a6810606642ad01c8653b053663a86d85
E  = e*G                    022f88fd8059bf1bfda332a2ff01f4667efdc1d8526562ecbd6bcac57ace81b6c3
X  = e*P' = d'*E            02d066aa56e65e5cba4051500237a51ae9fd16c2c3476904d47d667f9fe1fca3e9
k  (proof nonce)            488a39bee567858c457d6b53bcd01e5cc30cd0ff115fac29dae896d93ef9c9ef
c                           bf8f2ddfeb72fb808d95507bf325ca2e09ea762fd874aef4422a74b7b82e327d
s                           a6708a4fa9553e426718e3cf8ed714d75546b0458f8a4ef1820c30dce4b0163a
proof = c || s              (the 64 bytes above, concatenated)
t_0                         5f35332e2497524346eedbfbef92fb2691e4958a60a1c81181575d5a8aa9fb9d
child_0 public = t_0*P'     026d5b5608b352c2eeb78127d118e3ed07f0616e4d69f03e2265ed68f14d44d756
child_0 EVM address         0x7484023b108dbd1620c7dd17b7ce6d5789d519a9
t_1                         8004c399b7e0b38ef928eb6c42767525d8500127eca05c950e52fa178d975a97
child_1 EVM address         0xd6590830f44ea6ba318cbcae2591f87c5dfebf37
spend scalar for child_0    t_0*d' mod n  (its public point equals child_0)
```

T7. The topic burn commitment is `SHA256(ascii("frank:topic-vote:v1") ||
u16be(len(network)) || utf8(network) || target_hash)`, where `network` is field
0 of the type-10 or type-11 frame and `target_hash` is 32 bytes: for a type 11,
its field 1; for a type 10, the T1 content hash of the opened type-9 frame
(field 1). A post's own burn is therefore a vote on that post, and one function
serves both. A commitment binds the network (T5) and the exact target, so a
burn transaction cannot pay for a post or vote on another network, on another
post, or on a post whose frame differs by one byte (T6).

T8. A consumer that accepts a type-10 or type-11 event MUST derive the T7
commitment itself and MUST NOT accept one supplied by the client. It MUST verify
against the chain that the transaction carries exactly that commitment. The
vote direction, the burned value (the vote's weight), and the sender are the
verified transaction's, never an encoded assertion; the schemas carry none. A
burn transaction's consumption key is its chain transaction identifier, so the
same burn counts at most once whether it arrives as a type 10, a type 11, or a
legacy protobuf object. For Monad the calldata layout is
`"TPIC" || 0x02 || direction || commitment`, with direction byte `01` for an
up-vote and `00` for a down-vote. The layout of the legacy protobuf path
(`0x01`, commitment equal to the protobuf `payload_hash`) is a different
format: a consumer MUST NOT accept `0x01` calldata for a CBOR event or `0x02`
calldata for a protobuf object, so a burn made for one encoding cannot be
replayed into the other.

A type-10 post's own burn MUST be an up-vote (direction byte `01`): a post
enters the tally with positive weight, and a consumer MUST reject a type 10
whose burn carries `00`. The codec cannot check this, because the burn
transaction is opaque bytes and there is no stage 10 for these types, so the
rule is enforced by the consumer and pinned by its own tests, not by a manifest
vector.

S11 binds a type 10's network to its post's, and T7 binds a burn to its
network, but a type 11 has no opened post. A consumer MUST confirm that the
target post it holds belongs to the type-11 frame's network before counting the
vote, and MUST reject a vote whose target is unknown. The chain identifier and
burn address for each network come from the consumer's configuration, and the
consumer MUST check at startup that the network identifier it serves is tied
to the chain identifier it verifies against (for example `monad-mainnet` to a
mainnet chain id). Everything else about the chain adapter (confirmation depth
and value handling) belongs to the relay migration and is not decided by this
codec specification.

## 9. Validation order

A version-1 implementation runs the stages below in order, and within a stage
runs the listed checks in order. The first failing check determines the
category, and an implementation MUST NOT continue to report a later failure.

1. **Root limits.** The frame length exceeds `route_byte_limit` or
   `MAX_FRAME_BYTES`: `resource`. No implementation limit other than
   `route_byte_limit` applies here.
2. **Header.** Fewer than nine bytes or bad magic: `frame`. A child carried in a
   `framed-object` field and shorter than nine bytes never reaches this check:
   the parent's CDDL bound (`bstr .size (9..8388617)`) rejects it first as a
   stage 8.2 `schema` error. The check therefore applies to a root, to such a
   child of at least nine bytes, and to the stage 10.1 decrypted frame, which is
   supplied out of band and bounded only by `MAX_FRAME_BYTES`, so a decrypted
   frame under nine bytes fails here as `frame`.
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
      and R3's 256 KiB for type 2 (type 3 uses the global limit; R6 gives 1 MiB
      for types 9 and 10 and 64 KiB for type 11), and the counts
      named by R2 through R4 and R6 read from the decoded fields before typed
      conversion: `resource`. R2's cumulative 256-item total is not an 8.1 check; it is
      charged in 8.4. The CDDL bounds that restate these limits, and so are
      `resource` when exceeded, are exactly: 64 payment members, 256 message
      items per array, the 524,288-byte ciphertext, the 524,288-byte topic body, 32 relay bindings, 16
      signatures, 4,096 journal facts, and 4,096 opaque sections. Every other
      CDDL bound, including a lower bound such as `[1*64]` given no items and
      the upper bounds of `[1*16 key-transition]` and `[1*8 account-ref]`, is `schema`;
   2. the type's CDDL structure and range rules, including network-tag,
      ASCII-identifier, and endpoint-ASCII syntax (S1, C6, S4), and C12 unknown
      keys, plus the T3b encoding rules for type-5 schema-1 fields 6 through 8 and schema-2
      fields 5 through 7: `schema`. A CDDL cardinality or `.size` bound that merely restates an
      R2 through R4 or R6 limit is `resource`, checked in 8.1, not `schema`;
   3. allocated-identifier checks (S2b, S2c; type-5 schema 1 permits only proof suite 65535,
      while schema 2 permits only production suite 1): `unsupported`;
   4. recursive opening of only the byte-string fields that the schema declares
      as framed objects (never opaque sections). Each child is an embedded
      frame with the root operation's shared counters (R1), not charged against
      `route_byte_limit`, and runs as follows:
      - Before opening each child of a message-item array (an open field), charge
        it against R2's 256-item total for the whole operation. Every such child
        counts, whether its type is known, unknown, or retained, and a
        required-type child (type 5, 6, 8, or 9) never does. The first child over
        256 fails `resource` before that child's stage 2. The rule applies to any
        root and is labelled stage 8.4.
      - In an open field (a message item), a child of an assigned type other than
        16 or 17 (types 1 through 11) is `semantic`, checked after its stage 6
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
   selection of the prior authority (S4a, T2a), S9's destination key type and
   destination uniqueness, S10a.1 (the stamp-key type, in the type-4
   statement's own stage 9), S10a.2's schema-order check and S10a.3's
   same-subject rules, T3a.4 index contiguity, and S11's network equality
   between a type-10 submission and its opened type-9 post: `semantic`. No signature or digest is
   verified here, and the S10a.4 binding is not evaluated (it is stage 10).
10. **Cryptographic and external checks**, `full` only, in this order. A root
    other than type 1 or type 2 runs no stage 10 check. For every root other than
    type 1, `payment_policy`, `decrypted_frame_hex` and `recipient_directory_state`
    MUST be null, and for every root other than type 2,
    `prior_directory_statement_frame_hex` MUST be null:
    1. Decrypted content: the supplied decrypted frame is an embedded child of
       the type-5 payload sharing its counters and not charged against
       `route_byte_limit`, but its length is checked against `MAX_FRAME_BYTES`
       (`resource`). It runs as a required-type child (8.4) of type 6. Only after the child
       passes stage 9, for suite 65535, its bytes MUST equal the ciphertext
       field, otherwise `cryptographic`.
    2. S8's type-6 network equality: `semantic`.
    3. S8's T1a digest equality: `cryptographic`.
    4. The type-1 field 3 T3 digest, then in order: `P'` parses as a valid
       curve point (T3a.6), the S10a.4 binding of `P'` to
       `recipient_directory_state`, the T3b DLEQ proof (which includes `X` not
       equal to `e*P'`), the T3a `t_i` range for each member, and S9 destination
       equality: `cryptographic`.
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
       subject's: `cryptographic`. An entry whose algorithm is allocated but not
       verifiable in the reader's slice is `unsupported` before any verification
       runs (M7); `cryptographic` otherwise.

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
normative rules. The generated index is `vectors/manifest.json`. Rust encodings
of the three proof fixtures (direct message, directory attestation, mailbox
checkpoint) are committed separately in `vectors/rust-origin.json` so the
TypeScript codec can re-encode them; that file is not produced by the
TypeScript fixture builders. The pure hashes of the topic events (T1 of a
type-9 frame and the T7 commitment for a type-10 and a type-11 frame, each with
a one-byte mutation) are pinned in `vectors/topic-commitments.json`, which both
codecs recompute; a manifest has no field for a hash that is not a content hash. A `reject` case names its stable error category and
MAY name the stage that determined it (`error_stage`, below). An
`accept` case run through `typed` or `full` additionally names the type/schema and
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
whose context supports only schema 1, and type 4, whose schemas 2 and 3 (both
with `min_reader_version` 2) require a context with `reader_version` at least 2
and type 4 supported at schema 2 or 3; a schema-1 statement is also interpreted by that
context (versions `1..highest`).

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
`8.4`. The property is optional in the schema, and the committed corpus carries it
on every `reject` case. A runner that reports validation stages SHOULD compare
`error_stage`; a runner that reports only categories remains conformant and MUST
compare `error_category`. An `error_stage` beyond the operation's last stage
(`frame` 4, `generic` 7, `typed` 9) makes the manifest invalid. It is not allowed
on `accept` or `retain` cases.

Every `typed` or `full` case carries `prior_directory_statement_frame_hex`, and
every full case, including rejections and frames whose type is not yet known,
additionally carries `payment_policy`, `decrypted_frame_hex` and
`recipient_directory_state`; each is `null` when it does not apply. A
`full` case whose frame is type 1 MUST have non-null `payment_policy` and
`decrypted_frame_hex` (and `recipient_directory_state`, unless it is the
no-entry reject defined below); a type-2 frame MAY have a null prior statement only for
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

Every `full` case also carries `recipient_directory_state`, and a `typed` case
MAY carry it but `typed` ignores it, because the S10a.4 binding is stage 10.
For a type-1 case it is the recipient's directory state as the consumer holds
it: an object with `current_statement_frame_hex` (the exact last accepted type-4
frame for the recipient), and
`previous_stamp_key_hex` (the 33-byte compressed stamp key in force before the
current one, or null), maintained as S10a.5 defines; the current statement may be schema 1 (no
stamp key), in which case the previous key is null. It is
null for every root other than type 1 (a non-type-1 full case carries null), and
for a type-1 full case it is non-null except that null means no directory entry: such a full case
MUST be a `reject` with `error_category` `cryptographic` and `rules` including
`S10a`, which S10a.4 fails closed and the checker enforces. The state is the
recipient's by construction: type 1 has no recipient identity field (S8), so
the case, not the frame, names whose statement it is. The codec does not check that field 8 of the recipient statement is a curve point,
so a case may make that key `P'` to test the S10a.4 and T3a.6 checks apart.

The positive `full` type-1 direct-message case MUST also record
`content_digest_hex`, `payload_digest_hex`, and every
`payment_commitments_hex` value, plus `stamp_shared_point_hex` (`X`) and
`stamp_child_public_keys_hex` (one 33-byte compressed child key per payment
member, in the same order). Implementations compare those outputs with T1a,
T3, T3a, T4, the encoded payment member, and the simulated verifier-visible
transaction commitment. `payment_commitments_hex` position `i` corresponds
exactly to payment member position `i` after the S3 sort; it is not independently
sorted.

The corpus for #198 MUST include the vectors below. Each names its operation,
the section 9 stage, and its category.

| Vector                                                                                                                                                                                                                                 | Operation | Stage | Category        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----- | --------------- |
| Accept: `P'` equals the current field 8, DLEQ, digest and observations valid                                                                                                                                                           | `full`    | 10    | accept          |
| Accept: `P'` equals `previous_stamp_key_hex` (one-rotation grace)                                                                                                                                                                      | `full`    | 10    | accept          |
| Accept: type-2 statements with a greater revision and no field 5 that rotate field 8, and that add it (schema 1 to 2, migration), each plus a delivery to the new key; and a statement whose field 8 equals the subject (not rejected) | `typed`   | 9     | accept          |
| Accept: a delivery whose `P'` is not the recipient's key (the binding is not evaluated)                                                                                                                                                | `typed`   | 9     | accept          |
| Missing type-5 field 6, 7 or 8 (three vectors)                                                                                                                                                                                         | `typed`   | 8.2   | `schema`        |
| Wrong length for each of type-5 fields 6, 7 and 8 (three vectors)                                                                                                                                                                      | `typed`   | 8.2   | `schema`        |
| Field 6 and field 7 each: `x >= p` (an on-curve `x0` plus `p`), prefix `04`, prefix `05`, all-zero or `00` prefix, off curve                                                                                                           | `typed`   | 8.2   | `schema`        |
| Proof scalar: `c = 0`, `c >= n`, `s = 0`, `s >= n` (four separate vectors, `c` and `s` never combined)                                                                                                                                 | `typed`   | 8.2   | `schema`        |
| Type-1 field 1 with key type 1 and a 32-byte value                                                                                                                                                                                     | `typed`   | 8.2   | `schema`        |
| Type-1 field 1 with an unallocated key type                                                                                                                                                                                            | `typed`   | 8.3   | `unsupported`   |
| Type-1 field 1 with an allocated key type other than 1 (type 2 or 3, correct length; S9)                                                                                                                                               | `typed`   | 9     | `semantic`      |
| Type-4 field 8 with an allocated key type other than 1 (type 2 or 3, correct length; S10a.1)                                                                                                                                           | `typed`   | 9     | `semantic`      |
| Type-4 schema 2 without field 8, and type-4 schema 1 with a field 8 (S10a.1, C12), two vectors                                                                                                                                         | `typed`   | 8.2   | `schema`        |
| Type-2 attestation of a schema-2 statement opened by a context with `reader_version` 1 (V6.1, required-type child)                                                                                                                     | `typed`   | 7     | `unsupported`   |
| Payment child indices not contiguous from 0 (a gap, or starting at 1), and duplicate payment field 3 destinations                                                                                                                      | `typed`   | 9     | `semantic`      |
| Same-subject update (S10a.3) that changes only field 8 with a non-increasing revision, and one with a key transition present; a same-subject statement whose `schema_version` is lower than the prior statement's (S10a.2)             | `typed`   | 9     | `semantic`      |
| `P'` off curve, with the recipient state's field 8 equal to it (T3a.6 fails, the binding passes)                                                                                                                                       | `full`    | 10.4  | `cryptographic` |
| Foreign `P'`: the sender's own key, frame and proof otherwise consistent                                                                                                                                                               | `full`    | 10.4  | `cryptographic` |
| `P'` equals the identity key while field 8 is a different key (no fallback), and `P'` equals the identity key when the current statement is schema 1                                                                                   | `full`    | 10.4  | `cryptographic` |
| Recipient state whose current statement is schema 1 (no stamp key), with any type-1 `P'` other than the identity key (S10a.2)                                                                                                          | `full`    | 10.4  | `cryptographic` |
| Proof `c = 1`, `s = e` with `E = e*G` and `X = e*P'` (R1 and R2 are infinity; distinguishes a crash from a reject)                                                                                                                     | `full`    | 10.4  | `cryptographic` |
| `P'` two rotations old, and a null `recipient_directory_state` (no directory entry)                                                                                                                                                    | `full`    | 10.4  | `cryptographic` |
| One-byte proof change; wrong or substituted `X`; wrong `E`; `(E, X, proof)` copied from another network                                                                                                                                | `full`    | 10.4  | `cryptographic` |
| Payment address from the retired BIP32 derivation, and from `t_i` computed without the network                                                                                                                                         | `full`    | 10.4  | `cryptographic` |

Every `cryptographic` reject vector of this family MUST recompute the T3
digest, the T4 commitments, and the derived addresses from the values it
presents, with observations that match them, so that exactly one check fails
and the category is not an accident of an earlier mismatch. The off-curve `P'`
vector cannot: no `X = e*P'` or child address exists for it. It holds constant
the network, the recipient state (whose field 8 is that same key, so the S10a.4
binding passes), the payment members and matching observations, and the T3
digest and T4 commitments recomputed over the presented frame; `E`, `X`, the
proof and the destinations are arbitrary well-formed values, and the check
order (T3a.6 before the DLEQ and destination checks) means they are never
reached. Such a vector differs from an accept case in more than one byte and
is not a `one_byte_mutation` pair; only a deliberate digest-mismatch vector
is. Each of these rejects SHOULD have an accept twin: where one exists it is
recorded with `paired_case` and `pair_relation` `derivation_variant`,
otherwise the `description` names the accept case that shares its inputs (a
case has one `paired_case`, so a twin cannot be shared). The manifest records
its rules (`T3a`, `T3b`, `S9`, `S10a`).

`paired_case` relationships are reciprocal: both named cases MUST exist, name
each other, and carry the same `pair_relation`. `one_byte_mutation` requires
equal-length `frame_hex` values differing at exactly one byte and demonstrates
T6. `insertion_order_equivalent` relates independently constructed values whose
canonical frames must be identical. `cross_language_roundtrip` relates the
TypeScript- and Rust-origin copies of the same frame. `derivation_variant` relates one `full` type-1 accept case and one `full`
type-1 reject case built from the same recipient, network and payments that
differ in the single fault the reject's `description` names; the checker
verifies one accept, one reject, and equal operation and `type_id`.
`opaque_retention` relates
an input and retained output whose bytes must be identical. A `retain` case's
`retained_frame_hex` MUST equal its `frame_hex` byte for byte.

Stable error categories are: `frame`, `unsupported`, `resource`, `malformed`,
`noncanonical`, `schema`, `semantic`, and `cryptographic`. Public APIs may give
more detail but MUST preserve this cross-language category. When bytes violate
multiple rules, the validation order in section 9 selects the first category;
implementations MUST NOT continue merely to report a later failure. Passes A
and B in section 9 define the order within CBOR validation.

| Failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Category        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Frame or route length over a limit; any byte/depth/container/item limit; R2 through R4 type-specific limits, including a CDDL bound that restates them                                                                                                                                                                                                                                                                                                                                                                                                    | `resource`      |
| Short header, bad magic, declared-length mismatch, concatenated frame, bytes outside the declared body                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `frame`         |
| Unknown frame version or uninterpretable type/schema without permitted retention; unallocated key type, algorithm, encryption suite, or algorithm/key-type/length pairing; an entry whose algorithm is allocated but not verifiable in the reader's slice (M7)                                                                                                                                                                                                                                                                                            | `unsupported`   |
| Truncated/invalid CBOR syntax, invalid UTF-8, reserved additional information, or extra CBOR item in body/payload                                                                                                                                                                                                                                                                                                                                                                                                                                         | `malformed`     |
| Non-minimal integer/length, indefinite value, duplicate/out-of-order map key, or another alternate encoding of an allowed value                                                                                                                                                                                                                                                                                                                                                                                                                           | `noncanonical`  |
| Forbidden CBOR class (float, tag, forbidden simple value; a stray break code is `malformed`; non-uint map key), envelope/CDDL type mismatch, undeclared key (C12), missing/extra required key, scalar range violation, network-tag/ASCII-identifier/endpoint syntax violation, wrong key length for an allocated key type, a type-4 statement missing required field 8 or a schema-1 statement carrying it, a type-5 stamp field with the wrong length or an invalid point or proof-scalar encoding (T3b), or `min_reader_version` above `schema_version` | `schema`        |
| Wrong `type_id` in a required-type framed field; list order/uniqueness, revision or network versus the prior statement, transition count/linkage, missing subject-signed entry, unregistered prior authority, cross-field or network equality, key shape (including S10a.1's stamp-key type), a `schema_version` lower than the prior statement's (S10a.2), S10a.3, contiguity, decrypted frame not type 6, type-6 network mismatch, or S3 overflow, zero observed value, or sum below minimum                                                            | `semantic`      |
| Digest, hash, or signature mismatch; ciphertext not equal to the suite-65535 decrypted bytes; invalid `P'` point, `P'` not bound to the recipient's directory state (S10a.4), failed T3b DLEQ proof, T3a `t_i` range failure; wrong derived destination; transaction observation or commitment mismatch                                                                                                                                                                                                                                                   | `cryptographic` |

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
or `stamp_child_public_keys_hex` whose length differs from the frame's
payment-member count; a `stamp_shared_point_hex` that differs from type-5 field
7; a `stamp_child_public_keys_hex` entry that is not the T3a child key derived
from `X`, `P'`, the network and its member's index; a full type-1 accept case
with a null `recipient_directory_state`; a full type-1 case with a null state
that is not a `cryptographic` reject citing `S10a`; a full type-1 accept case whose state's current statement is schema 1;
a state whose `previous_stamp_key_hex` is non-null while its current statement
is schema 1 or equals the current stamp key; a non-null `payment_policy`, `decrypted_frame_hex` or
`recipient_directory_state` for a root other than type 1, or a
non-null `prior_directory_statement_frame_hex` for a root other than type 2; a `retain` case whose root type is known, `min_reader_version` does not
exceed `reader_version`, and frame version is `01`; and any rule ID that is not a numbered
rule in this README. Every reject vector for a rule SHOULD have an accept twin
or a `paired_case`, and each limit rule SHOULD have an at-limit accept and a
one-over reject.

Some properties are outside what a decode manifest can assert and are verified
by each codec's own unit tests: writer-side canonical encoding (C1, C2, C11)
beyond `cross_language_roundtrip` pairs; the C7 `bigint` surface; R1's
no-partial-result guarantee; the section 9 no-side-effects rule; T3a branches
that need `t_i = 0` or `t_i >= n`, which no producible input reaches, and the
infinity check on the child point, likewise unreachable (an infinity `R1` or
`R2` is reachable with `c = 1`, `s = e`, and the vector above distinguishes
only a crash from a reject); the sender MUSTs (a fresh `e` per frame, the T3b nonce rules, `E` not
an encryption ephemeral, `X` not a key); the recipient side (`X = d'*E` and the
spend scalar `t_i*d' mod n`); pinning the T3c constants, so that an encoding
change to a hash input (domain, network, point, index) is caught (a reference
mutation run kills every such change only through these constants); and a property
test that a leaked child private key yields only `d'` (T3a), which is the
identity key only if the subject published the identity key as field 8, and that
a sender holding only a schema-1 statement fails with `recipient_stamp_key_missing`
and builds no frame (S10a.2). The proof-scalar and point range checks
are redundant with hash equality for acceptance, so only the category in the
schema vectors above distinguishes an implementation that has them; and retention of unknown children and of the original
frame after a V6.3 projection, which a future manifest field may assert.

## 11. The account and attestation registration record

Status: the migration first slice of #106. This section pins the exact
deterministic-CBOR encoding of the account/attestation registration record that
today's protobuf `SignedPayload` wrapping `MonadProfile` carries (`packages/
cashweb/registry/proto/metadata.proto`, the backend `monad_profile.proto`, and
the verifier in `backend/cashweb/cashweb-registry/src/monad_profile_verify.rs`).
It is a pure serialization-format migration: same fields, same semantics, no new
identity schema. An explicit CBOR registration route and wallet helper exist,
but normal app and bot registration remain protobuf until the directory cutover
(#133) lands. It is normative for
[vectors/account-registration.json](vectors/account-registration.json) and
[vectors/account-registration-values.json](vectors/account-registration-values.json)
and for the codec implementation of #106's child B.

The record is a type-2 attestation of a complete type-4 statement frame
(section 6, Directory attestations), written at `schema_version` 3 with
`min_reader_version` 2: V1 bumps `schema_version` for the new optional field 9
and does not raise `min_reader_version`, because a schema-2 reader can safely
project the statement through V6.3 and retain field 9. Field 9 is present when
the profile carries at least one entry and absent otherwise. A schema-1 or
schema-2 statement that carries field 9 is a C12 `schema` error, a same-subject
update must not lower `schema_version` (S10a.2), and every schema-3 statement
still requires the stamp key (S10a.1). The codec-level rules of sections 2
through 9 are unchanged by this section except where M7 records an
`unsupported` category at stage 10.6 for allocated-but-unverifiable algorithms.

M1. Field mapping. Every protobuf field of the registration record maps 1:1
into the type-4 statement and its type-2 wrapper; nothing is dropped, nothing
new is invented, and the signature is always recomputed over the new bytes
(never transcoded):

| Protobuf field                                            | CBOR location (type-4 statement unless noted)                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `SignedPayload.public_key`                                | field 1, subject `account-ref`: key type 1, 33-byte compressed SEC1                    |
| `MonadProfile.timestamp` (ms)                             | field 2 (revision) and field 3 (`timestamp`), per M2                                   |
| `MonadProfile.ttl` (ms)                                   | field 6, expiry `timestamp`, per M3                                                    |
| `MonadProfile.entries` (`AddressEntry.kind/headers/body`) | field 9, `profile-entry` array, per M4                                                 |
| `SignedPayload.signature`, `scheme = ECDSA`               | type-2 wrapper field 1, `signature-entry` with algorithm 1, per M5                     |
| `SignedPayload.payload_digest`                            | absorbed: the SHA-256 digest of the frozen T2 transcript replaces it (M5)              |
| `SignedPayload.burn_amount`, `SignedPayload.transactions` | absent: registration is never burn-gated (the legacy verifier rejects a non-empty set) |
| (no protobuf counterpart)                                 | field 0, network tag (T5); field 4, relay bindings; field 8, stamp key `P'` (S10a)     |
| (no CBOR counterpart)                                     | the claimed registration address: derived from the subject, never stored (M6)          |

The last two rows are the frozen statement shape, not new semantics: field 0,
field 4, and field 8 are required fields of every type-4 statement, so the
first-slice registration fills them with the network it registers on (one of
the configured `MonadNetworkDescriptor` rows of
`backend/cashweb/cashweb-registry/src/network_tag.rs`, currently
`monad-testnet` or `monad-mainnet`), with the relay bindings the record is
published through, and with the wallet's stamp key. Which relay bindings a
wallet puts in field 4 at registration time is the directory cutover's (#133)
flow decision; the format is unchanged by it.

M2. Milliseconds to revision and timestamp, lossless. A source value `ms` (a
non-negative `int64` millisecond timestamp, the protobuf field's semantics)
becomes the statement's revision (`field 2`, the exact value of `ms`, which
therefore increases on every later update exactly as the protobuf verifier
requires) and its timestamp (field 3) as `seconds = ms div 1000` and
`nanoseconds = (ms mod 1000) * 1000000`, where `div` rounds toward negative
infinity and `mod` yields the non-negative remainder of that division (floor
semantics; TypeScript computes the remainder as
`((ms % 1000n) + 1000n) % 1000n` and its seconds as
`(ms - nanoseconds / 1000000n) / 1000n`, because bigint `/` truncates toward
zero; Rust uses `div_euclid` and `rem_euclid`). The inverse is `ms = seconds * 1000 +
nanoseconds div 1000000`; TypeScript implementations hold every part as
`bigint` (C7) because `ms` is an `int64`, and JSON vector files carry such
values as decimal strings because `2^63-1` exceeds the safe JSON integer range.
A negative `ms` has no unsigned revision: such a record is unencodable and the
mapping fails closed. The nanoseconds component is always a multiple of
`1000000`; a timestamp that is not came from no millisecond value, and the
migration reader MUST reject rather than silently truncate it. The round trips,
including `ms = 0` and `ms = 2^63-1`, are pinned in
`vectors/account-registration-values.json`.

M3. TTL to expiry. The protobuf `ttl` (milliseconds, `int64`) and the
registration timestamp `ms` produce field 6, an absolute expiry timestamp, as
`expiry = split_ms(ms + ttl)` with M2's split and its floor semantics, so a
negative total is a timestamp with a negative seconds component and is
encodable (the codec performs no clock check; a consumer may reject an already
expired record, which is #133 policy). The arithmetic MUST be done in a width
that cannot overflow (`i128` in Rust, `bigint` in TypeScript) before the split;
the result always fits the `timestamp` schema, because two `i64` millisecond
values sum below `2^64` and the seconds component of any value below `2^64` ms
is far below the `i64` maximum. Field 6 is present on every registration
record; a `ttl` of zero encodes an expiry equal to the registration timestamp.
The codec performs no clock check (S10's freshness policy stays with #133).

M4. Profile entries, field 9. The protobuf `repeated AddressEntry` becomes the
optional field 9: an array of 1 through 64 `profile-entry` maps in authored
order, which is never resorted (message-item array order is likewise authored,
S8), and absent when the profile carries no entries. One `profile-entry`:

| Key | Name      | CDDL value              | Meaning                                                                  |
| --: | --------- | ----------------------- | ------------------------------------------------------------------------ |
|   0 | `kind`    | `tstr`                  | The wallet's entry-type hint (`AddressEntry.kind`); consumer-interpreted |
|   1 | `headers` | `[0*64 profile-header]` | The entry's `map<string, string>` as a C11 list                          |
|   2 | `body`    | `bstr`                  | The entry body (`AddressEntry.body`), exact bytes                        |

One `profile-header` is `{0: name (tstr), 1: value (tstr)}`. The protobuf
headers are a set of name/value strings, and C1a forbids text keys in every
map, so the set is represented as a list sorted bytewise by the header name
(S1a) with duplicate names rejected; C11 applies with the header name as the
declared semantic key. An empty headers map is an empty array, an empty body an
empty byte string, exactly the protobuf defaults. The count bounds (`1*64`
entries, `0*64` headers) are plain CDDL bounds, so exceeding them is a `schema`
error at stage 8.2 and not a `resource` verdict (the 256 KiB type-2 frame limit
of R3 bounds the record first). Both maps carry the `* uint => frank-value`
wildcard, so a later schema may extend them and a V6.3 reader retains the
unknown fields, exactly as `relay-binding` does. Display-name content rules
(Decision #189) are consumer checks, not codec rules.

M5. Signature. The registration's type-2 wrapper carries the subject's
signature as exactly one entry in this slice: `{0: algorithm 1, 1: the
statement subject as the signer, 2: the signature bytes}`, where the bytes are
a strict-DER, low-S secp256k1 ECDSA signature (S2a, S2b: 8 through 72 bytes)
over the 32-byte SHA-256 digest of the frozen T2 transcript
(`frank/directory-signature/v1`, network = the statement's field 0, frame = the
exact complete type-4 frame, empty context). This pins the record this
migration writes; the frozen schema's allowance of further entries (a verified
co-signature, for example) is unchanged, and stage 9 requires an entry signed
by the statement subject while stage 10.6 verifies every entry (M7's
allocated-but-unverifiable algorithms are `unsupported` before verification).
The protobuf
`payload_digest` (the SHA-256 of the protobuf payload bytes) is absorbed: the
CBOR record authenticates the statement through T2 instead, and is recomputed
at registration time, so legacy signature bytes are never copied or
reinterpreted (V5, M8).

M6. Canonical address. The statement subject is the public key; the canonical
address is the low 20 bytes of `Keccak256(uncompressed_pubkey_without_04_prefix)`
— the exact rule of `monad_evm_tx::address_from_uncompressed_pubkey`, applied
to the 65-byte uncompressed encoding of the subject key. The address is
derived, never stored: no CBOR field of the record carries it. A consumer that
registers or serves the record under a claimed address MUST derive the address
from the verified statement's subject and MUST fail closed when they differ;
the claimed address is an out-of-frame input (the HTTP path today), so this
check has no manifest vector, exactly as S10a.2's sender-side error has none,
and each codec's unit tests cover it once child B lands.
`vectors/account-registration-values.json` pins the derivation itself, carrying
each vector's compressed key, its uncompressed `X||Y` (the exact Keccak input),
and the resulting address.

M7. First-slice support. This slice recognizes exactly the networks
`monad-testnet` and `monad-mainnet`, signature algorithm 1, and key type 1.
S2's allocation table and S2b's pairings are unchanged (an unallocated key
type, algorithm, or pairing is `unsupported` at stage 8.3). An entry whose
algorithm is allocated but not verifiable in this slice — algorithms 2, 3, and
16 today — passes stage 8.3 and stage 9 and then makes the attestation
`unsupported` at stage 10.6, not `cryptographic`: no verification ran, and V3
forbids reporting unverified semantics. A registration consumer SHOULD apply
the same slice to what it accepts (M8's legacy adapter is the only other
reader); widening the slice is a new decision that also adds the vectors.

M8. Legacy records. The protobuf `SignedPayload` with `scheme = SCHNORR`
(or `ECDSA` over the legacy SHA-256-of-payload digest) stays readable only
through the explicit legacy adapter. The legacy transcript differs from T2 in
domain, length prefixes, and coverage, so a legacy signature MUST NOT be
reinterpreted as algorithm 2 or 3 (S2a: Schnorr identifiers are not
interchangeable) or algorithm 1, a CBOR record is never built by transcribing
legacy signature bytes, and the two encodings never share an identity (V5).

M9. Vectors. `vectors/account-registration.json` is a manifest in the format of
[vectors.schema.json](vectors.schema.json) (`frank-cbor-v1-vectors`), so the
committed manifest checkers and runners of #185 accept it unchanged once child
B lifts their stage-10 guard; its cases cite this section's rules. At the
landing of this section the codecs implement stages 1-9 only, so the corpus
splits into: live cases, whose recorded outcome the current codecs already
produce at `typed` (the entry-less shapes, the V6.3 retention of field 9, and
every stage 1-9 reject), and forward-looking cases, which the current codecs
reach only until they fail on the C12 declaration of field 9 or at the not-yet-
implemented stage 10.6; those record the normative outcomes child B must
produce. The corpus checker of #185 (README section 10) applies to this file's
cases as written, including its stage labels (`10.6` is within `full`'s last
stage). `vectors/account-registration-values.json` carries the exact manifest
case inventory, a Rust-originated T2a digest/signature known answer, and the
pure-value vectors (M2, M3, M6) in its own documented format. The TypeScript,
Rust, Python, and browser runners consume the same T2a bytes and the manifest
also pins M7 precedence when an unsupported transition authorization appears
beside a corrupt outer signature.
