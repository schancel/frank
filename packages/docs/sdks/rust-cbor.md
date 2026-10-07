# frank-cbor (Rust SDK)

**Rust High-Performance Zero-Copy Deterministic CBOR Parser**  
**Crate Path**: `backend/cashweb/frank-cbor`  
**Parent Workspace**: `backend/cashweb`

---

## 1. Overview

`frank-cbor` is the high-performance, zero-allocation Rust parser and encoder for Frank deterministic CBOR v1 (FRNK). It forms the cryptographic serialization foundation of the `cashwebd` relay daemon.

### Architectural Highlights

- **Zero-Copy Parsing**: Operates over borrowed byte slices (`&'a [u8]`) where possible, avoiding unnecessary heap allocations during envelope transit.
- **Strict Byte-Level Invariants**: Validates canonical map key order, minimal integer encoding, and UTF-8 string validity.
- **High-Throughput Validation**: Evaluates framing, digests, resource limits, and CDDL schemas in microseconds.
- **Type 25 Envelope Support**: Validates multi-hop relay forwarding envelopes with payloads up to 32 MiB (`MAX_FORWARDING_DELIVERY_FRAME_BYTES = 33_554_432`).

---

## 2. Public API Entry Points

```rust
use frank_cbor::{
    encode_frame, parse_frame, validate_frame,
    FrameTypeId, FrameHeader, ValidationContext,
};

// Parse an incoming wire buffer into a strongly typed FRNK frame
let parsed = parse_frame(&wire_bytes)?;

// Validate frame against protocol stages (1 through 9)
let validated = validate_frame(&parsed, &ValidationContext::default())?;

println!("Frame Type: {:?}", validated.type_id());
println!("Payload Size: {} bytes", validated.payload_len());
```

---

## 3. Running Unit and Benchmark Tests

```bash
# Run all tests in frank-cbor crate
cargo test --manifest-path backend/cashweb/frank-cbor/Cargo.toml

# Run with release optimizations
cargo test --release --manifest-path backend/cashweb/frank-cbor/Cargo.toml
```
