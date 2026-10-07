# @frank/cashweb

**Client SDK for Relays, Direct Messaging, and Directory Registry**  
**Package Path**: `packages/cashweb`  
**License**: MIT

---

## 1. Overview

`@frank/cashweb` is the core client SDK providing higher-level workflows for interacting with Frank relays (`cashwebd`), reading authenticated inboxes, managing mailbox subscriptions, submitting payment stamps, and interacting with the username directory.

---

## 2. Architecture & Modules

- **`relay/`**: Direct messaging, stealth addresses, outbox journals, inbox polling, and WebSocket/SSE event subscriptions (`MonadMailboxClient`).
- **`registry/`**: Directory handles, username claims, attestation verification, and public pubsub topics.
- **`bip70/`**: Payment requests and verifiable merchant payment flows.
- **`pop.ts`**: Proof-of-Payment (PoP) authentication challenges for relay mailbox read authorization.

---

## 3. Usage Example: Mailbox Ingress & Sync

```typescript
import { MonadMailboxClient } from "@frank/cashweb/relay/monad-mailbox-client";

// Initialize client connected to an authenticated relay
const client = new MonadMailboxClient({
  relayUrl: "https://relay.example.com",
  signer: userSigner, // authenticates inbox access
});

// Sync new direct messages after known cursor
const syncResult = await client.syncMailbox({ cursor: "opaque-cursor-1234" });

for (const envelope of syncResult.envelopes) {
  console.log("Received new envelope:", envelope.id);
}
```
