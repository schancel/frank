# Frank: Stamp/cashweb → Monad migration plan

Hackathon POC goal: get Frank (forked from Stamp + cashweb) sending and receiving
end-to-end-encrypted, spam-priced messages on Monad testnet, using Alchemy for
indexing and transaction submission, with no self-hosted chain infrastructure.

## Non-negotiable design constraints

1. **No self-hosted chain infra.** No `lotusd`, no chronik, no bitcoind. All
   chain reads/writes go through Alchemy (HTTPS JSON-RPC + WS subscriptions).
2. **Multichain-ready, not multichain-complete.** Draw a `ChainAdapter`
   boundary now so Lotus can be re-added later without a second rewrite.
   Ship only the Monad adapter for the hackathon.
3. **Preserve Stamp's unlinkability property.** Stamp splays payments across
   many UTXOs/addresses so no single address accumulates a linkable history.
   On Monad this becomes an HD-derived pool of sub-account EOAs, one used per
   stamp/burn, not a single hot wallet address. Funding that pool (fan-out
   from a main account) is itself a correlation point — call it out, don't
   solve it perfectly in v1.
4. **POP and Stamp are separate mechanisms — do not conflate them.**
   - **POP** (bearer-token exchange): pay once via the payment protocol, get
     a token, reuse it for protected per-address API calls (read/manage
     your own inbox, profile, keyserver metadata).
   - **Stamp** (burn-to-speak, `cashweb-relay`/`cashweb-payload`): attached
     per-message by the sender, verified and *broadcast by the relay server
     on the sender's behalf* when the message is delivered.
   - **Correction (found during ticket #4 grooming): POP does not exist yet
     in this codebase.** `cashweb-token`/`ChainCommitmentScheme` only exist
     in the *deprecated* `cashweb-backends` repo. `grep -rn
     "ChainCommitmentScheme\|cashweb-token" backend` in this repo returns
     zero matches, and `cashweb-registry/src/http/server.rs`'s
     `handle_put_registry` (the endpoint POP is meant to gate) has no
     token/payment gating at all today — no `extract_pop`, no middleware,
     nothing. M3 is therefore not "swap the verification backend under an
     existing flow" — it's build the bearer-token layer (ported from the
     deprecated repo's `cashweb-token` crate, behind a pluggable
     verification trait), add Monad-backed verification, then wire both
     into the registry's HTTP endpoints. Same mistaken-premise shape as
     M1's `Registry.bitcoind` finding — verify infra exists before assuming
     a swap.
5. **The current backend already implements the paper's Stamp construction —
   this is a primitive swap, not new design work.** Verified:
   `cashweb-payload/src/verify.rs:12-132` already implements a LOKAD-ID +
   version + 32-byte commitment OP_RETURN burn scheme, matching the paper's
   `h_m = Hash(m‖pk‖ts)` / `UnspendableAddress(h_m)` design. (The
   BIP32-derived-P2PKH scheme only exists in the *deprecated*
   `cashweb-backends` repo we are not using — see constraint 6.) The Monad
   port of M4 is therefore: keep `verify.rs`'s commitment logic, swap the
   OP_RETURN script for EVM calldata carrying `h_m`, and swap the "is this
   burned on-chain" check for `eth_getTransactionReceipt` via Alchemy.
   Sender authentication comes free from the tx's own ECDSA signature
   (`ecrecover`), so no separate app-level signature is needed on the EVM
   side even though the current Lotus path signs explicitly.
6. **Base the backend on the correct upstream.** `backend/cashweb` +
   `backend/bitcoinsuite` (Tobias Ruck's rewrite, single `cashwebd-exe`
   binary: `cashweb-config`, `cashweb-http-utils`, `cashweb-payload`,
   `cashweb-registry`) — **not** the deprecated `cashweb-backends` repo
   (separate `keyserver`/`relayserver` binaries, BIP32 stamp scheme).
7. **rocksdb → distributed KV is real but out of hackathon scope.** Flag it
   as a follow-on milestone for HA/scale-out; don't block the POC on it.
8. **Native MON only — no ERC-20 in the hackathon scope.** All POP payments
   and stamp burns settle in the chain's native token. Token support (ERC-20
   burns/payments) is a deliberately deferred stretch: it adds approval
   flows, decimals handling, and per-token registries that materially hurt
   UX for a messaging app, and isn't needed to prove the core mechanism.

