# [epic] Restore reliable wallet messaging and establish maintainable subsystem boundaries

## Summary

Complete the child outcomes in dependency order. Normal stealth payments use independent inputs; legacy external consolidation is a distinct workflow. Keep HD derivation, inventory, private construction views, reservations and recovery journals where each owns a distinct fact. Prefer clean format breaks to migrations. Exclude multi-chain AVU funding, new asset frameworks, game settlement redesign, and worktree/stash deletion.

## Current evidence and reproduction

Owner reports an unusable wallet, suspected persisted-state corruption, slow address-related work, and sends blocked by an earlier operation. Static review confirms a wallet-wide live-attempt gate; actual corruption and browser latency causes have not been reproduced.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Repeated app-to-bot send/receive/restart succeeds; a stalled payment cannot block disjoint sends; partial/uncertain payments remain recoverable and accurately reported; measured browser regressions improve; dependency and registry checks enforce new boundaries. Every child acceptance obligation remains visible until integrated and reviewed.

## Solution contract and scope

- Kind: coordination.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: planning only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: AGENTS.md; this plan; child contracts and integration evidence.
- Semantic mutexes: coordination-only.
- Open decision / readiness requirement: Owner accepts the child contracts separately; proposed feature-module layout and maintenance thresholds require later decisions.
- Dependencies: chrome-baseline, payment-recovery, input-reservations, disjoint-sends, session-generation, conversation-identity, chain-config, evm-boundaries, messaging-boundaries, codec-composition, blackjack-slice, transport-backedges, maintenance-reachability, payment-reporting, queue-readiness. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 5
Proposed certainty: 3
Proposed unblocking: 5

Proposed score: 18. Coordination rollup is not an implementation candidate. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #68, #681, #1218, #1217, #784, #785.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
