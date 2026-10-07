---
layout: home

hero:
  name: "Frank & Cashweb"
  text: "High-Assurance Protocol Documentation"
  tagline: "Self-Custodial Encrypted Messaging, DKSAP Ambient Privacy, Deterministic CBOR, and Clustered Relays"
  actions:
    - theme: brand
      text: Architecture Guide
      link: /guide/introduction
    - theme: alt
      text: Protocol Specifications
      link: /protocol/stamp-derivation
    - theme: alt
      text: CBOR & CDDL Reference
      link: /cbor/spec

features:
  - title: DKSAP Stealth & Ambient Privacy
    details: Dual-Key Stealth Address Protocol with Chaum-Pedersen DLEQ proofs. Every payment uses fresh, unlinkable addresses with zero calldata markers to defeat graph surveillance.
    link: /protocol/ambient-privacy
  - title: End-to-End Encrypted Messaging
    details: Cryptographic Crypto-Box v2 (XChaCha20-Poly1305 + ECDH) with strict three-role separation (P identity authority, M messaging key, P' stamp receipt key).
    link: /guide/introduction
  - title: Deterministic CBOR v1 (FRNK)
    details: Formal CDDL-verified canonical binary frames with strict integer boundaries, cryptographic payload digests, and zero-copy Rust and TypeScript codecs.
    link: /cbor/spec
  - title: Universal State Channels
    details: Instant peer-to-peer state execution (Type 24) for interactive turns, cross-chain atomic swaps, and multi-network balance allocations across Monad, eCash, and Solana.
    link: /protocol/atomic-swaps
  - title: Clustered Federated Relays
    details: High-throughput relay mesh featuring Kvrocks CAS username uniqueness, S3/MinIO encrypted blob offloading, Ephemeral Core NATS notification fanout, and anti-self-peering.
    link: /architecture/clustered-relay
  - title: Self-Sovereign Codex32 Custody
    details: Error-correcting checksummed master recovery with HKDF domain root isolation (frank-domain-roots-v1), ensuring multi-chain activity never compromises root identity.
    link: /protocol/codex32-backup
---