## Current state (done)

- `frank/app`: forked from `stampchat/stamp` (confirmed current, HEAD
  matches upstream), rebranded (package.json, README, capacitor config,
  electron menu labels).
- `frank/backend`: forked from `LotusiaStewardship/cashweb` (the Tobias
  rewrite) + `LotusiaStewardship/bitcoinsuite` as its sibling path
  dependency. Full workspace compiles clean (`cargo check`, ~1m22s cold).
- software-factory kernel installed (`.agents/`, `.claude/skills/`,
  tracker binding = github).
- Alchemy Monad endpoints verified live: testnet chainId `0x279f` (10143,
  block ~65.9M), mainnet chainId `0x8f` (143). Stored in gitignored
  `frank/.env`, template in `.env.example`.
- Repo created and pushed: `github.com/schancel/frank` (private).

## Milestones

### M1 — ChainAdapter boundary (Rust + TS), Lotus-only, no behavior change
**First task, before extracting anything:** confirm whether
`Registry.bitcoind` (`cashweb-registry/src/registry.rs:21,27`, constructed
once at `registry.rs:145`) is actually called anywhere in the live request
path. A full-crate grep for live call sites (excluding test setup and the
struct-clone sites at lines 515/908/1061 and `test_instance.rs`) returned
**zero matches** — meaning burn verification may currently be purely
structural (`verify.rs`) with no on-chain confirmation step at all. This
changes the shape of M1: if the bitcoind field is dead in the request path,
document that explicitly (it's a real finding, not this milestone's job to
fix) and scope the `ChainAdapter` trait around wherever chain calls
*actually* happen, rather than assuming `registry.rs`'s stored client is it.

Once that's resolved: extract a `ChainAdapter` trait covering submit raw
tx, get tx/receipt by id, subscribe to new blocks, decode a payment/burn
from a tx. Re-wire whatever the real Lotus call sites are through a
`LotusAdapter` impl. Proof: existing Lotus-path tests still pass; no
behavior change. Same boundary on the TS wallet side (`src/cashweb/wallet`),
extracting a `ChainAdapter` interface backed by a `LotusAdapter` wrapping
the current `bitcore-lib-xpi`/`chronik-client` code.

### M2 — Monad adapter (Alchemy)
Implement `MonadAdapter` on both sides: HTTPS JSON-RPC (`eth_sendRawTransaction`,
`eth_getTransactionReceipt`, `eth_getLogs`) and WS subscription
(`eth_subscribe("newHeads")`) via Alchemy. This is the ZMQ replacement for
`cashweb-registry`'s block-tip watcher. No app-level behavior wired yet —
this milestone is adapter-only, proven with a standalone smoke test against
the live testnet endpoint.

### M3 — POP over Monad (depends on: M2; client side also depends on M5)
Corrected scope (see constraint 4): POP's bearer-token layer does not exist
in this codebase yet and must be built, not redirected. Three parts, in
order: (a) the bearer-token issuance/caching layer itself — chain-agnostic,
ported from the deprecated repo's `cashweb-token` crate, behind a pluggable
verification trait, no Monad dependency, can start as soon as M2's trait
shape is known; (b) a Monad-backed implementation of that verification
trait via `MonadAdapter` (tx receipt: to/value/status); (c) wiring POP
protection into `cashweb-registry`'s actual HTTP endpoints (e.g.
`handle_put_registry`), gated on (a)+(b), plus the end-to-end Monad-testnet
proof. Client-side payment construction (signing/submitting the payment
tx) needs M5's account/tx-building infrastructure — track that as
"M3-client" separately from this server-side sequence ("M3-server").

### M4 — Stamp (burn-to-speak) over Monad (depends on: M2, M5)
This is a primitive swap of already-working logic (see constraint 5), not
new design. Prerequisite task before implementation starts: **decide and
record the literal burn address** (e.g. the canonical `0x…dEaD`) — nothing
currently produces this value.
- Client: compute `h_m`, build+sign a raw tx (value → burn address,
  `h_m` in calldata) from one leased sub-account of the HD pool (M5).
  Leasing (below) must be held for the lifetime of this unconfirmed tx.
