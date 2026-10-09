# [refactor] Remove cashweb imports of wallet transport implementation types

## Summary

Trace production reachability first. Delete obsolete paths if unreachable; otherwise place necessary transport records under cashweb ownership and update consumers. Do not create a permanent universal transport package to preserve obsolete protobuf. Add a focused forbidden-import check including type-only imports.

## Current evidence and reproduction

Two type-only imports refer from cashweb into wallet-owned legacy protobuf records (packages/cashweb/relay/monad-message-feed.ts:23 and packages/cashweb/relay/monad-mailbox-client.ts:97). Runtime cycles are not demonstrated. The definitions are explicitly legacy and may be removable, so relocation is not automatically correct.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Reachability/deletion proof or retained mailbox/feed tests; cashweb builds without a wallet type dependency; focused boundary check detects direct and relative backedges; full typecheck. Any unexpectedly live legacy behavior requiring broader changes is returned to specification.

## Solution contract and scope

- Kind: investigation and bounded refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/cashweb/relay/monad-message-feed.ts; monad-mailbox-client.ts; exact legacy proto definitions in packages/wallet/monad-stamp-client.ts; callers, package metadata and dependency check.
- Semantic mutexes: canonical-stamp-client, cashweb-mailbox-feed.
- Open decision / readiness requirement: None beyond acceptance of this contract and active-work conflict clearance.
- Dependencies: payment-recovery (deliberate bugs-first scheduling on a shared stamp-client file, not a technical prerequisite). Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 3
Proposed cost: 2
Proposed certainty: 3
Proposed unblocking: 2

Proposed score: 13.5. Two concrete imports make the scope small; reachability decides deletion versus relocation, and urgent lifecycle work takes priority. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: none found in the inspected open and recent closed set.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
