# Frank dApp Provider, Multi-Platform Extension Bridge & `lotus-connect/1` Protocol (`#1708`, `#1709`, `#1710`)

Frank provides an origin-verified, anti-supercookie multi-chain dApp provider and signing bridge (`@frank/wallet/dapp-bridge`) across Desktop Chrome/Brave/Edge (`chrome.sidePanel`), Firefox (`browser.sidebarAction`), Safari Web Extensions (macOS & iOS), and the Standalone PWA (`https://signet.mx`), together with the **Consolidated W3C `MessagePort` Browser Connect Protocol (`lotus-connect/1`)** for Lotus V2 (`@lotus/v2-payment-compiler/transaction-runtime`, `lotus-v2/contract-artifact/2`, `lotus-v2/policy-artifact/1`, and Lotus V2 PSBT Profile 1 `0x4c560001`) and multi-chain CAIP-2 providers.

---

## 1. Multi-Platform Extension Targets & Runtime Topology

Frank's browser extension (`app/src-bex/`) builds from a unified Quasar/Vite bundle into three Manifest V3 platform targets (`app/src-bex/manifests.ts`, `app/scripts/build-extension.mjs`):

| Platform Target | Surface Modes | Content / In-Page Script Injection | Background & Storage Partition |
| :--- | :--- | :--- | :--- |
| **Chrome / Brave / Edge (`chrome`)** | Persistent Side Panel (`index.html?extMode=sidepanel` via `chrome.sidePanel`) + Toolbar Popup (`index.html?extMode=popup`) | Declarative MV3 `world: 'MAIN'` (`inpage.js` at `document_start`) + `world: 'ISOLATED'` (`content.js` at `document_start`) | ESM `service_worker: 'background.js'` (`chrome.storage.local` + `offscreen` capability) |
| **Firefox (`firefox`, Gecko $\ge 128$)** | Persistent Sidebar (`index.html?extMode=sidebar` via `browser.sidebarAction`) + Toolbar Popup (`index.html?extMode=popup`) | Declarative MV3 `world: 'MAIN'` (`inpage.js`) + `world: 'ISOLATED'` (`content.js`) | ESM background scripts `['background.js']` (`frank@signet.mx`) |
| **Safari macOS & iOS (`safari`)** | Native Extension Popover / Sheet (`index.html?extMode=popup`) | `content.js` (`document_start`) dynamically mounts `<script src="safari-web-extension://.../inpage.js" data-frank-safari-inpage="true">` (`ensureSafariFallbackInpageScript`) via `web_accessible_resources` when declarative `world: 'MAIN'` is unavailable | `service_worker: 'background.js'` bridged with native macOS/iOS WebExtension container |
| **Standalone PWA (`https://signet.mx`)** | Full-screen / Mobile PWA (`extMode` unset) | `FRANK_PWA_EXTENSION_SYNC_CHANNEL` (`frank-pwa-extension-sync-v1`) PIN pairing with `content.js` on `https://signet.mx` only | Origin-isolated IndexedDB / `localStorage`; the account moves to or from the extension by PIN pairing (section 8) |

### Context Invalidated & Reload Resilience
When an extension updates or reloads in development or production, `installContentScriptBridge` (`app/src-bex/content.ts`) cleans up any prior listener via `window.__FRANK_CONTENT_BRIDGE_CLEANUP__` and verifies `getRawExtensionApi()?.runtime?.id` before forwarding messages, detaching stale listeners immediately if the extension context was invalidated.

---

## 2. dApp Personas: hardened custody derivation

> Current support: EVM sites can connect to the custody-derived origin persona and explicitly approve `personal_sign`, `eth_sign`, `eth_signTypedData[_v3|_v4]`, and `eth_sendTransaction`. Solana Wallet Standard connect, message signing, transaction signing, and sign-and-send use the account's real Solana key through a session-bound custody capability. EVM and Solana connection grants are stored separately. Bitcoin-family and eCash dApp methods remain unsupported (`4200`). Sections 3, 6, and 7 preserve historical designs, not current behavior.

