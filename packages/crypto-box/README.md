# @frank/crypto-box

Versioned deniable encryption. This package owns suite ids, the KEM, the KDF, the AEAD, envelope bytes, and the vectors for those suites.

This envelope is not a CashWeb relay frame. The live relay path is still protobuf. A Frank-CBOR frame is serialized only by the CashWeb codec (`@frank/codec` and `frank-cbor`, specified in `docs/protocol/cbor/`).

## Suites

| Id       | Name                    | Mode | AEAD               |
| -------- | ----------------------- | ---- | ------------------ |
| `0xFE01` | base-aes-256-gcm        | base | AES-256-GCM        |
| `0xFE02` | base-xchacha20-poly1305 | base | XChaCha20-Poly1305 |
| `0xFE03` | auth-aes-256-gcm        | auth | AES-256-GCM        |
| `0xFE04` | auth-xchacha20-poly1305 | auth | XChaCha20-Poly1305 |

Suite id 65535 is reserved for proof vectors and is never produced. AES-CBC is not used.

## KEM

`0xFF00` is `DHKEM(secp256k1, HKDF-SHA256)`. secp256k1 has no registered HPKE KEM id. `0xFF00` is the first RFC 9180 private-use KEM id. A registered id does not exist. Changing it later is a new suite, not a silent rewrite.

Point encoding is 33-byte compressed SEC1 (`0x02` or `0x03`, then x). The DH output is that compressed encoding with no extra hash. `@frank/nakamoto`'s `ecdh` is the only implementation. The point at infinity and an off-curve point are rejected.

HPKE KDF id `0x0001` is HKDF-SHA256. HPKE AEAD id `0x0002` is AES-256-GCM. XChaCha20-Poly1305 has no registered HPKE AEAD id; this library names private-use AEAD id `0xFF01` as XChaCha20-Poly1305.

The shape follows RFC 9180 (labeled extract and expand, base mode, auth mode, one ciphertext per encapsulation, sequence number fixed at 0). It is not byte-compatible with RFC 9180 test vectors. A fresh 32-byte salt is mixed in as the HKDF-Extract salt of the key-schedule secret. RFC 9180 uses the shared secret as that salt. There is no PSK.

Associated data binds the suite id, the sender public key, the recipient public key, and the caller context. Optional padding is inside the AEAD so the ciphertext length need not equal the plaintext length. The tag comparison is the cipher backend's constant-time compare. This package does not compare tags itself.

## What authenticated mode does not protect

Authentication is only the AEAD under DH-derived keys, so it is deniable. The recipient, holding the recipient static key and the sender public key, can build a ciphertext that opens as that sender. A third party cannot treat the ciphertext as proof that the sender sent it.

A stolen recipient static key is key-compromise impersonation: it decrypts recorded mail and can forge messages from any sender to that recipient. Compromise of the sender static key does not decrypt recorded auth-mode mail. The ephemeral share is not recoverable from that key. It does let an attacker seal new auth-mode messages as that sender.

There is no forward secrecy against the recipient static key. v1 has no prekeys and no ratchet.

Base mode does not use the sender static secret. The sender public key is only bound in the associated data. Anyone who knows the recipient public key can seal a base-mode message that names any sender key.

`sha256`, `hmacSha256`, and `randomBytes` are the plain operations. `hmacSha256(data, key)` takes the message first and the key second. `seal` and `open` are a separate framed ciphertext. They do not replace these functions.

`@noble/ciphers` is exact `1.3.0`. `@noble/hashes` is exact `1.8.0` for HKDF-SHA256. Cure53 NBL-04 scoped ciphers tag `0.6.0` and does not cover `1.3.0`. AES T-tables (NBL-04-001) remain a property of that JavaScript library.
