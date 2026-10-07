# @frank/adaptor-signatures

**Transaction-Agnostic ECDSA Adaptor Signatures over secp256k1**  
**Package Path**: `packages/adaptor-signatures`  
**License**: MIT  
**Dependencies**: `@frank/nakamoto`, `@noble/curves`, `@noble/hashes`  
**Standard**: DLC (Discreet Log Contracts) Specification (162-byte wire format)

---

## 1. Overview

`@frank/adaptor-signatures` provides discrete-log-based **adaptor signatures** (often called "encrypted signatures") over secp256k1. 

Adaptor signatures allow a party to produce a valid-looking signature that is cryptographically locked under an **adaptor point** $T = t \cdot G$:
1. **Pre-signing**: Party A creates an encrypted signature for a transaction digest under adaptor point $T$.
2. **Verification**: Anyone with the public key and $T$ can verify that the encrypted signature is mathematically valid without possessing the secret scalar $t$.
3. **Completion**: Anyone who possesses secret $t$ can complete the encrypted signature into a canonical, broadcastable ECDSA signature.
4. **Secret Extraction**: Once the completed signature is broadcast on-chain, Party A can mathematically deduce $t$ by computing the algebraic difference between the encrypted signature and the completed signature.

This enables trustless cross-chain atomic swaps, off-chain state channel conditional payments, and discreet log contracts without escrow intermediaries.

---

## 2. Wire Format Specification

The wire encoding adheres strictly to the canonical 162-byte DLC specification:

$$\text{Wire Encoding (162 bytes)} = R\,(33) \parallel R_a\,(33) \parallel s_a\,(32) \parallel \text{proof}.b\,(32) \parallel \text{proof}.c\,(32)$$

- **$R$ (33 bytes)**: Canonical SEC1 compressed commitment point.
- **$R_a$ (33 bytes)**: Adaptor commitment point.
- **$s_a$ (32 bytes)**: Adaptor signature scalar.
- **$\text{proof}.b, \text{proof}.c$ (64 bytes)**: Proof of discrete log equality bound to the exact adaptor point.

### Frank Proof of Knowledge (PoK v1)
To prevent rogue-key and invalid-point attacks, Frank enforces a mandatory 65-byte proof-of-knowledge wire contract:
$$\text{PoK v1} = R\,(33) \parallel z\,(32)$$

---

## 3. Usage Example

```typescript
import {
  generateAdaptorSecret,
  adaptorSign,
  verifyAdaptorSignature,
  completeAdaptorSignature,
  extractAdaptorSecret,
} from "@frank/adaptor-signatures";

// 1. Generate Adaptor Secret & Public Point (Alice)
const secretMaterial = generateAdaptorSecret(crypto.getRandomValues(new Uint8Array(32)));
const { secret, point, proof } = secretMaterial.value;

// 2. Bob Pre-signs transaction digest under Alice's adaptor point
const encryptedSig = adaptorSign({
  privateKey: bobPrivKey,
  adaptorPoint: point,
  adaptorProof: proof,
  digest: transactionSighash,
});

// 3. Alice verifies the encrypted signature is valid
const isValid = verifyAdaptorSignature({
  publicKey: bobPubKey,
  adaptorPoint: point,
  digest: transactionSighash,
  encryptedSignature: encryptedSig,
});

// 4. Alice completes the signature using her secret and broadcasts on-chain
const validEcdsaSig = completeAdaptorSignature({
  encryptedSignature: encryptedSig,
  adaptorSecret: secret,
});

// 5. Bob observes validEcdsaSig on-chain and extracts Alice's secret!
const extractedSecret = extractAdaptorSecret({
  encryptedSignature: encryptedSig,
  completedSignature: validEcdsaSig,
  adaptorPoint: point,
});

console.assert(Buffer.from(extractedSecret).equals(Buffer.from(secret)));
```
