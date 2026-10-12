# AVU mining receipts and observed work (tier 3)

Owner request: include mining fees on every supported basket chain and use observed hashrate rather than instantaneous difficulty. Source baseline ac340b63. The normalized oracle feed is authoritative; Rust collector and the temporary TypeScript direct provider are parallel writers, wallet/oracle is the sole AVU formula consumer. Neither custody nor transaction state changes.

Replace difficulty/blockReward input series with hashrate (hashes/s) and minerRevenue (coins/s after consensus deductions). The formula is price × minerRevenue / hashrate × hashes/kWh. Revenue and hashrate must share an observation timestamp/window; incomplete observations are unavailable, never silently zero-fee. Zero observed fees are valid. Provider hashrates remain chainwork/time estimates, not physical hardware meters. Merge-mined chains contribute receipts per hash to one energy entry, never independent energy totals.

Live Blockchair stats supplies 24-hour observed-work estimate. Aggregate fees and generation over the last blocks_24h heights ending at stats tip; reject mismatching counts/issuance and absent/malformed aggregate fields. eCash miner-share deductions apply the whole coinbase, including fees. Monero is unavailable where provider lacks actual receipts/work observations; never invent tail-reward-only receipts. Configured hardware efficiency remains unchanged.

Historical BTC generator adds daily same-window mining revenue including fees and hash-rate observations, aligned with CBECI power. Existing source data lacking fee/work observations must not remain a subsidy-only fallback. Historical other-chain generator requires fee sums and observed work over a bounded calendar window; absent data leaves those terms unavailable until regenerated. No made-up historical fees. Seed generator is the only writer of docs/protocol/oracle/seed.json.

Wire names change together across producers/parser/consumer; no migration or obsolete fallback. Existing relay cached old series do not satisfy new calculation; fresh collector observations rebuild. Keys, balances, spend journals and private browser data remain untouched.

Acceptance: fee zero versus absent/malformed; BTC/BCH/LTC/DOGE/XEC unit conversion; eCash total reward deduction; observed hashrate effect independent of difficulty; mismatched observation timestamps rejected; merged-mining energy counted once; seed generation consistency; focused TS and Rust tests and all-project typecheck. Read-only public aggregate currently returns IP-limit code430, reported as a verification limitation; synthetic responses cannot substitute for actual upstream acceptance.

## Candidate verification

Focused gates: price-feeds 4 suites/61 tests; wallet oracle 2 suites/23 tests; app oracle and parity chart 2 suites/48 tests; generator Python 4 tests. All passed. `yarn typecheck:fast` equivalent node runner: all 22 projects pass using isolated links to the frozen Mera candidate dependency installation, with its package-specific Chronik versions (wallet4.3.1; legacy0.8.5). No shared dependency mutation. Initial use of root dependencies failed on obsolete package exports; corrected environment rerun passed.

Seed generation check, Python compilation, explicit app Prettier configuration and git diff whitespace check pass. Scoped ESLint semantics: zero errors, two non-null assertion warnings; formatting rule checked separately with explicit app config because files outside app otherwise resolve default Prettier options conflicting with their existing single-quote style. No live Blockchair aggregate acceptance claimed: public response remains code430. Production Rust counterpart remains a separately reviewed candidate. AvuDetails.vue selector names must change with this feed schema; chart worker owns that file.

## Review boundary follow-up

Independent review confirmed the TypeScript direct writer used retrieval time for consensus-share window checks while Rust uses the source block timestamp. The correction parses Blockchair best_block_time strictly as UTC and applies both endpoint share checks to that observation. Retrieval time still timestamps normalized live pairs, matching Rust. Delayed retrieval cannot reclassify a boundary-spanning observation as a stable one.

The proposed null-seed issue was independently disproven: unavailable observations are filtered by series(), and build() removes empty series. No repair or fallback was added.

Remaining inactive historical-source limitation: future other-chain fee/work monthly rows spanning a miner-share transition need per-period miner receipts or explicit omission with gap semantics; applying a month-start split is insufficient. Current bundled other-chain rows contain no fee/work observations, so this path supplies no AVU mining contribution. Do not claim regenerated eCash transition-month acceptance until that source treatment is resolved.

Follow-up verification: two affected price-feeds suites pass (42 tests); price-feeds TypeScript check passes. Replacing only the two observation-end lookups with the prior retrieval-time lookups makes both new allocation-window regressions fail; source restored afterward. Formatting and diff checks pass.
