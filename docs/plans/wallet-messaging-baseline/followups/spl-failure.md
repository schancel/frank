## Summary
A temporary SPL token-account outage is represented as a successful empty list, silently removing known holdings while native SOL balance can still succeed.

## Reproduction
At cbe9ffd60d33b45d9688f904d9841f57e77e4ee5, packages/wallet/chain/solana-balance.ts returns [] after all token RPC endpoints fail. useChainBalance additionally catches token failure as [] and overwrites the observation with hasError false. Seed a successful native-plus-token refresh, then make native succeed and every token endpoint fail. This is source-confirmed; no live failure injection was performed.

## Expected behavior
A failed token read is distinguishable from a successful empty wallet. Preserve the last known token observation with explicit unavailable/stale state, or report unknown if none exists. A genuine successful empty response may clear the list. Native SOL remains independently usable.

## Impact
Users see assets disappear while the wallet incorrectly reports a successful refresh.

## Acceptance criteria
- Adapter/composable/UI regression distinguishes successful empty result from complete endpoint failure.
- Known token data is retained with observable failure state; first-read failure does not claim zero holdings.
- Recovery clears the error state; successful empty refresh clears prior holdings.
- Native balance and verified native Send remain independently usable.

## Scope and readiness
Readiness: READY under the accepted exact adapter/error and separate native/token observation contract posted in the implementation claim. Candidate scope is solana-balance, useChainBalance and existing token presentation/tests. No token inventory redesign, signing, custody, new adapters or valuation-policy change. Related #1238 and #1214; their broader configuration/performance scope does not itself repair this false-empty observation. Accepted for investigation under the autonomous repair request.
