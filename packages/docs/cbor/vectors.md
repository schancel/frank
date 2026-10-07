# Test Vectors & Conformance

**Status**: Conformance Standard & Executable Evidence  
**Schema Definition**: `docs/protocol/cbor/vectors.schema.json`  
**Vector Directory**: `docs/protocol/cbor/vectors/`

---

## 1. Overview

Frank's deterministic CBOR encoding and validation pipeline is verified across TypeScript (`@frank/codec`) and Rust (`frank-cbor`) using a shared, frozen test vector corpus.

Every test vector in `docs/protocol/cbor/vectors/*.json` adheres to `vectors.schema.json`, ensuring that both implementations enforce identical byte representations, error codes, and cryptographic outcomes.

---

## 2. Test Vector Suites

| Vector File                 | Focus Area                       | Description                                                                                              |
| :-------------------------- | :------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `manifest.json`             | Core Framing & CBOR Engine       | Byte-level integer encoding boundaries, canonical map key sorting, and frame length enforcement.         |
| `directory-preview.json`    | Directory Statements (Type 4 v4) | 56 synthetic test frame pairs testing anchor validation, predecessor linkages, and key point uniqueness. |
| `directory-admission.json`  | Admission & Revocation           | Testing expiration, replay protection, and signature verification over directory statements.             |
| `dm-suite-1.json`           | Direct Messaging (Type 1 & 5)    | DKSAP stealth derivations, DLEQ zero-knowledge proofs, and authenticated XChaCha20-Poly1305 payloads.    |
| `dm-runtime.json`           | Decryption & Content Revision    | Inner Type 6/8 container nesting, message ID integrity, and multi-item arrays.                           |
| `account-registration.json` | Handle Registration              | Canonical username handle validation and account registration statement hashing.                         |
| `topic-commitments.json`    | Public Forum Topics              | Monad-native topic posts, burn transactions, and vote commitments.                                       |

---

## 3. Running Conformance Tests

### TypeScript (`@frank/codec`)

```bash
yarn workspace @frank/codec test
```

### Rust (`frank-cbor`)

```bash
cargo test --manifest-path backend/cashweb/frank-cbor/Cargo.toml
```

Both test suites consume the JSON vector files directly from disk, asserting that deserialization, canonicalization, and cryptographic verification pass with zero divergence.
