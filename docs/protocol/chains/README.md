# Frank chain registry v1

`v1.json` is the protocol-level chain identifier registry shared by clients and relays. Its `id`
is the stable value used in `/chain-rpc/:chain/...` paths and signed request scopes. Numeric EVM
chain IDs and CAIP-2 names are aliases and identity evidence; they are not Frank identifiers.

`family` controls dispatch. `evm` chains may expose JSON-RPC. `bitcoin` chains may expose node
JSON-RPC and Chronik. Chronik is not an EVM indexer; a future contract-specific EVM indexer needs
a separate capability and protocol contract.

`allowed_proxy_capabilities` states what the protocol permits for a chain. `GET /chains` reports
the subset an individual relay actually configured. A relay must additionally probe each upstream:

- EVM: `eth_chainId`, plus the registry-pinned block checkpoint.
- Bitcoin-family JSON-RPC: `getblockhash` at the registry-pinned post-fork checkpoint (operator
  checkpoints remain available only for regtest rows).
- Chronik: `GET /block/<height>` at the same registry-pinned checkpoint.

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
The subset currently omits `btc-regtest`, `bch-regtest`, `xec-regtest`, `xpi-mainnet`,
`xpi-testnet` and `xpi-regtest`. These protocol networks are intentionally unavailable in the
client registry. Ethereum Holesky is not a protocol row and is not exposed. Runtime chain
registration is removed: supporting a network requires a protocol definition and an explicit
client extension. Unknown direct lookups return `undefined`; existing alias/kind helpers are
separate consumer seams and do not add networks.

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
