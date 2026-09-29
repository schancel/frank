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

F1. A version-1 reader MUST compare the magic before interpreting any CBOR.

F2. A reader MUST reject an unsupported frame version. A storage or forwarding
boundary that explicitly permits unknown versions MAY retain the complete
frame opaquely, but MUST NOT interpret it as version 1.

F3. The declared body length MUST equal all bytes remaining after the nine-byte
header. Truncation, concatenated frames, and trailing bytes MUST reject.

F4. The applicable frame-size limit MUST be checked before allocating or
decoding the body.

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

E1. All four keys are required. Other envelope keys are forbidden in version

1. Additive evolution occurs inside the payload or in a later frame version.

E2. `schema_version` and `min_reader_version` begin at 1. A reader MUST NOT
interpret an object when its supported semantic-reader version is less than
`min_reader_version`.

E3. `payload` MUST contain exactly one data item satisfying section 3. A known
type additionally applies its CDDL and semantic rules. An unknown type or
schema MAY be retained and forwarded only as the original complete frame.

E4. A forwarder MUST NOT decode and re-encode a signed, hashed, committed, or
unknown object. Successful validation does not authorize reconstruction.

E5. Type identifiers are never reused. Version 1 reserves:

| Type ID | Name                                       | Schema                                         |
| ------: | ------------------------------------------ | ---------------------------------------------- |
|       1 | Recipient-specific direct-message delivery | [direct-message.cddl](direct-message.cddl)     |
|       2 | Signed directory attestation               | [directory.cddl](directory.cddl)               |
|       3 | Mailbox checkpoint                         | [checkpoint.cddl](checkpoint.cddl)             |
|       4 | Directory statement signed by type 2       | [directory.cddl](directory.cddl)               |
|  16–255 | Core message-item kinds                    | Allocated by a future reviewed registry change |

Unassigned identifiers remain reserved and MUST NOT be emitted.

## 3. Restricted deterministic-CBOR profile

C1. Maps use the RFC 8949 section 4.2.1 bytewise order: sort first by encoded
key length and then lexicographically by the encoded key bytes. Integer keys
are required for extensible protocol records.

C2. Integers and lengths MUST use their shortest preferred encoding. A value
that fits in the additional-information field or a smaller integer argument
MUST NOT use a larger representation.

C3. All byte strings, text strings, arrays, and maps MUST have definite length.

C4. Map keys MUST be unique and already sorted. A decoder MUST reject a
duplicate or out-of-order key rather than accepting a last value.

C5. Unsigned integers, negative integers, byte strings, UTF-8 text strings,
arrays, maps, `false`, `true`, and `null` are the only permitted CBOR data
items. Floats, simple values other than those three, tags, `undefined`, break
codes, and indefinite collections MUST reject.

C6. Text MUST be well-formed shortest-form UTF-8. Surrogates, overlong
sequences, and invalid continuation bytes MUST reject. Protocol identifiers
that a schema marks ASCII MUST contain only bytes `20` through `7e` unless that
schema narrows them further.

C7. A declared `u64` is in `0..18446744073709551615`; a declared `i64` is in
`-9223372036854775808..9223372036854775807`. TypeScript implementations MUST
expose these as `bigint`, never `number`.

C8. Values wider than 64 bits are fixed-width big-endian byte strings whose
width is declared by the schema. Leading zero bytes remain significant. No
bignum tag is permitted. Version-1 EVM quantities use exactly 32 bytes.

C9. Decoding MUST consume the entire envelope body and the entire payload data
item. Trailing data rejects at both levels.

C10. Canonical validation precedes typed conversion. An implementation may use
a streaming validator or compare validated input with an independent canonical
re-encoding over this restricted value set; permissive library defaults are
not the protocol.

C11. Source map insertion order MUST NOT affect encoded output. A protocol set
MUST be represented as a list sorted by its declared semantic key and MUST
reject duplicate semantic keys.

## 4. Resource limits

The limits below are part of version 1, not recommendations. A narrower route
or object limit MAY reject earlier but MUST NOT accept an object exceeding the
global limits.

