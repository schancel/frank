# Host recovery review and combined integration

Fresh verdict: SAFE TO INTEGRATE exact candidate `fcf51bca5a180c2ae0fa0e4feeb17aa62cbca1db` against `5100b241ae6bf8337124071fdb279c0c5601688f`. Reviewer negotiation_host_review_r2 ran independent correctness, security, efficiency, simplicity, shape, test-quality, concurrency, persistence, authority, lifecycle and accessibility passes. No actionable findings in the repaired candidate.

The earlier candidate `b3f5d140` had NH-LIFETIME-1: a timeout settled the wrapper while the underlying scan stayed pending, allowing overlapping retries. Independent reviewer and separate host_timeout_verifier both reproduced three outstanding scans after two timeout/retry cycles. Production per-request timeout did not disprove the issue. The repair retains underlying scan ownership, refuses new scans while it remains outstanding, discards late results and observes rejections. Stop still revokes admission/publication and drains local writes without waiting on network settlement. Three deterministic repair regressions failed on the old runtime and passed after; the fresh reviewer inspected that evidence.

Fresh independent execution: runtime/identity/dependency boundary14 tests, actual app recovery/session/polling/status64, full bot-host122, and all25 configured typechecks passed. Original-envelope binding, response-before-offer, qualified coverage CAS, stable account identity and independent status were traced. Chrome qualification and prior fail-before evidence were inspected, not independently rerun. No live-service or financial-execution qualification is claimed. Requested strong lane inherited; exact runtime model metadata unavailable.

Parent squash integration is `7c0ce06d` on the existing canonical-coin stack. Every changed file from both this reviewed candidate and canonical-coin candidate `cfc90e9e` was compared against the resulting tree with `git diff --exit-code`; both sets match exactly (22 paths each). There was no source conflict resolution.

Combined-tip checks passed:

- `node --import tsx scripts/typecheck.ts --fast`:25/25, `/tmp/negotiation-coin-combined-typecheck.log`.
- `node node_modules/jest/bin/jest.js --config packages/bot-framework/jest.config.js --runInBand bot-host-reliability`:31/31, `/tmp/negotiation-coin-combined-bot.log`.
- From app, `node ../node_modules/jest/bin/jest.js --config test/jest/accounts.config.cjs --runInBand negotiation-recovery monad-identity-session MailboxStatusIndicator pinia-chain-adapter.polling`:64/64, `/tmp/negotiation-coin-combined-app.log`.

Local integration only; no main merge, push, deployment, external message, funds or release-hold change. Authenticated negotiation recovery is installed in source; outgoing proposal/response signing and financial execution remain separate unfinished work.
