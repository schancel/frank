## Summary
The Solana native balance has different AVU values in the wallet header and native asset row. The header uses the configured oracle, while useChainBalance multiplies by fixed 145.0 × 11.90476.

## Reproduction
At cbe9ffd60d33b45d9688f904d9841f57e77e4ee5, load the Solana wallet with a positive balance and compare header and native asset AVU values. Default 1 SOL projects about 1785.7 AVU in the header and 1726.2 in the native row. A non-default oracle snapshot makes the distinction deterministic. Source-confirmed; the reported screenshot also shows disagreement, but no injected-rate browser reproduction is claimed.

## Expected behavior
The same native amount uses the same selected oracle snapshot across detail, asset row and drawer, allowing only documented display rounding. Snapshot changes update every projection.

## Impact
Conflicting displayed valuations make wallet totals impossible to reconcile.

## Acceptance criteria
- A non-default-rate fixture proves header, native asset and drawer agreement for the same balance.
- A snapshot refresh updates all projections reactively.
- Meaningful regression fails before the fix; existing native Send and balance availability tests remain green.

## Bounded solution contract
Readiness: READY for the accepted autonomous repair scope after the overlapping balance-display implementation is frozen and handed off. The existing oracle store remains the only native valuation authority; remove the hardcoded alternate formula. No new price service, token inventory model, custody, transfer, canonical identity or SPL observation policy changes. Allowed production paths are useChainBalance and existing wallet presentation/valuation helpers only where required; freeze exact paths in the claim. One worker owns overlapping wallet presentation code, independent review before integration. Related #1238; not completion of its broader registry refactor.