| Constant                |                                 Value | Applies to                                              |
| ----------------------- | ------------------------------------: | ------------------------------------------------------- |
| `MAX_FRAME_BYTES`       | 8,388,617 (8 MiB body + 9-byte frame) | Complete frame                                          |
| `MAX_BODY_BYTES`        |                     8,388,608 (8 MiB) | Envelope CBOR body                                      |
| `MAX_DEPTH`             |                                    32 | Nested CBOR arrays/maps, including envelope and payload |
| `MAX_CONTAINERS`        |                                16,384 | Arrays plus maps in one frame                           |
| `MAX_MAP_ENTRIES`       |                                   256 | Entries in any one map                                  |
| `MAX_ARRAY_ELEMENTS`    |                                 8,192 | Elements in any one array                               |
| `MAX_BYTE_STRING_BYTES` |                             8,388,608 | Any byte string before type-specific limits             |
| `MAX_TEXT_STRING_BYTES` |                     262,144 (256 KiB) | Any UTF-8 text string                                   |

R1. Counters include values inside the payload byte string after it is opened
for canonical validation. Implementations MUST fail without partially
returning a typed object when any limit is exceeded.

R2. The direct-message frame limit is 1 MiB, with at most 256 message items, 64
payment members, and 512 KiB in one encrypted payload. This deliberately
permits messages larger than 64 KiB while requiring large media to be chunked
or referenced rather than embedded without bound.

R3. The directory-attestation frame limit is 256 KiB, with at most 32 relay
bindings and 16 signatures.

R4. The checkpoint frame may use the global 8 MiB limit, with at most 4,096
journal facts or opaque sections. Larger state exports MUST be chunked into
independently framed checkpoints.

R5. Lengths and aggregate counters MUST be checked using arithmetic that cannot
wrap. A limit error is distinct from malformed, non-canonical, unsupported, and
schema errors as defined by the vector manifest.

## 5. Semantic ordering and uniqueness

S1. Network tags are lowercase ASCII identifiers matching
`[a-z0-9][a-z0-9._-]{0,63}`. Network tags are protocol data, not URL path
components.

S2. An account reference is ordered by `(key_type, key_bytes)`. Key type is an
allocated unsigned identifier, not an inference from byte length. Version 1
allocates key type 1 to 33-byte compressed SEC1 secp256k1 public keys, 2 to
32-byte Ed25519 public keys, and 3 to 32-byte x-only secp256k1 public keys.

S2a. Version 1 allocates signature algorithm 1 to strict-DER, low-S secp256k1
ECDSA over the 32-byte transcript digest; 2 to BIP340 Schnorr over that digest,
including BIP340's tagged challenge construction; and 16 to RFC 8032 Ed25519
over the complete common transcript. Algorithm 3 is reserved for a future
reviewed BCH-style Schnorr profile and MUST reject until that profile freezes
its distinct challenge construction. Signatures from algorithms 2 and 3 are
never interchangeable merely because both use secp256k1.

S3. Payment members are ordered by `(child_index, transaction_id)` and unique
by both fields. Their amounts need not be equal. A payment set is valid only
when the independently verified member values sum to the applicable minimum.

S4. Relay bindings are ordered by `(relay_id, endpoint)` and unique by
`relay_id`. Signatures are ordered by `(algorithm, signer_key_type,
signer_key_bytes)` and unique by that tuple.

S5. Key transitions are ordered by `(revision, new_key_type, new_key_bytes)`.
Two transitions with the same revision are invalid rather than tie-broken.

S6. Checkpoint journal facts are ordered by `(seconds, nanoseconds, fact_id)`.
Timestamps do not create identity: `fact_id` remains the stable tiebreaker and
must be unique within a checkpoint.

## 6. Fixture schemas and identity boundaries

The CDDL files describe the three proof families required by #131. CDDL cannot
express framing, canonical byte order, regexes, aggregate limits, cross-field
equality, or cryptographic validation; the numbered prose rules remain
normative.

### Direct messages and recursive items

The type-1 delivery contains one recipient-specific encrypted-payload frame,
its SHA-256 digest, and a sorted payment set. One valid payment member is
permitted when the wallet cannot economically source the preferred two or more.
`message_id` and plaintext
`content_digest` belong inside encrypted content; they are not relay-visible
delivery identity. Each recipient may therefore have different encrypted bytes
and a different payload digest for the same logical message.

