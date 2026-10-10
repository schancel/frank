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
environment variable. At startup the relay calls `eth_chainId` and serves a chain only once its
provider reports the configured `expected_chain_id` and registry-pinned block checkpoint; every
configured WebSocket upstream is probed independently with both identity checks. A provider that
is down or reports another chain never stops the relay: startup waits at most 2 seconds for the
first check, that chain's RPC routes answer `503 rpc_upstream_unavailable`, and the check is
repeated every 30 seconds until it passes. Message delivery does not depend on it. EVM proxy rows
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
`GET /block/<height>`, with the same rule as the EVM proxy: the relay starts whatever the answer,
and a chain whose upstream is unreachable or reports a different block is logged, answers
`503 rpc_upstream_unavailable`, and is checked again every 30 seconds until it passes; nothing is
forwarded to it before then. The Solana proxy treats `getGenesisHash` the same way. Anonymous Chronik wallet-bootstrap reads use a high,
burstable fixed-hour IP quota; anonymous `sendrawtransaction`, `broadcast-tx`, and bounded
`broadcast-txs` use a separate small fixed-hour broadcast quota. Other node RPC and indexer
operations require the same registered-customer challenge as EVM calls. Anonymous history queries
accept only bounded `page` and `page_size` parameters, and anonymous batch script requests consume
one quota unit per script. Chronik paths are canonicalized before policy and forwarding. Every valid
non-success upstream protobuf error retains its HTTP status and protobuf shape, but its
provider-controlled message is replaced with `upstream Chronik error` so credentials cannot leak.

