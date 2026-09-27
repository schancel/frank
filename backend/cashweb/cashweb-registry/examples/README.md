# Ticket #8 runbook: live e2e demo on Monad testnet

This is the reproduction runbook for issue #8 ("E2E integration demo on Monad testnet"): register
an identity, send a stamped message relay-to-relay on real Monad testnet, and independently verify
the resulting burn tx on-chain via Alchemy.

Everything here is **real**: a real, locally-running `cashweb-registry` HTTP server, a real Monad
testnet RPC endpoint (Alchemy), a real pre-funded testnet account, real signed transactions, real
broadcast/confirmation. See "Known gaps and deliberate stand-ins" below for the two places this
demo is honest about *not* being fully real (and why that's fine for what this ticket needs to
prove).

## What you need

- This repo checked out, on this branch (`ticket/8-e2e-demo`).
- `backend/cashweb`'s Rust workspace buildable (`cargo build` — no `BITCOINSUITE_BIN_DIR`/`lotusd`
  binary required for anything in this runbook; see "Known gaps" for why).
- `app/`'s `node_modules` installed (`yarn install`, or point `NODE_PATH` at another checkout's
  `node_modules` built from the same `package.json`/`yarn.lock` — that's what this ticket's own
  demo run did, via a symlink, to avoid a slow reinstall; see `app/node_modules` in this worktree).
- A `.env` at the repo root (gitignored) with:
  ```
  MONAD_TESTNET_HTTP_RPC_URL=https://monad-testnet.g.alchemy.com/v2/<your-alchemy-key>
  MONAD_STAMP_BURN_ADDRESS=0x000000000000000000000000000000000000dEaD
  CASHWEB_STAMP_MIN_BURN_VALUE_WEI=1000000000000
  ```
  (The last two lines were missing from this repo's `.env.example` before this ticket — see "Bugs
  found and fixed" below.)
- A funded Monad testnet account's private key, as a small JSON file `{ "address": "0x...",
  "privateKey": "0x..." }`. This ticket's own run reused the account at
  `frank-worktrees/spike-demo/spike/data/chain-wallet.json` (~9.9976 MON confirmed live via
  `eth_getBalance` immediately before this demo). Point `E2E_DEMO_MAIN_WALLET_JSON` (step 3) at
  whatever file holds your funded key.

## Step 1: start the demo registry server

```sh
cd backend/cashweb
set -a; source ../../.env; set +a
cargo run -p cashweb-registry --example e2e_demo_server -- 127.0.0.1:8098
```

Leave this running. It's a real `cashweb-registry` HTTP server (same `RegistryServer`/router
`cashwebd-exe` serves in production) with POP disabled (ticket #35 default) and an in-memory-only,
temp-dir RocksDB. See `e2e_demo_server.rs`'s own doc comment for exactly what it stubs and why (a
permissive stand-in for the *unrelated*, unmigrated Lotus burn-tx bookkeeping the metadata-PUT
endpoint still requires — not anything to do with Monad, which this process talks to for real).

## Step 2: register an identity (acceptance criterion 1)

In another shell:

```sh
cd backend/cashweb
cargo run -p cashweb-registry --example e2e_demo_register_identity -- http://127.0.0.1:8098
```

This builds a real, correctly-signed `SignedPayload` (the same helper
`tests/test_http_endpoint.rs`/`tests/pop_live_smoke.rs` use), `PUT`s it to `/metadata/:addr` with
**no** `Authorization`/`pop_tx_hash` payment proof at all, and reads it back via `GET` to confirm
it's stored — proving registration needs no payment now that POP is disabled.

Real output from this ticket's own run:

```
Identity address: lotusR16PSJHkWMkkRz9TddhnzZnsz28KgQGktVafkF6PJQ
PUT /metadata/lotusR16PSJHkWMkkRz9TddhnzZnsz28KgQGktVafkF6PJQ -> HTTP 200 OK
Registered with no payment (POP disabled). txids: ["9e0923bf9e060fb935e94ad041949bac4762a44ce6381aa7a4c56d16c80c370c"]
GET /metadata/lotusR16PSJHkWMkkRz9TddhnzZnsz28KgQGktVafkF6PJQ -> HTTP 200 OK
Identity registration verified end-to-end: no payment was made, POP disabled.
```

## Step 3: send a stamped message relay-to-relay (acceptance criteria 2 & 3)

From `app/`, compile the TS demo (no `ts-node` in this repo, so compile once with `tsc`, same
pattern as this directory's other `*.livecheck.ts` files):

```sh
cd app
node_modules/.bin/tsc --module commonjs --target es2019 --esModuleInterop --resolveJsonModule \
  --allowJs --skipLibCheck --outDir /tmp/monad-e2e-demo \
  src/cashweb/wallet/monad-http.ts src/cashweb/wallet/monad-account-tx.ts \
  src/cashweb/wallet/monad-hd-keyring.ts src/cashweb/wallet/monad-account-pool.ts \
  src/cashweb/wallet/monad-account-lease.ts src/cashweb/wallet/monad-stamp-client.ts \
  src/cashweb/wallet/monad_message_pb.js \
  src/cashweb/wallet/storage/sub-account-pool-storage.ts \
  src/cashweb/wallet/monad-e2e-demo.livecheck.ts \
  src/cashweb/wallet/verify-onchain-tx.livecheck.ts

