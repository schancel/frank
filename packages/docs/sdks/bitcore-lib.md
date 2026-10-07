# bitcore-lib-xpi

**Lotus & UTXO Cryptographic Library**  
**Package Path**: `packages/bitcore-lib-xpi`  
**License**: MIT

---

## 1. Overview

`bitcore-lib-xpi` provides transaction construction, script evaluation, address formatting, and cryptographic signing primitives for Lotus (XPI), eCash (XEC), and Bitcoin Cash UTXO networks.

---

## 2. Capabilities

- **Transaction Building**: Serialization and signing of standard P2PKH, P2SH, and OP_RETURN outputs.
- **Sighash Algorithms**: Implementation of BIP-143 / Bitcoin Cash signature hash algorithms.
- **Lotus Address Formats**: Encodes and decodes network-specific cashaddr prefixes.
- **Key Derivation**: secp256k1 private key generation, WIF export/import, and public key point compression.

---

## 3. Usage Example

```typescript
import bitcore from "bitcore-lib-xpi";

// Generate private key and address
const privateKey = new bitcore.PrivateKey();
const address = privateKey.toAddress();

console.log("Address:", address.toString());

// Build a transaction
const tx = new bitcore.Transaction()
  .from(utxos)
  .to(recipientAddress, 50000)
  .change(address)
  .sign(privateKey);

console.log("Serialized raw hex:", tx.serialize());
```
