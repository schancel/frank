# @frank/crypto-box

**Versioned Deniable AEAD Encryption & Key Encapsulation (HPKE)**  
**Package Path**: `packages/crypto-box`  
**License**: MIT

---

## 1. Overview

`@frank/crypto-box` implements high-assurance, versioned, deniable public-key encryption using Hybrid Public Key Encryption (HPKE, RFC 9180) principles tailored for secp256k1.

It provides authenticated and unauthenticated encryption modes using XChaCha20-Poly1305 and AES-256-GCM.

---

## 2. Cipher Suites

| Suite ID | Name                        | Mode     | KEM                               | AEAD                   |
| :------- | :-------------------------- | :------- | :-------------------------------- | :--------------------- |
| **`1`**  | **auth-xchacha20-poly1305** | **Auth** | **DHKEM(secp256k1, HKDF-SHA256)** | **XChaCha20-Poly1305** |
| `0xFE01` | base-aes-256-gcm            | Base     | DHKEM(secp256k1, HKDF-SHA256)     | AES-256-GCM            |
| `0xFE02` | base-xchacha20-poly1305     | Base     | DHKEM(secp256k1, HKDF-SHA256)     | XChaCha20-Poly1305     |
| `0xFE03` | auth-aes-256-gcm            | Auth     | DHKEM(secp256k1, HKDF-SHA256)     | AES-256-GCM            |

> [!NOTE]
> Suite `1` (`auth-xchacha20-poly1305`) is the designated production encryption suite for Type 5 Direct Message payloads in Frank CBOR v1.

---

## 3. Cryptographic Properties

1. **Cryptographic Deniability**: Authentication is achieved exclusively through Diffie-Hellman derived symmetric keys. Because the recipient can mathematically produce identical ciphertexts using their own private key and the sender's public key, the ciphertext cannot serve as transferable proof of authorship to a third party.
2. **Deterministic CBOR Envelope (v2)**: Sealed envelopes serialize as canonical CBOR maps containing version, suite ID, KEM ID, a 32-byte fresh salt, an ephemeral encapsulated public key point, and the ciphertext.
3. **Associated Data Binding**: AEAD encryption tightly binds caller context, sender public key, and recipient public key, preventing ciphertext transplantation attacks.
