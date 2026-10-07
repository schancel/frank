# Directory CDDL Schema (`directory.cddl`)

**Status**: Active Production Standard & Preview Profile  
**Schema Path**: `docs/protocol/cbor/directory.cddl`

---

## 1. Overview

`directory.cddl` specifies the schemas governing self-custodial account identity, directory statements, relay bindings, and authority key transitions:

- Type 2: **Directory Attestation** (`directory-attestation`)
- Type 4: **Directory Statement** (`directory-statement`, `directory-statement-v4`)
- Type 7: **Key Transition Statement** (`key-transition-statement`)
- Canonical Handle Constraints (`canonical-username`)

---

## 2. CDDL Source Definition

```cddl
; Type 2 wraps and signs the complete Type 4 statement frame.
directory-attestation = {
  0: framed-object,         ; type-4 directory-statement frame
  1: [1*16 signature-entry],; signatures by directory authority P
  * uint => frank-value,
}

; Type 4 schema 4 / min_reader 4: Production Directory Preview
directory-statement-v4 = {
  0: network-tag,           ; e.g. "monad-testnet"
  1: directory-preview-key, ; directory authority public key P
  2: uint .le 18446744073709551615, ; monotonic revision (0 at genesis)
  3: timestamp,             ; issue time
  4: [directory-preview-relay], ; bound relay endpoints
  6: timestamp,             ; expiry (positive validity <= 3600s)
  8: directory-preview-key, ; stamp receipt key P'
  10: directory-preview-key,; message encryption key M
  11: uint .le 18446744073709551615, ; mailbox_key_generation
  12: uint .le 18446744073709551615, ; stamp_key_generation
  13: null / bstr .size 32, ; predecessor Type 4 T1 hash; null at rev 0
  ? 14: canonical-username, ; optional canonical username handle
  ? 15: account-type,       ; optional account type (0=person, 1=bot, 2=service, 3=org)
  ? 16: bot-role,           ; optional bot/service role (0..7)
  * uint => frank-value,
}

directory-preview-key = {
  0: 1,                     ; secp256k1 key type
  1: bstr .size 33          ; 33-byte compressed SEC1 public key point
}

directory-preview-relay = {
  0: bstr .size (16..64),   ; relay node identifier
  1: tstr .size (1..2048),  ; HTTPS URI (no trailing slash)
  2: directory-preview-key, ; relay public key
  3: timestamp,             ; relay binding expiry
  * uint => frank-value,
}

; Canonical username handle constraint:
; Matches ^[a-z0-9][a-z0-9_-]{2,31}$ (3 to 32 chars, lowercase alphanumeric, -, _)
canonical-username = tstr .size (3..32)

; Account type: 0=person, 1=bot, 2=service, 3=organization
account-type = uint .le 3

; Bot/service role: 0=generic, 1=assistant, 2=faucet, 3=game, 4=bridge, 5=merchant, 6=moderator, 7=announcer
bot-role = uint .le 7
```
