# cashweb
CashWeb backend. Send peer-to-peer E2E encrypted messages with crypto as spam protection mechanism.

# Building From Source
## Linux (openSUSE)
1. Install the `protobuf-devel` package: `sudo zypper install protobuf-devel`
2. Clone this repo: `git clone https://github.com/givelotus/cashweb.git`
3. Clone the `bitcoinsuite` repo into the same directory (i.e. so that it is next to the `cashweb` directory): `git clone https://github.com/givelotus/bitcoinsuite`
4. Change into `cashweb` directory: `cd cashweb`
5. Add the following contents to `cashwebd-exe/config.toml` (create file if it doesn't exist):
```
host = "127.0.0.1:6543"
url = "http://127.0.0.1:6543"

[registry]
db_path = "./test_db"
net = "mainnet"
peers = []

[bitcoin_rpc]
url = "http://127.0.0.1:10604"
rpc_user = "lotus"
rpc_pass = "lotus"
```
6. Build and run cashweb: `cargo run cashwebd-exe/config.toml`

The build process will take some time to complete. If successful, you should see a message similar to the following:
```
2023-03-07T01:31:36.979388Z  INFO Listening on 127.0.0.1:6543
```

## Family-dispatched chain proxies

`GET /chains` advertises the configured subset of the versioned registry in
`docs/protocol/chains/v1.json`. All node traffic uses `POST /chain-rpc/:chain/rpc`; the stable
Frank chain identifier selects an EVM or Bitcoin-family handler. Bitcoin-family relays may also
serve the Chronik HTTP/Protobuf API at `/chain-rpc/:chain/chronik/*`. Chronik is not used for EVM.

The shipped relay configurations expose `monad-testnet`. Its provider URL is read only from the row's `upstream_env`
environment variable. At startup the relay calls `eth_chainId` and refuses readiness unless the
provider reports the configured `expected_chain_id` and registry-pinned block checkpoint; every
configured WebSocket upstream is probed independently with both identity checks. EVM proxy rows
must repeat the registry checkpoint exactly so a configuration cannot silently weaken the probe.
Rotate a provider key by changing that
server-side environment value and restarting the relay; the URL and key are never returned or
logged by the proxy.

RPC access uses the same customer authority source as private mailbox reads: control of a
currently registered Monad profile key. A client sends an empty body and an
`x-frank-rpc-customer` header to `POST /chain-rpc/:chain/capability/auth`, signs the returned
one-minute challenge, and exchanges it at `POST /chain-rpc/:chain/capability` for an expiring
chain-scoped capability. EVM issuance returns `/chain-rpc/:chain/cap/:token/rpc` and, when the
chain config names an `upstream_ws_env`, `/chain-rpc/:chain/cap/:token/ws`. Bitcoin-family
issuance returns the same `rpc_path` when a node RPC is configured and
`/chain-rpc/:chain/cap/:token/chronik` as `chronik_path` when Chronik is configured; append the
normal Chronik endpoint path to that base. These are ordinary client-compatible endpoints: the
bearer is in the path because browser WebSockets cannot set an Authorization header. The
TypeScript `issueMonadRelayRpcCapability` helper resolves the EVM paths into absolute URLs.
Treat every capability URL as a secret. The built-in request logger replaces the token and, for
Chronik, the full endpoint suffix with route templates. Their lifetime defaults to one hour and is
configured independently under each proxy with `capability_ttl_ms` (one minute through 24 hours).

The two capability-issuance requests use these headers:

- `x-frank-rpc-customer`
- `x-frank-rpc-epoch`
- `x-frank-rpc-nonce`
- `x-frank-rpc-expires-at-ms`
- `x-frank-rpc-token`
- `x-frank-rpc-signature` (hex DER ECDSA)

The signature digest is SHA-256 over `signing_domain || 0x00 || epoch || nonce || expires_at_ms
(i64 big-endian) || token || "POST\0/chain-rpc/" || chain_length (u32 big-endian) || chain UTF-8 ||
"\0capability" ||
customer (20 bytes) || body_sha256 || network_tag_length (u32 big-endian) || network_tag`. The
challenge is single-use and bound to the customer, chain, and empty issuance body. The returned
capability is HMAC authenticated, chain/customer scoped, and reusable until its expiry. EVM calls
continue to consume the customer's fixed-hour quota. Bitcoin-family capability calls remain
bounded by method allowlists, request/response limits, timeouts, and concurrency; the fixed-hour
Chronik/bootstrap and transaction-broadcast quotas apply only to anonymous callers. Anonymous,
expired, replayed-challenge, modified, or wrong-chain requests fail before any provider call. The
older per-request `/rpc/auth` and `/chronik-auth/*` proofs remain accepted during migration.

The EVM handler accepts only the configured allowlist. It rejects notifications, oversized or
over-count batches, full-transaction block reads, and `eth_getLogs` without a bounded explicit
hex block range. Operator limits cover request and response bytes, concurrency, timeout, batch
length, per-chain log range, a weighted fixed-UTC-hour customer quota, a smaller anonymous quota,
and bounded upstream concurrency. Cheap wallet-bootstrap reads and raw transaction submission may
be anonymous. The fixed-hour allowance can be consumed in a burst, so a wallet with hundreds of
accounts is not broken by a rolling request rate. Expensive calls cost more quota units; unbounded
debug/trace and log requests are denied. A genuinely exhausted HTTP allowance returns `429`, a
`Retry-After` header, and `reset_at_unix_seconds`; disabled, structurally oversized, and temporarily
unavailable quota states use distinct error codes and do not pretend that the next hour will help.
Transaction broadcasts are not put behind a short rolling
rate limiter: a pre-upstream quota or busy response is a definite non-attempt, while an upstream
timeout is ambiguous and clients must retain the signed transaction/account reservation and retry
the exact bytes. See issue #664 for the durable client reconciliation contract.

WebSocket connections require a customer capability and share that customer's fixed-hour quota.
They use a separate connection semaphore, close no later than capability expiry, cap client frames
at `max_request_bytes`, and cap upstream frames at the lesser of `max_response_bytes` and 16 MiB.
Only the HTTP allowlist plus `eth_unsubscribe`, `eth_subscribe("newHeads")`, and bounded
`eth_subscribe("logs", filter)` are accepted; pending-transaction and debug subscriptions are
denied. A connection may attempt at most 32 subscriptions.
At most 128 JSON-RPC requests may await an upstream response on one connection, each pending call
holds a shared upstream-concurrency permit, and responses and subscription notifications are
forwarded only when their IDs match an outstanding call or active subscription.

Bitcoin-family configuration names optional node JSON-RPC and Chronik upstream environment
variables plus the registry-pinned checkpoint height/hash (regtest rows use an operator
checkpoint). Startup checks `getblockhash` and Chronik's
`GET /block/<height>` before readiness. Anonymous Chronik wallet-bootstrap reads use a high,
burstable fixed-hour IP quota; anonymous `sendrawtransaction`, `broadcast-tx`, and bounded
`broadcast-txs` use a separate small fixed-hour broadcast quota. Other node RPC and indexer
operations require the same registered-customer challenge as EVM calls. Anonymous history queries
accept only bounded `page` and `page_size` parameters, and anonymous batch script requests consume
one quota unit per script. Chronik paths are canonicalized before policy and forwarding; valid
upstream protobuf error bodies are preserved byte-for-byte unless they contain configured upstream
credentials.

```toml
[registry.bitcoin_proxy]
enabled = true
anonymous_chronik_requests_per_hour = 20000
anonymous_broadcasts_per_hour = 20

[[registry.bitcoin_proxy.chains]]
id = "xec-mainnet"
rpc_upstream_env = "XEC_NODE_RPC_URL"       # optional
chronik_upstream_env = "XEC_CHRONIK_URL"   # optional; at least one upstream is required
checkpoint_height = 661648
checkpoint_hash = "000000000000000004284c9d8b2c8ff731efeaec6be50729bdc9bd07f910757d"
```

`GET /peers` publicly returns this relay and only the separate `public_relay_urls` allowlist; private
federation peers are never inferred to be public. Clients can select independent relays for reads
or identical transaction rebroadcast. Bitcoin-family duplicate broadcast is
normally idempotent. EVM provider behavior varies, so clients reconcile by locally derived
transaction hash rather than assuming an error proves rejection.
