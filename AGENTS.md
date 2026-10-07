# Frank Engineering & Architectural Invariants for Agents

This document defines core system invariants that all autonomous agents, contributors, and refactors must strictly follow across the Frank monorepo.

---

## 1. Canonical Chain Identifiers (`chainIdentifier`)

Frank unifies multi-chain and cross-chain operations through a single, canonical string identifier (`chainIdentifier`).

### Invariants:
1. **Single Canonical String Identifier**:
   Always use a canonical string `chainIdentifier` across all packages, maps, relay APIs, database keys, and payload serialization.
   - Examples of canonical identifiers:
     - `'monad-testnet'`
     - `'monad-mainnet'`
     - `'ecash'`
     - `'lotus'`
     - `'solana-mainnet'`
     - `'solana-devnet'`
2. **Never Invent Numeric Chain IDs or Ad-Hoc Aliases**:
   - Do **NOT** invent or use numeric chain IDs (such as EVM `10143` or `1`) as map keys, protocol identifiers, or payload fields.
   - Do **NOT** use ad-hoc string aliases (such as `"monad"`, `"eth"`, or `"evm"`).
   - The same canonical `chainIdentifier` string must work universally:
     - To look up records from registries and in-memory caches / hashmaps.
     - To query relay endpoints and message feeds.
     - To pack into cross-chain message items (e.g., `WalletSyncItem.chainIdentifier`).
     - To isolate transaction attempt locks (`nativeTransactionAttemptKey`).

---

## 2. Decoupling Messaging and Inbox Sync from `WalletHandle`

A `WalletHandle` represents key custody, derivation, signing, and pool storage.

### Invariants:
1. **Separation of Concerns**:
   - `WalletHandle` and `MonadWalletHandle` must **NOT** expose messaging methods (such as `sendSelfDirectMessage`) or inbox sync methods (such as `processSyncTransaction`).
   - Messaging is an application/protocol service that depends on wallet keys; wallet custody must never depend on the messaging transport.
2. **Sync Item Dispatching via `applyWalletSyncItem`**:
   - Incoming or self-sent wallet sync items (`WalletSyncItem`) must be processed through the clean helper `applyWalletSyncItem(wallet, item)` (located in `@frank/wallet/sync-dispatcher`).
   - The dispatcher routes the sync item cleanly to:
     - `wallet.pool` (e.g. `MonadSubAccountPool.processSyncTransaction` / `setStatus(index, 'spent')`) to retire spent sub-accounts and avoid multi-device desync.
     - `wallet.inventory` (e.g. `HdAddressInventory.processSyncTransaction` or mark spent/consume nonce) to maintain account clean/dirty states, nonces, and branch balances.
     - UTXO management: `wallet.deleteUtxo` for spent inputs with outpoints and `wallet.putUtxo` for created outputs.
3. **Consolidator Self-Sync Broadcast**:
   - When consolidators (such as `EvmLegacyConsolidator`) emit `onSyncTransaction`, callers wire up local dispatch via `applyWalletSyncItem(wallet, syncItem)` and then optionally broadcast to the user's own mailbox using `directMessages.send({ wallet, recipient: toChainAddress(wallet.identity.address.raw), items: [syncItem], stampValue: 0n })`.

---

## 3. Cross-Project Clean Compilation & Types

1. All 21 projects in the Frank monorepo must compile cleanly under `yarn typecheck:fast`.
2. Package boundaries must be respected:
   - `@frank/codec`: Pure data serialization and protocol codecs.
   - `@frank/cashweb`: Cashweb protocol client, relay communication, message types.
   - `@frank/wallet`: Chain wallet implementations, HD derivation, pooling, and sync dispatching.
   - `app`: User-facing Quasar/Vue frontend and Pinia stores.
