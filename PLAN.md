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
   envelope* (`MonadStampedMessage`/`StoredMonadTopicPost`/etc.), populated
   by the relay from its own configured `ChainAdapter` — not embedded in
   the on-chain calldata itself, since the calldata's commitment layout is
   already committed-to by every existing client and relay, and the
   envelope is the layer that actually varies per-deployment. Proto3 field
   addition is additive/backward-compatible. Best time to add it is before
   tickets #31/#32/#40 (topic client-side and listing route) solidify against the current
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
- **Backend CI (`.github/workflows/backend-ci.yml`) reached its first-ever
  full green run 2026-09-27** (ticket #29). The workflow had never
  completed successfully since the fork — every fix below was found by
  actually getting it to run, not by inspection: (1) `lotusd`'s upstream
  download bucket (`storage.googleapis.com/lotus-project`) is permanently
  dead (billing account closed), made non-fatal since nothing Frank ships
  needs a real `lotusd`; (2) bare `cargo make` runs cargo-make's default
  build+test flow, which was running `bitcoinsuite-bitcoind-nng`'s own
  Lotus-only NNG tests — switched to the `build`-only task; (3) 18 files
  of accumulated rustfmt drift, never checked before; (4) two real rustc
  lints in vendored `bitcoinsuite-core` newer toolchains promote to errors
  (`hidden_glob_reexports`, `mismatched_lifetime_syntaxes`); (5)
  `RUSTFLAGS="-D warnings"` on the release build was inherited, never
  validated, and promotes an unbounded tail of vendored-code lints —
  dropped, `cargo clippy` remains the real lint gate; (6) 8 tests across
  5 files need a real `lotusd`/`bitcoind` binary unavailable in CI (and
  most local dev environments) — `#[ignore]`d with clear reasons, test
  code kept intact for whenever Lotus support actually resumes (constraint
  2's shim); (7) `librocksdb-sys@0.8.3+7.4.4`'s vendored RocksDB 7.4.4 C++
  source doesn't compile under Ubuntu 24.04's default GCC 13 (verified:
  the vendored header/source pair is internally consistent, so this is a
  compiler-version incompatibility, not a corrupt/mismatched dependency) —
  pinned `gcc-12`/`g++-12` for the job rather than bumping `rocksdb` itself
  (which `librocksdb-sys`'s `^0.8.0` requirement would force, a much
  larger/riskier change).

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
Proposed shape once the current wave (topic client, bot demo) lands:
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
  stamp/POP/topic clients, generated protobuf bindings — extracted so both
  `app/` and `bot/` import it rather than the bot reaching into `app/src`
  directly or duplicating logic.

**Don't do this yet.** Ticket #9 is actively landing code against the
current `app/src/cashweb/wallet` layout; extracting mid-flight would
conflict with in-progress work. Revisit once #9 and #31/#32/#33 are merged.
Needs a package-manager/workspace-tooling decision (npm/yarn/pnpm
workspaces, or a lighter TS project-references setup) before it's
actionable — not yet made.

### Follow-on: UI still shows Lotus addresses/XPI units, not wired to Monad at all (raised 2026-09-26)
The old Stamp UI displayed `lotus:`-style cashaddr addresses and denominated
everything in "XPI". Investigated 2026-09-26: this has NOT been touched or
ported. `app/src/utils/address.ts`'s `toAPIAddress`/`toDisplayAddress` still
convert through `bitcore-lib-xpi`'s `Address`/`Networks` (Lotus cashaddr/
xaddress encoding) — would throw or produce garbage on a Monad `0x` address.
"XPI" is still a hardcoded literal unit suffix in `ChatInput.vue` and
`CreatePost.vue`, plus a comment in `utils/constants.ts`.

**Decision (user, 2026-09-26): for now, just use native Monad `0x` addresses
and "MON" as the unit — no cashaddr-style encoding layer needed for a
single-chain display.** Full multichain UX (a user holding balances/
addresses across many chains without needing to think about which chain
they're on) is explicitly deferred — genuinely clutters the UX and needs
real design work, not a hackathon-time decision. Leave a TODO at the
address/unit display layer marking this as the deferred harder problem
once/if a second chain is ever actually wired in.

**Not fixed yet, and deliberately not done as a quick pass tonight**:
`toAPIAddress`/`toDisplayAddress` are still load-bearing for the *old*,
still-active Lotus code paths (`app/src/cashweb/registry/index.ts`,
`app/src/cashweb/relay/index.ts`, `stores/chats.ts`, `stores/contacts.ts`,
`components/setup/DepositStep.vue`, `components/dialogs/
TransactionDialog.vue`, `pages/AddContact.vue`) — none of that has been
rewired to the new Monad wallet clients (`app/src/cashweb/wallet/*`) yet.
Rewriting the address/unit display layer in isolation, before that store
rewiring exists, would be disconnected surgery on code that isn't
receiving Monad addresses yet, not a real fix.

**Design for the eventual fix (user, 2026-09-26): a compile-time chain
selection, not a runtime one.** A single compile-time constant picks the
active chain; that choice is what supplies the address converters, the
unit/denomination, and the wallet factory — not three independently-wired
concerns. This is a cleaner, higher-level seam than the existing TS
`ChainAdapter` (`app/src/cashweb/wallet/chain-adapter.ts`, from M1):
that interface is UTXO-shaped (`ChainUtxo`, `satoshis`, P2PKH-only
`DecodedOutput`) and only `lotus-adapter.ts` ever implements it — the
entire Monad wallet stack built this session (`monad-account-tx.ts`,
`monad-account-pool.ts`, `monad-stamp-client.ts`, `monad-topic-*-
client.ts`) bypasses it completely as its own parallel, ethers-based
stack, precisely because an account-based chain doesn't fit a UTXO-shaped
interface (same reason the *backend* needed a separate Monad-native wire
format instead of reusing `SignedPayload`/`BurnTx` — see constraint 5).
Proposed shape: a small `ActiveChain` module, selected by a compile-time
constant/build flag, exporting `{ formatAddress, parseAddress, unit,
createWallet(...) }` (exact shape TBD when this is actually scoped) —
the chat/contacts store and UI components import from that module instead
of reaching into `utils/address.ts`/a hardcoded chain-specific wallet
directly. Needs its own scoped ticket (rewire the chat/contacts store +
relevant components onto this new seam, *then* the Lotus and Monad
implementations both hang off it) rather than a standalone find-and-
replace on the current Lotus-only code.

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
  for cashweb's topic broadcast + burn-weighted voting feature than
  for plain 1:1 messaging. That feature is back in scope as a follow-on —
  see the new milestone below.

### M8 (follow-on, blocked on M6) — Monad topic broadcast + burn-weighted voting
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
forum instead. M8 is that UI preference realized on Monad, not just a
bounty-fit add-on. Server side shipped in #30 (merged, then renamed —
see below); client side (#31/#32: post, vote — merged and also renamed;
#33: tally/read — next).

**Correction (2026-09-26, mid-review of ticket #40): "forum" had wrongly
leaked into the *backend's* vocabulary.** On Lotus, the backend primitive
is generic — `BroadcastMessage` + `DbTopics` + `/messages/:topic` — and
every message posted through it already requires a burn that inherently
carries an up/down vote tag (`createBroadcast`'s `vote` parameter has no
default; there is no code path for posting without one). "Forum" never
existed as a backend concept there — only as a *client-side* rendering
choice (`stores/forum.ts`'s threaded/sorted view vs. `stores/topics.ts`'s
flat feed, both consuming the same always-voted messages). Tickets #30/
#31/#32/#40 baked "forum" into backend types, modules, and routes anyway
(`MonadForumPost`, `http/forum.rs`, `ForumGateConfig`, `/message/monad/
forum`, ...), copying the product framing ("let's build a forum for the
bounty") into code that should have stayed a general topic-broadcast
primitive. Renamed the whole surface once caught, while it was still
small: `MonadForumPost`/`MonadForumVote` → `MonadTopicPost`/
`MonadTopicVote` (and every derived type), `http/forum.rs` →
`http/monad_topics.rs`, `store/forum.rs` → `store/monad_topics.rs`,
`monad_forum_verify.rs`/`monad_forum_relay.rs` → `monad_topic_verify.rs`/
`monad_topic_relay.rs`, `forum_message.proto` → `topic_message.proto`,
routes `/message/monad/forum*` → `/message/monad/topics*`, the app-side
`monad-forum-{post,vote}-client.ts` → `monad-topic-{post,vote}-client.ts`,
and the wire-format LOKAD ID `"FRUM"` → `"TPIC"` (safe to change bytes
too — nothing is live on mainnet yet). "Forum" stays exactly where it
always belonged: the pre-existing Lotus-side UI/store layer
(`ForumMessageEntry`, `stores/forum.ts`, `broadcast_pb`'s `ForumPost`
payload-content type) is untouched, since that naming was never the
problem — the eventual Monad-side UI is free to build its own
forum-style view on top of the (correctly-named) topic-broadcast
primitive, exactly mirroring the old architecture.

**Before dispatching #33:** it depends on #40 (topic-filtered listing,
merged and renamed alongside the above).

**Considered and deliberately deferred (2026-09-26): making the proto
messages themselves cross-chain-generic** (a shared `TopicPost{chain, ...}`
schema instead of `MonadTopicPost`), rather than just correctly-named but
still Monad-specific types. Rejected for now, for concrete reasons, not
just caution: (1) the HTTP routes are already chain-namespaced
(`/message/monad/topics`, mirroring `/message/monad`'s own precedent) —
the relay already knows which `ChainAdapter`/decoder to use from the URL
before it decodes the body, so a `chain` field on the message itself would
be redundant with that unless the routes were *also* flattened to
chain-generic (`/message/topics?chain=monad`), a materially bigger change
than a proto rename; (2) the actually chain-specific part — `raw_burn_tx`'s
raw bytes (RLP-encoded EVM tx for Monad; something structurally different
for any future Lotus path) — can't be unified by a schema field regardless;
a `chain` tag would only say which decoder to reach for, not make the
payload itself interoperable; (3) only one chain (Monad) is actually
implemented right now — designing a shared cross-chain schema from a
single example risks guessing its shape wrong (field lengths, semantics)
and having to redo it anyway once a second chain is real. Revisit when
Lotus (or another chain) actually gets wired back in behind the
`ChainAdapter` boundary — that's the right moment, informed by two real
examples instead of one guess.

### M9 — Rewire the UI onto the Monad wallet clients (raised 2026-09-26)
Everything shipped through M8 (Stamp, POP, topic broadcast, the Qwen bot)
is verified at the backend/wallet-client layer — real testnet transactions,
real tests. None of it is wired into the actual Quasar UI: `stores/
chats.ts`, `stores/contacts.ts`, `stores/topics.ts`, `stores/forum.ts`
still exclusively call the old Lotus `RegistryHandler`/`RelayClient`/
`Wallet` (`cashweb/registry`, `cashweb/relay`, `cashweb/wallet/index.ts`).
There is currently no clickable path in the actual app that exercises
Monad at all.

**Design: a compile-time `ActiveChain` seam**, not a runtime multi-chain
dispatch (matches M8's own deferred-cross-chain-schema reasoning) — one
compile-time constant (`app/src/cashweb/chain/index.ts`'s `activeChain`)
supplies address formatting, the unit/denomination, a wallet factory, and
the direct-message/topic-broadcast client methods every store imports
through instead of reaching into Lotus-specific code directly.

Decomposed into four tickets, dependency-ordered:
- **#41** — Build `ActiveChain`/`MonadChain` itself (interface + a real
  implementation over the already-merged Monad wallet clients). No UI
  wiring. Also builds `monad-identity.ts`, a Monad-native identity module
  that doesn't exist yet — `lotus-identity.ts` (ticket #9) is NOT
  chain-agnostic despite its name (hardcodes Lotus address encoding); this
  is the same Lotus-identity-on-Monad inconsistency flagged when reviewing
  the Qwen bot.
- **#42** — Rewire `stores/chats.ts`/`contacts.ts` (direct messaging) onto
  it. Blocked by #41.
- **#43** — Rewire `stores/topics.ts`/`forum.ts` (topic broadcast) onto it.
  Blocked by #41. Independent of #42, can run in parallel.
- **#44** — Clean up remaining hardcoded `XPI`/Lotus-address UI spots
  (`ChatInput.vue`/`CreatePost.vue`'s unit suffix, `utils/address.ts`'s
  remaining callers). Blocked by #42 and #43, since it needs both done
  first to know what's actually left over.

**Real structural findings from design review, not guesses** (see #41's
issue body for the full detail):
- The old `Wallet` class's ~400 lines of UTXO coin-selection and
  privacy-motivated change-output splitting have **no Monad equivalent to
  port** — not a gap, a simplification. Monad's account-based burns are a
  single scalar + calldata; change handling already lives separately in
  ticket #36's `monad-change-pool.ts`/`monad-change-recovery.ts`, operating
  on whole retired sub-accounts, not transaction outputs.
- The old messaging path is WS-push-driven; every Monad client built
  tonight is poll-based (`fetchSince(sinceMs)`). #42 needs to actually
  introduce a polling loop, not just swap one client call for another.
- `ChatMessage.outpoints: Utxo[]`/`ForumMessage.satoshis` are UTXO-shaped
  fields baked into stored message types — #42/#43 need an explicit
  decision on the Monad-side replacement (`burnValueWei: bigint` alongside
  or instead of `outpoints`), not a silent type change.
- `toDisplayAddress`/`toAPIAddress`'s output is used as the actual **store
  key** for `state.chats`/`state.contacts`, not just a display string —
  switching address representation without a migration path would silently
  orphan any existing persisted chat/contact data on first load.

**Also on the radar, not yet scoped as tickets** (raised in conversation
2026-09-26, capturing so they aren't lost):
- **Peer/gossip replication for the topic-broadcast system.** The Lotus
  registry has a real two-part replication design (`src/p2p/peer.rs`,
  `src/p2p/peers.rs`): push-on-write fan-out to a static, config-file peer
  list, deduped per-peer via a *rolling window* of Bloom filters
  (`PeerState.filters: Vec<BloomFilter>`, oldest evicted once bounded
  `max_filters` is exceeded — genuinely "resizable" in the sense of aging
  out old entries with bounded memory, not a single ever-growing filter);
  plus a separate pull-based catch-up sync (`initial_metadata_download`,
  randomly sampling peers each round) for **profile/metadata only** — there
  is no equivalent pull-catchup for broadcast messages/topics, even on
  Lotus, so a missed push is simply lost there too. None of this — peer
  list, push fan-out, Bloom-filter dedup, or catch-up sync — exists on the
  Monad topic-broadcast path at all; it's a single centralized relay today.
  Real multi-relay decentralization for Monad topics would need this
  ported (and arguably the profile-only pull-catchup asymmetry fixed while
  porting, not replicated as-is) — not started, not scoped.
- **Email-like human-readable addressing for profiles** (`bob@frank.net`,
  `foo@bar.com` resolving to a profile/address, à la ENS/WebFinger/Matrix's
  `user@domain` convention) — maps naturally onto the mbox/profile system
  already being federated (domain = federation node, local-part = identity
  within it). Explicitly less secure/direct than a raw address, but noted
  as "required UX." Not scoped.
- **Chain-first route restructuring**: `/message/monad/*` →
  `/monad/messages/*`, `/message/monad/topics/*` → `/monad/topics/*` —
  mirrors the already-separate `http::monad_message`/`http::monad_topics`
  Rust modules, supports clean `axum::Router::nest("/monad", ...)`
  composition, and is symmetric for whenever a second chain is added.
  Requires a coordinated backend route-registration change + every TS
  client's URL strings (mirrors the forum→topic rename's shape). Not
  started — agreed to let then-in-flight ticket #33 land on the current
  paths first rather than redirect it mid-flight.
- **Mbox/topic subsystem toggle for deployment flexibility**: mbox/profile
  is inherently a federated (home-server-per-identity) model; topic
  broadcast is more of a small-world gossip network — different scaling
  shapes. Keep one binary (already the case, see constraint 6) but add
  config to selectively disable either route-group subset at deploy time,
  so an operator can run a pure profile-federation node or a pure
  topic-relay node without needing separate binaries. Not scoped.
