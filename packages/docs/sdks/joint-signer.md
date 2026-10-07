# @frank/joint-signer

**Pluggable Multi-Backend Interface for Two-Party Joint Signing**  
**Package Path**: `packages/joint-signer`  
**License**: MIT  
**Dependencies**: `@frank/threshold-ecdsa`, `@frank/adaptor-signatures`, `@noble/curves`  
**Status**: Experimental / Testnet-Only

---

## 1. Overview

`@frank/joint-signer` provides a high-level, backend-neutral interface for managing jointly held secp256k1 keys and cooperative EVM transactions between two counterparties.

It decouples application logic (e.g. game channels, atomic swap escrows, multi-sig vaults) from the underlying cryptographic protocol:
- **Pluggable Backends**: Swap between pure TypeScript Lindell17 and WebAssembly DKLs23 backends without changing application code.
- **Session Management**: Handles message packet serialization, turn coordination, and error recovery across untrusted network hops.
- **EVM Compatibility**: Produces signatures directly compatible with standard Ethereum, Monad, and EVM smart contracts.

---

## 2. Supported Backends

| Backend | Implementation | Characteristics |
| :--- | :--- | :--- |
| **Lindell 2017** | `@frank/threshold-ecdsa` | Pure TypeScript; zero binary dependencies; uses Paillier encryption and zero-knowledge range proofs; hardened against BitForge and CVE-2023-33242. |
| **DKLs 2023** | `third_party/silent-shard-dkls23-ll` | High-performance WebAssembly compiled from Silence Laboratories DKLs23; based on oblivious transfer extensions; ultra-fast keygen and signing. |

---

## 3. Usage Example

```typescript
import { JointSigner, createLindellBackend } from "@frank/joint-signer";

// Initialize joint signer with Lindell 2017 backend
const signer = new JointSigner({
  backend: createLindellBackend(),
  storage: sessionStateStore,
});

// Run key generation session over network transport
const keySession = await signer.initiateKeygen({
  peerAddress: "0x1234...",
  sendPacket: (pkt) => frankClient.sendDM(peerAddress, pkt),
});

console.log("Joint Account EVM Address:", keySession.address);

// Cooperatively sign an on-chain transaction
const txSignature = await signer.signDigest({
  address: keySession.address,
  digest: txSighash,
  sendPacket: (pkt) => frankClient.sendDM(peerAddress, pkt),
});
```
