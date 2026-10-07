# @frank/nakamoto

**Typed Multi-Chain Cryptographic & UTXO Library**  
**Package Path**: `packages/nakamoto`  
**License**: MIT  
**Dependencies**: `@noble/curves`, `@noble/hashes` (Zero Node.js built-in dependencies; browser-safe)

---

## 1. Overview

`@frank/nakamoto` is Frank's modern, typed chain library for Bitcoin (BTC), Bitcoin Cash (BCH), eCash (XEC), and Lotus (XPI). 

It replaces legacy `bitcore-lib-xpi` with a modern, high-assurance architecture:
- **Zero Node Built-ins**: Browser-safe and sandbox-friendly; all cryptography is backed by audited `@noble/curves` and `@noble/hashes`.
- **Typed Domain Objects**: Callers work with strongly typed `PrivateKey`, `PublicKey`, `Address`, `Transaction`, `Script`, and `Integer` objects rather than raw scalars or unsafe byte arrays.
- **Strict Consensus Adherence**: Wire encodings and consensus serialization bytes strictly match chain specifications. The public API is intentionally clean and modern, rather than copying legacy Bitcore idioms.
- **Clean Separation of Concerns**: Nakamoto owns key operations, address codecs, and script evaluation. It does not parse CashWeb CBOR—digest bytes produced by `@frank/codec` and `frank-cbor` are passed directly to Nakamoto sign and verify routines.

---

## 2. Supported Networks & Formats

| Chain | Symbol | Address Encoding | Derivation Standard | Signature Schemes |
| :--- | :--- | :--- | :--- | :--- |
| **Lotus** | `XPI` | Lotus CashAddr (`lotus_`, `lotusR`) | BIP-44 (Coin `10605'`) | Schnorr, ECDSA, ECDH |
| **eCash** | `XEC` | eCash CashAddr (`ecash:`) | BIP-44 (Coin `1899'`) | Schnorr, ECDSA, ECDH |
| **Bitcoin Cash** | `BCH` | CashAddr (`bitcoincash:`) | BIP-44 (Coin `145'`) | Schnorr, ECDSA, ECDH |
| **Bitcoin** | `BTC` | Base58Check & Bech32 (`bc1`) | BIP-44 / BIP-84 | ECDSA, Schnorr |

---

## 3. Architecture & Entry Points

`@frank/nakamoto` exposes dedicated modular subpaths via `package.json` exports:

```typescript
// Chain-specific modules
import * as xpi from "@frank/nakamoto/xpi";
import * as xec from "@frank/nakamoto/xec";
import * as btc from "@frank/nakamoto/btc";
import * as bch from "@frank/nakamoto/bch";

// Core cryptographic and primitive modules
import { PrivateKey, PublicKey } from "@frank/nakamoto/keys";
import { HDNode } from "@frank/nakamoto/hd";
import { Address, encodeAddress, decodeAddress } from "@frank/nakamoto/address";
import { Transaction } from "@frank/nakamoto/transaction";
import { Script } from "@frank/nakamoto/script";
import { ecdh, signSchnorr, verifySchnorr } from "@frank/nakamoto/curve";
```

---

## 4. Usage Examples

### Key Derivation & Address Generation

```typescript
import { PrivateKey } from "@frank/nakamoto/keys";
import { encodeAddress } from "@frank/nakamoto/address";

// Generate or import a secp256k1 private key
const privKey = PrivateKey.random();
const pubKey = privKey.toPublicKey();

// Encode a native Lotus CashAddr
const lotusAddress = encodeAddress({
  prefix: "lotus",
  type: "p2pkh",
  hash: pubKey.toHash160(),
});

console.log("Lotus Address:", lotusAddress);
// => lotus_16PSJYUi4...
```

### ECDH Key Exchange (Diffie-Hellman)

Used by `@frank/crypto-box` and direct-message envelope key agreements:

```typescript
import { PrivateKey, PublicKey } from "@frank/nakamoto/keys";
import { ecdh } from "@frank/nakamoto/curve";

const alicePriv = PrivateKey.random();
const bobPriv = PrivateKey.random();

// Alice computes shared secret using Bob's public key
const sharedSecretA = ecdh(alicePriv.bytes, bobPriv.toPublicKey().bytes);

// Bob computes shared secret using Alice's public key
const sharedSecretB = ecdh(bobPriv.bytes, alicePriv.toPublicKey().bytes);

// Both compute identical 32-byte shared secrets
console.assert(Buffer.from(sharedSecretA).equals(Buffer.from(sharedSecretB)));
```

### Script & Transaction Construction

```typescript
import { Transaction } from "@frank/nakamoto/transaction";
import { Script } from "@frank/nakamoto/script";

// Construct standard P2PKH script
const script = Script.buildPublicKeyHashOut(pubKey.toHash160());

// Assemble and sign a UTXO transaction
const tx = new Transaction()
  .from(availableUtxos)
  .to(recipientAddress, 100_000n)
  .change(changeAddress)
  .sign(privKey);

const rawTxHex = tx.toHex();
```

---

## 5. Security & Invariants

1. **No Bitcore Leaks**: Public APIs do not return Bitcore objects or rely on unmaintained prototype mutations.
2. **Safe Integer Handling**: Monetary amounts and script integers use native `bigint` with bounds validation against 64-bit signed/unsigned overflow.
3. **Constant-Time Primitives**: Underlying curve operations in `@noble/curves` provide constant-time scalar multiplication resistant to timing side-channel attacks.