set -a; source ../.env; set +a
export E2E_DEMO_RELAY_URL=http://127.0.0.1:8098
export E2E_DEMO_MAIN_WALLET_JSON=/absolute/path/to/your/chain-wallet.json
node /tmp/monad-e2e-demo/monad-e2e-demo.livecheck.js
```

This: derives+funds one fresh HD sub-account from your funded main account (a real, confirmed
Monad-testnet transfer), leases it, builds+locally-signs a real EIP-1559 burn transaction
committing `SHA256(encrypted_payload)` in its calldata, `PUT`s the `MonadStampedMessage` to the
relay's live `PUT /message/monad` route (the relay itself broadcasts + polls-for-confirmation +
verifies that exact tx against the real chain before storing anything), and then `GET`s the
message back by its `payload_hash` to prove it round-trips.

Real output from this ticket's own run:

```
Funded 0x7494372aF686Db5ABC346fB4Cc49B5b17Fe8bEE8 with 20001000000000000 wei, tx 0x3f063aa95f0489b6cd653d0bcb74db006fb6fe8816611c3df6315d398eeed2fd
Funding tx confirmed on-chain.
Relay accepted the message.
  payload_hash: 8f89f92e78b603395e05c88f1ecbc6296025a3e8a94b246cc3b1508dad458a90
  burn tx hash: 0xe581d4a1750fa39e75f1c434b557e1ba8501b0f9358d76814d17e3064b15ef85
  sender (recovered on relay from raw_burn_tx): 0x7494372af686db5abc346fb4cc49b5b17fe8bee8
  sub-account leased: index 0 (now 'spent', never reused)
Fetched payload matches: true
Fetched tx_hash matches: true
```

**Gap, reported plainly (criterion 3's "existing WS push mechanism"):** there is no live WS push
for this path. Checked `backend/cashweb/cashweb-registry/src/http/server.rs`'s router (the only
routes are the `GET`/`PUT` ones above — no `axum::extract::ws` route registered anywhere in this
crate) and `src/monad_ws.rs` (a WS *client*, subscribing to Monad's own `eth_subscribe("newHeads")`
block-header feed for internal `ChainAdapter` use — nothing to do with pushing messages to
recipients). The app's legacy `RelayClient`/`isomorphic-ws` WS code (`app/src/cashweb/relay/
index.ts`) targets a different, pre-Monad relay-server protocol entirely, not this registry's HTTP
API. **A Monad-message recipient today has no way to be pushed a new message; they can only poll
`GET /message/monad/:payload_hash`** (and would need the payload hash out-of-band, since there's
also no "list new messages for me" endpoint on this path — only `Registry::get_monad_message` by
exact hash). This demo's step above (`GET` right after `PUT`) proves the read side works, but does
not and cannot prove "delivery" in the sense of a live push, because that mechanism doesn't exist
yet for this message path.

## Step 4: independently verify the broadcast on-chain (acceptance criterion 4)

In a **separate** shell/process (the point being it shares no state with whatever sent the tx):

```sh
node /tmp/monad-e2e-demo/verify-onchain-tx.livecheck.js
# (reads the tx hash from /tmp/e2e-demo-stamp-tx.json, written by step 3;
#  or pass it explicitly: node verify-onchain-tx.livecheck.js 0x<tx_hash> $MONAD_TESTNET_HTTP_RPC_URL)
```

Real output from this ticket's own run:

```
== Independently verifying 0xe581d4a1750fa39e75f1c434b557e1ba8501b0f9358d76814d17e3064b15ef85 against https://monad-testnet.g.alchemy.com/v2/... ==
Chain ID: 0x279f (10143)

