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

## Customer-authenticated EVM RPC proxy

The shipped relay configurations expose one EVM-family handler at `POST /rpc/:chain`; the first
chain row is `monad-testnet`. Its provider URL is read only from the row's `upstream_env`
environment variable. At startup the relay calls `eth_chainId` and refuses readiness unless the
provider reports the configured `expected_chain_id`. Rotate a provider key by changing that
server-side environment value and restarting the relay; the URL and key are never returned or
logged by the proxy.

RPC access uses the same customer authority source as private mailbox reads: control of a
currently registered Monad profile key. A client sends the exact intended JSON-RPC body and an
`x-frank-rpc-customer` header to `POST /rpc/:chain/auth`, signs the returned one-minute challenge,
then retries the same bytes at `POST /rpc/:chain` with these headers:

- `x-frank-rpc-customer`
- `x-frank-rpc-epoch`
- `x-frank-rpc-nonce`
- `x-frank-rpc-expires-at-ms`
- `x-frank-rpc-token`
- `x-frank-rpc-signature` (hex DER ECDSA)

The signature digest is SHA-256 over `signing_domain || 0x00 || epoch || nonce || expires_at_ms
(i64 big-endian) || token || "POST\0/rpc/" || chain_length (u32 big-endian) || chain UTF-8 ||
customer (20 bytes) || body_sha256 || network_tag_length (u32 big-endian) || network_tag`. The
challenge is single-use and bound to the customer, chain, and exact body bytes. Anonymous,
unregistered, expired, replayed, or modified requests fail before any provider call.

The EVM handler accepts only the configured allowlist. It rejects notifications, oversized or
over-count batches, full-transaction block reads, and `eth_getLogs` without a bounded explicit
hex block range. Operator limits cover request and response bytes, concurrency, timeout, batch
length, and per-chain log range. Set `[registry.evm_rpc] enabled = false` (or omit the table) to
remove all `/rpc/*` routes; no stored-data rollback is needed.
