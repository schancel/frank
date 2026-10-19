# Zero-Backend Ephemeral Bearer Claim Links (`#1706`)

**Status**: Active Production Standard  
**Cryptographic Primitives**: HKDF-SHA256, secp256k1, Keccak-256 (EIP-55), ChaCha20-Poly1305 AEAD  
**Implementation**: `@frank/wallet/claim-link`

---

## 1. Overview & Motivation

Onboarding a brand-new user onto a self-custodial messaging and payment network traditionally suffers from a chicken-and-egg problem:

1. The recipient does not yet have a wallet address or public key in any directory.
2. Even if they install the client, a newly generated wallet has `0` native balance and cannot pay gas or attach an anti-spam payment stamp to their first reply.

**Ephemeral Bearer Claim Links** (`https://signet.mx/#claim=<token>`) solve this without any custodian, backend database, or faucet server:

- The sender generates a 16-byte (128-bit) or 32-byte (256-bit) random bearer seed $S$.
- Using HKDF-SHA256 with salt `"frank-claim-link-v1"`, the client deterministically derives:
  - A one-time secp256k1 private key and EIP-55 EVM address (`info = "secp256k1-privkey"`).
  - A 32-byte ChaCha20-Poly1305 AEAD key (`info = "welcome-note-aead"`) and 12-byte nonce (`info = "welcome-note-nonce"`).
  - A 16-byte public claim identifier `claimIdHex` (`info = "claim-id"`) for multi-device claim deduplication.
- The sender funds the ephemeral EOA on-chain with the gift amount plus a sweep gas reserve and first-reply stamp reserve, and shares the URL out-of-band (SMS, Signal, QR code, AirDrop).

---

## 2. URL Fragment Threat Model (`#claim=`)

Bearer secrets MUST NEVER appear in URL path segments (`/claim/...`) or query parameters (`?claim=...`).

By placing the token exclusively inside the RFC 3986 URI fragment (`https://signet.mx/#claim=<token>`):

- **Zero HTTP Server Leakage**: Browsers strip the `#...` fragment before transmitting HTTP `GET` requests. CDN logs, reverse proxies, and static hosting servers only ever see `GET / HTTP/2`.
- **Zero `Referer` Header Leakage**: User agents strip URI fragments from `Referer` headers when navigating to external links.
- **Strict Client Enforcement**: `parseClaimLink()` explicitly rejects any URL where `claim=` is supplied in the query string (`?claim=...`) and only extracts bearer tokens from the URL fragment.
- **AEAD Metadata Integrity**: The token binary layout is:
  $$\text{token} = \text{base64url}\!\left(\text{version}_1 \parallel \text{seedLen}_1 \parallel S \parallel \text{ChaCha20-Poly1305}_{K, N}\!\left(\text{AAD}=\text{header},\, \text{plaintext}=\text{metadata}\right)\right)$$
  Modifying any byte of the header, seed, ciphertext, or 16-byte Poly1305 tag causes `parseClaimLink()` to reject the link and return `null`.

---

## 3. Funding Reserve & First-Reply Stamp Math

To guarantee that a newly onboarded user receives the advertised gift amount *and* can immediately send stamped replies back to the sender, `calculateClaimFundingBreakdown()` computes:

$$\text{sweepFeeReserveWei} = \text{sweepGasLimit} \times \text{gasPriceWei} \quad (\text{default } \text{sweepGasLimit} = 21{,}000)$$

$$\text{replyStampReserveWei} = \text{replyStampWei} \times \text{replyCount}$$

$$\text{totalFundingRequiredWei} = \text{giftAmountWei} + \text{sweepFeeReserveWei} + \text{replyStampReserveWei}$$

When the recipient opens the claim link, their wallet sweeps the net balance:

$$\text{netSweepableAmountWei} = \max\!\left(0,\, \text{observedBalanceWei} - \text{sweepGasLimit} \times \text{currentGasPriceWei}\right)$$

into their permanent HD wallet account, leaving `0` dust behind on the ephemeral bearer EOA.

---

## 4. Claim & Sender Clawback State Machine

Because both the sender and the link recipient can derive the ephemeral bearer account from $S$, no smart-contract escrow is required for clawback of unclaimed links. `evaluateClaimBearerState()` evaluates four states:

| Status | Condition | `canRecipientClaim` | `canSenderClawback` |
| :--- | :--- | :---: | :---: |
| `already_claimed` | `claimIdHex` is present in synced `alreadyClaimedIds` set | `false` | `false` |
| `empty_or_swept` | `netSweepableWei == 0` (already swept on-chain or unfunded) | `false` | `false` |
| `expired_clawback_eligible` | `netSweepableWei > 0` and `nowMs >= expiresAtMs` | `false` | `true` |
| `claimable` | `netSweepableWei > 0` and not yet expired | `true` | `false` |
