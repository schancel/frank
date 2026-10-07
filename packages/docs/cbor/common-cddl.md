# Common CDDL Schema (`common.cddl`)

**Status**: Frozen Specification Primitive  
**Schema Path**: `docs/protocol/cbor/common.cddl`

---

## 1. Overview

`common.cddl` defines the fundamental scalar types, timestamps, cryptographic references, and generic container structures shared across all Frank protocol families.

---

## 2. CDDL Source Definition

```cddl
; The five .cddl files are one schema: concatenate them (common.cddl first)
; before compiling, because CDDL has no import. The `* uint => frank-value`
; wildcards describe how a reader sees a newer compatible schema; at an
; exactly supported schema version an undeclared key is a `schema` error.

frank-envelope = {
  0: uint .le 4294967295, ; type_id
  1: 1..4294967295,       ; schema_version
  2: 1..4294967295,       ; min_reader_version
  3: bstr,                ; exactly one restricted canonical-CBOR payload item
}

network-tag = tstr .size (1..64)
digest-32 = bstr .size 32
uuid-16 = bstr .size 16
evm-quantity-256 = bstr .size 32

timestamp = {
  0: -9223372036854775808..9223372036854775807, ; seconds since UNIX epoch
  1: uint .le 999999999,                          ; nanoseconds fraction
}

account-ref = {
  0: uint .le 65535,      ; allocated key_type (1: secp256k1, 2: ed25519)
  1: bstr .size (1..128), ; key bytes, interpreted only by key_type
}

; The generic profile value. Protocol maps use unsigned integer keys even when
; their schema is not yet known; all other CBOR major/simple types are excluded.
frank-value =
  uint /
  nint /
  bstr /
  tstr /
  [* frank-value] /
  {* uint => frank-value} /
  false /
  true /
  null

framed-object = bstr .size (9..33554432)

signature-entry = {
  0: uint .le 65535,      ; exact signature algorithm/profile identifier
  1: account-ref,         ; signing public key
  2: bstr .size (1..512), ; signature bytes (strict-DER low-S ECDSA or Ed25519)
}
```