dApp persona keys are hardened BIP-32 children of the account's EVM BIP-32 master (the `evm-wallet` domain root; the BIP39 seed for historical accounts), derived only inside custody (`packages/wallet/dapp-bridge/persona-keys.ts`, exposed through `accountSession.createDappPersonaSigner()`):

| Path | Use |
| :--- | :--- |
| `m/1785'/60'/0'/<slot>'` | Shared persona slots (slot 0 is the default shared persona) |
| `m/1785'/60'/1'` | Site-index key; its private key keys the per-site HMAC |
| `m/1785'/60'/2'/<a>'/<b>'` | Per-site persona; `(a, b)` are the first two u32 words (top bit cleared) of `HMAC-SHA256(site-index key, "frank/dapp-persona/site/v1" \|\| 0x00 \|\| canonical origin)` |

Purpose `1785'` is used by no other Frank role. Every frontend of an account computes the same EVM persona for a site without sync; nobody without the account secret can derive a persona key or link two sites. The extension background never derives personas: Frank views provide the addresses (`update-persona-state`, `provision-site-personas`), and until they have, EVM persona requests fail with `4900`. Solana uses the account's actual Solana address and public key; it does not present an EVM persona as a Solana account.

---

## 3. Anti-Supercookie Architecture & UTXO Anti-Clustering

1. **Per-Origin Burner Personas by Default (`mode: 'per-origin-burner'`)**:
   - `MultiChainDappPersonaKeyring.getOrAssignOriginPersona(origin, chainFamily)` defaults to `'per-origin-burner'`.
   - Every origin receives a cryptographically distinct Persona index ($\ge 1$):
     - `https://jup.ag` and `https://raydium.io` receive completely different Solana base58 addresses.
     - `https://magiceden.io` and `https://unisat.io` receive completely different Bitcoin `bc1q...` Payment and `bc1p...` Taproot Ordinals addresses.
     - `https://cashtab.com` and `https://ecash.supply` receive completely different `ecash:q...` CashAddr personas.
2. **Zero Silent Account Leakage (`silent: true`)**:
   - Silent probes (`eth_accounts`, `solana:connect({ silent: true })`, `unisat.getAccounts()`, `bch_getAddresses`) never prompt the user and always return `[]` (or `""` for `unisat.getPublicKey()`) on unapproved origins.
   - On approved origins, silent probes return **only** the Persona bound to that specific origin.
3. **Ephemeral Per-Page EIP-6963 `crypto.randomUUID()` & Provider Stealth Policy (`DappTrackabilityPolicy`)**:
   - When announcing via EIP-6963, Frank generates a fresh per-page-load `crypto.randomUUID()` rather than a static cross-site UUID when privacy masking is active.
   - Supports `announceMode: 'always' | 'connected-only' | 'stealth'`. In `'stealth'` mode, zero ambient `window.*` globals or unprompted `eip6963:announceProvider` events are emitted until the user explicitly activates the Frank extension on that tab.
   - Enforces `maxPendingPerOrigin = 1` and a post-rejection cooldown (`rejectionCooldownMs = 5000`) after EIP-1193 error `4001` so a malicious page cannot trap users in a `while (true)` approval loop.
4. **Virtual Balance Privacy Masking (`computeOriginVirtualBalanceMaskOffsetWei`)**:
   - Prevents websites from fingerprinting a user's exact wallet balance across origins via `eth_getBalance`.
5. **UTXO Anti-Cluster JIT Input Selection (`planUtxoPersonaJitInputSelection`)**:
   - On UTXO chains (`xpi`, `btc`, `bch`, `xec`, `doge`, `ltc`), co-spending multiple wallet UTXOs inside an untrusted dApp transaction or PSBT leaks common-input-ownership (CIOH) across the user's wallet.
   - `planUtxoPersonaJitInputSelection` prioritizes UTXOs already owned by the origin's Persona address; when unfunded, it plans a 1-hop JIT funding output for the exact required atoms/satoshis + fee from non-main-receive pool UTXOs so the dApp never sees the user's primary receiving address or multi-address UTXO cluster.

