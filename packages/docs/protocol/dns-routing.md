# Frank Dual-Protocol Domain DNS Routing Specification (SRV + MX)

- **Status**: Standard Draft (Parent Epic #821, Issue #973, Commit `21ef1bea`)
- **Scope**: DNS standards and client resolution algorithms enabling `user@domain` handles to function simultaneously as native Frank cryptographic direct-message endpoints and standard RFC 5321/5322 email addresses.

---

## 1. Overview & Architectural Objective

Frank provides self-custodial, end-to-end encrypted messaging with Dual-Key Stealth Address Protocol (DKSAP) financial payments. In traditional communication networks, users must manage disparate identifiers: public cryptographic keys, telephone numbers, and email addresses.

This specification establishes DNS record conventions and client resolution procedures allowing any registered Internet domain (e.g., `alice@example.com`) to serve as:

1. **A Native Frank Direct Messaging Handle**: Resolving transparently to a federated Cashweb relay endpoint, retrieving the recipient's authenticated Diffie-Hellman encryption public key ($K_{\text{msg}}$), stamp payment key ($K_{\text{stamp}}$), and directory evidence.
2. **A Standard Internet Email Address**: Routing traditional SMTP mail delivery through MX records to an automated Frank Email Gateway daemon that translates inbound emails into privacy-preserving DKSAP direct messages.

---

## 2. Client Resolution Algorithm

When a Frank client or daemon is instructed to communicate with an identifier matching `localpart@domain`:

```mermaid
flowchart TD
    Start(["Input: localpart@domain"]) --> Parse["1. Parse & validate localpart syntax<br/>(^[a-z0-9][a-z0-9_-]{2,31}$)"]
    Parse -->|Invalid Syntax| RejectSyntax["❌ Reject: Invalid handle format"]
    Parse -->|Valid| SRV["2. Query DNS SRV: _frank._tcp.&lt;domain&gt;"]

    SRV -->|SRV Records Found| SelectRelay["Select relay host by priority/weight"]
    SRV -->|No SRV Records| Fallback["Query HTTPS fallback (RFC 8615):<br/>https://&lt;domain&gt;/.well-known/frank-relay"]

    Fallback -->|Fallback Found| SelectRelay
    Fallback -->|No Fallback| CheckMX["3. Query DNS MX for &lt;domain&gt;"]

    SelectRelay --> QueryRelay["4. HTTP GET https://&lt;relay&gt;/directory/user/&lt;localpart&gt;"]

    QueryRelay -->|200 OK: Active User| NativeSend["🚀 Native Send:<br/>Extract K_msg, K_stamp, and Directory Evidence.<br/>Send native E2E encrypted DKSAP message"]
    QueryRelay -->|404 / Tombstoned| CheckMX
    QueryRelay -->|Relay Error / Timeout| CheckMX

    CheckMX -->|MX Records Present| GatewaySend["📧 Submit to Frank &harr; Email Gateway<br/>(Outbound SMTP translation with credit quota)"]
    CheckMX -->|No MX Records| RejectUnresolvable["❌ Reject: Destination unresolvable"]

    style Start fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#fff
    style NativeSend fill:#064e3b,stroke:#10b981,stroke-width:2px,color:#fff
    style GatewaySend fill:#78350f,stroke:#f59e0b,stroke-width:2px,color:#fff
    style RejectSyntax fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fff
    style RejectUnresolvable fill:#7f1d1d,stroke:#ef4444,stroke-width:2px,color:#fff
```

---

## 3. Handshake & Resolution Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Sender Client (Alice)
    participant DNS as DNS Server / Resolver
    participant Relay as Frank Cashweb Relay
    participant GW as Frank Email Gateway
    actor Bob as Recipient (Bob)

    Note over Alice: Alice intends to message 'bob@example.com'
    Alice->>DNS: DNS Query SRV _frank._tcp.example.com
    alt Native Frank Enabled
        DNS-->>Alice: SRV 10 50 443 relay.example.com
        Alice->>Relay: TLS 1.3 GET /directory/user/bob
        Relay-->>Alice: 200 OK: Directory Statement v4 { P, P', M, StatementAttestation }
        Note over Alice: Alice verifies attestation signature over statement bytes
        Note over Alice: Computes DKSAP stealth address using P' and derives session AEAD key from M
        Alice->>Relay: HTTP PUT /mailbox/delivery (Type 25 Forwarding Envelope)
        Relay->>Relay: Verify Storage Stamps & Index Envelope
        Relay-->>Alice: 202 Accepted
        Relay->>Bob: Push notification via WebSocket / SSE
        Bob->>Relay: HTTP GET /mailbox/messages
        Relay-->>Bob: Returns Encrypted Type 1 DM Payload
        Note over Bob: Bob decrypts message using private key m
    else Legacy Domain (No SRV / No Active User)
        DNS-->>Alice: NXDOMAIN / No SRV
        Alice->>Alice: Fallback check: GET https://example.com/.well-known/frank-relay (fails)
        Alice->>DNS: DNS Query MX example.com
        DNS-->>Alice: MX 10 mail.example.com
        Note over Alice: Alice selects Email Gateway Bridge
        Alice->>GW: HTTP POST /gateway/outbound (MIME Body + DKSAP Payment)
        GW->>GW: Deduct payment quota, sign DKIM
        GW->>Bob: SMTP Outbound (Port 25) to mail.example.com
        Note over Bob: Bob receives standard RFC 5322 email in classic inbox
    end
```

---

## 4. Cryptographic & Operational Invariants

1. **DNS is Discovery Only, Never Authority**: DNS SRV and MX records provide network routing locations only. All cryptographic authority derives strictly from the user's self-custodial root statement attestation.
2. **DNSSEC Strongly Recommended**: Relay discovery queries SHOULD be executed with DNSSEC validation enabled to prevent man-in-the-middle redirection to rogue relay endpoints.
3. **Strict TLS Enforcement**: Frank clients MUST reject plaintext HTTP connections. All relay communication MUST use TLS 1.3 on port 443 with valid X.509 server certificates matching the SRV target FQDN.
4. **Content-Oblivious Relay Boundary**: Relays process encrypted envelopes without access to message text. Resolution of `user@domain` happens exclusively at envelope creation; inner Type 6 encrypted payloads remain end-to-end encrypted to $K_{\text{msg}}$.
