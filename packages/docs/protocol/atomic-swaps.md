# Cross-Chain Atomic Swaps Specification

**Status**: Research & Design Specification (Testnet-Only)  
**Implementation**: `packages/swap-protocol`, `packages/adaptor-signatures`  
**Primary Specification**: `docs/atomic-swap-specification.md`

---

## 1. Overview & Goals

Frank provides a decentralized, peer-to-peer atomic swap protocol enabling cryptographic asset exchange across disjoint blockchain ecosystems without centralized intermediaries, custodian smart contracts, or bridge exploits.

The protocol couples state changes across three heterogeneous chain families:

1. **EVM Account Chains**: Monad, Ethereum, Polygon
2. **UTXO Chains**: eCash (XEC), Bitcoin Cash (BCH), Lotus (XPI)
3. **Account/Signature Chains**: Solana (Ed25519)

---

## 2. Core Protocol Mechanics

Swaps use Frank's end-to-end encrypted messaging channels for private negotiation and state machine transitions, while native on-chain smart contracts or script hash locks enforce unilateral settlement:

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Party A (Maker)
    participant Frank as Frank Relay (Encrypted Transport)
    participant Bob as Party B (Taker)
    participant ChainA as Monad (EVM Leg)
    participant ChainB as eCash (UTXO Leg)

    Alice->>Bob: 1. Send Swap Offer via Frank DM (Side A: 100 MON for Side B: 10,000 XEC)
    Bob->>Alice: 2. Accept Offer with Adaptor Point & Timelock Commitments
    Alice->>ChainA: 3. Lock 100 MON into HTLC Contract (Locktime: 24h, Hash: H(s))
    Alice->>Bob: 4. Transmit Chain A HTLC Txid & Funding Proof via Frank
    Bob->>ChainB: 5. Lock 10,000 XEC into Script HTLC (Locktime: 12h, Hash: H(s))
    Bob->>Alice: 6. Transmit Chain B Funding Proof via Frank
    Alice->>ChainB: 7. Claim 10,000 XEC by revealing secret scalar `s` on Chain B
    Bob->>ChainA: 8. Read `s` from Chain B and claim 100 MON on Chain A
```

---

## 3. Cryptographic Invariants & Safety Rules

1. **Staggered Timelocks**: $T_A > T_B$ (e.g. 24h vs. 12h) ensures that Party A cannot wait out Party B's timeout while simultaneously claiming Party B's funds.
2. **Zero Custody by Relays**: Relays act solely as oblivious, encrypted message couriers. Relays never possess swap preimages, cannot execute transactions, and have no authority over chain state.
3. **Unilateral Recovery**: If either party disconnects or halts after funding, the non-faulty party can unilaterally reclaim their deposit once the respective timelock expires.
