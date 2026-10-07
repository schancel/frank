# Direct Message CDDL Schema (`direct-message.cddl`)

**Status**: Active Production Standard  
**Schema Path**: `docs/protocol/cbor/direct-message.cddl`

---

## 1. Overview

`direct-message.cddl` defines the wire structures for:

- Type 1: **Direct Message Delivery** (`direct-message-delivery`)
- Type 5: **Recipient Encrypted Payload** (`recipient-encrypted-payload-v2`)
- Type 6: **Encrypted Message Content** (`encrypted-message-content`)
- Type 8: **Message Content Revision** (`message-content-revision`)
- Type 25: **Forwarding Delivery Envelope** (`forwarding-delivery-envelope`)

---

## 2. CDDL Source Definition

```cddl
; Payload schemas for Type 1, Type 5, Type 6, Type 8, and Type 25 frames.

direct-message-delivery = {
  0: network-tag,
  1: account-ref,          ; stamp key P' the sender used, key type 1
  2: framed-object,        ; recipient-specific encrypted-payload frame
  3: digest-32,            ; T3 digest of the exact field-2 frame
  4: [1*64 payment-member],; storage/delivery payment stamps
  ? 5: account-ref,        ; long-term recipient identity P (key type 1)
  ? 6: dleq-proof,         ; Chaum-Pedersen DLEQ proof
  * uint => frank-value,
}

payment-member = {
  0: uint .le 2147483647,  ; stamp child index i
  1: bstr .size (1..128),  ; chain transaction identifier
  2: evm-quantity-256 / uint, ; verified value in wei or satoshis
  3: bstr .size (1..128),  ; derived destination/address bytes
  4: digest-32,            ; exact T4 commitment verified in the transaction
  ? 5: uint .le 4294967295, ; UTXO output index (vout)
}

stamp-point = bstr .size 33 ; 33-byte compressed SEC1 secp256k1 point
dleq-proof = bstr .size 64  ; 64-byte Chaum-Pedersen DLEQ proof (c || s)

; Type 5 schema 2, min_reader_version 2: production DM payload
recipient-encrypted-payload-v2 = {
  0: network-tag,
  1: account-ref,          ; routing sender identity
  2: account-ref,          ; routing recipient identity
  3: 1,                    ; Frank-CBOR authenticated XChaCha20-Poly1305 suite
  4: bstr .size (1..524376), ; complete crypto-box v2 envelope
  5: stamp-point,          ; ephemeral point E
  6: stamp-point,          ; blinded stamp point X
  7: dleq-proof,           ; DLEQ proof
  * uint => frank-value,
}

encrypted-message-content = {
  0: network-tag,
  1: uuid-16,              ; stable logical message_id
  2: framed-object,        ; type-8 message-content-revision frame
  3: digest-32,            ; T1a digest of field 2
  4: uuid-16,              ; stable logical conversation_id
  ? 5: tstr .size (1..512),; optional conversation name
  * uint => frank-value,
}

message-content-revision = {
  0: "frank",              ; logical transcript domain
  1: [1*256 framed-object],; ordered semantic message-item frames
  * uint => frank-value,
}

text-message-item = {
  0: tstr .size (0..262144), ; UTF-8 chat text (up to 256 KiB)
  * uint => frank-value,
}

; Type 19 schema 1: Stealth payment item
stealth-message-item = {
  0: network-tag,
  1: account-ref,            ; ephemeral pubkey (key type 1 or 2)
  2: [1*16 bstr .size (1..16384)], ; raw transaction payloads or hashes
  3: uint,                   ; transferred value
  ? 4: tstr .size (0..1024), ; optional memo
  * uint => frank-value,
}

; Type 24 schema 1: Universal state channel update item
channel-update-item = {
  0: digest-32,              ; unique channel-id
  1: tstr .size (1..64),     ; app-id ("swap", "dice", "game", "poker")
  2: uint .le 4294967295,    ; sequence-number (state turn / nonce)
  3: [1*8 chain-allocation], ; allocations across 1 or more networks
  4: bstr .size (0..65536),  ; app-state (opaque or nested CBOR payload)
  5: [1*4 signature-entry],  ; participant signatures over state digest
  ? 6: bstr .size (1..128),  ; optional on-chain settlement contract or script reference
  * uint => frank-value,
}

; Type 25 schema 1: Store-and-forward relay forwarding delivery envelope
forwarding-delivery-envelope = {
  0: network-tag,          ; destination relay network
  1: account-ref,          ; destination relay routing identity
  2: framed-object,        ; inner Type 1 direct-message-delivery frame
  3: digest-32,            ; forwarding payload digest of field 2
  4: [1*64 payment-member],; relay storage payment stamps
  ? 5: tstr .size (1..256),; optional destination relay endpoint URI
  ? 6: uint .le 4294967295,; optional delivery TTL timestamp
  * uint => frank-value,
}
```