---

## 4. Required CAIP-2 Chain Identification (`docs/protocol/chains/v1.json`)

Every chain in Frank's protocol registry (`docs/protocol/chains/v1.json`, validated by `packages/wallet/chain/protocol-chain-registry.ts`) requires a non-null, globally unique `caip2: string` identifier alongside its required `identity_probes`:

| Canonical Protocol `id` | Family | Network | Required `caip2` Identifier |
| :--- | :--- | :--- | :--- |
| `xpi-mainnet` | `bitcoin` (Lotus) | `mainnet` | `bip122:000000000abc0cde58ee7e919d3d4de1` |
| `xpi-testnet` | `bitcoin` (Lotus) | `testnet` | `bip122:00000000080a6c9633aae9d24b9acda1` |
| `xpi-regtest` | `bitcoin` (Lotus) | `regtest` | `bip122:xpi-regtest` |
| `monad-mainnet` / `testnet` / `regtest` | `evm` | `mainnet` / `testnet` / `regtest` | `eip155:143` / `eip155:10143` / `eip155:20143` |
| `ethereum-mainnet` / `ethereum-sepolia` | `evm` | `mainnet` / `testnet` | `eip155:1` / `eip155:11155111` |
| `base-mainnet` / `base-sepolia` | `evm` | `mainnet` / `testnet` | `eip155:8453` / `eip155:84532` |
| `arbitrum-mainnet` / `arbitrum-sepolia` | `evm` | `mainnet` / `testnet` | `eip155:42161` / `eip155:421614` |
| `polygon-mainnet` / `polygon-amoy` | `evm` | `mainnet` / `testnet` | `eip155:137` / `eip155:80002` |
| `bnb-mainnet` / `bnb-testnet` | `evm` | `mainnet` / `testnet` | `eip155:56` / `eip155:97` |
| `hyperliquid-mainnet` / `testnet` | `evm` | `mainnet` / `testnet` | `eip155:999` / `eip155:998` |
| `tempo-mainnet` / `tempo-testnet` | `evm` | `mainnet` / `testnet` | `eip155:4217` / `eip155:42431` |
| `solana-mainnet` / `devnet` / `testnet` | `solana` | `mainnet` / `testnet` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` / `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` / `solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z` |
| `btc-mainnet` / `testnet` / `testnet4` / `regtest` | `bitcoin` | `mainnet` / `testnet` / `regtest` | `bip122:000000000019d6689c085ae165831e93` / `bip122:000000000933ea01ad0ee984209779ba` / `bip122:00000000da84f2bafbbc53dee25a72ae` / `bip122:btc-regtest` |
| `bch-mainnet` / `testnet` / `regtest` | `bitcoin` | `mainnet` / `testnet` / `regtest` | `bip122:000000000000000000651ef99cb9fcbe` / `bip122:00000000000e38fef93ed9582a7df438` / `bip122:bch-regtest` |
| `xec-mainnet` / `testnet` / `regtest` | `bitcoin` | `mainnet` / `testnet` / `regtest` | `bip122:000000000000000004284c9d8b2c8ff7` / `bip122:00000000062c7f32591d883c99fc89eb` / `bip122:xec-regtest` |
| `doge-mainnet` / `doge-testnet` | `bitcoin` | `mainnet` / `testnet` | `bip122:1a91e3dace36e2be3bf030a65679fe82` / `bip122:bb0a78264637406b6360aad926284d54` |
| `litecoin-mainnet` / `litecoin-testnet` | `bitcoin` | `mainnet` / `testnet` | `bip122:12a765e31ffd4059bada1e25190f6e98` / `bip122:4966625a4b2851d9fdee139e56211a0d` |

---

## 5. Consolidated W3C `MessagePort` Browser Connect Protocol (`lotus-connect/1`)

Alongside legacy ecosystem shims, Frank implements the canonical **`lotus-connect/1`** protocol specified in the Lotus V2 Specifications (`docs/lotus-v2/browser-connect.md`).

### 5.1 W3C `MessageChannel` (`MessagePort`) Handshake & Structured Clone Transport
Instead of polluting `window.*` or broadcasting JSON strings over `window.postMessage(..., '*')`, a web application opens a dedicated W3C `MessageChannel` and transfers `channel.port2` to the isolated content script:

```ts
const channel = new MessageChannel();
channel.port1.start();

