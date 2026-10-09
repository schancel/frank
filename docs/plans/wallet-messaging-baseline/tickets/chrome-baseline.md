# [investigation] Reproduce wallet failures and capture an isolated Chrome performance baseline

## Summary

Build repeatable cold/warm startup, wallet open, conversation switch, typing, blocked/disjoint send, reconciliation and restart scenarios in an isolated Chrome profile. Leave current owner state untouched; obtain explicitly authorized sanitized reproduction evidence before any owner-state access or reset. Compare an owner-authorized sanitized reproduction of the failing state with clean fixtures; if unavailable, explicitly leave the reported corruption unreproduced. Trace CPU/long tasks, address derivation counts, network waits and persistence. Use fake-chain/loopback fixtures for automated sends; live funded reproduction needs an explicit network/amount scope.

## Current evidence and reproduction

User-reported corruption and severe latency are not reproduced. Existing CDP harnesses exist but are functional checks. Demo defaults use persistent state and real-network configuration, so they cannot be treated as disposable profiling fixtures.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Record exact revision, Chrome version, fixture scale and commands. Capture repeated timing distributions and sanitized traces. Identify the responsible stack/wait or state invariant; do not infer corruption from symptoms. Demonstrate no owner profile/database was opened or reset by the isolated harness. Route measured wallet hotspots to their owning tickets and avoid arbitrary latency promises.

## Solution contract and scope

- Kind: investigation.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; harness work is isolated and non-destructive, with writes only to claimed source, disposable profiles/fixtures and artifacts; no owner-state mutation.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: app/test/accounts-browser.mjs; app/test/forum-browser.mjs; app/src/accounts/custody/test/browser.mjs; new narrowly scoped app/test profiling harness and non-secret fixtures.
- Semantic mutexes: browser-profile-and-demo-fixture, quiet-performance-measurement.
- Open decision / readiness requirement: None beyond acceptance of this contract and active-work conflict clearance.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 2
Proposed certainty: 4
Proposed unblocking: 5

Proposed score: 60. Directly targets the unusable app, has a bounded measurement method, and supplies evidence for several uncertain performance/storage fixes. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #1214, #1215, #1216.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
