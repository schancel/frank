# Content-Addressed Encrypted Blob Storage & Attachments

- **Status**: Standard (Track C, Issue #983, Commit `e38d9cf6`)
- **Scope**: Large payload (> 64 KB) offloading to S3-compatible object storage, Apache Kvrocks metadata indexing, ephemeral Core NATS fan-out, and end-to-end client decryption.

---

## 1. Architectural Motivation

In high-throughput federated messaging, embedding large files (images, audio notes, PDF documents) directly inside RocksDB write-ahead logs (WAL) causes write amplification, LSM compaction freezes, and database bloat.

Frank decouples control plane metadata from data plane payloads:

- **Control Plane**: Envelopes $\le 64\text{ KB}$ (metadata, DKSAP stamps, Chaum-Pedersen DLEQ proofs, expiration timestamps) are stored in **Apache Kvrocks** (or RocksDB in standalone mode).
- **Data Plane**: Encrypted file attachments and payloads $> 64\text{ KB}$ are streamed directly to **S3-compatible Object Storage** (MinIO, Cloudflare R2, AWS S3) addressed purely by cryptographic hash.
- **Event Plane**: Ephemeral **Core NATS** notifies connected nodes without storing persistent message copies.

---

## 2. End-to-End Cryptographic & Data Architecture

```mermaid
flowchart TD
    subgraph ClientSide ["Client-Side Security Boundary (Alice)"]
        Plaintext["Plaintext Attachment<br/>(e.g., PDF, Image, Audio)"]
        GenKey["Generate Ephemeral Key<br/>K_blob ← Rand(256 bits)"]
        EncryptBlob["Encrypt Payload<br/>Ciphertext ← XChaCha20-Poly1305(K_blob, Plaintext)"]
        HashBlob["Compute Content Address<br/>BlobDigest ← SHA-256(Ciphertext)"]

        Plaintext --> EncryptBlob
        GenKey --> EncryptBlob
        EncryptBlob --> HashBlob
    end

    subgraph BlobUpload ["Content-Addressed Storage Ingestion"]
        UploadBlob["PUT /blobs/{BlobDigest}<br/>(Header: Storage-Stamp / Auth)"]
        ObjectStore[("S3 / MinIO Object Store<br/>Bucket: frank-relay-payloads<br/>Key: /blobs/{BlobDigest}")]

        HashBlob --> UploadBlob
        UploadBlob --> ObjectStore
    end

    subgraph MessagingPlane ["Encrypted Control & Messaging Plane"]
        ComposeDM["Compose Type 8 Message Item<br/>Attachment Reference:<br/>• blob_digest: BlobDigest<br/>• key: K_blob (Encrypted)<br/>• size: ByteCount, mime: 'application/pdf'"]
        WrapDM["Wrap in Type 5 / Type 1 / Type 25 Envelope<br/>(Signed by Alice, Stamped for Bob)"]
        PushDM["PUT /mailbox/delivery<br/>(Lightweight Envelope &lt; 64 KB)"]

        GenKey -.->|Key encrypted to Bob's M| ComposeDM
        HashBlob --> ComposeDM
        ComposeDM --> WrapDM
        WrapDM --> PushDM
    end

    subgraph ClusteredBackend ["Clustered Relay Node Architecture"]
        IngressNode["Relay Ingress Node"]
        Kvrocks[("Apache Kvrocks<br/>(Metadata, Stamps, Mailbox Index)")]
        CoreNATS{{"Ephemeral Core NATS<br/>Subject: frank.relay.notify.&lt;bob_hex&gt;"}}
        WSNode["Relay WebSocket Connection Node"]

        PushDM --> IngressNode
        IngressNode -->|Index Metadata| Kvrocks
        IngressNode -->|Publish Ping| CoreNATS
        CoreNATS -->|Deliver Event| WSNode
    end

    subgraph RecipientSide ["Client-Side Decryption Boundary (Bob)"]
        RecvPush["WebSocket Notification Received"]
        SyncInbox["Fetch Envelope: GET /mailbox/messages"]
        DecryptDM["Decrypt Envelope with Private Key m<br/>Extracts K_blob & BlobDigest"]
        FetchBlob["GET /blobs/{BlobDigest}<br/>(Direct from Object Store or CDN)"]
        DecryptFile["Decrypt Ciphertext with K_blob<br/>Recovers Original Attachment"]

        WSNode -.->|Socket Push| RecvPush
        RecvPush --> SyncInbox
        Kvrocks -.-> SyncInbox
        SyncInbox --> DecryptDM
        DecryptDM --> FetchBlob
        ObjectStore -.-> FetchBlob
        FetchBlob --> DecryptFile
    end

    style ClientSide fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff
    style RecipientSide fill:#0f172a,stroke:#34d399,stroke-width:2px,color:#fff
    style ClusteredBackend fill:#1e1b4b,stroke:#818cf8,stroke-width:2px,color:#fff
    style MessagingPlane fill:#14532d,stroke:#22c55e,stroke-width:2px,color:#fff
    style BlobUpload fill:#3b0764,stroke:#c084fc,stroke-width:2px,color:#fff
```

---

## 3. Cryptographic Invariants

1. **Zero Cleartext on Relays**: The blob storage provider never stores plaintext files. All data is encrypted client-side with an ephemeral 256-bit symmetric key $K_{\text{blob}}$ using XChaCha20-Poly1305 before transmission.
2. **Key Transport Security**: The symmetric key $K_{\text{blob}}$ is encapsulated within the end-to-end encrypted Type 5 payload, sealed with the recipient's authenticated Diffie-Hellman key $M$. Only the intended recipient can recover $K_{\text{blob}}$.
3. **Immutability & Content Verification**: The object identifier in storage is strictly equal to the SHA-256 (or BLAKE3) digest of the ciphertext. Recipients verify that the downloaded ciphertext matches the digest in the signed envelope before decryption.
