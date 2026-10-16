# [bug] Intermittent zero-stamp swap acceptance reports conflict

Local investigation draft; not a published tracker item. Classification: observed test failure with unresolved cause. Not a confirmed production regression. Parent owns follow-up triage; tracker deduplication remains required before publication.

## Observed and expected behavior

At local integration `3377f616`, the mounted zero-stamp Accept flow reached the signed negotiation command after duplicate confirmation clicks, then reported `conflict` before the second relay request. Expected behavior is one retained response authorization and delivery of the original response despite duplicate clicks. The wait at `signed-negotiation.flow.jest.test.ts:524` expired with `ready conflict`.

The original exception was mapped to the localized conflict code, so the first log cannot establish whether the cause is product concurrency, fixture isolation or another condition. No live user incident, payment loss or new spending is established by this evidence.

## Reproduction evidence

Run from the integration checkout's `app` directory:

```sh
node ../node_modules/jest/bin/jest.js --config test/jest/accounts.config.cjs --runInBand src/swap/signed-negotiation.flow.jest.test.ts src/accounts/session.jest.test.ts src/accounts/evm-wallets.jest.test.ts src/accounts/evm-rpc-identity.jest.test.ts
```

Original log `/tmp/evm-gates-combined-app.log`: exit 1, 158 passed, 1 failed, 1 intentional skip. Later unmodified isolated acceptance passed 1/1 and full flow passed 20/20. A detached diagnostic probe at source-equivalent `340e03280a4086abcc5aaabcef96a90f034966a1`, with exception tracing only, passed the same four-suite combination: 159 passed, 1 skip. Corrected probe log: `/tmp/signed-ui-conflict-probe-combination-corrected.log`. No traced conflict occurred. The probe initially lacked package-local Chronik dependencies; those unrelated probe-only errors were resolved by using the existing installed overlay and are not evidence against the integration.

## Follow-up criteria

- Capture the original conflict exception and a concrete causal interleaving if the failure repeats; preserve the immutable claim, original message identity and stamp policy.
- If a product defect is established, pin a deterministic regression at the actual command/durable-authorization boundary before repair and independent review.
- If fixture isolation is established as the cause, fix that fixture with evidence rather than weakening production guards or increasing a timeout.

No production fix, changed timeout or claim that rerunning cured the issue. Investigation is bounded; repeated passing runs alone cannot identify the cause. Existing broader swap execution and recovery obligations remain separate.
