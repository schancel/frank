# [bug] Let disjoint payments progress while another canonical send is pending

## Summary

Keep short atomic selection/admission critical sections and release them before network waits. Admit disjoint operations independently and run reconciliation independently of new sends. Maintain family nonce ordering and exact input ownership. Do not merely remove guards: prove that every active send path uses the agreed reservation authority.

## Current evidence and reproduction

monad-canonical-dm.ts:1212 serializes an entire send; :683 settles previous attempts then :685 rejects any remaining live link. monad-stamp-client.ts:2292 holds canonical exclusion across network submission. These gates block unrelated inputs, not just conflicting reservations.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Stall A after durable preparation and show B selects, persists, submits and receives using disjoint funds; C competing for A inputs cannot sign. Repeat across conversations and restart. Background reconciliation progresses with no new send. Failure in A does not poison B. No relaxation of partial-payment recovery or wallet/chain affinity.

## Solution contract and scope

- Kind: bug.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/chain/monad-canonical-dm.ts; packages/wallet/monad-stamp-client.ts; canonical admission integration in packages/wallet/chain/monad-chain.ts; focused concurrency tests.
- Semantic mutexes: canonical-attempt-lifecycle, canonical-stamp-client, chain-composition.
- Open decision / readiness requirement: None beyond acceptance of this contract and active-work conflict clearance.
- Dependencies: payment-recovery. Add input-reservations as a native blocker only if tracing shows the active canonical path relies on that pool boundary; otherwise prove the existing journal reservation authority is sufficient. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 4
Proposed certainty: 4
Proposed unblocking: 4

Proposed score: 25. Removes the reported global messaging stall once recovery is sound; known queue gates make the outcome concrete, but admission concurrency needs careful review. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: none found in the inspected open and recent closed set.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
