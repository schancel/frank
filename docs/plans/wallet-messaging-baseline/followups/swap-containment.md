# [bug] Disable fabricated Instant Swap balances and execution

Readiness: READY. The owner explicitly authorized autonomous bug and UX repairs; this is a bounded containment of demonstrated behavior, not authorization to implement a DEX.

## Evidence

At main `23c73b645fac7a27dfa7873994543724f2224195`, the real Wallet Instant Swap tab mounts DAppSwapView unconditionally. A read-only Chrome check on the isolated funded test profile showed Available 1,000.00 USDC and an enabled SWAP NOW button for 1 USDC to MON, with a fixed quote and router label. No execute, signing or confirmation action was taken.

Source inspection confirms hardcoded AVAILABLE_BALANCES and price arithmetic in DAppSwapView.vue. Its execute action attempts an ordinary SOL transfer to a program address rather than a swap, catches errors, creates random transaction IDs when no actual transaction exists, and logs confirmed history. This can mislead users about holdings and financial effects.

## Expected outcome and contract

The live app must expose unsupported swap execution honestly. Remove fabricated balances, quotes, receipt IDs and success records, and remove the ordinary transfer pretending to perform a swap. Since no verified end-to-end swap implementation exists in this route, show a clear localized unavailable capability state and disable execution for every current route. No signer, provider transaction, history write or self-message may be invoked by this UI. Preserve existing history and funded custody state.

Current owner: DAppSwapView owns both presentation and mock execution. Target owner: this component presents an explicit unavailable capability; future transaction execution requires a separately reviewed adapter contract. No new registry, service framework, persistent format or DEX implementation is needed. Allowed changes: DAppSwapView, focused existing/new component regression tests, necessary English/French labels, and a Wallet mounting test if needed. No wallet signer, custody, plugin protocol, asset inventory or history-store rewrite.

## Acceptance

- Actual mounted Wallet swap UI shows no invented balance, executable quote, or enabled execution for unsupported routes across configured families.
- A regression fails on the base at the public component boundary and passes on the candidate.
- Attempted UI/programmatic execution cannot sign, transfer, record history or invent transaction IDs.
- Independent review and applicable local/hosted gates pass, then Chrome confirms the unavailable state without clicking any financial action.

## Separate follow-up leads

The eCash swap plugin's synthetic hash-lock/quote builder and useSwapHistory's production fallback/default-confirmed behavior require ownership review. They are not evidence of a working swap engine and do not expand this immediate containment. Existing records must not be silently deleted or rewritten. No matching open or recently closed swap-containment issue was found in the fresh tracker search.
