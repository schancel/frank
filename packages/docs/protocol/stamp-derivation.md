# DKSAP Stamp Derivation & DLEQ Proofs

**Status**: Active Production Standard  
**Cryptographic Primitive**: secp256k1 Elliptic Curve Cryptography  
**Implementation**: `@frank/role-keys`, `@frank/wallet`, `frank-cbor`

---

## 1. Dual-Key Stealth Address Protocol (DKSAP)

Frank direct messages use Dual-Key Stealth Address Protocol (DKSAP) to ensure financial privacy and prevent linkability between the recipient's public identity and on-chain payment stamps.

### 1.1 Key Roles

- **Recipient Base Key**: $P' = p' \cdot G$ (published in directory statement)
- **Sender Ephemeral Key**: $E = e \cdot G$ (generated freshly for each message)
- **Shared Secret Scalar**: $s_{\text{shared}} = H(e \cdot P') = H(p' \cdot E)$
- **Derived Stealth Child Key**:
  $$P'_i = P' + H(s_{\text{shared}} \parallel i) \cdot G$$
- **Private Key Recovery (by Recipient)**:
  $$p'_i = p' + H(s_{\text{shared}} \parallel i) \pmod n$$

Because only the recipient possesses private key $p'$, only the recipient can calculate the spending private key $p'_i$ for the on-chain UTXO or EVM address.

---

## 2. Chaum-Pedersen DLEQ Proofs

To prevent a malicious sender from creating an envelope with an invalid stealth payment that the recipient cannot spend, the sender provides a 64-byte non-interactive zero-knowledge Discrete Logarithm Equality (DLEQ) proof.

### 2.1 The Statement Proven

The sender proves in zero-knowledge that:
$$\log_G(E) = \log_{P'}(S)$$
where:

- $E = e \cdot G$ (the sender's ephemeral public key)
- $S = e \cdot P'$ (the shared Diffie-Hellman secret point)

This guarantees to the recipient and intermediate relays that the stealth address was derived honestly from the recipient's advertised $P'$ key without revealing the ephemeral scalar $e$.

### 2.2 Proof Format

The DLEQ proof is serialized as a 64-byte binary string in Type 1 and Type 5 frames:
$$\text{proof} = c \parallel s$$

- **$c$ (32 bytes)**: Fiat-Shamir challenge scalar $H(G \parallel P' \parallel E \parallel S \parallel R_1 \parallel R_2)$
- **$s$ (32 bytes)**: Response scalar $k + c \cdot e \pmod n$

---

## 3. Air-Gapped Mobile Wallet Pattern (Relay Stamps)

For relay storage payment stamps:

- Relays advertise a static `payout_address` (child index $i = 0$).
- Senders pay the relay directly in the Type 25 forwarding envelope.
- The relay operator receives funds straight into their personal mobile wallet in real time without the relay daemon holding hot private keys or needing to perform on-chain dust sweeping.
