# Frank chain registry v1

`v1.json` is the protocol-level chain identifier registry shared by clients and relays. Its `id`
is the stable value used in `/chain-rpc/:chain/...` paths and signed request scopes. Numeric EVM
chain IDs and CAIP-2 names are aliases and identity evidence; they are not Frank identifiers.

`family` controls dispatch. `evm` chains may expose JSON-RPC. `bitcoin` chains may expose node
JSON-RPC and one of two indexers: Chronik (eCash) or Electrum (Bitcoin, Bitcoin Cash, Dogecoin). Chronik is not an EVM indexer; a future contract-specific EVM indexer needs
a separate capability and protocol contract.

`allowed_proxy_capabilities` states what the protocol permits for a chain. `GET /chains` reports
the subset an individual relay actually configured. A relay must additionally probe each upstream:

- EVM: `eth_chainId`, plus the registry-pinned block checkpoint.
- Bitcoin-family JSON-RPC: `getblockhash` at the registry-pinned post-fork checkpoint (operator
  checkpoints remain available only for regtest rows).
- Chronik: `GET /block/<height>` at the same registry-pinned checkpoint.
- Electrum: `blockchain.block.header` at the operator's configured checkpoint, asked of every
  upstream connection before it carries a client frame (`http/electrum_proxy.rs`). The genesis
  hash from `server.features` is not used: Bitcoin testnet and Bitcoin Cash testnet share one.
  Because this probe runs per connection, an Electrum upstream that is down or wrong makes that
  chain unavailable; it never stops the relay.

Electrum routes: `GET /chain-rpc/<chain>/electrum` is a public WebSocket (per-address quotas, as
the public Chronik routes); `GET /chain-rpc/<chain>/cap/<capability>/ws` is the same for a
capability holder. Upstreams may be `tcp://`, `ssl://`, `ws://` or `wss://`.

Forks can share genesis blocks and numeric IDs can be reused. For that reason a native ID or CAIP-2
alias never substitutes for the required checkpoint probe. Public-network checkpoints are protocol
data; only regtest checkpoints are operator data because those chains are created locally. CAIP-2 is omitted when the registry
cannot name a network without creating a false uniqueness claim.

## Configuration ownership

`v1.json` owns protocol identifiers, identity requirements and permitted capabilities. The Rust
configuration crate (`backend/cashweb/cashweb-config/src/lib.rs`) includes that file directly.

`packages/wallet/chain/chains-registry.ts` imports `v1.json` directly through the pure
`chain/protocol-chain-registry.ts` projection. The JSON owns canonical IDs, family, network,
CAIP-2, native chain identity, permitted proxy capabilities and required identity probes.
The projection validates consumed fields, duplicate IDs and client references, preserves the
probes and capability limits, and returns deeply immutable derived entries. Native EVM IDs
remain numbers within the safe integer range and exact decimal strings above it.

`CLIENT_CHAIN_EXTENSIONS` selects the explicit client-supported subset and owns only
presentation, units, curve/key selection, public endpoint defaults, deployments and feature
settings. Its typed shape excludes protocol facts; the projection also rejects unknown or
protocol-owned extension keys at runtime. Client metadata cannot broaden protocol capabilities.
The subset currently omits `btc-regtest`, `bch-regtest`, `xpi-mainnet`, `xpi-testnet` and
`xpi-regtest`. These protocol networks are intentionally unavailable in the client registry.
`xec-regtest` is in the subset: it is the local eCash node that `packages/bot/demo/regtest`
starts (see "Local regtest networks" below). Ethereum Holesky is not a protocol row and is not exposed. Runtime chain
registration is removed: supporting a network requires a protocol definition and an explicit
client extension. Unknown direct lookups return `undefined`; existing alias/kind helpers are
separate consumer seams and do not add networks.

Contract addresses are per network and have one source: the deployment records in
`packages/contracts/deployments/<chainIdentifier>.json`, written by the deploy script after it
reads the code back from the chain and listed in `packages/contracts/deployments/index.ts`. The
client registry copies an EVM network's addresses from its own record. A network without a
record has no contract address, and `requireChainContract` throws for it; there is no address
shared between networks and no default. Deploy and check a deployment with:

