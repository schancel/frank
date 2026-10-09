# [bug] Prevent old account derivations from publishing into a replacement session

## Summary

Bind asynchronous derivation/cache results to the requesting account generation. Older work cannot populate replacement caches, remove newer pending work, or publish an obsolete receive address. Preserve derivation algorithms, paths and custody formats. Dispose stale results without suppressing current-session failures.

## Current evidence and reproduction

session.ts:131 clears maps on release, but getChainAddress (:421) and getCurvePublicKey (:586) publish after awaits without a generation check. Their finally blocks can remove a newer in-flight entry. getActiveDomainRoot (:331) awaits custody without post-await generation validation. This is a static race candidate, not proven cause of reported corruption.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Deferred-promise regression: pause A, replace/close, start B, complete A. A cannot affect B cache, in-flight map or rendered address. Verify same-generation deduplication and current errors across existing secp256k1/ed25519 and chain address paths. No live keys needed.

## Solution contract and scope

- Kind: bug.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: app/src/accounts/session.ts; app/src/accounts/session.jest.test.ts; address-display callers only if regression proves necessary.
- Semantic mutexes: account-session-generation.
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
Proposed unblocking: 3

Proposed score: 40. A bounded deferred-promise fix protects account-affine addresses and avoids stale session publication without redesigning custody. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: none found in the inspected open and recent closed set.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