window.postMessage(
  {
    protocol: "lotus-connect/1",
    type: "handshake-init",
    requestedChains: ["bip122:000000000abc0cde58ee7e919d3d4de1", "eip155:143"],
  },
  window.location.origin,
  [channel.port2],
);
```

- **Point-to-Point Isolation**: Once `port2` is transferred, third-party scripts on the page cannot eavesdrop on or inject messages into the `port1 <-> port2` pipe.
- **Native Structured Clone**: Binary `Uint8Array` payloads (Lotus V2 v7 wire templates, sparse-state `CoinProof`s, PSBT bytes, signatures), `bigint` atom amounts, and `lotus-v2/contract-artifact/2` structures traverse the `MessagePort` directly without hex/Base64 encoding overhead.
- **Unspoofable Origin Binding**: `content.ts` attaches `origin: window.location.origin`, `href: window.location.href`, and `isTopFrame: window.top === window` to every forwarded request.

### 5.2 Connectless Intent Fulfillment (`wallet_fulfillIntent`) & Lotus V2 Compiler Integration
`wallet_fulfillIntent` allows a webpage to request a payment, token transfer, or smart-contract covenant interaction **without calling `connect()` or learning the user's persistent address or UTXO inventory**.

On Lotus V2 (`bip122:000000000abc0cde58ee7e919d3d4de1`, `bip122:00000000080a6c9633aae9d24b9acda1`, `bip122:xpi-regtest`), `wallet_fulfillIntent` integrates directly with `@lotus/v2-payment-compiler/transaction-runtime` (`prepareTransactionCall` and `finalizeTransactionCall`):

1. **Accepted Lotus V2 Intent Payloads**:
   - **Mode A (`lotus-v2-transaction-intent`)**: A partial `TransactionIntent` (`profile: 'P01-P02-P03-candidate-2026-10-14'`, 32-byte `chainId`, `dustLimitAtoms`) containing protocol `SpendInput`s (with `lotus-v2/contract-artifact/2` witnesses, resolved `Coin-v2` bytes, and `COIN_PROOF`s) or `MintInput`s, protocol `AssetOutput`s (with optional `lotus-v2/policy-artifact/1` provenance), and symbolic wallet placeholders (`$WALLET_FUNDING_INPUTS`, `$WALLET_FRESH_RECEIVE_POLICY`, `$WALLET_PERSONA_POLICY`, `$WALLET_CHANGE_OUTPUT`).
   - **Mode B (`lotus-v2-psbt`)**: A binary **Lotus V2 PSBT Profile 1 (`version = 0x4c560001`, magic `70736274ff`, proprietary `lotus-v2`)** `Uint8Array` document (`TX_TEMPLATE`, `CHAIN_ID`, `UTXO_ROOT`, per-input `COIN`, `COIN_PROOF`, `ARGUMENTS`, `SIGN_REQUEST`).
2. **Enclave Verification & Completion Pipeline**:
   - Verifies `caip2` and the 32-byte `ChainID` against the active chain configuration.
   - Authenticates every protocol `COIN` via its sparse-tree `COIN_PROOF` against Frank's independently validated `UTXO_ROOT` / header commitment (`psbt.md`).
   - Runs `assertContractArtifact` on every `lotus-v2/contract-artifact/2` (`sorted-leaves-largest-power-split-v1` method tree, leaf/proof membership, and branch root equality) and validates `lotus-v2/policy-artifact/1` branch-and-path encodings.
   - Substitutes `$WALLET_FRESH_RECEIVE_POLICY` with a freshly derived Type-1 x-only BLAKE3 keyhash policy (`DUP BLAKE3 PUSH32(keyhash) EQUALVERIFY CHECKSIG`, `branches=[BranchLeaf(program)]`, `paths=[[0]]`), privately selects uncorrelated funding UTXOs (`planUtxoPersonaJitInputSelection`) to satisfy the native XPI deficit + complete-wire byte floor + `2 * dustLimitAtoms * tokenOutputCount` + P05 parabolic fee floor, and appends a fresh change output.
   - Executes `prepareTransactionCall(completeIntent)` to obtain the deterministic `TransactionPlan` (`txid`, `feeAtoms`, `tokenDeltas`, `tokenBurns`, `FullSignatureRequest[]`).
   - Renders the human-readable approval prompt: formats native XPI to **2 decimal places (`1.00 XPI`)** by default with expandable 6-decimal atom (`1 XPI = 10^6 atoms`) inspection, displays per-token deltas/burns and verified `artifact.contract` + `methodName` provenance, signs each `FullSignatureRequest.digest` with BIP-340 Schnorr (`scheme = 0`), runs `finalizeTransactionCall(plan, signatures)`, and broadcasts or returns `{ txid, txhash, wire }`.

### 5.3 Lotus V2 Application Message Signing (`lotus-chain-bound-compact-ecdsa-v1`) & Session Keys
- **Origin-Bound Message Signing (`wallet_signMessage`)**:
  Uses the exact preimage from `docs/lotus-v2/message-signing.md`:
  $$\text{preimage} = \text{CompactSize}(22) \parallel \text{"Lotus Signed Message:\textbackslash n"} \parallel \texttt{0x01} \parallel \text{ChainID}[32] \parallel \text{CompactSize}(\text{len}(\text{message})) \parallel \text{message}$$
  hashed with double-SHA256 and signed with 65-byte RFC 6979 low-$S$ recoverable ECDSA (`header = 31..34`), verified against the origin's Type-1 `xpi1p...` persona address via `BLAKE3(xonly_public_key) == address.payload`. Web session challenges enforce mandatory `Origin: <https://origin>` and `Nonce:` binding so a signature from one site can never be replayed on another.
