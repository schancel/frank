# Domain Discovery (`/.well-known/cashweb.json`) and Cryptographic External Naming Proofs (`.eth` / `.sol`)

See [`docs/protocol/dns-routing.md`](./protocol/dns-routing.md) for the full specification of:

1. **$O(1)$ Single-Record Domain Discovery (`GET /.well-known/cashweb.json`)**:
   - Served by both `cashweb-registry` (`backend/cashweb/cashweb-registry/src/http/server.rs`) and `mail-gateway` (`packages/mail-gateway/src/host/resend-webhook-http.ts`) with `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=3600`.
   - Eliminates per-user DNS records: any domain (`signet.mx`, `example.com`) publishes at most **one** static `/.well-known/cashweb.json` file (and optionally one domain-level `_cashweb._tcp.<domain>` SRV record + one `MX` record).
   - Client resolution via `discoverDomainRelay` and `resolveFederatedIdentifier` in `@frank/cashweb/directory` (`packages/cashweb/directory/domain-discovery.ts`).
2. **Bi-Directional External Naming Proofs (`.eth` ENS & `.sol` SNS)**:
   - Implemented via `ExternalNameClaim`, `createExternalNameClaim`, and `verifyExternalNameClaim` in `@frank/cashweb/directory` (`packages/cashweb/directory/external-naming.ts`).
