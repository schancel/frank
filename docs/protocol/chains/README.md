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

`packages/wallet/chain/chains-registry.ts` is a separately declared client metadata table, not a
generated copy of `v1.json`. It includes presentation metadata and public endpoint defaults;
operator-specific or credential-bearing endpoints do not belong in those defaults. There is
currently no generator or regeneration command for this TypeScript table. Its existing registry
tests check agreement on shared protocol fields across chain families:

```sh
yarn --cwd packages/wallet test --runInBand --runTestsByPath chain/chains-registry.jest.test.ts
```

Relay operator upstreams belong to runtime configuration: EVM rows name server-only environment
variables through `EvmRpcChainConf.upstream_env` and `upstream_envs`, rather than storing provider
credentials in checked-in public metadata. Public client defaults do not override that runtime
configuration or relax the protocol's native-ID and checkpoint identity probes.
