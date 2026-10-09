# [refactor] Make EVM contracts generic and move network choices to configuration and adapters

## Summary

Invert EVM contracts, use generic implementations directly and delete aliases. Monad and Sepolia are peer configurations; Solana and Bitcoin family remain peers. Put network facts/defaults in config and behavior in explicit adapters. Remove hardcoded pool aliases using per-wallet chain scope. Do not rename wire tags/derivation domains blindly or expand chain support merely by renaming restricted code.

## Current evidence and reproduction

EvmChainConfig extends MonadChainConfig and EvmChainWalletHandle aliases MonadChainWalletHandle. Generic factory constructs Monad-named internals; pools use literal monad keys. Generic keyring/inventory replacements already exist as deprecated aliases. Factory selects Tempo behavior by identifier prefix.

Evidence is static inspection and owner reports at `f2231d2ff3d244ea5641e5444722271023c2fa2f`, not a completed browser or live-funds reproduction. Agent handoffs are leads only.

## Expected behavior and impact

This item contributes to usable, reliable messaging without weakening input ownership, original-operation recovery, or chain isolation. Actual behavior and unknowns are stated above; no production root cause is inferred beyond that evidence.

## Acceptance criteria

All consumers typecheck; same EVM implementation works with Monad and Sepolia fixtures; identical account addresses on distinct chains remain isolated; all family factory tests pass. No obsolete alias imports or implicit Monad fallback remain in migrated scope. Land mechanical import changes separately from behavioral adapter changes when separable.

## Solution contract and scope

- Kind: refactor.
- Planning state: NEEDS_SPECIFICATION until the owner accepts this prepared artifact and the prerequisites below are satisfied. Publication alone does not authorize implementation or mark it READY.
- Proposed execution owner: Shammah (@schancel): product/architecture decisions; root coordinator: contracts and integration; one claimed worker per implementation scope; independent reviewer before landing.
- Tier: 3 for production changes to money, lifecycle, identity, persistence, concurrency or wire; investigation itself is read-only.
- Model lane: strong for contract authoring and affected production work; resolve through the active harness at dispatch.
- Allowed scope: packages/wallet/chain/monad-chain.ts and replacement EVM/config modules; chain/chain-factory.ts; EVM wallet/signer/provider/keyring/stealth modules and exact import consumers.
- Semantic mutexes: chain-composition, canonical-stamp-client, chain-inventory-reservations, chain-registry-schema.
- Open decision / readiness requirement: Freeze exact move/import list after urgent payment landings. This is a later refactor, not authority for a global rename now.
- Dependencies: chain-config, disjoint-sends. Draft keys must become native GitHub blocked-by edges at publication; prose alone is not the dependency graph.
- Non-goals: no broad unscoped rewrite, legacy migrations, live-funds experiments, new asset framework, stash/worktree cleanup, or independent sibling integration.
- Staging: regression/evidence first; required replacement/refactor next; switch consumers and delete predecessor before completion. Temporary coexistence, if unavoidable between landings, belongs to this item's implementation owner and ends when the immediate successor switches consumers. Do not leave a compatibility layer.
- Durable shape: where records change, freeze current and target ownership and restart/partial-submission semantics before editing. Known consumers are app/bot delivery and supported chain adapters; hypothetical plugins/assets do not justify a framework. Development reset replaces migrations but never deletes custody or unrelated state implicitly.
- Rollback: stop dispatch, preserve operation evidence and keys, and fix forward or revert only when new-format and financial effects permit it. A code revert is not a financial rollback.
- Gates: relevant existing package tests and boundary/browser checks selected at dispatch, plus `yarn typecheck:fast` for source changes. No invented factory gate script. Investigations report evidence rather than claiming source gates passed.

## Queue proposal

Proposed value: 4
Proposed cost: 4
Proposed certainty: 3
Proposed unblocking: 3

Proposed score: 12. Correct generic ownership removes recurring naming/configuration mistakes, but broad import movement must wait for urgent wallet edits. These scores are advisory and do not override readiness, blockers or scope mutexes.

## Related work and provenance

Related existing issues: #681.

Owner discussion establishes chain-scoped pools, per-input reservations, independent normal stealth payments, distinct legacy fan-in, durable pre-submission recovery, partial-payment reporting, and clean format breaks. Current `AGENTS.md` records these decisions. Linked existing issues must be reconciled with these newer decisions, not blindly treated as current implementation truth.

Prepared labels: none. Prepared assignees: none. Implementation claims will be recorded separately after scope/liveness checks.