A known container message item holds complete child frames as byte strings.
Unknown item types remain exact child-frame bytes. The proof fixture MUST
contain at least two levels and an unknown nested item.

Direct-message stamps are payments to recipient-derived addresses. They are not
burns. A payment member commits to this recipient-specific encrypted-payload
frame and its distinct child index, so an existing transaction cannot authorize
a different payload.

### Directory attestations

Type 4 is the complete framed statement. Type 2 wraps that exact frame and a
sorted signature set, avoiding a signature-containing-itself cycle. A
signature authenticates the complete type-4 frame through section 8. The proof
fixture contains two relay bindings, `u64::MAX` revision, and a seconds plus
nanoseconds timestamp.

### Mailbox checkpoints

Type 3 records a checkpoint identity, ordered journal facts, and sorted opaque
extension sections. A tombstone is a durable fact, not physical deletion. Each
opaque section value is a complete frame when its advertised kind is a Frank
object. The proof fixture contains an unknown section and an unknown nested
message item whose exact bytes survive every round trip.

## 7. Evolution and retention

V1. Adding an optional integer-keyed payload field increments
`schema_version`. It need not raise `min_reader_version` when an older reader
can safely retain/forward the original frame without interpreting the field.

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

## 8. Cryptographic transcripts

All lengths below are unsigned big-endian integers. `utf8(x)` is the exact UTF-8
encoding of a normalized protocol string. `frame` is the complete bytes from
section 1. Concatenation is written `||`.

The common transcript is:

```text
u16be(len(domain)) || ascii(domain)
|| u16be(len(network_tag)) || utf8(network_tag)
|| u32be(len(frame)) || frame
|| context
```

T1. The content hash is SHA-256 of the common transcript with domain
`frank/content-hash/v1` and empty context.

T2. A directory signature signs SHA-256 of the common transcript with domain
`frank/directory-signature/v1`, where `frame` is the complete type-4 directory
statement frame. The algorithm identifier lives in the type-2 signature entry
and selects its signing/verification rules. ECDSA encodings MUST name their
exact profile; Schnorr identifiers distinguish BIP340 from BCH-style Schnorr
and other incompatible challenge hashes.

T3. A recipient stamp-child derivation digest is SHA-256 of the common
transcript with domain `frank/stamp-payment-child/v1`, where `frame` is the
recipient-specific encrypted-payload frame and context is
`u32be(child_index)`. This preserves one-message use: changing any payload byte,
network, frame metadata, or child index changes the derived destination.

T4. A payment-set commitment is SHA-256 of the common transcript with domain
`frank/stamp-payment-set/v1`, where `frame` is the encrypted-payload frame and
context is the exact canonical CBOR encoding of the sorted payment-members
array. Relay delivery fees use a separate domain and are not part of this
transcript.

T5. Protocol signatures and commitments MUST bind the network tag passed to
the transcript and MUST confirm it equals the frame's typed network field.

T6. A one-byte change anywhere in a bound frame changes the transcript. The
golden-vector proof MUST demonstrate changed hashes and failed verification;
canonical encoding alone is not authentication.

## 9. Validation order

A version-1 implementation validates in this order:

1. Caller-supplied route/object byte limit.
2. Magic and frame version.
3. Declared length, global length, and exact input exhaustion.
4. Restricted-CBOR syntax, canonicality, and global resource counters for the
   envelope.
5. Exact common-envelope keys and scalar ranges.
6. Restricted-CBOR syntax, canonicality, and resource counters for payload.
7. Known-type schema and per-type resource limits.
8. Semantic ordering, uniqueness, cross-field, network, and digest checks.
9. Signature, payment, or other cryptographic verification.

No stage may consume funds, mark a payment used, advance a mailbox cursor, or
persist an interpreted record before every applicable later stage succeeds.

## 10. Vector manifest

[vectors.schema.json](vectors.schema.json) defines the committed corpus index.
Every case names its source implementation, complete frame hex, expected stable
error category, and normative rules. Positive vectors additionally name the
type/schema and expected content hash. Hostile vectors retain their bytes even
when parsing fails so both implementations test the same input.

Stable error categories are: `frame`, `unsupported`, `resource`, `malformed`,
`noncanonical`, `schema`, `semantic`, and `cryptographic`. Public APIs may give
more detail but MUST preserve this cross-language category.
