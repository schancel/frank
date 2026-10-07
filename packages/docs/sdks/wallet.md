# @frank/wallet

**Unified EVM & UTXO Cryptographic Wallet Engine**  
**Package Path**: `packages/wallet`  
**License**: MIT

---

## 1. Overview

`@frank/wallet` provides client-side hierarchical deterministic (HD) key management, autonomous account leasing, stamp generation, and topic interactions across Monad, EVM networks, and UTXO chains.

---

## 2. Key Modules & Entry Points

- **`monad-hd-keyring.ts`**: BIP-32/BIP-44 deterministic key generation and role management.
- **`monad-stamp-client.ts`**: Automated stamp payment generation, DKSAP stealth address calculation, and payment journal management.
- **`monad-stamp-stealth.ts`**: Single-use address derivation and Chaum-Pedersen DLEQ zero-knowledge proof generation.
- **`monad-topic-post-client.ts`**: Public forum publishing with Monad gas and stamp burn coordination.
- **`chain/active-chain.ts`**: Compile-time and runtime chain-selection abstraction.

---

## 3. Usage Example: Deriving Stealth Payment Stamp

```typescript
import { MonadStampClient } from "@frank/wallet/monad-stamp-client";

const stampClient = new MonadStampClient({
  walletHandle,
  provider,
  networkTag: "monad-testnet",
});

// Construct payment stamp for direct message delivery
const stamp = await stampClient.createMessageStamp({
  recipientStampPubkey: bobStampKey,
  childIndex: 0,
  amountWei: 1000000000000n,
});

console.log("Stealth target address:", stamp.stealthAddress);
console.log("Transaction hash:", stamp.txHash);
console.log("DLEQ proof:", stamp.dleqProof);
```
