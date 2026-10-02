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
provider reports the configured `expected_chain_id`. Rotate a provider key by changing that
server-side environment value and restarting the relay; the URL and key are never returned or
logged by the proxy.

RPC access uses the same customer authority source as private mailbox reads: control of a
currently registered Monad profile key. A client sends the exact intended JSON-RPC body and an
`x-frank-rpc-customer` header to `POST /chain-rpc/:chain/rpc/auth`, signs the returned one-minute challenge,
then retries the same bytes at `POST /chain-rpc/:chain/rpc` with these headers:

- `x-frank-rpc-customer`
- `x-frank-rpc-epoch`
- `x-frank-rpc-nonce`
- `x-frank-rpc-expires-at-ms`
- `x-frank-rpc-token`
- `x-frank-rpc-signature` (hex DER ECDSA)

The signature digest is SHA-256 over `signing_domain || 0x00 || epoch || nonce || expires_at_ms
(i64 big-endian) || token || "POST\0/chain-rpc/" || chain_length (u32 big-endian) || chain UTF-8 ||
"\0rpc" ||
customer (20 bytes) || body_sha256 || network_tag_length (u32 big-endian) || network_tag`. The
challenge is single-use and bound to the customer, chain, and exact body bytes. Anonymous,
expired, replayed, or modified authenticated requests fail before any provider call.

The EVM handler accepts only the configured allowlist. It rejects notifications, oversized or
over-count batches, full-transaction block reads, and `eth_getLogs` without a bounded explicit
hex block range. Operator limits cover request and response bytes, concurrency, timeout, batch
length, per-chain log range, a weighted fixed-UTC-hour customer quota, a smaller anonymous quota,
and bounded upstream concurrency. Cheap wallet-bootstrap reads and raw transaction submission may
be anonymous. The fixed-hour allowance can be consumed in a burst, so a wallet with hundreds of
accounts is not broken by a rolling request rate. Expensive calls cost more quota units; unbounded
debug/trace and log requests are denied. Transaction broadcasts are not put behind a short rolling
rate limiter: a pre-upstream quota or busy response is a definite non-attempt, while an upstream
timeout is ambiguous and clients must retain the signed transaction/account reservation and retry
the exact bytes. See issue #664 for the durable client reconciliation contract.

Bitcoin-family configuration names optional node JSON-RPC and Chronik upstream environment
variables plus a required checkpoint height/hash. Startup checks `getblockhash` and Chronik's
`GET /block/<height>` before readiness. Anonymous Chronik wallet-bootstrap reads use a high,
burstable fixed-hour IP quota; anonymous `sendrawtransaction`, `broadcast-tx`, and bounded
`broadcast-txs` use a separate small fixed-hour broadcast quota. Other node RPC and indexer
operations require the same registered-customer challenge as EVM calls.

```toml
[registry.bitcoin_proxy]
enabled = true
anonymous_chronik_requests_per_hour = 20000
anonymous_broadcasts_per_hour = 20

[[registry.bitcoin_proxy.chains]]
id = "xec-mainnet"
rpc_upstream_env = "XEC_NODE_RPC_URL"       # optional
chronik_upstream_env = "XEC_CHRONIK_URL"   # optional; at least one upstream is required
checkpoint_height = 900000
checkpoint_hash = "<64 lowercase or uppercase hex characters>"
```

`GET /peers` publicly returns this relay and its configured peers so clients can select independent
relays for reads or identical transaction rebroadcast. Bitcoin-family duplicate broadcast is
normally idempotent. EVM provider behavior varies, so clients reconcile by locally derived
transaction hash rather than assuming an error proves rejection.
