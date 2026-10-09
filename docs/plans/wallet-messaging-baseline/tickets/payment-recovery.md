# [bug] Preserve payment and message recovery across retry exhaustion and discard

## Summary

Reconcile and finish the original authorized operation after uncertain/partial submission. Separate UI deletion, delivery status, financial settlement and retention obligations. Retry count, missing workflow links, and a later relay rejection cannot establish that earlier exposed signed transactions are unexecutable. Preserve exact encrypted message/payment recovery records and input ownership until obligations resolve. No fresh replacement payment, blanket clean-marking, broad pool rewrite or compatibility format.

## Current evidence and reproduction

At the base revision monad-canonical-dm.ts:610 terminalizes after five failed submits or selected HTTP errors, :1226 does so on discard, and :501/:519 acknowledges missing links as dead. monad-stamp-client.ts:2350 terminalizes orphaned attempts; :2383 performs cleanup. Acknowledged journal compaction can remove exact request records. Cleanup retires accounts; immediate reuse/double-spend has NOT been demonstrated.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

Deterministic fail-before/pass-after scenarios: relay accepts/broadcasts but response is lost; repeated transient failures; partial settlement; discard; missing link; restart; idempotent repeated reconciliation. Prove retained recovery evidence, no duplicate payment and accurate operation-level settlement evidence. Recipient presentation is owned by payment-reporting. Include delayed relay OR recipient broadcast of previously exposed bytes after exhaustion/discard/rejection and restart. Also prove a genuinely unsubmitted unsigned plan can release its claim without losing derivation ownership. Use an offline relay/chain fixture rather than reproducing against third parties.

## Solution contract and scope

- Kind: bug.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/chain/monad-canonical-dm.ts; packages/wallet/monad-stamp-client.ts; packages/wallet/storage/stamp-attempt-journal.ts; canonical link/journal stores reached by those modules; focused lifecycle tests.
- Semantic mutexes: canonical-attempt-lifecycle, canonical-stamp-client.
- Open decision / readiness requirement: Trace retention and terminal proofs in current code before authoring exact state changes; derive a bounded first fix, and split any required durable-model replacement into its own reviewed predecessor.
- Dependencies: none within this plan. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 5
Proposed cost: 4
Proposed certainty: 4
Proposed unblocking: 5

Proposed score: 30. Original-payment evidence is financially consequential and blocks safe concurrency; several concrete terminalization paths are known, but persistence review raises cost. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #68.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