- **Scoped Session Keys (`wallet_requestSession`)**:
  Web applications can register an ephemeral in-memory `sessionPublicKey` with a bounded micro-budget (`maxSpendAtoms`, e.g. `5_000_000n` = `5.00 XPI`, and `expiresAtUnix`) backed by a dedicated session UTXO or enclave allowance for 0-click micro-stamps and high-frequency actions.

---

## 6. Current provider APIs and unsupported methods

Current injected providers are routed through `app/src-bex/inpage.ts`, `content.ts`, and `background.ts`. User approval is shown in the dedicated approval window; signing and transaction requests execute only through the unlocked Frank app session.

- **EVM:** EIP-1193 and EIP-6963 account discovery; message and typed-data signatures from the selected origin persona; signed transaction broadcast through the selected supported EVM chain RPC. The submitted transaction hash is checked against the signed bytes. Ambiguous submissions retain the signed bytes and retry the same transaction.
- **Solana:** Wallet Standard discovery, connect/disconnect, message signing, legacy and v0 transaction signing, and sign-and-send on Solana mainnet or devnet. Accounts and signatures use the account's actual Ed25519 Solana key. Each signing/submission request requires approval.
- **Bitcoin-family and eCash:** No injected provider methods are advertised; method requests fail explicitly with `4200`.

The compatibility designs below describe removed implementations and are not active capabilities.

## 6. Historical Unified Multi-Chain Legacy Compatibility Shims (`UnifiedMultiChainDappRouter`)

All legacy browser wallet protocols translate into the exact same internal `UnifiedDappRequest` and `MultiChainDappPersonaKeyring` architecture:

