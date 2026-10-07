# @frank/codec

**TypeScript Deterministic CBOR v1 Reference Codec**  
**Package Path**: `packages/frank-codec`  
**License**: MIT

---

## 1. Overview

`@frank/codec` is the browser-safe TypeScript reference implementation of Frank deterministic CBOR v1 (FRNK). It guarantees strict byte-for-byte canonical serialization, two-pass parsing, and multi-stage schema validation matching the Rust zero-copy implementation.

### Key Capabilities

- **Strict Canonical CBOR**: Enforces minimal integer sizes, unsigned integer map keys in ascending numerical order, and rejection of floating point or indefinite lengths.
- **FRNK Framing**: Validates 16-byte magic headers (`FRNK`), lengths, type IDs, and schema floors.
- **Resource Limiter**: Enforces strict memory budgets, max recursion depth (16 levels), container limits (256 items), and aggregate byte caps to defend against decompression bombs.
- **Type 25 Forwarding Envelope Support**: Encodes and decodes multi-hop relay envelopes up to 32 MiB (`33_554_432` bytes).

---

## 2. Installation & Usage

Within the Frank monorepo:

```bash
yarn workspace @frank/codec add
```

### Encoding a Frame

```typescript
import { encodeFrame, FrameTypeId } from "@frank/codec";

const payload = new Map<number, unknown>([
  [0, "monad-testnet"],
  [1, recipientAccountRef],
  [2, innerEncryptedPayloadFrame],
  [3, innerPayloadDigest],
  [4, paymentMembersArray],
]);

const frameBytes = encodeFrame({
  typeId: FrameTypeId.DirectMessageDelivery, // 1
  schemaVersion: 1,
  minReaderVersion: 1,
  payload,
});
```

### Decoding & Validating a Frame

```typescript
import { decodeAndValidateFrame, defaultContext } from "@frank/codec";

const result = decodeAndValidateFrame(frameBytes, defaultContext());

if (result.isValid) {
  console.log("Validated frame type:", result.frame.typeId);
  console.log("Parsed payload:", result.frame.payload);
} else {
  console.error("Validation failed at stage:", result.stage, result.error);
}
```

---

## 3. Test Suites & Conformance

`@frank/codec` runs continuous conformance checks against `docs/protocol/cbor/vectors/`:

```bash
yarn workspace @frank/codec test
```

All unit tests verify identical parsing behavior against vectors shared with the Rust `frank-cbor` parser.
