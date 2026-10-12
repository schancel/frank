# Public Gold observation

Read-only `eth_call latestRoundData()` to the configured XAU/USD proxy on the official Arbitrum RPC (`https://arb1.arbitrum.io/rpc`) succeeded on 2026-10-12 around 00:17:52 UTC. No wallet, account, signing, owner profile, capability URL or funded operation was used.

- Proxy: `0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c`.
- Price: 4194.495 USD/troy ounce (8 decimals).
- Actual updatedAt: 1791694996 = 2026-10-11 05:03:16 UTC, about 19h15m before observation.
- Contract read-only metadata independently confirms `decimals() = 8` and `description() = "XAU / USD"`.
- Complete five-word ABI; startedAt precedes updatedAt; roundId and answeredInRound match.
- Python urllib failed local TLS validation; curl succeeded against the same official endpoint without disabling TLS validation or changing endpoints.

Official metadata: https://data.chain.link/feeds/arbitrum/mainnet/xau-usd . Source-time API: https://docs.chain.link/data-feeds/api-reference . Historical retrieval: https://docs.chain.link/data-feeds/historical-data . This proves a dated current source is available; it does not establish historical coverage or promise uninterrupted future availability. The implementation preserves the source timestamp and reports stale age rather than labeling fetch time as market time.
