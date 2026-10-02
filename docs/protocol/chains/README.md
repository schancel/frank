# Frank chain registry v1

`v1.json` is the protocol-level chain identifier registry shared by clients and relays. Its `id`
is the stable value used in `/chain-rpc/:chain/...` paths and signed request scopes. Numeric EVM
chain IDs and CAIP-2 names are aliases and identity evidence; they are not Frank identifiers.

`family` controls dispatch. `evm` chains may expose JSON-RPC. `bitcoin` chains may expose node
JSON-RPC and Chronik. Chronik is not an EVM indexer; a future contract-specific EVM indexer needs
a separate capability and protocol contract.

`allowed_proxy_capabilities` states what the protocol permits for a chain. `GET /chains` reports
the subset an individual relay actually configured. A relay must additionally probe each upstream:

- EVM: `eth_chainId`, plus an operator-pinned block checkpoint when configured.
- Bitcoin-family JSON-RPC: `getblockhash` at an operator-pinned height.
- Chronik: `GET /block/<height>` at the same operator-pinned checkpoint.

Forks can share genesis blocks and numeric IDs can be reused. For that reason a native ID or CAIP-2
alias never substitutes for the configured checkpoint probe. CAIP-2 is omitted when the registry
cannot name a network without creating a false uniqueness claim.
