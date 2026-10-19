# Frank dApp Provider & Multi-Platform Extension Bridge (`#1708`, `#1709`, `#1710`)

Frank provides an origin-verified dApp provider and signing bridge (`@frank/wallet/dapp-bridge`) across Desktop Chrome/Brave/Edge (`chrome.sidePanel`), Firefox (`browser.sidebarAction`), Safari Web Extensions (macOS & iOS), and the Standalone PWA (`https://signet.mx`).

---

## 1. Cryptographic Isolation: dApp Persona EOAs vs. Stamp Pool Sub-Accounts (`#1708`)

Unlike standard single-EOA wallets (MetaMask, Rabby, Phantom) that expose one linkable address to every dApp, Frank splits user balances across `EvmStampPayer` sub-accounts (`m/44'/60'/0'/0/i`) for unlinkable messaging and payment stamps.

To prevent any external dApp from linking a user's messaging identity or stamp pool sub-accounts:

| Key Domain | BIP-44 Derivation Path | Purpose | Exposed to External dApps? |
| :--- | :--- | :--- | :--- |
| **Messaging Identity** | Frank Identity Keyring | E2EE messaging & KeyRegistry | **NEVER** |
| **Stamp Pool Sub-Accounts** | `m/44'/60'/0'/0/{i}` | Unlinkable stamp & payment UTXO-style pool | **NEVER** |
| **Primary dApp Persona** | `m/44'/60'/1'/0/0` | Default dApp checking EOA | Yes (when user selects Primary Persona) |
| **Burner dApp Personas** | `m/44'/60'/1'/0/{1..N}` | Per-origin isolated EOA (`app.uniswap.org` $\neq$ `opensea.io`) | Yes (bound to a single normalized HTTPS origin) |

`DappPersonaKeyring.assertNotIdentityOrStampPoolAddress` enforces at runtime that no signing or connection operation can ever expose a protected identity or `m/44'/60'/0'/0/i` address.

---

## 2. Just-In-Time (JIT) Pool Consolidation & Zero-Dust Return Sweeps (`#1708`)

When a connected dApp requests `eth_sendTransaction({ from: personaAddress, to, value, data })`:

1. **Shortfall Calculation (`calculateDappJitSweepRequirement`)**:
   $$
   R_{\text{persona}} = V_{\text{tx}} + G_{\text{dapp}} \cdot F_{\max}
   $$
   $$
   \Delta_{\text{shortfall}} = \max\bigl(0,\; R_{\text{persona}} - B_{\text{persona}}\bigr)
   $$
2. **Pre-Funding Sweep (`executeDappJitSweepAndSignTx`)**:
   - If $\Delta_{\text{shortfall}} = 0$, the dApp Persona EOA signs the EIP-1559 (Type 2) transaction immediately.
   - If $\Delta_{\text{shortfall}} > 0$, `EvmStampPayer` sweeps $\Delta_{\text{shortfall}}$ (plus $21{,}000 \cdot F_{\max}$ transfer gas overhead) from the user's sub-account pool into `personaAddress`, and then signs the dApp transaction.
3. **Zero-Dust Return Sweep (`buildPersonaReturnSweepTx`)**:
   - When retiring a burner persona or returning unused funds to the Frank pool, Frank sweeps:
     $$
     V_{\text{return}} = B_{\text{observed}} - 21{,}000 \cdot F_{\max}
     $$
     leaving exactly `0` wei dust in the retired persona EOA.

---

## 3. EIP-6963 & EIP-1193 Origin-Verified Router (`#1709`)

- **EIP-6963 Announcement**:
  - `rdns`: `'mx.signet.frank'`
  - `name`: `'Frank'`
- **Origin Verification (`normalizeDappOrigin`)**:
  - Every RPC call is bound to the sender frame's canonical origin (`https://...` or `http://localhost`).
  - Opaque origins (`"null"`), `file://`, `data:`, and non-localhost `http://` origins are rejected before reaching the router.
- **Inline Approval Queue (`FrankDappBridgeRouter`)**:
  - Interactive methods (`eth_requestAccounts`, `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, `wallet_switchEthereumChain`) enqueue a `PendingDappApproval` card rendered inline in the Frank UI without spawning modal browser popups.
  - Rejections return standard EIP-1193 error code `4001` (`User Rejected Request`).

---

## 4. PWA $\leftrightarrow$ Browser Extension Origin Sync (`#1710`)

Because `https://signet.mx` and `chrome-extension://<id>` / `moz-extension://<uuid>` / `safari-web-extension://<uuid>` inhabit isolated browser storage partitions, `createExtensionOriginSyncHandshake` binds both origins into the `#1707` ephemeral `secp256k1` ECDH + `HKDF-SHA256` + `ChaCha20-Poly1305` transcript to transfer an encrypted `DeviceSyncBundle` with 6-digit / 4-word SAS verification.
