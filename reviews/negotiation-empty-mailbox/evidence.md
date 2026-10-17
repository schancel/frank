# Candidate evidence

Base integration: `61c6d468a1911f05fb469a4d28c512fb049ef78a`; contract parent: `1adf93f4ef490b8823ce05036e84bf17018a07c5`. Tier 2 bounded local repair. Parent-selected GPT-6.1-Sol medium; no inference about a hidden runtime model.

Scanner owns authenticated evidence and timestamp coverage. The existing `truncated` result now also reports unresolved timestamp groups. Pagination eligibility and inclusive cursor calculation are unchanged. Runtime publishes readiness from completeness after its existing admissions, coverage CAS, and durable refresh. No wire/persistent formats, wallet effects, app production code, or bot production code changed. App and bot adapters forward the scanner result directly; no separate completeness flag was necessary.

Joined tests use the production canonical authenticated scanner, production recovery runtime, and native journal store with offline relay/RPC fixtures. Cases cover a genuinely empty new mailbox/store; complete coverage followed by idle reads; missing authenticated directory evidence with no progress and with an earlier completed prefix; replay of the whole incomplete timestamp group plus later records after directory recheck; equal-timestamp pagination cutoff; and terminal unreadable rows. Every complete idle pass retains its exact durable cursor.

Fail-before command (before the two production behavior edits):

```
node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts -t 'reconciles production scanner completeness'
```

All six cases failed as expected; log `/tmp/negotiation-empty-mailbox-before.log`.

Pass-after gates:

- Same scanner suite filtered with `-t 'authenticated original-envelope scan'`: 22 passed, including the six joined regressions. `/tmp/negotiation-empty-mailbox-scanner.log`.
- Swap runtime and boundary suites: 12 passed, including storage/CAS, timeout/nonoverlap/stop and durable writes. `/tmp/negotiation-empty-mailbox-runtime.log`.
- App negotiation recovery and MailboxStatusIndicator suites: 30 passed. Run from `app` so Vue-Jest finds its tsconfig: `node ../node_modules/jest/bin/jest.js --config test/jest/accounts.config.cjs --runInBand --runTestsByPath src/utils/negotiation-recovery.jest.test.ts src/components/chat/MailboxStatusIndicator.jest.test.ts`. `/tmp/negotiation-empty-mailbox-app.log`.
- Bot installed recovery (`bot-host-reliability`): 31 passed. Existing empty restart expectation updated to ready with explicit parent authorization. `/tmp/negotiation-empty-mailbox-bot-recovery.log`.
- Adjacent bot message-items and wallet-reconcile suites: 5 passed. `/tmp/negotiation-empty-mailbox-bot.log`.
- `yarn typecheck:fast`: 25/25 configured projects passed. `/tmp/negotiation-empty-mailbox-typecheck.log`.
- `git diff --check` passed.

Dependencies use candidate-local symlinks to existing external root dependencies; every @frank link resolves into this candidate. Bot-local @types and wallet-local Chronik 4.3.1 overlays reference existing dependencies. No installs or shared dependency mutations.

Mounted unseeded paid/free UI acceptance remains assigned to the sibling UI owner after reviewed integration. No live relay/RPC, funded-wallet execution, push, deployment or main merge was performed. Initial app invocation from repository root failed Vue template compilation because Vue-Jest did not find app tsconfig; the corrected app-directory invocation above passed without source/config changes.

The unfiltered canonical DM suite was also attempted (`node node_modules/jest/bin/jest.js --config packages/wallet/jest.config.js --runInBand --runTestsByPath packages/wallet/chain/monad-chain-canonical-dm.jest.test.ts`). After almost three minutes there was no completed summary; its latest output referenced the existing refused-send retry fixture around line 2239. This does not establish that the suite was hung. The worker-owned test process was terminated; this broad run is **incomplete**, not a pass. Its partial log is `/tmp/negotiation-empty-mailbox-wallet.log`. The focused authenticated scanner suite completed independently and passed all 22 tests.
