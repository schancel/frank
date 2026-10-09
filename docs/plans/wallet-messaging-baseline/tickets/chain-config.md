# [refactor] Derive shared chain identity from the protocol registry

## Summary

Choose direct consumption or generation after tracing build constraints; shared identity/family/native evidence comes from the protocol registry. Client metadata extends by canonical key, relay operator settings remain distinct. Reject unregistered static keys and clearly document supported subsets. Keep native IDs distinct from Frank identity; preserve identity probes. Do not advertise capabilities a relay has not configured or invent checkpoints.

## Current evidence and reproduction

Rust includes v1.json directly. TS chains-registry.ts declares a separate table; no generation relationship established. Its tests at :702 compare shared rows, skip unknown wallet keys, and require completeness only for EVM/Solana rows. Client/operator metadata and shared protocol facts need explicit provenance.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Add/remove/change a protocol entry and demonstrate affected consumers agree; reject unregistered extension keys; check all supported families and intentional subsets. Verify deterministic generation if used and exact regeneration command. Preserve registry probe tests and native chain ID uses.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: docs/protocol/chains/v1.json; docs/protocol/chains/README.md; packages/wallet/chain/chains-registry.ts and tests; backend/cashweb/cashweb-config/src/lib.rs and registry tests; specific generator/build configuration only if chosen.
- Semantic mutexes: chain-registry-schema.
- Open decision / readiness requirement: None beyond acceptance of this contract and active-work conflict clearance.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 4
Proposed cost: 3
Proposed certainty: 4
Proposed unblocking: 3

Proposed score: 21.3333. Shared identity consistency enables later family cleanup; source provenance is clear enough to investigate, while build integration needs a bounded design choice. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #1118, #681.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
