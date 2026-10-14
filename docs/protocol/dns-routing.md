# Single-Record Domain Discovery (`/.well-known/cashweb.json`) & External Naming Proofs (`.eth` / `.sol`)

- **Status**: Standard Specification (Parent Epic #821, Issue #973)
- **Scope**: $O(1)$ domain-level discovery via `GET /.well-known/cashweb.json` (plus optional single-domain `_cashweb._tcp.<domain>` SRV and `MX` records) and bi-directional cryptographic proofs for external naming systems (ENS `.eth` and Solana Name Service `.sol`).

---

## 1. Architectural Invariant: $O(1)$ Domain-Scoped Discovery (Zero Per-User DNS Records)

A domain serving $100,000$ users (e.g., `signet.mx` or `example.com`) MUST **never** provision per-user DNS `SRV` or `TXT` records. All DNS and HTTPS discovery is strictly **domain-scoped ($O(1)$ per domain)**, while individual handle resolution (`alice@signet.mx`) occurs over the discovered relay's authenticated directory API (`GET /usernames/:name`).

### 1.1 Primary HTTPS Well-Known Discovery (`GET /.well-known/cashweb.json`)

Every Cashweb-enabled domain (and every `cashweb-registry` relay or `mail-gateway` HTTP host) serves a single static discovery document at:

```http
GET /.well-known/cashweb.json HTTP/1.1
Host: signet.mx
Accept: application/json
```

Response headers MUST include:
- `Content-Type: application/json`
- `Access-Control-Allow-Origin: *` (enabling direct browser/PWA resolution without DoH)
- `Cache-Control: public, max-age=3600`

Response JSON schema:

```json
{
  "version": 1,
  "relay": "https://relay.signet.mx",
  "mail_gateway": "signet.mx",
  "network": "monad-testnet"
}
```

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `version` | `1` | Yes | Discovery document schema version (`1`). |
| `relay` | `string` | Yes | Canonical HTTPS origin of the domain's Cashweb relay (`https://...`). |
| `mail_gateway` | `string` | No | Optional domain of the Frank ↔ SMTP email gateway serving inbound/outbound mail. |
| `network` | `string` | Yes | Canonical Frank protocol network identifier (e.g., `monad-testnet`). |

### 1.2 Optional Single Domain-Wide DNS SRV + MX Records

For native daemon/server federation and standard RFC 5321 SMTP email routing, operators optionally publish **one** domain-wide `SRV` record and **one** `MX` record:

```dns
_cashweb._tcp.signet.mx.  3600 IN SRV 10 0 443 relay.signet.mx.
signet.mx.                3600 IN MX  10 mail.signet.mx.
```

*(Note: `_frank._tcp.<domain>` is accepted as a legacy alias for `_cashweb._tcp.<domain>`.)*

### 1.3 Federated Handle Resolution (`resolveFederatedIdentifier`)

When a client resolves `alice@signet.mx` or `@alice@signet.mx`:
1. **Domain Discovery**: Calls `discoverDomainRelay('signet.mx')`, which fetches `https://signet.mx/.well-known/cashweb.json`, validates the HTTPS `relay` origin and `version: 1` schema, and caches the descriptor per domain (default 24h TTL).
2. **User Lookup**: Queries `GET ${relayUrl}/usernames/alice` on the discovered relay.
3. **Directory Verification**: Extracts Alice's canonical Frank `0x...` address and verifies her self-signed directory statement before sending any encrypted message or DKSAP payment.

---

## 2. Cryptographic External Naming Proofs (`.eth` ENS & `.sol` SNS)

Users who own an **ENS (`.eth`)** name (e.g., `vitalik.eth`) or **Solana Name Service (`.sol`)** handle (e.g., `toly.sol`) can bind their external handle to their canonical Frank identity address (`0x...`) using `ExternalNameClaim` (`@frank/cashweb/directory`).

### 2.1 `ExternalNameClaim` Structure

```ts
export interface ExternalNameClaim {
  readonly namespace: 'ens' | 'sns' | 'dns';
  readonly name: string;          // e.g. "alice.eth" or "toly.sol"
  readonly ownerAddress: string;  // canonical Frank 0x... identity address
  readonly chainId?: string;      // e.g. "eip155:1" or "solana:mainnet"
  readonly proofSignature: string;
  readonly timestamp: number;
}
```

### 2.2 Bi-Directional Verification (`createExternalNameClaim` & `verifyExternalNameClaim`)

To prevent spoofing, `verifyExternalNameClaim(claim, { resolveExternalName })` enforces bi-directional verification:
1. **Reverse Attestation (`Key -> Name`)**: Verifies `claim.proofSignature` over the canonical domain-separated binding transcript:
   `frank-name-bind-v1:<namespace>:<name>:<ownerAddress>:<chainId>:<timestamp>`
2. **Forward Resolution (`Name -> Key`)**: Invokes `resolveExternalName(claim.name, claim.namespace)` and verifies that the external naming registry currently resolves `claim.name` to `claim.ownerAddress`.
