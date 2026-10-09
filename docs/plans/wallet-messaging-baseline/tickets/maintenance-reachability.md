# [investigation] Establish the active maintenance worker and reservation eligibility policy

## Summary

Trace actual worker startup, lifecycle, reservation authority and configured amount distribution. Distinguish dirty-account cleanup from splitting large nonce-zero deposits. Return a bounded fix contract only after proving active reachability or the missing composition path. Never remove nonce-zero deposits from distribution by a blanket rule.

## Current evidence and reproduction

Engine scans dirty inventory under literal monad and has a local isSweeping guard; dirty selection can include pending entries. Static search found simulation/tests constructing this engine, not established active app composition. Owner expects deposit distribution and economical cleanup, but completion/reachability is unknown.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Evidence identifies active/inactive paths and the exact distribution rule source. Proposed follow-up includes payment-versus-maintenance reservation tests and uneconomic-move behavior. Threshold changes, token inventory policy and multi-chain funding require explicit owner decisions.

## Solution contract and scope

- Kind: investigation.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/monad-account-hygiene.ts; privacy-simulation-engine.ts; maintenance composition and selection callers; distribution tests; no production edits in this investigation.
- Semantic mutexes: maintenance-selection.
- Open decision / readiness requirement: Mapping may begin after accepting this investigation; owner approval of eligibility/distribution gates a later implementation, not the investigation. This is not a confirmed production race.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: read-only reachability and policy evidence, then a separately accepted follow-up if needed. This investigation performs no production replacement.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 4
Proposed cost: 2
Proposed certainty: 3
Proposed unblocking: 3

Proposed score: 24. Determines whether expected distribution exists and avoids a speculative race fix; bounded inspection is cheap but active reachability remains uncertain. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #925, #1180, #1217.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
