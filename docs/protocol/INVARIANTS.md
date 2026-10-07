# Protocol Invariants

This document defines the non-negotiable core invariants of the Frank messaging and application protocol. Every subsystem (relay server, DM crypto codec, client wallet, and application plugins) must satisfy these invariants. Future PRs, refactors, and LLM sessions must strictly uphold them.

---

## 1. Mailbox Holds Both Directions

**Invariant:** An address's mailbox contains **both** incoming and outgoing messages for that address.
- **Relay Store:** When a direct message is finalized, the relay writes indexes for both the recipient (`I‖recipient‖ts‖hash`) and the sender (`O‖sender‖ts‖hash`).
- **Querying:** `GET /message/monad/cbor/mailbox/:address` returns the merged chronological stream of inbound and outbound messages with a `direction: "in" | "out"` tag.
- **Multi-Device Sync:** Any device initialized with the wallet secret must be able to restore the complete conversation history (both sides of the chat) purely by querying the mailbox from its home relay. No reliance on local IndexedDB or client-side peer-to-peer history transfer is required to view past sent messages.

---

## 2. Sender Can Decrypt Its Own Sent Messages (`openSelf`)

**Invariant:** The sender can decrypt any of its own outbound messages using only its wallet secret and the data present in the message wrapper.
- **Mechanism:** In the DM crypto envelope, the 32-byte cleartext authenticated `salt` is stored in the wrapper.
- **Key Derivation:** The sender derives an ephemeral secret deterministically from its wallet messaging root, the envelope `salt`, and the recipient's public key.
- **Result:** The sender recomputes the shared key `ECDH(eph, recipient) ‖ ECDH(senderStatic, recipient)` and successfully decrypts the ciphertext.
- **Multi-Device:** Any frontend sharing the same wallet seed can open and read messages sent by any other frontend attached to the same account.

---

## 3. "Sent" Means Echoed Over the Websocket

**Invariant:** A client considers an outbound message "sent" and confirmed **only** when the stored record is echoed back over its authenticated mailbox websocket.
- **Websocket Echo:** The relay pushes every newly committed mailbox record (`direction: "out"` for sender, `direction: "in"` for recipient) over the authenticated websocket `/message/monad/cbor/mailbox/:address/ws`.
- **Client Confirmation:** An HTTP `PUT` returning `200` or `delivered` marks the message as *pending* on the sending client. The message transitions to *confirmed/sent* only upon receipt of the websocket echo (or retrieval via `/mailbox` pagination).
- **Multi-Frontend Notification:** When Device A sends a message, Device B (attached to the same wallet) receives the websocket echo immediately and updates its UI with the sent message in real time.

---

## 4. The Relay is Application-Agnostic

**Invariant:** The relay NEVER parses application payloads, validates game rules, or tracks application state machines.
- **Dumb Store:** The relay handles only envelope-level concerns: authentication, rate limits, storage retention, payment stamps, and delivery.
- **Privacy:** Payload contents are end-to-end encrypted. The relay has no visibility into application fields (`gameId`, `seq`, `action`, etc.).
- **No Turn Slots or State Enforcers on Relay:** All sequencing, state machine transitions, and concurrency arbitration must be handled client-side in the protocol fold.

---

## 5. Application State is a Pure Deterministic Fold

**Invariant:** Interactive state channel applications (Type 24) derive their entire state by folding the authenticated, ordered stream of mailbox messages.
- **Message Chaining:** Every application item commits to `channelId`, an incrementing sequence number `seq`, and the previous accepted message hash `prev`.
- **Pure Function:** `fold(events) -> State` is a pure function. Given the same sequence of mailbox events, every client and frontend arrives at the exact same state.
- **Fork and Concurrency Resolution:**
  - If two frontends attached to the same wallet send concurrent actions at the same `seq`, both are written to the mailbox.
  - The deterministic fold accepts the first valid message continuing `seq - 1` and marks the conflicting subsequent message at the same `seq` as rejected/stale.
  - Both frontends fold the exact same sequence; the loser frontend seamlessly recognizes that the action was taken on another device and reconciles its UI without divergence.

---

## 6. Deterministic Secrets from Wallet Roots

**Invariant:** All protocol secrets (such as game entropy and seed chains) are derived deterministically from the wallet root and public transcript parameters (`walletSecret`, `gameId`, `salt`).
- **No Volatile Seeds:** Secrets must never be stored exclusively in volatile device storage (`localStorage` or temporary memory) without a deterministic derivation path from the wallet seed.
- **Multi-Device Rederivation:** Any device sharing the wallet seed can re-derive the exact same hash chain or secrets, allowing a user to seamlessly switch devices mid-game or verify game history after the fact.
