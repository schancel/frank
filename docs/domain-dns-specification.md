# Domain DNS Specification: Dual-Protocol Resolution (SRV + MX)

This document specifies the standard DNS configuration for Frank-enabled domains, allowing an address such as \`user@example.com\` to function seamlessly across both the standard Internet email network (via SMTP) and the Frank cryptographic messaging network (via Cashweb Direct Messaging).

---

## 1. Overview

A Frank-enabled domain delegates routing using two standard DNS resource records:

1. **DNS SRV (\`_frank._tcp.<domain>\`):** Advertises the authoritative Frank relay cluster for native Frank clients.
2. **DNS MX (\`<domain>\`):** Advertises the authoritative Email Gateway (MTA) for standard Internet email senders.

```text
                                  alice@example.com
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼                                           ▼
          Native Frank Clients                        Standard Email (SMTP)
                    │                                           │
         Query DNS SRV Record                        Query DNS MX Record
      _frank._tcp.example.com.                     example.com. IN MX 10
                    │                                           │
                    ▼                                           ▼
            relay.example.com                           mail.example.com
        (Cashweb Frank Relay)                      (Frank Email Gateway)
                    │                                           │
                    │                                 Translate SMTP ➔ DM
                    │                                           │
                    └───────────────────┬───────────────────────┘
                                        ▼
                            Alice's Frank Direct Inbox
```

---

## 2. DNS Record Specifications

### 2.1 Frank Relay Discovery (SRV Record)

To enable client discovery of the relay responsible for a domain's accounts, the domain MUST publish an RFC 2782 \`SRV\` record:

```dns
_frank._tcp.example.com.  86400  IN  SRV  10  0  443  relay.example.com.
```

* **Service:** \`_frank\` (the Frank protocol)
* **Proto:** \`_tcp\`
* **Name:** The organizational domain (e.g. \`example.com\`)
* **Priority:** \`10\` (lower priority value is preferred)
* **Weight:** \`0\` (used for server selection within same priority)
* **Port:** \`443\` (HTTPS / WSS endpoint)
* **Target:** The FQDN of the Frank relay host (e.g. \`relay.example.com\`)

### 2.2 Internet Email Routing (MX Record)

To receive inbound email from SMTP servers (Gmail, Outlook, etc.), the domain MUST publish standard RFC 5321 \`MX\` records pointing to the Frank Email Gateway host:

```dns
example.com.              86400  IN  MX   10  mail.example.com.
mail.example.com.         86400  IN  A    198.51.100.25
```

---

## 3. Email Authentication & Deliverability Records

To ensure outbound emails sent by the Frank Email Gateway reach recipient inboxes without being marked as spam or rejected by major providers, the domain MUST publish valid SPF, DKIM, and DMARC records:

### 3.1 Sender Policy Framework (SPF)
Authorizes the gateway's outbound IP to send mail on behalf of the domain:

```dns
example.com.              3600   IN  TXT  "v=spf1 ip4:198.51.100.25 -all"
```

### 3.2 DomainKeys Identified Mail (DKIM)
Publishes the gateway's public signing key under the configured selector (e.g. \`frank\`):

```dns
frank._domainkey.example.com. 3600 IN TXT "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
```

### 3.3 DMARC Policy
Enforces rejection of unaligned or fraudulent mail purporting to originate from the domain:

```dns
_dmarc.example.com.       3600   IN  TXT  "v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-reports@example.com"
```

### 3.4 Forward-Confirmed Reverse DNS (FCrDNS)
* The gateway IP (\`198.51.100.25\`) MUST have a PTR record resolving to \`mail.example.com\`.
* Forward resolution for \`mail.example.com\` MUST resolve back to \`198.51.100.25\`.
* The gateway's SMTP \`EHLO\` banner MUST state \`mail.example.com\`.

---

## 4. Resolution Algorithm for Native Frank Clients

When a Frank client is given a destination address of the form \`username@domain.com\` or \`0xAddress@domain.com\`:

1. **Parse Address:** Split into local part (\`recipient\`) and domain part (\`domain\`).
2. **Resolve Relay via SRV:**
   * Query \`_frank._tcp.<domain>\` via DNS SRV.
   * If found: construct base URL \`https://<target>:<port>\`.
   * If not found: fallback to \`https://relay.<domain>\` or reject as unresolvable.
3. **Resolve Recipient in Directory:**
   * If local part is a raw hex account (\`0x...\`): query \`GET /directory/account/:address\`.
   * If local part is a username handle: query \`GET /directory/user/:username\`.
4. **Attestation Verification:**
   * Verify the returned directory statement signature.
   * If the username is \`tombstoned\`: abort delivery and report that the account is deactivated.
   * Extract stamp key \(P'\) and encryption DH key \(M\).
5. **Encrypt and Stamp:**
   * Package message content and encrypt for \(M\).
   * Attach required stamp payment to \(P'\).
   * Submit direct message to the resolved relay endpoint.
