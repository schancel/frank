# [refactor] Compose feature schemas while preserving core codec validation boundaries

## Summary

Freeze a small trusted feature composition contract: core owns framing, canonical encoding, limits, allocation and validation order; feature modules own application schemas/projection/types and semantic validation (including central blackjack rules in semantic.ts:236–300). No dynamic untrusted plugin loader, new universal contracts package, or independent parsing with fresh budgets. Choose feature home and public entry points before implementation.

## Current evidence and reproduction

Core schema.ts owns blackjack payload validators (:350/:450/:554/:1587). Runtime plugin interface lacks wire codecs. validate.ts already distinguishes open, required and root unknown-item handling with shared traversal budget; permissive replacement parsing would lose existing guarantees.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Installed/uninstalled feature cases retain permitted unknown bytes; malformed installed types reject; required/open/root semantics and total-depth/slot budgets hold with stable validation order. Existing vectors remain a reference; any deliberate wire break updates Rust/client fixtures together and retires old formats without migrations.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/frank-codec/src/schema.ts; types.ts; semantic.ts; validate.ts; index.ts; feature schema modules; fixtures/tests and Rust counterpart only if an explicit format break requires it.
- Semantic mutexes: codec-schema-and-validation.
- Open decision / readiness requirement: Owner accepts concrete feature-module home and composition interface. This proposal is not implementation-ready until those are recorded.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 3
Proposed cost: 4
Proposed certainty: 3
Proposed unblocking: 3

Proposed score: 9. Enables feature ownership with strong existing validation tests, but the exact trusted composition contract needs acceptance. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #950, #64.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