- **EVM (`FrankDappBridgeRouter` / EIP-1193 + EIP-6963)**:
  - Announces `rdns: 'mx.signet.frank'`, `name: 'Frank'`.
  - Per-origin pinned `chainId`, virtual balance privacy masking (`computeOriginVirtualBalanceMaskOffsetWei`), and JIT pool consolidation (`executeDappJitSweepAndSignTx`).
- **Solana Wallet Standard (`SolanaWalletStandardBridge`)**:
  - Implements `standard:connect`, `standard:disconnect`, `standard:events`, `solana:signMessage`, `solana:signTransaction`, `solana:signAndSendTransaction`, and `solana:signIn` (Sign-In-With-Solana / SIWS challenge formatting and Ed25519 signing).
- **Bitcoin Fragmentation Unifier (`BitcoinDappBridge` — WBIP004 / `sats-connect` + `UniSat` + `@frank/nakamoto`)**:
  - Translates both **UniSat** (`unisat_requestAccounts`, `unisat_getAccounts`, `unisat_getPublicKey`, `unisat_getNetwork`, `unisat_switchNetwork`, `unisat_signMessage` ECDSA & BIP-322 Schnorr, `unisat_signPsbt`, `unisat_signPsbts`) and **WBIP004 / Xverse `sats-connect`** (`getAccounts` / `wallet_connect` returning `{ address, publicKey, purpose: 'payment' | 'ordinals', addressType: 'p2wpkh' | 'p2tr' }[]`, `signMessage`, `signPsbt`) into `UnifiedMultiChainDappRouter`.
  - Uses `@frank/nakamoto` (`signPsbtWithPersonaKey`, `finalizePsbtInputs`, `extractPsbtTransaction`) to parse BIP-174 PSBTs (`0x70736274ff`), verify witness/non-witness UTXO scripts against the origin's `p2wpkh` (`m/84'/0'/1'/0/{index}`) and `p2tr` (`m/86'/0'/1'/0/{index}`) persona keys, sign with secp256k1 ECDSA or BIP-340 Schnorr, and optionally finalize and extract raw transaction hex.
- **eCash Cashtab Bridge (`EcashCashtabBridge`)**:
  - Translates `window.postMessage` `{ type: 'FROM_PAGE', text: 'Cashtab', addressRequest, txInfo }` requests into `xec-cashtab` approvals and emits `{ type: 'FROM_CASHTAB', address | txid }` responses.
- **BCH CashConnect & UTXO Bridge (`BchUtxoBridge`)**:
  - Handles `bch_*`, `doge_*`, and `ltc_*` account, message-signing, and transaction-signing requests.

---

## 7. Just-In-Time (JIT) EVM Pool Consolidation & Zero-Dust Return Sweeps (`#1708`)

The removed JIT implementation described how a connected EVM dApp might have requested `eth_sendTransaction({ from: personaAddress, to, value, data })` or `wallet_fulfillIntent`:

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

## 8. PWA $\leftrightarrow$ Browser Extension Origin Sync (`#1710`)

Because `https://signet.mx` and `chrome-extension://<id>` / `moz-extension://<uuid>` / `safari-web-extension://<uuid>` inhabit isolated browser storage partitions, "Sync account" hands the account (two Codex32 backup shares) to the other side by PIN pairing (`app/src/utils/sync-pairing.ts`). The side holding the account shows a uniform random 6-digit PIN; the user types it into the other window. The two sides run CPace (draft-irtf-cfrg-cpace, ristretto255 + SHA-512, `app/src/utils/cpace.ts`) with the PIN as the password over `FRANK_PWA_EXTENSION_SYNC_CHANNEL`, with HMAC key confirmation. The sender encrypts the bundle (XChaCha20-Poly1305 under an HKDF key from the CPace session key) only after the receiver's confirmation tag checks, so a wrong PIN gets no ciphertext, and an observer of the channel has nothing to test PINs against offline. Each wrong PIN replaces the PIN; three end the session; a session lasts two minutes and sends once. The extension's sending session lives in its background (`storage.session`), so it outlives a closing popup; the web app's lives in page memory. The background relays pairing messages only between extension pages and `https://signet.mx` tabs.
