# App messaging policy

This folder currently owns only the foreground outgoing retry decision. Start with
[README.md](README.md) and `outgoing-retry-policy.ts`.

- Keep decisions separate from effects: no timers, RPC, storage, locks, signing,
  exposure authorization, Vue/Pinia state or session selection in this helper.
- Preserve branch order and short-circuit evaluation, including separate
  `isCurrent()` calls. Error formatting may throw; this extraction preserves that
  behavior. Typed wallet outcomes are a separately contracted change.
- The caller owns exact-rejection no-effect evidence and original operation IDs.
  Retryability and missing digests never establish that a payment was unattempted.
- The existing error-class import is the only allowed module dependency. The
  AST boundary test includes type-only, alias, re-export and dynamic imports.
- This is app policy, not a shared bot/mail delivery engine. Do not move their
  journals or policies here merely to make a common interface.

From the repository root:

```sh
yarn --cwd app test:unit:ci src/messaging/outgoing-retry-policy --runInBand
yarn --cwd app test:unit:ci src/stores/chats.outgoing.jest.test.ts --runInBand
yarn typecheck:fast
```

Use `test:unit:ci` for verification; `test:unit` updates snapshots. Root invariants
remain authoritative. Changes to persistence, exposure or recovery require their
own contract and composed tests, not just policy-unit tests.