```toml
[registry.bitcoin_proxy]
enabled = true
anonymous_chronik_requests_per_hour = 20000

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

## Price and energy oracle

`GET /oracle/v1/feed` is the one place a client gets prices, chain statistics, mining hardware
efficiency and electricity prices: the inputs of every AVU figure the app shows. The contract
(series names, lookup semantics, formulas) is `docs/protocol/oracle/README.md`. The relay serves
the inputs and does not compute AVU. The feed is for display and valuation, never a quote.

- `?latest` (or no query): exactly one point per series, its latest. Built after each collector
  round and served from memory; about 7 kB with the shipped configuration (1.5 kB gzipped).
  `Cache-Control: public, max-age=600` and an `ETag` (`If-None-Match` answers `304`).
- `?since=<unixSeconds>&until=<unixSeconds>&step=<seconds>`: history for a chart: per series the
  point in force at `since`, then the last point of each step. At most 1000 steps per request; a
  smaller `step` is refused with `400` naming the smallest allowed. Cacheable for a day once
  `until` has passed.

The route is public and unauthenticated. A request is answered from the relay's own store and
never causes a request to a provider. The `[registry.oracle]` section turns the oracle on;
without it there is no collector and the path answers `404` (also on a relay that serves the web app from
`spa_dir`), which is how a client learns a relay has no feed.

### What the collector does

The collector is a task of its own. Relay startup opens its store and returns; no provider is
contacted before the relay is listening, and no provider failure reaches message handling. A
provider that fails (non-2xx, timeout, unreadable answer) is skipped for the round and left
alone for 10 minutes, doubling with each further failure up to 6 hours. Failures are logged with
the provider's name and the kind of failure only: never a URL (it may carry a key) and never
upstream text. While one of a round's providers is resting, the round stays due and
comes round again when the rest ends (resting providers are not asked), so a daily source that
was down is asked again the same day. A round
that is not yet due after a restart is not repeated.

- Prices, every `price_interval_s` (10 minutes): two providers are drawn at random and each is
  asked once for every asset it lists. Per asset: two answers within `agree_tolerance_bps` (2%)
  give their mean. If they disagree, one more provider is asked for that asset and the median
  of three is taken; with nobody left to ask, their mean, unless they are more than
  `two_source_max_spread_bps` (10%) apart, in which case there is no sample. A sample more
  than `outlier_threshold_bps` (10%) from the smoothed value, and the first sample of a series
  or after `long_gap_s` (6 hours), also wants a third provider; when no third can answer, two
  that agree are taken. An asset only one provider can answer for uses it (its `source` says
  "single source" when only one lists it), but one provider alone cannot confirm a jump: such
  a sample is dropped until another provider answers or the long gap has passed.
  Samples are smoothed with a time-weighted moving average, `alpha = 1 - exp(-dt / ewma_tau_s)`
  (30 minutes). Upstream cost: at most one request per provider per round, so at most 6 an hour
  each. A round is two requests only when the two providers drawn list every asset between
  them and agree; otherwise each asset still short of two agreeing answers brings in one more
  provider that lists it. With the shipped tables that is usually three or four requests a
  round (XEC and XMR are listed by few providers), and five or six on the first round or
  after a long gap, when every series wants three answers.
- Chain statistics, every `stats_interval_s` (1 hour): one Blockchair `/stats` request gives
  every chain's difficulty, coins in existence and the subsidy it paid per block over 24 hours.
  `blockReward/<chain>` is that subsidy times the miner's share in force (eCash: 0.58, from
  the dated steps in the bundled seed);
  `marketCap/<chain>` is coins in existence times the relay's smoothed price. A chain with
  `hashrate_block_seconds` (Dogecoin: 60) retargets every block and swings about 15% between
  readings, so its difficulty is a 24-hour figure: the 24-hour hash rate times the block time.
- Electricity, every `electricity_interval_s` (1 day): per region one request for day-ahead
  prices and one for the ECB euro reference rates. Each complete UTC day becomes one point of
  `electricity/<region>`: the day's mean price in US dollars per kWh, zero and negative days
  included. `electricity/aggregate`, the series AVU_spot is read from, is derived when read
  and never stored: its point for a day is the equally weighted mean, over the regions with
  `in_aggregate` (default true), of each region's mean daily price in the
  `electricity_window_days` (30) days ending that day; a region with fewer than
  `electricity_min_days` (10) prices in that window is left out, and the series ends at the
  latest day any region has a price for. The feed's `electricity` block names each region,
  its attribution and the last day it counted.

`collect = false` under `[registry.oracle]` turns the collector off: no provider is ever
asked, and the feed serves the bundled history and whatever the store already holds (live
series are then marked `stale`). `run-local-monad.sh` writes it into every relay it starts, so
development, test and demo relays do not spend the providers' free allowances;
`FRANK_RELAY_ORACLE_COLLECT=true` turns collection on for a run (`yarn demo` sets it; the
checks that start a demo do not). A relay started from a shipped configuration directly, or in
Docker, collects.

A store that cannot be opened does not stop the relay: it is logged, the relay runs without the
feed and the path answers `404`. If the collector task ever ends or panics it is logged and
started again after a minute.

Keys stay on the server. A row with `key_env` is used only when that environment variable is
set; the key is sent to its provider and appears in no log and no answer. The shipped
configurations name no keyed provider. A US region can be collected from the EIA API v2 once a
key exists (this adapter has not been run against the live API):

```toml
[[registry.oracle.electricity]]
region = "us-pjm-west"
label = "PJM Western Hub day-ahead"
attribution = "US Energy Information Administration"
adapter = "eia"
api_url = "https://api.eia.gov/v2/<route>/data/?frequency=daily&data[0]=<column>&..."
key_env = "EIA_API_KEY"
value_field = "<column>"
usd_per_kwh_factor = "0.001"    # the column is $/MWh
```

Identifiers are the mainnet chain identifiers of `docs/protocol/chains/v1.json`: a chain's coin
is priced under its chain's identifier, and a test network's coin is valued by the client at
its mainnet price. Identifiers that are priced but are not Frank networks (`ltc-mainnet`,
`xmr-mainnet`, `usdc`, `usdt`) must be listed in `non_network_ids`; any other unknown identifier
stops the relay at startup. A provider's `symbols` table maps identifiers to the provider's own
names; adding an asset is a configuration change. Provider endpoints are `api_url` (not `url`:
`run-local-monad.sh` rewrites top-of-line `url =` keys).

Adapters: `coinbase` (`/v2/exchange-rates`), `kraken` (`/0/public/Ticker`; symbols are the pair
names Kraken answers under, e.g. `XXBTZUSD`), `binance` (`/api/v3/ticker/price`, also
Binance.US), `coingecko` (`/api/v3/simple/price`), `chainlink` (USD feed contracts read with
`eth_call` in one JSON-RPC batch; a symbol is the feed's address). Pyth Hermes is not included:
it answers `401` without an API key.

### Storage

Collected data lives in its own RocksDB directory beside the registry database: `db_path` with
the extension `oracle-v1` (`data/registry.oracle-v1`). It is created the first time a relay
with the oracle enabled starts. The registry database is not touched, so an existing database
opens unchanged and a build from before the oracle still opens it. The store holds every
provider answer (`raw`) and the served series (`series`), at full resolution for
`full_resolution_days` (14) and thinned to the last point of each UTC day after that, so
history survives restarts. The smoothed prices are recomputable from the stored answers.
Deleting the directory loses collected history only.

### Bundled history

History from before a relay started collecting, the curated hardware-efficiency steps and the
basket definition are compiled into the binary from `docs/protocol/oracle/seed.json`. That file
is generated: its sources are the JSON files in `packages/price-feeds/src/historical/`, and
`python3 packages/price-feeds/scripts/build-oracle-seed.py` rebuilds it (`--check` exits 1 when
it is out of date). For each series the relay serves bundled points up to its first collected
point and collected points from there on.
