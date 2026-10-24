# App messaging policy

This folder owns outgoing execution, foreground retry decisions and row-bound recovery policy.
Start with [README.md](README.md) and the module you are changing.

- `outgoing-retry-policy.ts` stays effect-free: no timers, RPC, storage, locks,
  signing, exposure authorization, Vue/Pinia state or session selection.
- Preserve branch order and short-circuit evaluation, including separate
  `isCurrent()` calls. Error formatting may throw; this extraction preserves that
  behavior. Typed wallet outcomes are a separately contracted change.
- The caller owns exact-rejection no-effect evidence and original operation IDs.
  Retryability and missing digests never establish that a payment was unattempted.
- Retry policy retains only its existing error-class import. Recovery imports
  only public wallet/cashweb capability types. AST tests enforce these direct
  boundaries, including type-only, alias, re-export and dynamic imports.
- `outgoing-recovery.ts` owns the three recovery algorithms, but no state. Inject
  current original message objects, existing shared exclusion sets and lock/mutation
  owners. Never clone records into another working set or capture global UI state.
- Capture context per recovery invocation. Preserve method receivers, exact original
  digests, stale-result classification, assertion forwarding and catch boundaries.
  State/confirmation ports perform assertions inside their existing mutation queue.
- Retained financial-envelope recovery and scheduling remain separate owners;
  this module does not enumerate financial bindings, prepare payments or own timers.
- `outgoing-execution.ts` owns the complete run/runExclusive orchestration, including
  retained binding/bootstrap and envelope callback ordering. Inject existing lifecycle,
  projection, financial/application capabilities and grouped presentation hooks; no whole
  store, global wallet selection, second journal or new authorization policy.
- Execution retains explicit existing error-class/accessor and retry-helper imports.
  Its AST allowlist pins those runtime dependencies; never normalize exact thrown objects
  before the no-effect accessor or replace the shared host stale sentinel.
- Group dispatch, contacts/wakeup features, progress state and mutation queue remain
  composition-owned. Do not fold group delivery or contact-card policy into execution.
- This is app policy, not a shared bot/mail delivery engine. Do not move their
  journals or policies here merely to make a common interface.

From the repository root:

```sh
yarn --cwd app test:unit:ci src/messaging/ --runInBand
yarn --cwd app test:unit:ci src/stores/chats.outgoing.jest.test.ts --runInBand
yarn typecheck:fast
```

Use `test:unit:ci` for verification; `test:unit` updates snapshots. Root invariants
remain authoritative. Changes to persistence, exposure or recovery require their
own contract and composed tests, not just policy-unit tests.
