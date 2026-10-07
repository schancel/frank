# Inbound & Outbound Email Gateway Architecture

**Status**: Architecture Specification & Production Standard  
**Components**: `packages/mail-gateway`, `packages/frank-codec`, `cashweb-registry`  
**Related Specifications**: [Dual-Protocol DNS Routing](/protocol/dns-routing), [Clustered Relay Architecture](/architecture/clustered-relay)

---

## 1. Overview

The Frank Email Gateway (`packages/mail-gateway`) bridges traditional Internet email (RFC 5321 SMTP / RFC 5322 MIME) with Frank's native end-to-end encrypted Dual-Key Stealth Address Protocol (DKSAP) messaging network.

This architecture enables users with standard email clients (Apple Mail, Thunderbird, Gmail, Outlook) to communicate seamlessly with Frank users possessing `user@domain` handles, and allows Frank users to send cryptographic chat messages that arrive as standard signed emails to external recipients.

```mermaid
flowchart LR
    subgraph SMTP["Internet Email Network"]
        ExtMTA["External Mail Server (MTA)<br/>(e.g., Gmail, Proton, Outlook)"]
    end

    subgraph FrankEdge["Frank Domain Edge"]
        DNS["DNS MX & SRV Records<br/>(_frank._tcp & MX priority)"]
        MailGW["Frank Email Gateway<br/>(Postfix / Haraka / Node Worker)"]
    end

    subgraph Cluster["Frank Relay Cluster"]
        NATS["Core NATS Queue<br/>(mail.inbound.queue)"]
        S3["Blob Store (S3 / MinIO)<br/>(Raw MIME & Attachments)"]
        Relay["Cashweb Relay Nodes<br/>(cashwebd)"]
    end

    subgraph Client["End Users"]
        FrankUser["Frank User Client<br/>(Desktop / Mobile App)"]
    end

    ExtMTA -->|RFC 5321 SMTP| MailGW
    DNS -.->|MX Resolution| ExtMTA
    MailGW -->|Store MIME| S3
    MailGW -->|Publish Task| NATS
    NATS -->|Worker Claim| Relay
    Relay -->|DKSAP Envelope Delivery| FrankUser
    FrankUser -->|Outbound Gateway Message| Relay
    Relay -->|DKIM Sign & Send| ExtMTA
```

---

## 2. Inbound Email Flow (SMTP &rarr; Frank DKSAP)

When an external email sender transmits a message to `alice@example.com`:

```mermaid
sequenceDiagram
    autonumber
    participant Ext as External MTA (Sender)
    participant GW as Frank Email Gateway
    participant S3 as S3/MinIO Blob Store
    participant NATS as Core NATS Bus
    participant Relay as Cashweb Relay
    participant Alice as Alice's Frank Client

    Ext->>GW: SMTP connection (STARTTLS)
    GW->>GW: Verify SPF, DKIM, and DMARC
    GW->>S3: Upload raw RFC 5322 MIME payload
    GW->>NATS: Publish inbound task on `mail.inbound.queue`
    GW-->>Ext: 250 2.0.0 OK: Message queued
    NATS->>Relay: Dispatched to available worker
    Relay->>Relay: Lookup `alice` in Directory (`K_msg`, `K_stamp`)
    Relay->>Relay: Generate ephemeral DKSAP stealth keypair
    Relay->>Relay: Encrypt email text/HTML & attach blob reference
    Relay->>Alice: Push Type 25 forwarding envelope / WebSocket ping
    Alice->>Alice: Scan inbox, compute shared secret, decrypt MIME
```

### 2.1 Security & Inbound Sanitization

1. **DKIM / SPF / DMARC Verification**: Inbound messages undergo strict cryptographic verification. Authentication results are injected into internal envelope metadata (`Authentication-Results` header).
2. **HTML & Attachment Sanitization**: Malicious script tags, tracking pixels, and active content are stripped before encapsulation into Frank markdown chat format.
3. **Payload Decoupling**: Large email attachments (> 64 KiB) are extracted and written directly to the content-addressed blob store. The encrypted DM payload contains encrypted URI pointers and SHA-256 hashes.

---

## 3. Outbound Message Flow (Frank Chat &rarr; Internet SMTP)

When a Frank user sends a message to a traditional email recipient (e.g. `bob@external.org`):

```mermaid
sequenceDiagram
    autonumber
    participant Alice as Alice's Frank Client
    participant Relay as Cashweb Relay
    participant GW as Outbound Email Gateway
    participant Ext as External MTA (Recipient)

    Alice->>Relay: POST /monad/mailbox/outbox (Type 25 Envelope)
    Relay->>Relay: Deduplicate & verify storage/gas payment quota
    Relay->>GW: Forward to Outbound Mail Queue
    GW->>GW: Convert Frank Markdown to MIME multipart (Plain + HTML)
    GW->>GW: Sign message with Ed25519 / RSA DKIM key for sender domain
    GW->>Ext: Resolve DNS MX for `external.org` and deliver via SMTP (TLS 1.3)
    Ext-->>GW: 250 2.0.0 OK: Message accepted
    GW->>Relay: Update delivery job status to `DELIVERED`
    Relay-->>Alice: Delivery receipt / journal update
```

---

## 4. Multi-Worker Queueing and Scaling

To handle bursty email traffic without blocking relay API workers:

1. **Queue Groups**: Workers subscribe to `mail.inbound.queue` using NATS queue group semantics. Exactly one worker claims each inbound email delivery job.
2. **Crash Resilience**: If a worker crashes while processing a message, NATS re-delivers the job after an unacknowledged timeout.
3. **Idempotency**: Inbound SMTP `Message-ID` headers are combined with the cryptographic hash of the raw MIME body to produce an idempotent deduplication key in Apache Kvrocks. Re-transmitted SMTP deliveries do not create duplicate Frank DMs.
