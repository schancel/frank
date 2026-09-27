# Frank: Stamp/cashweb → Monad migration plan

Hackathon POC goal: get Frank (forked from Stamp + cashweb) sending and receiving
end-to-end-encrypted, spam-priced messages on Monad testnet, using Alchemy for
indexing and transaction submission, with no self-hosted chain infrastructure.

**Timeline update:** submissions aren't due for a week or two, not hours as
originally assumed. This relaxes the earlier "cut every corner" bias — the
"if time allows, non-blocking" hedges on things like Mera (see the bounty
section below) and fixing the jest/test-infra gaps several tickets have
flagged should be treated as real, do-it-properly work now, not stretch
goals. The demo spike (`spike/demo` branch) remains throwaway and should be
fully superseded by the tracked ticket pipeline rather than kept as a crutch.

## Non-negotiable design constraints

1. **No self-hosted chain infra.** No `lotusd`, no chronik, no bitcoind. All
   chain reads/writes go through Alchemy (HTTPS JSON-RPC + WS subscriptions).
2. **Multichain-ready, not multichain-complete.** Draw a `ChainAdapter`
   boundary now so Lotus can be re-added later without a second rewrite.
   Ship only the Monad adapter for the hackathon.
3. **Preserve Stamp's unlinkability property — sub-accounts are single-use,
   like UTXOs, not a reusable pool.** Stamp splays payments across many
   UTXOs/addresses so no single address accumulates a linkable history. On
   Monad this becomes an HD-derived pool of sub-account EOAs — but the
   analogy only holds if each account is spent exactly once and never
   reused. **Correction (found after #14/#18/#21 shipped): the current
   implementation gets this backwards.** `SubAccountLeaseManager.releaseLease
   (handle, 'confirmed')` returns the account to `'available'`, so the same
   small fixed-size pool cycles through reuse across many messages — which
   accumulates linkable history over time, the opposite of the goal. #21's
   test (merged) explicitly asserts this reuse as correct behavior; it isn't
   anymore. Correct model: a successful stamp also retires/discards the
   account (never `'available'` again, regardless of outcome — success and
   failure converge to the same "never reuse" result, they just differ in
   whether the underlying funds were spent or not), and the pool must
   continuously derive fresh indices (`m/44'/60'/0'/0/i` for ever-increasing
   `i`) and fund them ahead of demand, rather than fan-out-funding a fixed N
   once. Funding those fresh accounts (fan-out from a main account) is
   itself a correlation point — call it out, don't solve it perfectly in v1.
   **The one legitimate exception**: POP's account-opening payment (see
   constraint 4) is inherently identity-bound to a specific server already,
   so reusing an address there isn't a new privacy leak the way reusing a
   Stamp sub-account is — though POP is disabled entirely for the hackathon
   demo anyway (see constraint 4), so this doesn't matter in practice yet.
   **Change handling (see ticket following #34):** a spent burn account's
   leftover balance (funded with `burn_value + gas_reserve`, but actual gas
   used is usually less) needs somewhere to go rather than being abandoned
   in a dead account. Use a separate BIP-44 change branch
   (`m/44'/60'/0'/1/i`, mirroring Bitcoin's internal/external chain split)
   allocated strictly in order, one change index per swept-out account.
   Day-to-day, track "next unused change index" locally/persisted the same
   way the burn pool already does — a chain-scanning binary search (exploit
   strict sequential allocation: `nonce > 0 OR balance > 0` is monotonic
   across indices, so bisect for the used/unused boundary) is a *recovery*
   tool for reconstructing that pointer from chain data alone (e.g.
   restoring a wallet from seed with no local state), not the live
   bookkeeping mechanism — bisecting live risks a false "unused" read on an
   index whose funding tx is still unconfirmed.
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
   - **Disabled for the hackathon demo.** POP is fully built and merged
     (#22/#23/#24/#4), but the actual payment requirement is turned off for
     the demo so signing up / opening a mailbox account needs no payment —
     the thing being demonstrated is Stamp's per-message anti-spam burn, not
     POP's access-control gate, and requiring payment just to sign up adds
     friction with no demo value. See the follow-up ticket for the actual
     config toggle (fail-open "disabled" mode, distinct from fail-closed
     "misconfigured" — don't conflate the two, a missing/invalid config
     should still fail closed if POP is ever re-enabled later).
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
9. **Wire formats should carry a Frank-specific network tag, not a raw EVM
   `chainId`.** Raised 2026-09-26: once one backend deployment could serve
   multiple chains (constraint 2's whole point), a client needs a way to
   tell which network a given `raw_burn_tx`/vote was actually verified
   against, and to detect "I'm pointed at the wrong network." An EVM
   `chainId` doesn't generalize — Lotus (and any future non-EVM adapter)
   has no such concept, so tagging at that level would tie the wire format
   back to EVM specifically, which constraint 2 explicitly avoids. Instead,
   add a short Frank/Stamp-specific tag (e.g. a 4-byte LOKAD-style code,
   `"MON1"`/`"MONT"`/`"LTUS"`) as an explicit field on the *protobuf
   envelope* (`MonadStampedMessage`/`StoredMonadForumPost`/etc.), populated
   by the relay from its own configured `ChainAdapter` — not embedded in
   the on-chain calldata itself, since the calldata's commitment layout is
   already committed-to by every existing client and relay, and the
   envelope is the layer that actually varies per-deployment. Proto3 field
   addition is additive/backward-compatible. Best time to add it is before
   ticket #31/#32/#33 (forum client-side) solidify against the current
   shape, since they're the next thing to touch these protos. **For the
   hackathon itself, the UI only ever shows Monad — this is a wire-level
   forward-compat field, not a multi-chain switcher UI.**
10. **No fiat (USD) values in the UI.** Raised 2026-09-26, deliberately
    unresolved: displaying stamp/vote "weight" or account balances in USD
    was explicitly rejected. Floated alternative — a synthetic benchmark
    unit derived from a basket of cryptocurrencies rather than any single
    price feed — but the basket composition, weighting, and price-feed
    source are all undefined. **Not actionable yet; needs a real design
    pass before any ticket is cut.** Do not build this for the hackathon;
    if a numeric value must be shown in the meantime, show raw MON/wei, not
    a fabricated fiat conversion.

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

### M1 — ChainAdapter boundary (Rust + TS), Lotus-only, no behavior change — DONE
**Correction (found during implementation, supersedes the earlier grooming
finding below):** the "zero live call sites" claim was wrong. A closer
check found `Registry.bitcoind` **is** called live, via
`validate_burn_tx(s)` in `cashweb-registry/src/registry.rs`, from both
`PUT /registry` (`handle_put_registry`) and `PUT /message`
(`handle_put_message`) in `http/server.rs`, plus peer metadata sync
(`p2p/peers.rs::relay_metadata`). On-chain confirmation/broadcast is real,
not structural-only. (Earlier text, kept for the record: "a full-crate grep
... returned zero matches" — that grep missed these call sites.)

Landed: `ChainAdapter` trait in `cashweb-payload/src/chain_adapter.rs`
(submit_tx, get_tx, test_accept, subscribe_new_blocks, decode_burn) with a
`LotusAdapter` in `cashweb-registry/src/lotus_adapter.rs` wrapping
`BitcoindRpcClient`; `Registry` now holds `Arc<dyn ChainAdapter>` instead of
a concrete `bitcoind` field, exact RPC sequence/error semantics preserved.
Same shape on TS: `ChainAdapter` interface in
`app/src/cashweb/wallet/chain-adapter.ts`, `LotusAdapter` in
`lotus-adapter.ts` wrapping `ChronikClient`/`bitcore-lib-xpi`; `Wallet`'s
internal chain call sites now go through `this.chainAdapter`. Two external
TS call sites (`relay/index.ts`, `boot/setup-apis.ts`) still touch chronik
directly — left alone as out of this milestone's ownership scope, cheap
follow-up later if the boundary needs to be exhaustive.

Gate results: `cargo check`/`cargo test -p cashweb-payload` pass; 4
pre-existing Rust regtest test failures reproduced identically on
unmodified base commit (missing `BITCOINSUITE_BIN_DIR`/lotusd binary in
this environment, not a regression); `yarn lint` passes; `yarn test:unit`
blocked by a pre-existing gap (jest isn't actually a declared dependency in
`app/package.json`, and CI doesn't run it either) — not something this
milestone introduced. Follow-up flagged: get a working lotusd regtest
binary path, and decide whether to reinstate jest before M5 needs a real
wallet test harness.

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

### Follow-on: monorepo subproject split (raised 2026-09-26)
Proposed shape once the current wave (forum client, bot demo) lands:
- `app/` — the Frank frontend (Quasar/Vue3), unchanged in role.
- `bot/` — ticket #9's headless Qwen-backed bot demo, as its own subproject
  rather than living inside `app/`.
- `backend/cashweb` (+ `backend/bitcoinsuite`) — already effectively one
  binary (`cashwebd-exe`) with route groups rather than separate services
  (mailbox/metadata routes vs. topic/pubsub routes), matching what was
  asked for. No restructuring needed here beyond what constraint 6 already
  describes.
- A new TS package (or packages) for the wallet/client code currently under
  `app/src/cashweb/wallet/` — HD keyrings, account pool/lease manager,
  stamp/POP/forum clients, generated protobuf bindings — extracted so both
  `app/` and `bot/` import it rather than the bot reaching into `app/src`
  directly or duplicating logic.

**Don't do this yet.** Ticket #9 is actively landing code against the
current `app/src/cashweb/wallet` layout; extracting mid-flight would
conflict with in-progress work. Revisit once #9 and #31/#32/#33 are merged.
Needs a package-manager/workspace-tooling decision (npm/yarn/pnpm
workspaces, or a lighter TS project-references setup) before it's
actionable — not yet made.

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
- Production-grade key custody, HSMs, or multi-sig for the sub-account pool.
- Lotus chain support actually re-enabled behind the new adapter boundary
  (the boundary is built so it *can* be, not so it *is*, this hackathon).
- ERC-20/token-denominated payments or burns (native MON only, see
  constraint 8).

## Hackathon bounty/track strategy

**Track (corrected — one track only, already selected by the user):
Social, Attention & Culture**, not Trust/Identity/AI as earlier PLAN.md
text wrongly guessed. Confirmed rule: a submission enters exactly one main
track, but sponsor bounties are independent of track tags — a Social/
Culture submission can still win a bounty tagged to a different track.

- **Already targeting**: "Best Builds with Qwen 3.8 Max" (ticket #9, the
  headless LLM bot demo, blocked on #8) — still viable despite its card
  being tagged to a different track, per the rule above.
- **Also pursuing**: "Best Projects using Alchemy" ($1,000 credits) —
  already qualifies via tickets #12/#15/#17/#20, no new work, just submit.
- **Worth pursuing if time allows, non-blocking**: Mera ("Best Mera-Powered
  UX on Monad" + "One Passkey, Many Keys", $2,500 each). Mera's WebAuthn
  PRF-derived keys use the identical `m/44'/60'/0'/0/i` path already
  specified for ticket #14's HD sub-account pool — genuine architectural
  fit (no seed phrase, no extension, no custody backend), not just a
  bounty checkbox. See the option documented on issue #14; fall back to a
  plain stored mnemonic if there isn't time.
- **Secondary, skippable**: Envio (HyperSync/HyperRPC could replace direct
  Alchemy log/receipt polling and sidestep the 10-block `eth_getLogs`
  limit ticket #17 found) — real but not on the critical path, since
  Stamp verification uses `eth_getTransactionReceipt` on a known hash, not
  broad log scans.
- **Skip**: Cleanverse (bank-verified KYC identity is in tension with
  Frank's unlinkable-multi-account privacy goal), Dynamic/Privy (don't
  stack three competing wallet-auth SDKs against Mera), Aurora Intents,
  Kuru, Agora, Perpl (all trading/payments-specific, Frank is a messaging
  protocol), Chainlink CRE (no orchestration need), Nansen (analytics
  product, wrong fit), Kimi (redundant with the already-committed Qwen
  bounty). Tencent Hunyuan (targets Social/Culture, our actual track) is
  no longer an automatic skip on track grounds, but is not currently
  pursued — would mean a second, competing LLM integration alongside Qwen.
- **Track fit note**: Social, Attention & Culture ("open social graphs,
  competitive feed algorithms, community governance... cultural
  participation translate into real ownership") is a better narrative fit
  for cashweb's forum/topic broadcast + burn-weighted voting feature than
  for plain 1:1 messaging. That feature is back in scope as a follow-on —
  see the new milestone below.

### M8 (follow-on, blocked on M6) — forum/topic broadcast + burn-weighted voting over Monad
Re-admits the feature originally scoped out as a hackathon non-goal, now
relevant to the Social/Attention/Culture track narrative: topics, posts,
and burn-weighted up/down voting (`registry/index.ts`'s OP_RETURN
"POND"-tagged burn transactions on the Lotus side). Same primitive-swap
shape as Stamp (M4): keep the commitment/vote-weight concept, swap the
OP_RETURN vote-tagged output for EVM calldata, verify via `MonadAdapter`.
Explicitly lower priority than M7 (bot demo) — both are follow-ons gated
on M6, pursue whichever has clearer remaining time.

**Validated, not speculative:** the original Stamp UI used a group-chat-like
model; user feedback on that version consistently preferred a Reddit-style
forum instead. M8 is that preference realized on Monad, not just a
bounty-fit add-on. Server side shipped in #30 (merged); client side
(#31/#32/#33: post, vote, tally/read) is next, blocked on #30.

**Before dispatching #31/#32/#33:** fold in constraint 9's network-tag
proto field now, while the forum client is still unbuilt — see constraint
9 for why this is the cheapest moment to add it.
