# Gold round association repair — Tier 3

Candidate under review: 879b2ea582f90d05c93ed6ad594ffbdf7ef0df2e.

Current store raw identity is (series, time, provider). Derived multi-provider samples are formed per collection round, and replay joins raw provider inputs to the providers-count record by that round time. Storing Chainlink's earlier observedAt as raw time detaches it from the mixed round and overwrites earlier inputs when the same source round is polled again. Ordinary Coinbase+Chainlink BTC/ETH collection is a reachable affected path; display sampling itself still uses both inputs, but persisted replay loses them.

Target: use collection time for raw inputs of configured multi-provider assets, preserving the existing derived-round association and persistence format. For a configured sole dated source such as Gold, continue retaining the actual source timestamp and exact unsmoothed observation. Decide this from stable configured source ownership, not a transient failed-provider count. No wire/store format, wallet state or mining formula change.

Regression: three actual collector rounds through Coinbase and Chainlink adapters (dated source earlier than collection), reopen the store, reconstruct rounds from persisted raw records, and require replay to equal all three stored derived samples and retain six provider inputs. Existing sole-Gold exact-date/no-smoothing/dedup regression must continue passing.

Verification: the new persisted Coinbase+Chainlink regression fails on 879b2ea5 with replay `[]` versus three stored `(round,101.0)` samples. After the association correction, all 38 oracle tests pass, including sole-Gold exact date, unsmoothed price, repeated-poll deduplication and served unit/asOf checks. Rust formatting and diff whitespace checks pass. No TS, configuration, mining or persistence format changes in this repair; their prior gates remain applicable. The repair does not reconstruct inputs already lost by an uncorrected candidate.