```sh
yarn --cwd packages/contracts test
yarn --cwd packages/contracts deploy --chain <chainIdentifier> --rpc <url> --wallet-json <file> --dry-run
yarn --cwd packages/contracts deploy --chain <chainIdentifier> --rpc <url> --wallet-json <file>
yarn --cwd packages/contracts htlc-round --chain <chainIdentifier> --rpc <url> --wallet-json <file>
```

The Solana rows still carry placeholder program IDs; no Solana program is deployed.

`wallet` in a client extension says the app has its own wallet on a network (balance, receive and
send) and which proxy capability it reads through (`json-rpc`, `chronik` or `electrum`; the
projection rejects one the protocol does not permit for that chain). The app's balance reader,
Send routing, wallet list and Settings all read this one setting. A network without it is shown
as not supported, with no deposit address.

The funded send check, one command per UTXO testnet, against a running relay
(`backend/cashweb/run-local-monad.sh`) and a test wallet whose 64-hex seed is in a file outside
the repository:

```sh
cd packages/wallet
export FRANK_LIVE_RELAY_URL=http://127.0.0.1:8098 FRANK_UTXO_TEST_SEED_FILE=<seed file>
export TSX_TSCONFIG_PATH=tsconfig.livecheck.json
node --import tsx utxo-funded-send.livecheck.ts xec-testnet
node --import tsx utxo-funded-send.livecheck.ts btc-testnet
node --import tsx utxo-funded-send.livecheck.ts bch-testnet
```

Unfunded, each prints the address to fund and exits 2. Funded, it sends a small amount to the
wallet's next unused address, waits for the indexer to show it, and exits 0 (1 on failure). As of
2026-10-10 no funded send has been observed on any of the three: the test wallets were empty.

Client extensions no longer list
Electrum servers: the app reaches Electrum only through its relay, whose operator configures the
upstreams (`backend/cashweb/cashwebd.local.toml`).

Operator-specific or credential-bearing endpoints do not belong in public defaults. There is
no generated identity copy and no generator or regeneration command. Checks cover all three
families, exact supported and omitted sets, source agreement, mutation through the same
projection, validation and immutability:

```sh
yarn --cwd packages/wallet test --runInBand --runTestsByPath chain/chains-registry.jest.test.ts chain/protocol-chain-registry.jest.test.ts sync-router.jest.test.ts
yarn typecheck:fast
# Exercise the direct JSON import in the existing application bundler:
cd app && ../node_modules/.bin/quasar build -m spa
```

Relay operator upstreams belong to runtime configuration: EVM rows name server-only environment
variables through `EvmRpcChainConf.upstream_env` and `upstream_envs`, rather than storing provider
credentials in checked-in public metadata. Public client defaults do not override that runtime
configuration or relax the protocol's native-ID and checkpoint identity probes.

## Local regtest networks

A regtest network is a named network in its own right, with its own registry row
(`network: regtest`), address prefix and network tag. It is never a stand-in for a testnet.
Every regtest of a client starts from the same genesis block, so its identity probe is an
operator block checkpoint: whoever starts the node reads a block the node mined in that run and
gives its height and hash to the relay (`checkpoint_height`, `checkpoint_hash` in its
`[[registry.bitcoin_proxy.chains]]` row). The relay refuses to start when the upstream does not
have that block.

`packages/bot/demo/regtest/regtest-stack.ts` does this for eCash: `startRegtestStack()` starts a
Bitcoin ABC node with Chronik in regtest mode, mines the first blocks, starts the relay with that
run's checkpoint, and returns `chains['xec-regtest']` with `fund`, `mine`, `checkpoint` and
`stop`. The node is a checksum-verified download into the git-ignored `.regtest-cache/`
(`packages/bot/demo/regtest/bitcoin-abc.ts`). Check the whole stack with:

```sh
yarn --cwd packages/bot regtest:check
```