Receipt found on-chain:
  blockNumber: 65997428
  blockHash:   0x630fab7bae71a45b8dfad4351c70fb00acef24da1b781704d366c6081ba069ee
  from:        0x7494372af686db5abc346fb4cc49b5b17fe8bee8
  to:          0x000000000000000000000000000000000000dead
  status:      0x1 (success)
  gasUsed:     22596
  value:       1000000000000 wei
  calldata:    0x504f4e44018f89f92e78b603395e05c88f1ecbc6296025a3e8a94b246cc3b1508dad458a90

Independently confirmed: this transaction is real, mined, and successful on Monad testnet.
```

`calldata` decodes as `POND` (LOKAD ID, `0x504f4e44`) + `01` (version tag) +
`8f89f92e78b603395e05c88f1ecbc6296025a3e8a94b246cc3b1508dad458a90` (the payload hash) — matching
step 3's reported `payload_hash` exactly, confirming this on-chain transaction really is the same
stamp the relay verified and stored.

## Known gaps and deliberate stand-ins

1. **No live WS push for Monad messages** (criterion 3) — see Step 3 above. Real gap, not fixed
   here (out of this ticket's scope to build; flagged for a follow-up ticket).
2. **`DemoChainAdapter` (identity registration only)** — `e2e_demo_server.rs` uses a permissive,
   always-accept `ChainAdapter` stub instead of a real Lotus `bitcoind`/`lotusd` regtest node,
   because (a) no `lotusd` binary is available in this environment (only its C++ source), and (b)
   `Registry::put_metadata`'s Lotus-shaped burn-tx bookkeeping is pre-existing, unmigrated
   plumbing unrelated to Monad or to this ticket's actual subject. This never touches any real or
   simulated blockchain (so it isn't "self-hosted chain infrastructure" under `PLAN.md` constraint
   1 — it's a no-op, not infrastructure), and it's scoped *only* to the metadata-PUT path: the
   Monad-stamped-message path (this ticket's real subject) never goes through `ChainAdapter` at
   all and is 100% real, live Monad testnet + Alchemy, served by this same process.
3. **Message content is not encrypted in this demo** — `MonadStampedMessage.encrypted_payload` is
   opaque to every layer this ticket touches; no Monad-side message-content encryption module has
   landed in this codebase yet. This demo sends a plain UTF-8 JSON blob as a stand-in, to prove the
   burn/relay/verify/store pipeline, not a confidentiality property nothing implements yet.

## Bugs found and fixed while wiring this demo up

Both were genuine bugs in already-merged code, found only because this ticket actually ran the
real pipeline end-to-end for the first time. Fixed minimally, documented here and at the fix site:

1. **Wrong env var name for the stamp burn address**
   (`backend/cashweb/cashweb-registry/src/http/monad_message.rs`): `MonadMessageGateConfig::
   from_env` read `CASHWEB_STAMP_BURN_ADDRESS`, a name that never appeared anywhere in
   `.env`/`.env.example` — only the correct, documented `MONAD_STAMP_BURN_ADDRESS` (ticket #7) did.
   Every real `PUT /message/monad` request following the documented `.env` setup would fail closed
   with a `500` (`GateUnavailable`). Fixed to read `MONAD_STAMP_BURN_ADDRESS`. Also added the
   never-documented-at-all `CASHWEB_STAMP_MIN_BURN_VALUE_WEI` to `.env.example` (and this
   worktree's `.env`) — that one wasn't a naming mismatch, just missing.
2. **Wrong `Content-Type` header on the client's `PUT /message/monad`**
   (`app/src/cashweb/wallet/monad-stamp-client.ts`, `putStampedMessage`): sent
   `application/octet-stream`; the live route decodes its body via the same generic `Protobuf`
   extractor every other route in this crate uses, which requires exactly
   `application/x-protobuf`. Every real call failed with `400 wrong-content-type` until fixed.
   Confirmed live (this exact error, then success after the fix) during this ticket's demo run.

Neither fix touches any test's asserted behavior (checked: no test asserted the old, wrong
values) — both are now covered indirectly by this runbook's own successful live run, which is a
stronger proof than a unit test could be for either bug.
