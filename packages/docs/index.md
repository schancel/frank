---
layout: home

hero:
  name: "Frank Docs"
  text: "High-Assurance Protocol Specifications"
  tagline: "Deterministic CBOR, DKSAP Stealth Messaging, Dual-Protocol DNS Routing, and Clustered Relays"
  actions:
    - theme: brand
      text: Explore Protocol Specs
      link: /protocol/dns-routing
    - theme: alt
      text: CBOR v1 Reference
      link: /cbor/spec

features:
  - title: Dual-Protocol DNS Routing
    details: RFC 2782 SRV discovery and RFC 5321 MX gateway bridging for user@domain handles.
    link: /protocol/dns-routing
  - title: Store-and-Forward Envelope
    details: Type 25 hop-by-hop relay delivery with independent storage payment stamps.
    link: /protocol/forwarding-envelope
  - title: Content-Addressed Blob Storage
    details: Decoupled S3/MinIO payload offloading, Kvrocks CAS, and ephemeral NATS fan-out.
    link: /protocol/blob-storage
---