- Relay server: on message ingestion, verify via `MonadAdapter`
  (`eth_getTransactionReceipt` + calldata decode), matching the current
  code's pattern of *broadcasting the sender's raw tx itself*
  (`eth_sendRawTransaction`) rather than requiring the client to have
  already landed it on-chain.
- **Nonce race, must be handled, not just noted:** a pre-signed raw tx is
  bound to one nonce. If a sub-account is reused for a second stamp before
  the relay's broadcast of the first confirms, the second tx either
  double-spends the nonce or queues behind it. M5 must provide a "one
  in-flight tx per sub-account" lease/lock; M4's client-side stamp
  construction acquires that lease before signing and releases it only
  after confirmation (or documented abandonment).
- This crate already implements the paper's scheme on Lotus (`verify.rs`);
  the legacy BIP32/P2PKH scheme exists only in the deprecated
  `cashweb-backends` repo and is irrelevant here.

### M5 — Wallet rewrite (TS, account-based + privacy pool)
Replace UTXO coin-selection/tx-building (`bitcore-lib-xpi`) with
ethers.js/viem account-based tx construction for the `MonadAdapter` path.
Add an HD sub-account pool (BIP-44 `m/44'/60'/0'/0/i`) with:
- **Fan-out funding that budgets gas and burn value separately**: each
  sub-account is funded with `burn_value + gas_reserve`, not just the burn
  amount — acceptance criteria must state this explicitly.
- **A stuck-nonce recovery path**: if a sub-account's tx fails/reverts or
  never confirms, the account is retired (skipped for future stamps), not
  silently reused with a guessed next nonce.
- **A per-account in-flight lease**: exactly one unconfirmed tx per
  sub-account at a time (see M4's nonce-race requirement above).
- Per-stamp account rotation, replacing UTXO-based unlinkability with
  account-based unlinkability (constraint 3 above).

There is currently no EVM wallet code at all in `app/src/cashweb/wallet`
(it's 100% UTXO/`bitcore-lib-xpi`) — this is greenfield work, not a
refactor.

### M6 — End-to-end integration on Monad testnet
Register an identity (POP-gated keyserver metadata write), send a stamped
message relay-to-relay, confirm recipient receives over WS, confirm the
relay actually broadcast the stamp tx on-chain (visible via Alchemy). This
is the hackathon demo's spine.

### M7 (stretch, blocked on M6) — headless LLM bot demo
Headless client built on `app`'s TS cashweb/relay code as a library,
proxying conversation turns to a local Ollama or Finch model, holding a
conversation over Frank. Explicitly deferred until M6 is solid.

### Follow-on (not in hackathon scope)
Replace rocksdb with a distributed KV store for HA/horizontal scale-out of
`cashwebd-exe`. Needs its own design pass (which store, consistency model,
migration path) — do not fold into the Monad port.

## Dependency graph (for ticket blocked-by edges)

```
M1 (ChainAdapter boundary)
 └─ M2 (Monad adapter / Alchemy)
     ├─ M5 (wallet rewrite: account pool, gas/nonce/lease)
     │   ├─ M3-client (POP client-side payment construction)
     │   └─ M4 (Stamp over Monad; also needs M2 directly for verify path)
     └─ M3-server (POP server-side verification)

M3-client, M3-server, M4  ──▶  M6 (E2E integration demo)
M6  ──▶  M7 (stretch: headless LLM bot demo)

Follow-on: rocksdb → distributed KV — no edges, does not block anything above.
```

M1 is the only milestone with no blockers, so it's the sole wave-1 ticket;
M2 unblocks everything else and should be prioritized immediately after.

## Explicit non-goals for the hackathon

- Mobile (Capacitor)/Electron packaging validation.
- Forum/registry burn-voting (OP_RETURN vote weight) port to Monad — Lotus
  chain feature, not required for core messaging demo.
- Production-grade key custody, HSMs, or multi-sig for the sub-account pool.
- Lotus chain support actually re-enabled behind the new adapter boundary
  (the boundary is built so it *can* be, not so it *is*, this hackathon).
- ERC-20/token-denominated payments or burns (native MON only, see
  constraint 8).
