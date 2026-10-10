# Initial worker dispatch packets

These are prepared packets, not authorization to start production work. Replace draft keys with published issue URLs; record accepted contracts, resolve live ownership conflicts, and fill the actual isolated worktree and refreshed base SHA before dispatch. The planning base is f2231d2ff3d244ea5641e5444722271023c2fa2f plus the documented AGENTS.md policy overlay. Never silently drop that overlay.

## Payment recovery worker

- Item/outcome: `payment-recovery`; keep the original message/payment recoverable across lost responses, delayed external broadcast, discard and retry exhaustion.
- Contract: [prepared body](tickets/payment-recovery.md), including the separate delivery/financial/retention facts. Strong-lane coordinator authors the exact minimal state transition contract after tracing current retention; the worker does not invent terminal proofs.
- Repo: schancel/frank. Worktree: a new isolated persistent issue worktree, assigned after publication. Base: coordinator-recorded current full SHA; not a guessed branch tip.
- Allowed production owners: `packages/wallet/chain/monad-canonical-dm.ts`, `packages/wallet/monad-stamp-client.ts`, `packages/wallet/storage/stamp-attempt-journal.ts`, and the exact canonical link store identified during contract finalization. Tests: their existing canonical/attempt lifecycle suites and offline fixture helpers. Freeze the exact link-store path before edits.
- Exclusions: chats.ts, UI display, ChainUtxoPool replacement, chain naming, game code and assets. Acquire canonical-attempt-lifecycle and canonical-stamp-client mutexes. Reporting UI belongs to its successor.
- Proof: offline delayed/lost/partial submit, relay/recipient rebroadcast, restart, discard, missing links and idempotency regressions; an unused unsigned plan does not leak reservations forever. Run scoped wallet tests and typecheck:fast; report before/after and residual failure states.
- Lane/tier: strong / 3. No selected strong definition was found during planning; inherit and report actual model if still absent.
- Execution: repository fixtures and owned loopback only; no owner wallet data or live transfers. Edits only after claim. No tracker writes beyond coordinator-authorized claim workflow, no push/merge/closure/cleanup.
- Owner: assigned worker implementation, root integration, independent reviewer, Shammah unresolved product decisions. Handoff exact commit/files, gate matrix, requested/actual lane, remaining risks and next action; no attribution trailer.

## Account session worker

- Item/outcome: `session-generation`; stale async derivation cannot publish into a new account generation.
- Contract: [prepared body](tickets/session-generation.md). Keep derivation algorithms and custody formats unchanged.
- Repo/workspace/base: schancel/frank; new isolated issue worktree and exact refreshed SHA assigned by coordinator.
- Allowed files: `app/src/accounts/session.ts` and `app/src/accounts/session.jest.test.ts`. Caller files require coordinator-approved scope expansion only if boundary tests show they are necessary.
- Dependencies: none of the wallet recovery tasks. Mutex: account-session-generation; check import/reset branches for live ownership.
- Proof: deferred A/replacement/B completion test, stale cleanup cannot delete B pending entry, close handling, same-generation deduplication and current errors. App session tests and typecheck:fast.
- Lane/tier: strong / 3 because account identity lifecycle can affect receive-address routing. Execution: synthetic roots and test fixtures, no owner keys.
- Authority/handoff: implementation only after accepted contract/claim; no push/merge/closure or external messages. Root integrates, independent reviewer verifies. Exact commit/files, gate matrix and residual risks required.

## Chrome reproduction worker

- Item/outcome: `chrome-baseline`; reproducible isolated UI scenarios and measured bottlenecks, with corruption reported only if evidence establishes it.
- Contract: [prepared body](tickets/chrome-baseline.md).
- Repo/workspace/base: schancel/frank; dedicated persistent harness worktree/profile/artifact namespace and exact SHA recorded before execution.
- Read existing `app/test/accounts-browser.mjs`, `app/test/forum-browser.mjs` and custody browser harness. Claim only a narrowly named new profiling harness/fixtures under `app/test` and a private local artifact directory; any existing demo-config edits require a separate scope decision.
- No owner profile or database access/reset. Do not run demo defaults blindly. Use the real relay on a loopback port against Monad testnet (`packages/bot/demo/real-stack.ts`; there is no simulated chain), synthetic accounts, a separate test wallet (`FRANK_TEST_WALLET_JSON`), sanitized logs and recorded child PIDs. Live reproduction needs a specifically authorized network/amount and data scope.
- Capture cold/warm load, wallet open, thread switching/typing, disjoint sends with another pending operation, reconciliation and restart; separate UI, signing, relay and chain timing. Timed captures hold the quiet-performance mutex, so coordinator pauses heavy test/build activity.
- Proof: repeatable commands, Chrome/revision/fixture identifiers, timing distributions and sanitized trace references. An unsuccessful reproduction states the smallest missing evidence; it does not declare the real wallet healthy.
- Lane: strong for contract; resolve execution lane based on actual harness scope. No production feature fixes, network/provider credential changes, or process-pattern termination. Root routes findings to existing perf tickets or bounded new bugs.
- Handoff: artifact locations and reproduction outcome, gate matrix for any harness edits, requested/actual lane, owner-state preservation evidence, remaining blocker and next action. Stop only owned processes; no worktree cleanup by the worker.

## Replenishment and integration

After a slot clears, choose the next accepted dependency-eligible nonconflicting item. A quiet Chrome capture and expensive test suite are mutually exclusive even if their source scopes differ. No unattended backlog-loop run until the explicit-readiness reporting gap is fixed or a separately verified acceptance gate excludes proposals. Separate workers must not edit shared chats.ts/canonical state files just because they are available.
