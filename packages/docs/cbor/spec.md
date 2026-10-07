# Deterministic CBOR v1 (FRNK) Specification

**Status**: Normative Encoding and Validation Standard  
**Implementations**: `@frank/codec` (TypeScript), `frank-cbor` (Rust zero-copy parser)  
**Conformance Vectors**: `docs/protocol/cbor/vectors/`

---

## 1. Framing Architecture

Every independently stored, signed, hashed, or forwarded Frank object is serialized as an exact binary **frame**:

| Offset | Size | Field | Description |
| :---: | :---: | :--- | :--- |
| **0** | 4 bytes | Magic Bytes | ASCII `FRNK` (`0x46 0x52 0x4e 0x4b`) |
| **4** | 1 byte | Frame Version | Protocol frame version (`0x01`) |
| **5** | 4 bytes | Body Length | Big-endian uint32 payload length (bytes `9..N`) |
| **9** | $N$ bytes | CBOR Envelope | Canonical CBOR map `{ 0: type_id, 1: schema_version, 2: min_reader_version, 3: payload_bytes }` |

Worked example: a Type 17 text item `{0: "hi"}` (23 bytes total):

```text
46 52 4e 4b            FRNK (magic)
01                     frame version 1
00 00 00 0e            CBOR body length 14
a4                     envelope map, 4 entries
  00 11                  0: type_id = 17 (text-message-item)
  01 01                  1: schema_version = 1
  02 01                  2: min_reader_version = 1
  03 45                  3: payload = 5-byte string
     a1 00 62 68 69        payload map {0: "hi"}
```

---

## 2. Canonical Encoding Constraints (Strict CBOR)

To ensure byte-for-byte deterministic hashing across all languages (TypeScript, Rust, Go, Python):

1. **Integer Map Keys**: All protocol map keys MUST be unsigned integers (`uint`), serialized in strictly ascending numerical order without duplicates. Text or string keys are forbidden.
2. **Minimal Integer Representation**: Integers MUST use the shortest possible CBOR encoding (0–23 inline, 24–255 as 1-byte, 256–65535 as 2-byte, etc.).
3. **No Indefinite-Length Items**: Indefinite-length byte strings, text strings, arrays, or maps are strictly rejected.
4. **No Floating-Point Values**: IEEE 754 float types are disallowed in protocol records to prevent architecture-dependent precision loss.
5. **Exact UTF-8 String Encoding**: Text strings MUST be valid UTF-8, with no unassigned Unicode code points or invalid surrogate pairs.
6. **Zero Trailing Bytes**: The CBOR payload must consume exactly the remaining bytes of the frame. Trailing data is a fatal deserialization error.

---

## 3. Type ID Allocation Registry

| Type ID |   Hex    | Name                                             | CDDL Schema Rule                 | Description                                                                                                   |
| :-----: | :------: | :----------------------------------------------- | :------------------------------- | :------------------------------------------------------------------------------------------------------------ |
|  **1**  | `0x0001` | Direct Message Delivery                          | `direct-message-delivery`        | Outermost DKSAP message container with payment stamps                                                         |
|  **2**  | `0x0002` | Directory Attestation                            | `directory-attestation`          | Wraps and signs a Type 4 directory statement with ECDSA                                                       |
|  **3**  | `0x0003` | Mailbox Checkpoint                               | `mailbox-checkpoint`             | Durable journal facts and mailbox state checkpoint                                                            |
|  **4**  | `0x0004` | Directory Statement                              | `directory-statement`            | Account-to-relay binding, public keys ($P, M, P'$), and revision                                              |
|  **5**  | `0x0005` | Recipient Encrypted Payload                      | `recipient-encrypted-payload-v2` | XChaCha20-Poly1305 ciphertext with DLEQ zero-knowledge proof                                                  |
|  **6**  | `0x0006` | Encrypted Message Content                        | `encrypted-message-content`      | Inner decrypted container with logical message ID & payload                                                   |
|  **7**  | `0x0007` | Key Transition Statement                         | `key-transition-statement`       | Cryptographic authorization linking a retiring key to a new subject key                                       |
|  **8**  | `0x0008` | Message Content Revision                         | `message-content-revision`       | Ordered array of semantic message items                                                                       |
|  **9**  | `0x0009` | Topic Post Content                               | `topic-post`                     | Public forum post content with structured authored entries                                                    |
| **10**  | `0x000a` | Topic Post Submission                            | `topic-post-submission`          | Initial post creation paired with raw signed on-chain burn transaction ($T_7$)                                 |
| **11**  | `0x000b` | Topic Vote Submission                            | `topic-vote-submission`          | Upvote on existing post paired with raw signed on-chain burn transaction ($T_7$)                               |
| **12**  | `0x000c` | Forum Post Observation                           | `forum-single-view`              | Single post observation paired with author address, raw signed burn tx, and vote weight                       |
| **13**  | `0x000d` | Forum Topic Batch (`forum-topic-page`)           | `forum-topic-page`               | Paginated batch of up to 128 post observation frames within a topic, with continuation cursor and relay epoch |
| **14**  | `0x000e` | Forum Discovery Listing (`forum-discovery-page`) | `forum-discovery-page`           | Paginated directory of active topics, post counts, and last activity timestamps                               |
| **15**  | `0x000f` | Forum Operation Status                           | `forum-operation-status`         | Relay submission/confirmation status report for an on-chain burn transaction                                  |
| **16**  | `0x0010` | Container Message Item                           | `container-message-item`         | Opaque nested child frame container for multi-item deliveries                                                 |
| **17**  | `0x0011` | UTF-8 Text Item                                  | `text-message-item`              | Plaintext chat message text up to 256 KiB                                                                     |
| **19**  | `0x0013` | Stealth Payment Item                             | `stealth-message-item`           | Single-use ephemeral DKSAP on-chain transfer notification                                                     |
| **24**  | `0x0018` | Universal State Channel Update                   | `channel-update-item`            | Instant off-chain multi-network state execution and interactive turns                                         |
| **25**  | `0x0019` | Forwarding Delivery Envelope                     | `forwarding-delivery-envelope`   | Store-and-forward relay hop delivery envelope with storage stamps (up to 32 MiB)                              |

> [!NOTE]
> **Database Pagination vs. Web Pages**: In Types 13 and 14 (`forum-topic-page` and `forum-discovery-page`), the term **"Page"** refers strictly to cursor-based database query result sets (holding up to 128 verified post observations with continuation cursors), not HTML documents or rendered web pages.

---

## 4. Multi-Stage Validation Order

Implementations MUST process frames through twelve rigorous validation stages:

```mermaid
flowchart TD
    S1["1. Frame Boundary & Magic ('FRNK')"] --> S2["2. Version & Length Validation"]
    S2 --> S3["3. Digest Verification (T1 / T2 / T3)"]
    S3 --> S4["4. Resource Bounds Check (Heap/Depth/Item Limits)"]
    S4 --> S5["5. Canonical CBOR Syntax Verification"]
    S5 --> S6["6. Minimum Reader Version Gate"]
    S6 --> S7["7. Schema Structural Validation (CDDL matching)"]
    S7 --> S8["8. Semantic Predicate Validation"]
    S8 --> S9["9. Cryptographic Curve Point Validation (secp256k1)"]
    S9 --> S10["10. Zero-Knowledge Proofs (DLEQ)"]
    S10 --> S11["11. Digital Signature Verification (strict-DER low-S ECDSA)"]
    S11 --> S12["12. State Machine Admission & State Commit"]
```
